/**
 * poolIdentity — verify that a freshly created pool is EXACTLY the one the
 * creator signed for (I-08): owner, PDA, config, pool_id, admin, mint
 * order, token programs, weights, fee and (optionally) the launch state.
 * Port of `contracts/scripts/cli/pool-identity.ts`. No side effects.
 */
import { randomBytes } from "crypto";
import { PublicKey, type AccountInfo, type Commitment, type Connection } from "@solana/web3.js";
import { POOL_SEED } from "../config";
import { POOL_LAYOUT, POOL_LEN_V5, POOL_LEN_V61, TOKEN_SLOT_LAYOUT } from "../parsers/layout";
import type { ExpectedPoolIdentity, VerifiedPoolIdentity } from "../types/tx-v61";

/** `CofferPool` account discriminator (pinned to the legacy struct-name hash, see idl/abi-pins.json). */
export const POOL_ACCOUNT_DISCRIMINATOR = Buffer.from("89d22a16d19c2b4e", "hex");

export function randomPoolIdU64(): bigint {
  return randomBytes(8).readBigUInt64LE();
}

/** The subset of `Connection` `verifyCreatedPool` needs (lets tests stub it). */
export interface PoolAccountReader {
  getAccountInfo(address: PublicKey, commitment?: Commitment): Promise<AccountInfo<Buffer> | null>;
}

/**
 * Check owner, PDA, mint order, programs, weights and fee. Both the v4/v5
 * (1683) and the v6.1 (2304) layouts share the identity prefix, so both
 * are accepted. The deprecated slot at 1651 is deliberately NOT part of the
 * identity (T19). Throws `Pool identity mismatch: <field>` on the first
 * divergence.
 */
export function validatePoolIdentity(
  address: PublicKey,
  info: Pick<AccountInfo<Buffer>, "owner" | "data">,
  expected: ExpectedPoolIdentity,
): VerifiedPoolIdentity {
  const n = expected.mints.length;
  if (n < 2 || n > 10 || expected.tokenPrograms.length !== n || expected.weights.length !== n) {
    throw new Error("Invalid expected pool identity lengths");
  }
  if (expected.poolId < 0n || expected.poolId > 0xffff_ffff_ffff_ffffn) throw new Error("pool_id must be u64");
  const seed = Buffer.alloc(8);
  seed.writeBigUInt64LE(expected.poolId);
  const [pda] = PublicKey.findProgramAddressSync([POOL_SEED, expected.config.toBuffer(), seed], expected.programId);
  const fail = (field: string): never => {
    throw new Error(`Pool identity mismatch: ${field}; refusing to seed or publish ${address.toBase58()}`);
  };
  if (!pda.equals(address)) fail("PDA");
  if (!info.owner.equals(expected.programId)) fail("program owner");
  if (info.data.length !== POOL_LEN_V5 && info.data.length !== POOL_LEN_V61) fail("account layout");
  const data = info.data;
  if (!data.subarray(0, 8).equals(POOL_ACCOUNT_DISCRIMINATOR)) fail("discriminator");
  if (data[POOL_LAYOUT.TOKEN_COUNT.offset] !== n) fail("token count");
  const key = (offset: number) => new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  const slot = (i: number) => POOL_LAYOUT.TOKENS.offset + i * TOKEN_SLOT_LAYOUT.TOTAL;
  const actual: VerifiedPoolIdentity = {
    config: key(POOL_LAYOUT.CONFIG.offset),
    poolId: data.readBigUInt64LE(POOL_LAYOUT.POOL_ID.offset).toString(),
    poolAdmin: key(POOL_LAYOUT.POOL_ADMIN.offset),
    tokenCount: data[POOL_LAYOUT.TOKEN_COUNT.offset],
    swapFeeRate: data.readUInt32LE(POOL_LAYOUT.SWAP_FEE_RATE.offset),
    poolEnabled: data[POOL_LAYOUT.POOL_ENABLED.offset] === 1,
    swapsEnabled: data[POOL_LAYOUT.SWAPS_ENABLED.offset] === 1,
    tokens: Array.from({ length: n }, (_, i) => ({
      mint: key(slot(i) + TOKEN_SLOT_LAYOUT.MINT.offset),
      tokenProgram: key(slot(i) + TOKEN_SLOT_LAYOUT.TOKEN_PROGRAM.offset),
      normalizedWeight: data.readBigUInt64LE(slot(i) + TOKEN_SLOT_LAYOUT.NORMALIZED_WEIGHT.offset),
    })),
  };
  if (actual.config !== expected.config.toBase58()) fail("config");
  if (actual.poolId !== expected.poolId.toString()) fail("pool_id");
  if (actual.poolAdmin !== expected.poolAdmin.toBase58()) fail("pool_admin");
  if (actual.tokenCount !== n) fail("token count");
  if (actual.swapFeeRate !== expected.swapFeeRate) fail("swap fee");
  if (expected.swapsEnabled !== undefined && actual.swapsEnabled !== expected.swapsEnabled) fail("swaps_enabled (launch state)");
  for (let i = 0; i < n; i++) {
    if (actual.tokens[i].mint !== expected.mints[i].toBase58()) fail(`mint[${i}]`);
    if (actual.tokens[i].tokenProgram !== expected.tokenPrograms[i].toBase58()) fail(`token program[${i}]`);
    if (actual.tokens[i].normalizedWeight !== expected.weights[i]) fail(`weight[${i}]`);
  }
  return actual;
}

export async function verifyCreatedPool(
  connection: PoolAccountReader | Connection,
  address: PublicKey,
  expected: ExpectedPoolIdentity,
): Promise<VerifiedPoolIdentity> {
  const info = await connection.getAccountInfo(address, "confirmed");
  if (!info) throw new Error(`Pool missing after confirmation: ${address.toBase58()}`);
  return validatePoolIdentity(address, info, expected);
}
