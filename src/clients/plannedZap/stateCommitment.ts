/**
 * `plan::state_commitment` — the hash the program recomputes from the live
 * pool, LP mint and token-mint accounts and compares to the signed plan's
 * `expected_state`. The pool account is committed whole; of each mint only
 * the fields a quote depends on (`mintFingerprint`), so counters anyone can
 * move without touching the pool (an underlying mint's supply, withheld
 * transfer fees) cannot stale a signed plan. Any committed byte, a key, an
 * owner or the epoch changing between quote and execution makes the plan
 * `AllocationPlanStale`.
 */
import { sha256 } from "@noble/hashes/sha256";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

export const PLAN_DOMAIN = "coffer-stld-v6-plan-v2";
/** `MAX_PLAN_AGE_SECONDS`: the program accepts `0 ≤ clock − quoted_at ≤ 90`. */
export const MAX_PLAN_AGE_SECONDS = 90;
/** Upper bound the SDK enforces on `valid_until_slot − slot` (≈ 60 s). */
export const MAX_VALID_FOR_SLOTS = 150;
/** Extension ids committed per mint; a longer TLV list is cut here (`MAX_FINGERPRINT_EXTENSIONS`). */
export const MAX_FINGERPRINT_EXTENSIONS = 32;
/**
 * Known-answer vector shared with `plan.rs` (`cross_language_vectors`): pool
 * key 1 / owner 2 / data 3×64, plain SPL LP mint key 4 (9 decimals, supply
 * 500), one plain SPL token mint key 7 (6 decimals, supply 1_000_000), epoch 17.
 */
export const V6_PLAN_HASH_VECTOR = "029095d4f1a6c590422134c478a5c844024bddcf592812d0d673e84a2376d839";
/**
 * Second `cross_language_vectors` vector: Token-2022 LP mint with a fee
 * schedule; token mints: fee + hook + pausable, plain SPL, and a closed mint
 * of a sidelined slot; epoch 900.
 */
export const V6_PLAN_HASH_VECTOR_RICH = "6062556f7ad11e0878d8014739a6c672104c9245940e7e8086078611ec17d035";

/** Account bytes exactly as fetched; the quote and the commitment use the same snapshot. */
export interface SnapshotAccount {
  key: PublicKey;
  owner: PublicKey;
  data: Uint8Array;
}

const MINT_BASE_LEN = 82;
const MINT_SUPPLY = 36;
const MINT_DECIMALS = 44;
const MINT_IS_INITIALIZED = 45;
/** Token-2022 account-type byte and its mint value; TLV entries follow it. */
const ACCOUNT_TYPE_OFFSET = 165;
const ACCOUNT_TYPE_MINT = 1;
const TLV_HEADER_LEN = 4;
const EXT_TRANSFER_FEE_CONFIG = 1;
const EXT_TRANSFER_HOOK = 14;
const EXT_PAUSABLE = 26;
/**
 * Committed slice `[start, end)` of each extension body, in hash order: both
 * `TransferFeeConfig` schedules (after two authorities and `withheld_amount`),
 * `TransferHook.program_id` (after the authority), `PausableConfig.paused`.
 */
const COMMITTED_FIELDS: ReadonlyArray<readonly [id: number, start: number, end: number]> = [
  [EXT_TRANSFER_FEE_CONFIG, 72, 108],
  [EXT_TRANSFER_HOOK, 32, 64],
  [EXT_PAUSABLE, 32, 33],
];
const KIND_NOT_A_MINT = 0;
const KIND_MINT = 1;

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

/**
 * `MintFingerprint`: the mint fields a signed plan depends on, byte-for-byte
 * as `plan.rs` hashes them. Total over every byte string, so a sidelined
 * slot's closed or unsupported mint does not block the zap.
 *
 * Committed, in order: `[kind, decimals, extension count]`; every Token-2022
 * extension id (u16 LE, TLV order, at most {@link MAX_FINGERPRINT_EXTENSIONS});
 * both `TransferFeeConfig` schedules; `TransferHook.program_id`;
 * `PausableConfig.paused`; and, with `withSupply` (the LP mint only), the
 * `supply`. A repeated extension id keeps its first body; a body shorter
 * than its committed slice commits nothing; a zero id or a truncated entry
 * ends the walk. Anything that is not an initialized SPL Token / Token-2022
 * mint hashes as `[0, 0, 0]`. Left out: an underlying mint's supply,
 * withheld fees, authorities, metadata and confidential-transfer state.
 */
export function mintFingerprint(owner: PublicKey, data: Uint8Array, withSupply = false): Uint8Array {
  const token2022 = owner.equals(TOKEN_2022_PROGRAM_ID);
  if (!(token2022 || owner.equals(TOKEN_PROGRAM_ID)) || data.length < MINT_BASE_LEN || data[MINT_IS_INITIALIZED] !== 1) {
    return Uint8Array.from([KIND_NOT_A_MINT, 0, 0]);
  }
  const ids: number[] = [];
  const fields = new Map<number, Uint8Array>();
  if (token2022 && data.length > ACCOUNT_TYPE_OFFSET && data[ACCOUNT_TYPE_OFFSET] === ACCOUNT_TYPE_MINT) {
    let offset = ACCOUNT_TYPE_OFFSET + 1;
    while (ids.length < MAX_FINGERPRINT_EXTENSIONS * 2 && data.length - offset >= TLV_HEADER_LEN) {
      const id = data[offset] | (data[offset + 1] << 8);
      const bodyLength = data[offset + 2] | (data[offset + 3] << 8);
      const bodyStart = offset + TLV_HEADER_LEN;
      if (id === 0 || data.length - bodyStart < bodyLength) break;
      ids.push(data[offset], data[offset + 1]);
      offset = bodyStart + bodyLength;
      const field = COMMITTED_FIELDS.find(([extension]) => extension === id);
      if (field && !fields.has(id) && bodyLength >= field[2]) fields.set(id, data.subarray(bodyStart + field[1], bodyStart + field[2]));
    }
  }
  return Buffer.concat([
    Buffer.from([KIND_MINT, data[MINT_DECIMALS], ids.length / 2]),
    Buffer.from(ids),
    ...COMMITTED_FIELDS.map(([extension]) => Buffer.from(fields.get(extension) ?? [])),
    Buffer.from(withSupply ? data.subarray(MINT_SUPPLY, MINT_SUPPLY + 8) : []),
  ]);
}

/**
 * sha256 chain: `H(domain ‖ epoch)`, then `H(prev ‖ key ‖ owner ‖ data)` for
 * the pool, then `H(prev ‖ key ‖ owner ‖ fingerprint)` for the LP mint (with
 * supply) and every token mint.
 */
export function stateCommitment(pool: SnapshotAccount, lpMint: SnapshotAccount, mints: SnapshotAccount[], epoch: bigint): Uint8Array {
  let digest = hash(textBytes(PLAN_DOMAIN), u64le(epoch));
  digest = hash(digest, pool.key.toBytes(), pool.owner.toBytes(), pool.data);
  digest = hash(digest, lpMint.key.toBytes(), lpMint.owner.toBytes(), mintFingerprint(lpMint.owner, lpMint.data, true));
  for (const mint of mints) {
    digest = hash(digest, mint.key.toBytes(), mint.owner.toBytes(), mintFingerprint(mint.owner, mint.data));
  }
  return digest;
}
