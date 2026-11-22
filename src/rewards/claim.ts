import { Commitment, ComputeBudgetProgram, Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { SdkResult, err, ok } from "../types/result";
import { BuiltTx } from "../types/tx";
import { MintExtension, mintExtensionName, parseMintExtensions } from "../utils/extensions";
import { safeCall } from "../utils/retry";
import { deriveAta } from "../utils/pda";
import type { RewardVoucherResponse } from "../clients/CofferBackendClient";
import {
  COFFER_REWARDS_PROGRAM_ID,
  REWARD_CLAIM_CU_LIMIT,
  REWARD_RECEIPT_RENT_LAMPORTS,
} from "./constants";
import { ParsedRewardVoucher, parseRewardVoucher, rewardVerificationInstruction } from "./voucher";
import { RewardCampaignAccount, decodeRewardCampaignAccount, decodeRewardReceiptAccount } from "./accounts";
import { deriveRewardReceiptPda, deriveRewardSolVaultPda, deriveRewardTokenVault } from "./pda";
import { buildRewardClaimIx } from "./instructions";
import {
  RewardClaimFailure,
  parseRewardMintTransferFee,
  rewardClaimPayout,
  rewardTokenAccountInfo,
  rewardTransferFeeAt,
  rewardVaultSpendable,
} from "./payout";

/**
 * Chain state a claim is built against. Every field is optional: what is
 * absent is not checked, and the preview falls back to the voucher's
 * `claimableNowRaw`. `loadRewardClaimState` reads all of it in one RPC call.
 */
export interface RewardClaimState {
  /** The reward mint's data (token campaigns): refuses a TransferHook mint, reads the transfer fee. null = no such account. */
  mintData?: Buffer | Uint8Array | null;
  /** The destination token account's data; null = it does not exist (the ATA is created). Absent = unknown: the idempotent create is added. */
  destinationData?: Buffer | Uint8Array | null;
  /** Receipt data; null = no receipt (first claim, rent). Absent: claimedRaw of the voucher. */
  receiptData?: Buffer | Uint8Array | null;
  /** Campaign.liquidity. Absent: liquidityRaw of the voucher. */
  liquidityRaw?: bigint;
  /** Spendable vault (rewardVaultSpendable). Absent: the preview is the voucher's claimableNowRaw. */
  vaultRaw?: bigint;
  /** Current epoch, for the transfer-fee schedule in force; absent: the higher of the two. */
  epoch?: bigint | number;
}

export interface BuildRewardClaimTxOptions extends RewardClaimState {
  /** The program the voucher must be for; default COFFER_REWARDS_PROGRAM_ID. */
  programId?: PublicKey;
  /** The wallet that will sign; a voucher for another wallet is refused. */
  beneficiary?: PublicKey;
  /** Token campaigns: the receiving token account; default ATA(beneficiary, mint, tokenProgram). */
  destination?: PublicKey;
  /** Pays the ATA rent; default the beneficiary. */
  payer?: PublicKey;
  /** setComputeUnitLimit; default REWARD_CLAIM_CU_LIMIT, null = none (the wallet sets it). */
  computeUnitLimit?: number | null;
  /** setComputeUnitPrice in micro-lamports; default none. */
  computeUnitPriceMicroLamports?: number;
  /** Add createAssociatedTokenAccountIdempotent; default: unless destinationData shows the account exists. */
  createDestination?: boolean;
  /**
   * Pass SPL Memo to the claim; default: when destinationData requires incoming
   * memos, and always for a Token-2022 reward when destinationData is absent
   * (the program invokes it only when the destination requires it).
   */
  memo?: boolean;
}

export interface RewardClaimTx extends BuiltTx {
  voucher: ParsedRewardVoucher;
  native: boolean;
  campaign: PublicKey;
  receipt: PublicKey;
  vault: PublicKey;
  /** Where the reward lands: the token account, or the wallet itself for SOL. */
  destination: PublicKey;
  /** The memo program is passed to the claim. */
  memo: boolean;
  /** The destination ATA is created (idempotent) in this transaction. */
  createsDestination: boolean;
  /** Rent the wallet pays: receipt (first claim, not returned) + the ATA when created. An estimate. */
  rentLamports: number;
  receiptRentLamports: number;
  destinationRentLamports: number;
  /** Expected vault debit and wallet credit (net), from the state passed in or the voucher's estimate. */
  expectedGrossRaw: bigint;
  expectedNetRaw: bigint;
}

const FAILURE_MESSAGES: Record<RewardClaimFailure, string> = {
  AlreadyClaimed: "All claimed: the receipt has reached this voucher's total (6001 AlreadyClaimed)",
  InsufficientLiquidity: "The reward pool is being refilled, try later (6002 InsufficientLiquidity)",
  ZeroPayment: "Too small to claim (6003 ZeroPayment)",
  Overflow: "The transfer fee of this mint does not allow a claim now",
};

/** Rent-exempt minimum for `size` bytes at the current rate (3480 lamports per byte-year, 2 years, 128-byte header). */
function rentExemptLamports(size: number): number {
  return (128 + size) * 6960;
}

/** Rent of a destination ATA: 165 bytes, Token-2022 + ImmutableOwner (+ TransferFeeAmount for a fee mint). */
function ataRent(tokenProgram: PublicKey, extensions: number[]): number {
  if (!tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) return rentExemptLamports(165);
  const fee = extensions.includes(MintExtension.TransferFeeConfig) ? 4 + 8 : 0;
  return rentExemptLamports(165 + 1 + 4 + fee);
}

/**
 * The claim transaction for a voucher:
 * `[ComputeBudget?, createAssociatedTokenAccountIdempotent?, Ed25519 verify, claim_token | claim_native]`.
 * Rebuilds and checks the voucher message, refuses a TransferHook mint
 * (`unsupported_token_extension`), passes SPL Memo when the destination
 * requires it or its state is unknown (Token-2022), and previews the payout and the rent. The beneficiary signs.
 * A wallet must not put anything between the Ed25519 instruction and the claim.
 */
export function buildRewardClaimTx(
  voucher: RewardVoucherResponse | ParsedRewardVoucher,
  options: BuildRewardClaimTxOptions = {},
): SdkResult<RewardClaimTx> {
  let v: ParsedRewardVoucher;
  try {
    v = isParsed(voucher)
      ? voucher
      : parseRewardVoucher(voucher, { programId: options.programId });
  } catch (e) {
    return err("backend_invalid_response", `Invalid reward voucher: ${(e as Error).message}`, e);
  }
  const programId = options.programId ?? COFFER_REWARDS_PROGRAM_ID;
  if (!v.programId.equals(programId)) return err("invalid_input", `Voucher is for program ${v.programId.toBase58()}`);
  if (options.beneficiary && !v.beneficiary.equals(options.beneficiary)) {
    return err("invalid_input", `Voucher is for ${v.beneficiary.toBase58()}, not ${options.beneficiary.toBase58()}`);
  }

  let claimed = v.claimedRaw;
  let receiptExists = claimed > 0n;
  if (options.receiptData !== undefined) {
    receiptExists = options.receiptData !== null;
    try {
      claimed = options.receiptData === null ? 0n : decodeRewardReceiptAccount(options.receiptData).claimed;
    } catch (e) {
      return err("parse_failure", `Receipt: ${(e as Error).message}`, e);
    }
  }
  if (v.totalRaw <= claimed) return err("invalid_input", FAILURE_MESSAGES.AlreadyClaimed);

  const [receipt] = deriveRewardReceiptPda(v.campaign, v.beneficiary, programId);
  const user = v.beneficiary;
  let vault: PublicKey;
  let destination: PublicKey;
  let memo = false;
  let createsDestination = false;
  let destinationRentLamports = 0;
  let fee = null as ReturnType<typeof rewardTransferFeeAt> | null;
  const setup: TransactionInstruction[] = [];

  if (v.native) {
    vault = deriveRewardSolVaultPda(v.campaign, programId)[0];
    destination = user;
  } else {
    if (!v.tokenProgram.equals(TOKEN_PROGRAM_ID) && !v.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
      return err("invalid_input", `Unknown token program ${v.tokenProgram.toBase58()}`);
    }
    vault = deriveRewardTokenVault(v.campaign, v.mint, v.tokenProgram);
    destination = options.destination ?? deriveAta(user, v.mint, v.tokenProgram);
    let extensions: number[] = [];
    if (options.mintData === null) return err("account_not_found", `Reward mint ${v.mint.toBase58()} does not exist`);
    if (options.mintData !== undefined) {
      try {
        extensions = parseMintExtensions(options.mintData);
        const config = parseRewardMintTransferFee(options.mintData);
        fee = config ? rewardTransferFeeAt(config, options.epoch) : null;
      } catch (e) {
        return err("parse_failure", `Reward mint: ${(e as Error).message}`, e);
      }
      if (extensions.includes(MintExtension.TransferHook)) {
        return err("unsupported_token_extension", `Reward mint ${v.mint.toBase58()} has a ${mintExtensionName(MintExtension.TransferHook)}: claims of hook mints are not supported`);
      }
    }
    if (options.destinationData) {
      let info: ReturnType<typeof rewardTokenAccountInfo>;
      try {
        info = rewardTokenAccountInfo(options.destinationData);
      } catch (e) {
        return err("parse_failure", `Destination token account: ${(e as Error).message}`, e);
      }
      if (!v.mint.toBuffer().equals(info.mint) || !user.toBuffer().equals(info.owner)) {
        return err("invalid_input", `Destination ${destination.toBase58()} is not a ${v.mint.toBase58()} account of ${user.toBase58()}`);
      }
      if (info.frozen) return err("invalid_input", `Destination ${destination.toBase58()} is frozen`);
      memo = info.requiresMemo;
    } else if (options.destinationData === undefined && v.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
      // Unknown destination: it may require incoming memos (MemoTransfer).
      memo = true;
    }
    if (options.memo !== undefined) memo = options.memo;
    const isAta = destination.equals(deriveAta(user, v.mint, v.tokenProgram));
    if (!isAta && options.destinationData === null) {
      return err("account_not_found", `Destination ${destination.toBase58()} does not exist; only the associated token account can be created`);
    }
    createsDestination = options.createDestination ?? (isAta && !options.destinationData);
    if (createsDestination) {
      if (!isAta) return err("invalid_input", "Only the associated token account can be created; pass createDestination: false for another account");
      setup.push(createAssociatedTokenAccountIdempotentInstruction(options.payer ?? user, destination, user, v.mint, v.tokenProgram));
      // Unknown state counts as missing: an upper bound.
      destinationRentLamports = options.destinationData ? 0 : ataRent(v.tokenProgram, extensions);
    }
  }

  let expectedGrossRaw = v.claimableNowRaw;
  let expectedNetRaw = v.claimableNowRaw;
  if (options.vaultRaw !== undefined) {
    const payout = rewardClaimPayout({
      totalRaw: v.totalRaw,
      claimedRaw: claimed,
      liquidityRaw: options.liquidityRaw ?? v.liquidityRaw,
      vaultRaw: options.vaultRaw,
      native: v.native,
      fee,
    });
    if (payout.failure) {
      return err(payout.failure === "InsufficientLiquidity" ? "insufficient_funds" : "invalid_input", FAILURE_MESSAGES[payout.failure]);
    }
    expectedGrossRaw = payout.grossRaw;
    expectedNetRaw = payout.netRaw;
  } else if (v.claimableNowRaw === 0n) {
    return err("insufficient_funds", FAILURE_MESSAGES.InsufficientLiquidity);
  }

  const computeBudget: TransactionInstruction[] = [];
  const cuLimit = options.computeUnitLimit === undefined ? REWARD_CLAIM_CU_LIMIT : options.computeUnitLimit;
  if (cuLimit !== null) computeBudget.push(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
  if (options.computeUnitPriceMicroLamports !== undefined) {
    computeBudget.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: options.computeUnitPriceMicroLamports }));
  }

  let verify: TransactionInstruction;
  let claim: TransactionInstruction;
  try {
    verify = rewardVerificationInstruction(v.programId, v.campaign, user, v.signerEpoch, v.totalRaw, v.signer, v.signature);
    claim = buildRewardClaimIx(
      {
        campaign: v.campaign,
        user,
        total: v.totalRaw,
        asset: v.native ? { native: true } : { mint: v.mint, tokenProgram: v.tokenProgram },
        walletToken: v.native ? undefined : destination,
        memo,
      },
      programId,
    );
  } catch (e) {
    return err("tx_build_failed", (e as Error).message, e);
  }
  const receiptRentLamports = receiptExists ? 0 : REWARD_RECEIPT_RENT_LAMPORTS;
  return ok({
    instructions: [...computeBudget, ...setup, verify, claim],
    suggestedCuLimit: cuLimit ?? REWARD_CLAIM_CU_LIMIT,
    voucher: v,
    native: v.native,
    campaign: v.campaign,
    receipt,
    vault,
    destination,
    memo,
    createsDestination,
    rentLamports: receiptRentLamports + destinationRentLamports,
    receiptRentLamports,
    destinationRentLamports,
    expectedGrossRaw,
    expectedNetRaw,
  });
}

function isParsed(v: RewardVoucherResponse | ParsedRewardVoucher): v is ParsedRewardVoucher {
  return (v as ParsedRewardVoucher).programId instanceof PublicKey;
}

export interface LoadRewardClaimStateOptions {
  programId?: PublicKey;
  /** Token campaigns: the receiving token account; default ATA(beneficiary). */
  destination?: PublicKey;
  /** Default "confirmed". */
  commitment?: Commitment;
}

export interface LoadedRewardClaimState extends RewardClaimState {
  campaignAccount: RewardCampaignAccount;
  /** Token campaigns: the token account destinationData was read from; spread into buildRewardClaimTx options. */
  destination?: PublicKey;
}

/**
 * Read what `buildRewardClaimTx` checks, in one getMultipleAccountsInfo
 * (+ getEpochInfo for a fee mint): the campaign, the mint, the destination,
 * the receipt and the vault. Refuses a voucher the campaign would reject
 * with 6000: another signer or signer epoch (rotated — ask for a new
 * voucher), another mint or token program.
 */
export async function loadRewardClaimState(
  connection: Connection,
  voucher: RewardVoucherResponse | ParsedRewardVoucher,
  options: LoadRewardClaimStateOptions = {},
): Promise<SdkResult<LoadedRewardClaimState>> {
  let v: ParsedRewardVoucher;
  try {
    v = isParsed(voucher) ? voucher : parseRewardVoucher(voucher, { programId: options.programId });
  } catch (e) {
    return err("backend_invalid_response", `Invalid reward voucher: ${(e as Error).message}`, e);
  }
  const programId = options.programId ?? COFFER_REWARDS_PROGRAM_ID;
  const commitment = options.commitment ?? "confirmed";
  const [receipt] = deriveRewardReceiptPda(v.campaign, v.beneficiary, programId);
  const vault = v.native ? deriveRewardSolVaultPda(v.campaign, programId)[0] : deriveRewardTokenVault(v.campaign, v.mint, v.tokenProgram);
  const destination = v.native ? null : options.destination ?? deriveAta(v.beneficiary, v.mint, v.tokenProgram);
  const keys = [v.campaign, receipt, vault, ...(v.native ? [] : [v.mint, destination!])];
  const read = await safeCall(() => connection.getMultipleAccountsInfo(keys, commitment));
  if (!read.ok) return read;
  const [campaignInfo, receiptInfo, vaultInfo, mintInfo, destinationInfo] = read.data;
  if (!campaignInfo) return err("account_not_found", `Campaign ${v.campaign.toBase58()} does not exist`);
  if (!campaignInfo.owner.equals(programId)) return err("invalid_input", `Campaign ${v.campaign.toBase58()} is not owned by ${programId.toBase58()}`);
  let campaignAccount: RewardCampaignAccount;
  try {
    campaignAccount = decodeRewardCampaignAccount(campaignInfo.data);
  } catch (e) {
    return err("parse_failure", (e as Error).message, e);
  }
  if (!campaignAccount.backendSigner.equals(v.signer) || campaignAccount.signerEpoch !== v.signerEpoch) {
    return err("invalid_input", "The campaign's signing key was rotated: request a new voucher (6000 InvalidVoucher)");
  }
  if (!campaignAccount.mint.equals(v.mint) || (!v.native && !campaignAccount.tokenProgram.equals(v.tokenProgram))) {
    return err("invalid_input", "The voucher's mint or token program is not the campaign's (6006 WrongAsset)");
  }
  if (!v.native && mintInfo && !mintInfo.owner.equals(v.tokenProgram)) {
    return err("invalid_input", `Mint ${v.mint.toBase58()} is not owned by ${v.tokenProgram.toBase58()}`);
  }
  if (receiptInfo && !receiptInfo.owner.equals(programId)) return err("invalid_input", "The receipt is not owned by the rewards program");

  let vaultRaw: bigint;
  try {
    vaultRaw = rewardVaultSpendable(vaultInfo, v.native);
  } catch (e) {
    return err("parse_failure", (e as Error).message, e);
  }
  const state: LoadedRewardClaimState = {
    campaignAccount,
    receiptData: receiptInfo ? receiptInfo.data : null,
    liquidityRaw: campaignAccount.liquidity,
    vaultRaw,
  };
  if (!v.native) {
    state.mintData = mintInfo ? mintInfo.data : null;
    state.destination = destination!;
    state.destinationData = destinationInfo ? destinationInfo.data : null;
    let feeMint = false;
    try {
      feeMint = !!mintInfo && parseRewardMintTransferFee(mintInfo.data) !== null;
    } catch {
      feeMint = false;
    }
    if (feeMint) {
      const epoch = await safeCall(() => connection.getEpochInfo(commitment));
      if (epoch.ok) state.epoch = BigInt(epoch.data.epoch);
    }
  }
  return ok(state);
}
