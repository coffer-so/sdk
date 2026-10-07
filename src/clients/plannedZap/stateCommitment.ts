/**
 * `plan::state_commitment` — the hash the program recomputes from the live
 * pool, BPT mint and token-mint accounts and compares to the signed plan's
 * `expected_state`. Any byte of those accounts, their keys/owners or the
 * epoch changing between quote and execution makes the plan
 * `AllocationPlanStale`.
 */
import { sha256 } from "@noble/hashes/sha256";
import type { PublicKey } from "@solana/web3.js";

export const PLAN_DOMAIN = "coffer-stld-v6-plan-v1";
/** `MAX_PLAN_AGE_SECONDS`: the program accepts `0 ≤ clock − quoted_at ≤ 90`. */
export const MAX_PLAN_AGE_SECONDS = 90;
/** Upper bound the SDK enforces on `valid_until_slot − slot` (≈ 60 s). */
export const MAX_VALID_FOR_SLOTS = 150;
/** Known-answer vector from `plan.rs` unit tests (pool key 1/owner 2/data 3×64, …, epoch 17). */
export const V6_PLAN_HASH_VECTOR = "bcd8bfff973d3e697596905f000e29d8cd62589995dec9441ce90b80eba7f7a0";

/** Account bytes exactly as fetched; the quote and the commitment use the same snapshot. */
export interface SnapshotAccount {
  key: PublicKey;
  owner: PublicKey;
  data: Uint8Array;
}

const textBytes = (text: string): Uint8Array => new TextEncoder().encode(text);
function u64le(value: bigint): Uint8Array {
  if (value < 0n || value > (1n << 64n) - 1n) throw new Error("stateCommitment: epoch must fit u64");
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}
function hash(...parts: Uint8Array[]): Uint8Array {
  return sha256(Buffer.concat(parts.map((part) => Buffer.from(part))));
}

/** sha256 chain: `H(domain ‖ epoch)`, then `H(prev ‖ key ‖ owner ‖ data)` for pool, BPT mint, every token mint. */
export function stateCommitment(pool: SnapshotAccount, bptMint: SnapshotAccount, mints: SnapshotAccount[], epoch: bigint): Uint8Array {
  let digest = hash(textBytes(PLAN_DOMAIN), u64le(epoch));
  for (const account of [pool, bptMint, ...mints]) {
    digest = hash(digest, account.key.toBytes(), account.owner.toBytes(), account.data);
  }
  return digest;
}
