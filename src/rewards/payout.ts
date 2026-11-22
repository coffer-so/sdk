import { MintExtension } from "../utils/extensions";
import { U64_MAX } from "../math/fixedPoint";
import { REWARD_SOL_VAULT_RENT_LAMPORTS } from "./constants";

/** One Token-2022 transfer-fee schedule. */
export interface RewardTransferFee {
  basisPoints: number;
  maximumFee: bigint;
}

/** TransferFeeConfig of a Token-2022 mint: `newer` applies from `newerEpoch`, `older` before it. */
export interface RewardTransferFeeConfig {
  older: RewardTransferFee;
  newerEpoch: bigint;
  newer: RewardTransferFee;
}

const ACCOUNT_TYPE_OFFSET = 165;

/** TLV entries of a Token-2022 mint (account type 1) or token account (2); [] for a classic layout. */
function tlvEntries(data: Buffer, accountType: 1 | 2): Array<{ type: number; value: Buffer }> {
  if (data.length <= ACCOUNT_TYPE_OFFSET) return [];
  if (data[ACCOUNT_TYPE_OFFSET] !== accountType) throw new Error(`account type ${data[ACCOUNT_TYPE_OFFSET]}, expected ${accountType}`);
  const out: Array<{ type: number; value: Buffer }> = [];
  let off = ACCOUNT_TYPE_OFFSET + 1;
  while (off + 4 <= data.length) {
    const type = data.readUInt16LE(off);
    const len = data.readUInt16LE(off + 2);
    if (type === 0 && len === 0) break;
    if (off + 4 + len > data.length) throw new Error(`extension ${type} runs past the end`);
    out.push({ type, value: data.subarray(off + 4, off + 4 + len) });
    off += 4 + len;
  }
  return out;
}

/** The TransferFeeConfig of a mint account's data; null for a mint without one (classic SPL included). */
export function parseRewardMintTransferFee(mintData: Buffer | Uint8Array): RewardTransferFeeConfig | null {
  const entry = tlvEntries(Buffer.from(mintData), 1).find((e) => e.type === MintExtension.TransferFeeConfig);
  if (!entry) return null;
  // authority 32 · withdraw authority 32 · withheld u64 · older {epoch u64, max u64, bps u16} · newer {…}
  if (entry.value.length !== 108) throw new Error(`TransferFeeConfig of ${entry.value.length} bytes`);
  return {
    older: { maximumFee: entry.value.readBigUInt64LE(80), basisPoints: entry.value.readUInt16LE(88) },
    newerEpoch: entry.value.readBigUInt64LE(90),
    newer: { maximumFee: entry.value.readBigUInt64LE(98), basisPoints: entry.value.readUInt16LE(106) },
  };
}

/**
 * The fee in force at `epoch` (`get_epoch_fee`). Without an epoch: a fee at
 * least as high as either schedule, so a preview never overstates what the
 * wallet receives (the backend's `claimableNowRaw` uses the same rule).
 */
export function rewardTransferFeeAt(config: RewardTransferFeeConfig, epoch?: bigint | number): RewardTransferFee {
  if (epoch !== undefined) return BigInt(epoch) >= config.newerEpoch ? config.newer : config.older;
  return {
    basisPoints: Math.max(config.older.basisPoints, config.newer.basisPoints),
    maximumFee: config.older.maximumFee > config.newer.maximumFee ? config.older.maximumFee : config.newer.maximumFee,
  };
}

/** Token-2022 `calculate_fee`: ⌈amount · bps / 10⁴⌉, at most maximumFee. */
function transferFee(amount: bigint, fee: RewardTransferFee): bigint {
  if (fee.basisPoints === 0 || amount === 0n) return 0n;
  const raw = (amount * BigInt(fee.basisPoints) + 9_999n) / 10_000n;
  return raw < fee.maximumFee ? raw : fee.maximumFee;
}

/** Token-2022 `calculate_post_fee_amount`. */
function postFeeAmount(gross: bigint, fee: RewardTransferFee): bigint {
  return gross - transferFee(gross, fee);
}

/** Token-2022 `calculate_pre_fee_amount`; null where Rust returns None (u64 overflow). */
function preFeeAmount(net: bigint, fee: RewardTransferFee): bigint | null {
  if (fee.basisPoints === 0) return net;
  if (net === 0n) return 0n;
  if (fee.basisPoints === 10_000) {
    const gross = fee.maximumFee + net;
    return gross > U64_MAX ? null : gross;
  }
  const denominator = 10_000n - BigInt(fee.basisPoints);
  const raw = (net * 10_000n + denominator - 1n) / denominator;
  if (raw - net >= fee.maximumFee) {
    const gross = net + fee.maximumFee;
    return gross > U64_MAX ? null : gross;
  }
  return raw > U64_MAX ? null : raw;
}

/**
 * Why a claim would fail on chain: 6001 AlreadyClaimed, 6002
 * InsufficientLiquidity, 6003 ZeroPayment; Overflow — the fee math does not
 * fit (Rust None, or a gross above the available balance).
 */
export type RewardClaimFailure = "AlreadyClaimed" | "InsufficientLiquidity" | "ZeroPayment" | "Overflow";

export interface RewardClaimPayout {
  /** What leaves the vault and is debited from liquidity. */
  grossRaw: bigint;
  /** What the wallet receives and its receipt counts. */
  netRaw: bigint;
  /** null when the claim pays. */
  failure: RewardClaimFailure | null;
}

export interface RewardClaimPayoutInput {
  /** Voucher total. */
  totalRaw: bigint;
  /** Receipt.claimed (0 without a receipt). */
  claimedRaw: bigint;
  /** Campaign.liquidity. */
  liquidityRaw: bigint;
  /** Spendable vault: the token amount, or for SOL the lamports above the 0-byte rent (see `rewardVaultSpendable`). */
  vaultRaw: bigint;
  native: boolean;
  /** The transfer fee in force; null or absent for SOL, classic SPL and Token-2022 mints without a fee. */
  fee?: RewardTransferFee | null;
}

/**
 * What a claim pays: a port of claim_native / claim_token and of assets.rs
 * `claim_transfer_amount`. Native: min(due, liquidity, vault). Token: the
 * net is clipped to what min(vault, liquidity) yields after the fee, and the
 * gross is the least that pays it (the campaign pays the fee).
 */
export function rewardClaimPayout(input: RewardClaimPayoutInput): RewardClaimPayout {
  const fail = (failure: RewardClaimFailure): RewardClaimPayout => ({ grossRaw: 0n, netRaw: 0n, failure });
  if (input.totalRaw <= input.claimedRaw) return fail("AlreadyClaimed");
  const due = input.totalRaw - input.claimedRaw;
  const available = input.vaultRaw < input.liquidityRaw ? input.vaultRaw : input.liquidityRaw;
  if (available <= 0n) return fail("InsufficientLiquidity");
  const fee = input.native ? null : input.fee ?? null;
  if (!fee) {
    const paid = due < available ? due : available;
    return { grossRaw: paid, netRaw: paid, failure: null };
  }
  const availableNet = postFeeAmount(available, fee);
  const net = due < availableNet ? due : availableNet;
  const gross = preFeeAmount(net, fee);
  if (gross === null || gross > available) return fail("Overflow");
  if (gross === 0n) return fail("ZeroPayment");
  const credited = postFeeAmount(gross, fee);
  if (credited === 0n) return fail("ZeroPayment");
  return { grossRaw: gross, netRaw: credited, failure: null };
}

/** Spendable vault: lamports above the 0-byte rent for SOL, the token amount (bytes 64..72) otherwise. */
export function rewardVaultSpendable(account: { lamports: number; data: Buffer | Uint8Array } | null, native: boolean): bigint {
  if (!account) return 0n;
  if (native) {
    const lamports = BigInt(account.lamports);
    return lamports > REWARD_SOL_VAULT_RENT_LAMPORTS ? lamports - REWARD_SOL_VAULT_RENT_LAMPORTS : 0n;
  }
  const data = Buffer.from(account.data);
  if (data.length < 72) throw new Error("rewardVaultSpendable: not a token account");
  return data.readBigUInt64LE(64);
}

/** A token account's mint, owner and whether it requires memos on incoming transfers (MemoTransfer). */
export function rewardTokenAccountInfo(data: Buffer | Uint8Array): { mint: Buffer; owner: Buffer; frozen: boolean; requiresMemo: boolean } {
  const buf = Buffer.from(data);
  if (buf.length < ACCOUNT_TYPE_OFFSET) throw new Error("not a token account");
  const memo = tlvEntries(buf, 2).find((e) => e.type === MintExtension.MemoTransfer);
  return {
    mint: buf.subarray(0, 32),
    owner: buf.subarray(32, 64),
    frozen: buf[108] === 2,
    requiresMemo: !!memo && memo.value.length >= 1 && memo.value[0] === 1,
  };
}
