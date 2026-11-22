import { PublicKey } from "@solana/web3.js";
import {
  COFFER_REWARDS_PROGRAM_ID,
  REWARD_CAMPAIGN_DISCRIMINATOR,
  REWARD_CAMPAIGN_LEN,
  REWARD_CAMPAIGN_METADATA_MAX,
  REWARD_PAID_DISCRIMINATOR,
  REWARD_PAID_LEN,
  REWARD_RECEIPT_DISCRIMINATOR,
  REWARD_RECEIPT_LEN,
} from "./constants";

/**
 * Campaign — 389 bytes:
 *   0 discriminator · 8 admin · 40 id[32] · 72 bump · 73 mint (default
 *   pubkey = SOL) · 105 token_program · 137 backend_signer · 169
 *   signer_epoch u64 · 177 liquidity u64 · 185 metadata (u32 length + at
 *   most 200 bytes of UTF-8)
 */
export interface RewardCampaignAccount {
  /** The creator; the only key that can deposit, withdraw, rotate and return surplus. */
  admin: PublicKey;
  id: Buffer;
  bump: number;
  /** `PublicKey.default` for SOL. */
  mint: PublicKey;
  native: boolean;
  /** `PublicKey.default` for SOL (never set). */
  tokenProgram: PublicKey;
  backendSigner: PublicKey;
  /** +1 on every rotate_signer; vouchers of an older epoch fail with 6000. */
  signerEpoch: bigint;
  /** Spendable net units deposited and not yet withdrawn or paid out. */
  liquidity: bigint;
  metadata: string;
}

const key = (buf: Buffer, offset: number) => new PublicKey(buf.subarray(offset, offset + 32));

/** Decode a Campaign account; throws for anything that is not exactly one. Check the owner separately. */
export function decodeRewardCampaignAccount(data: Buffer | Uint8Array): RewardCampaignAccount {
  const buf = Buffer.from(data);
  if (buf.length !== REWARD_CAMPAIGN_LEN) throw new Error(`decodeRewardCampaignAccount: ${buf.length} bytes, a Campaign is ${REWARD_CAMPAIGN_LEN}`);
  if (!buf.subarray(0, 8).equals(REWARD_CAMPAIGN_DISCRIMINATOR)) throw new Error("decodeRewardCampaignAccount: not a Campaign (discriminator)");
  const metadataLen = buf.readUInt32LE(185);
  if (metadataLen > REWARD_CAMPAIGN_METADATA_MAX) throw new Error(`decodeRewardCampaignAccount: metadata of ${metadataLen} bytes`);
  const metadata = new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(189, 189 + metadataLen));
  const mint = key(buf, 73);
  return {
    admin: key(buf, 8),
    id: Buffer.from(buf.subarray(40, 72)),
    bump: buf.readUInt8(72),
    mint,
    native: mint.equals(PublicKey.default),
    tokenProgram: key(buf, 105),
    backendSigner: key(buf, 137),
    signerEpoch: buf.readBigUInt64LE(169),
    liquidity: buf.readBigUInt64LE(177),
    metadata,
  };
}

/** Receipt — 16 bytes: discriminator · claimed u64 (lifetime net received). */
export interface RewardReceiptAccount {
  claimed: bigint;
}

export function decodeRewardReceiptAccount(data: Buffer | Uint8Array): RewardReceiptAccount {
  const buf = Buffer.from(data);
  if (buf.length !== REWARD_RECEIPT_LEN) throw new Error(`decodeRewardReceiptAccount: ${buf.length} bytes, a Receipt is ${REWARD_RECEIPT_LEN}`);
  if (!buf.subarray(0, 8).equals(REWARD_RECEIPT_DISCRIMINATOR)) throw new Error("decodeRewardReceiptAccount: not a Receipt (discriminator)");
  return { claimed: buf.readBigUInt64LE(8) };
}

/** RewardPaid (emit!, logs only), one per successful claim. */
export interface RewardPaidEvent {
  campaign: PublicKey;
  user: PublicKey;
  /** The voucher total of the claim. */
  authorizedTotal: bigint;
  /** What left the vault (with the Token-2022 fee). */
  grossDebit: bigint;
  /** What the wallet received. */
  netCredit: bigint;
  /** Receipt.claimed after the claim. */
  claimed: bigint;
}

/** Decode the 104 bytes after `Program data:`; null for anything else. */
export function decodeRewardPaidEvent(data: Buffer | Uint8Array): RewardPaidEvent | null {
  const buf = Buffer.from(data);
  if (buf.length !== REWARD_PAID_LEN || !buf.subarray(0, 8).equals(REWARD_PAID_DISCRIMINATOR)) return null;
  return {
    campaign: key(buf, 8),
    user: key(buf, 40),
    authorizedTotal: buf.readBigUInt64LE(72),
    grossDebit: buf.readBigUInt64LE(80),
    netCredit: buf.readBigUInt64LE(88),
    claimed: buf.readBigUInt64LE(96),
  };
}

const INVOKE_RE = /^Program (\w+) invoke \[(\d+)\]$/;
const FINISH_RE = /^Program (\w+) (?:success|failed)/;
const DATA_PREFIX = "Program data: ";

/**
 * RewardPaid events of a transaction's logs, in order. Only `Program data:`
 * lines printed while `programId` is on top of the invoke stack count (a
 * program that CPIs into the claim, or prints the same bytes, does not), and
 * nothing after `Log truncated`. Read logs of successful transactions only.
 */
export function parseRewardPaidEvents(logs: readonly string[], programId: PublicKey = COFFER_REWARDS_PROGRAM_ID): RewardPaidEvent[] {
  const program = programId.toBase58();
  const stack: string[] = [];
  const out: RewardPaidEvent[] = [];
  for (const line of logs) {
    if (line === "Log truncated") break;
    const invoke = INVOKE_RE.exec(line);
    if (invoke) {
      const depth = Number(invoke[2]);
      if (depth <= stack.length) stack.length = depth - 1;
      stack.push(invoke[1]);
      continue;
    }
    const finish = FINISH_RE.exec(line);
    if (finish) {
      if (stack.length && stack[stack.length - 1] === finish[1]) stack.pop();
      continue;
    }
    if (!line.startsWith(DATA_PREFIX) || stack[stack.length - 1] !== program) continue;
    const event = decodeRewardPaidEvent(Buffer.from(line.slice(DATA_PREFIX.length), "base64"));
    if (event) out.push(event);
  }
  return out;
}
