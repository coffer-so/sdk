import { PublicKey } from "@solana/web3.js";
import {
  COFFER_REWARDS_PROGRAM_ID,
  REWARD_CAMPAIGN_CLOSED_DISCRIMINATOR,
  REWARD_CAMPAIGN_CLOSED_LEN,
  REWARD_CAMPAIGN_DISCRIMINATOR,
  REWARD_CAMPAIGN_LEN,
  REWARD_CAMPAIGN_METADATA_MAX,
  REWARD_CLOSED_CAMPAIGN_DISCRIMINATOR,
  REWARD_CLOSED_CAMPAIGN_LEN,
  REWARD_PAID_DISCRIMINATOR,
  REWARD_PAID_LEN,
  REWARD_RECEIPT_DISCRIMINATOR,
  REWARD_RECEIPT_LEN,
} from "./constants";

/**
 * Campaign — 518 bytes (rc8+):
 *   0 discriminator · 8 version · 9 bump · 10 admin · 42 id[32] · 74 domain[32]
 *   · 106 mint (default pubkey = SOL) · 138 token_program · 170 backend_signer
 *   · 202 signer_epoch u64 · 210 liquidity u64 · 218 payout_limit u64
 *   · 226 window_seconds u64 · 234 window_start i64 · 242 window_paid u64
 *   · 250 reserved[64] · 314 metadata (u32 length + at most 200 bytes of UTF-8)
 */
export interface RewardCampaignAccount {
  version: number;
  bump: number;
  /** The creator; the only key that can withdraw, rotate, set the payout limit, return surplus and close. Anyone can deposit. */
  admin: PublicKey;
  id: Buffer;
  /** Newest slot hash at creation: signed into every voucher, so a voucher fits this campaign instance on this cluster only. */
  domain: Buffer;
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
  /** Most gross units all claims together may debit per window; 0 = no limit. */
  payoutLimit: bigint;
  windowSeconds: bigint;
  /** Unix seconds the current window started (set by the first claim after the previous one elapsed). */
  windowStart: bigint;
  /** Gross units paid in the current window. */
  windowPaid: bigint;
  metadata: string;
}

const key = (buf: Buffer, offset: number) => new PublicKey(buf.subarray(offset, offset + 32));

/** Decode a Campaign account; throws for anything that is not exactly one (a closed campaign included). Check the owner separately. */
export function decodeRewardCampaignAccount(data: Buffer | Uint8Array): RewardCampaignAccount {
  const buf = Buffer.from(data);
  if (isRewardClosedCampaign(buf)) throw new Error("decodeRewardCampaignAccount: the campaign is closed (ClosedCampaign marker)");
  if (buf.length !== REWARD_CAMPAIGN_LEN) throw new Error(`decodeRewardCampaignAccount: ${buf.length} bytes, a Campaign is ${REWARD_CAMPAIGN_LEN}`);
  if (!buf.subarray(0, 8).equals(REWARD_CAMPAIGN_DISCRIMINATOR)) throw new Error("decodeRewardCampaignAccount: not a Campaign (discriminator)");
  const metadataLen = buf.readUInt32LE(314);
  if (metadataLen > REWARD_CAMPAIGN_METADATA_MAX) throw new Error(`decodeRewardCampaignAccount: metadata of ${metadataLen} bytes`);
  const metadata = new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(318, 318 + metadataLen));
  const mint = key(buf, 106);
  return {
    version: buf.readUInt8(8),
    bump: buf.readUInt8(9),
    admin: key(buf, 10),
    id: Buffer.from(buf.subarray(42, 74)),
    domain: Buffer.from(buf.subarray(74, 106)),
    mint,
    native: mint.equals(PublicKey.default),
    tokenProgram: key(buf, 138),
    backendSigner: key(buf, 170),
    signerEpoch: buf.readBigUInt64LE(202),
    liquidity: buf.readBigUInt64LE(210),
    payoutLimit: buf.readBigUInt64LE(218),
    windowSeconds: buf.readBigUInt64LE(226),
    windowStart: buf.readBigInt64LE(234),
    windowPaid: buf.readBigUInt64LE(242),
    metadata,
  };
}

/** The 9-byte `ClosedCampaign` marker a closed campaign leaves for good (its address can never be initialized again). */
export function isRewardClosedCampaign(data: Buffer | Uint8Array): boolean {
  const buf = Buffer.from(data);
  return buf.length === REWARD_CLOSED_CAMPAIGN_LEN && buf.subarray(0, 8).equals(REWARD_CLOSED_CAMPAIGN_DISCRIMINATOR);
}

/**
 * Gross units a claim may debit at `now` (Unix seconds): liquidity clipped to the
 * payout allowance left in the current window (`Campaign::claimable`). 0 means
 * the claim fails with 6010 PayoutLimitReached until the window ends.
 */
export function rewardCampaignClaimable(campaign: Pick<RewardCampaignAccount, "liquidity" | "payoutLimit" | "windowSeconds" | "windowStart" | "windowPaid">, now: bigint | number): bigint {
  if (campaign.payoutLimit === 0n) return campaign.liquidity;
  const allowance = campaign.payoutLimit - rewardWindowPaidAt(campaign, now);
  if (allowance <= 0n) return 0n;
  return campaign.liquidity < allowance ? campaign.liquidity : allowance;
}

/** Gross paid in the window that is current at `now` (0 once the stored window has elapsed). */
export function rewardWindowPaidAt(campaign: Pick<RewardCampaignAccount, "windowSeconds" | "windowStart" | "windowPaid">, now: bigint | number): bigint {
  const age = BigInt(now) - campaign.windowStart;
  return age >= 0n && age >= campaign.windowSeconds ? 0n : campaign.windowPaid;
}

/** When the current window's allowance resets (Unix seconds); null without a limit or once it has elapsed. */
export function rewardWindowResetsAt(campaign: Pick<RewardCampaignAccount, "payoutLimit" | "windowSeconds" | "windowStart" | "windowPaid">, now: bigint | number): bigint | null {
  if (campaign.payoutLimit === 0n || rewardWindowPaidAt(campaign, now) === 0n) return null;
  return campaign.windowStart + campaign.windowSeconds;
}

/** Receipt — 32 bytes: discriminator · version u8 · claimed u64 (lifetime net received) · 15 reserved. */
export interface RewardReceiptAccount {
  claimed: bigint;
}

export function decodeRewardReceiptAccount(data: Buffer | Uint8Array): RewardReceiptAccount {
  const buf = Buffer.from(data);
  if (buf.length !== REWARD_RECEIPT_LEN) throw new Error(`decodeRewardReceiptAccount: ${buf.length} bytes, a Receipt is ${REWARD_RECEIPT_LEN}`);
  if (!buf.subarray(0, 8).equals(REWARD_RECEIPT_DISCRIMINATOR)) throw new Error("decodeRewardReceiptAccount: not a Receipt (discriminator)");
  return { claimed: buf.readBigUInt64LE(9) };
}

/** CampaignClosed (emit!, logs only): the admin closed the campaign for good. */
export interface RewardCampaignClosedEvent {
  campaign: PublicKey;
  admin: PublicKey;
}

/** Decode the 72 bytes after `Program data:`; null for anything else. */
export function decodeRewardCampaignClosedEvent(data: Buffer | Uint8Array): RewardCampaignClosedEvent | null {
  const buf = Buffer.from(data);
  if (buf.length !== REWARD_CAMPAIGN_CLOSED_LEN || !buf.subarray(0, 8).equals(REWARD_CAMPAIGN_CLOSED_DISCRIMINATOR)) return null;
  return { campaign: key(buf, 8), admin: key(buf, 40) };
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
