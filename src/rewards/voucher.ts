import { Ed25519Program, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { U64_MAX } from "../math/fixedPoint";
import type { RewardVoucherResponse } from "../clients/CofferBackendClient";
import {
  COFFER_REWARDS_PROGRAM_ID,
  REWARD_VOUCHER_DOMAIN,
  REWARD_VOUCHER_MESSAGE_LEN,
} from "./constants";

/**
 * Vouchers of coffer_rewards: a byte-for-byte port of contracts
 * scripts/rewards/voucher.ts (and programs/coffer-rewards/src/voucher.rs).
 * Checked against tests/fixtures/rewards-vectors.json, the same file the
 * backend signs against.
 */

function u64le(value: bigint, what: string): Buffer {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) throw new Error(`${what} must be a u64 bigint`);
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

/**
 * The 129 bytes the campaign's backend key signs:
 * `"COFFER_REWARDS_V1" ‖ program ‖ campaign ‖ beneficiary ‖ signer_epoch u64le ‖ total u64le`.
 */
export function rewardVoucherMessage(
  program: PublicKey,
  campaign: PublicKey,
  user: PublicKey,
  epoch: bigint,
  total: bigint,
): Buffer {
  return Buffer.concat([
    REWARD_VOUCHER_DOMAIN,
    program.toBuffer(),
    campaign.toBuffer(),
    user.toBuffer(),
    u64le(epoch, "signerEpoch"),
    u64le(total, "total"),
  ]);
}

/**
 * The Ed25519 precompile instruction for a voucher, in the self-contained
 * web3.js layout the program compares byte for byte (no `instructionIndex`:
 * every index is 0xffff). Place it immediately before the claim.
 */
export function rewardVerificationInstruction(
  program: PublicKey,
  campaign: PublicKey,
  user: PublicKey,
  epoch: bigint,
  total: bigint,
  backendSigner: PublicKey,
  signature: Uint8Array,
): TransactionInstruction {
  if (signature.length !== 64) throw new Error("rewardVerificationInstruction: an Ed25519 signature is 64 bytes");
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: backendSigner.toBytes(),
    message: rewardVoucherMessage(program, campaign, user, epoch, total),
    signature,
  });
}

/** A voucher answer of `POST /api/rewards/vouchers`, checked and typed. */
export interface ParsedRewardVoucher {
  programId: PublicKey;
  campaign: PublicKey;
  beneficiary: PublicKey;
  signerEpoch: bigint;
  /** Cumulative net total the voucher allows, all time. */
  totalRaw: bigint;
  signer: PublicKey;
  signature: Buffer;
  /** The 129 signed bytes, equal to `rewardVoucherMessage` of the fields above. */
  message: Buffer;
  /** Receipt.claimed when the backend answered (confirmed). */
  claimedRaw: bigint;
  /** What a claim would pay now by the backend's estimate (net). */
  claimableNowRaw: bigint;
  liquidityRaw: bigint;
  /** `PublicKey.default` for a SOL campaign. */
  mint: PublicKey;
  native: boolean;
  tokenProgram: PublicKey;
  decimals: number;
}

export interface ParseRewardVoucherExpect {
  /** The program the claim goes to; default COFFER_REWARDS_PROGRAM_ID. */
  programId?: PublicKey;
  /** The wallet that will sign the claim. */
  beneficiary?: PublicKey;
  campaign?: PublicKey;
}

function u64String(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new Error(`voucher.${field} must be a u64 decimal string`);
  const n = BigInt(value);
  if (n > U64_MAX) throw new Error(`voucher.${field} is above u64`);
  return n;
}

function key(value: unknown, field: string): PublicKey {
  if (typeof value !== "string") throw new Error(`voucher.${field} must be a base58 address`);
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`voucher.${field} must be a base58 address`);
  }
}

function base64(value: unknown, field: string, length: number): Buffer {
  if (typeof value !== "string") throw new Error(`voucher.${field} must be base64`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || bytes.length !== length) throw new Error(`voucher.${field} must be ${length} bytes of base64`);
  return bytes;
}

/**
 * Check a voucher answer and type it. Rebuilds the 129-byte message from
 * `programId`, `campaign`, `beneficiary`, `signerEpoch` and `totalRaw` and
 * throws when it differs from `message`, when a field is malformed, or when
 * it does not match `expect`. The signature itself is verified on chain by
 * the Ed25519 precompile.
 */
export function parseRewardVoucher(response: RewardVoucherResponse, expect: ParseRewardVoucherExpect = {}): ParsedRewardVoucher {
  if (!response || typeof response !== "object") throw new Error("voucher must be an object");
  const programId = key(response.programId, "programId");
  const campaign = key(response.campaign, "campaign");
  const beneficiary = key(response.beneficiary, "beneficiary");
  const signer = key(response.signer, "signer");
  const mint = key(response.mint, "mint");
  const tokenProgram = key(response.tokenProgram, "tokenProgram");
  const signerEpoch = u64String(response.signerEpoch, "signerEpoch");
  const totalRaw = u64String(response.totalRaw, "totalRaw");
  const signature = base64(response.signature, "signature", 64);
  const message = base64(response.message, "message", REWARD_VOUCHER_MESSAGE_LEN);
  const decimals = response.decimals;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("voucher.decimals must be a u8");

  const expectedProgram = expect.programId ?? COFFER_REWARDS_PROGRAM_ID;
  if (!programId.equals(expectedProgram)) throw new Error(`voucher is for program ${programId.toBase58()}, expected ${expectedProgram.toBase58()}`);
  if (expect.beneficiary && !beneficiary.equals(expect.beneficiary)) throw new Error(`voucher is for ${beneficiary.toBase58()}, not ${expect.beneficiary.toBase58()}`);
  if (expect.campaign && !campaign.equals(expect.campaign)) throw new Error(`voucher is for campaign ${campaign.toBase58()}, not ${expect.campaign.toBase58()}`);
  if (signer.equals(PublicKey.default) || !PublicKey.isOnCurve(signer.toBytes())) throw new Error("voucher.signer is not an Ed25519 public key");
  if (!message.equals(rewardVoucherMessage(programId, campaign, beneficiary, signerEpoch, totalRaw))) {
    throw new Error("voucher.message does not match its fields");
  }
  return {
    programId,
    campaign,
    beneficiary,
    signerEpoch,
    totalRaw,
    signer,
    signature,
    message,
    claimedRaw: u64String(response.claimedRaw, "claimedRaw"),
    claimableNowRaw: u64String(response.claimableNowRaw, "claimableNowRaw"),
    liquidityRaw: u64String(response.liquidityRaw, "liquidityRaw"),
    mint,
    native: mint.equals(PublicKey.default),
    tokenProgram,
    decimals,
  };
}
