/**
 * `deposit_single_token_planned` instruction builder (browser-safe, no RPC).
 *
 * Account layout (`DepositSingleTokenDirect` + remaining accounts):
 *   [pool w, lp_mint w, user_lp w, user s, coffer_pool_program, lp_token_program]
 *   + [mint_i, user_token_i w, vault_i w] × N
 *   + exactly 0 or 1 token program (the pool program that is NOT the LP program)
 *   + hook/memo extras (never signers, never a core account)
 */
import { sha256 } from "@noble/hashes/sha256";
import { AccountMeta, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { CofferConfig } from "../../config";
import { PoolInfo } from "../../types/pool";
import { deriveAta } from "../../utils/pda";

/** Anchor discriminator of `deposit_single_token_planned`, pinned against the v6 IDL. */
export const PLANNED_ZAP_DISCRIMINATOR_HEX = "fc0a53ee02ee4b1a";
const DISCRIMINATOR = Buffer.from(sha256(new TextEncoder().encode("global:deposit_single_token_planned"))).subarray(0, 8);
if (DISCRIMINATOR.toString("hex") !== PLANNED_ZAP_DISCRIMINATOR_HEX) {
  throw new Error("deposit_single_token_planned discriminator drifted from the pinned v6 value");
}

/** Suggested compute-unit limit for a planned zap (N=10 with surge fees stays well below). */
export const PLANNED_ZAP_CU_LIMIT = 1_400_000;
export const PLANNED_ZAP_MIN_TOKENS = 2;
export const PLANNED_ZAP_MAX_TOKENS = 10;

const U64_MAX = (1n << 64n) - 1n;
function u64(value: bigint, label: string): Buffer {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) throw new Error(`${label}: expected a u64 bigint`);
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}
function i64(value: bigint, label: string): Buffer {
  if (typeof value !== "bigint" || value < -(1n << 63n) || value >= 1n << 63n) throw new Error(`${label}: expected an i64 bigint`);
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(value);
  return out;
}

/** `plan::AllocationPlan` (Borsh: `Vec<u64>`, `[u8; 32]`, `i64`, `u64`). */
export interface AllocationPlan {
  allocations: bigint[];
  expectedState: Uint8Array;
  quotedAt: bigint;
  validUntilSlot: bigint;
}

/** Borsh body of the plan (after `amount_in`, `token_in_index`, `minimum_lp_amount`). */
export function encodeAllocationPlan(plan: AllocationPlan): Buffer {
  if (plan.expectedState.length !== 32) throw new Error("AllocationPlan.expectedState must be 32 bytes");
  const count = Buffer.alloc(4);
  count.writeUInt32LE(plan.allocations.length);
  return Buffer.concat([
    count,
    ...plan.allocations.map((a, i) => u64(a, `allocations[${i}]`)),
    Buffer.from(plan.expectedState),
    i64(plan.quotedAt, "quotedAt"),
    u64(plan.validUntilSlot, "validUntilSlot"),
  ]);
}

export interface PlannedZapAccounts {
  pool: PublicKey;
  lpMint: PublicKey;
  userLpAccount: PublicKey;
  user: PublicKey;
  cofferPoolProgram: PublicKey;
  lpTokenProgram: PublicKey;
  mints: PublicKey[];
  userTokenAccounts: PublicKey[];
  vaults: PublicKey[];
  tokenPrograms: PublicKey[];
  /** Resolved hook/memo union for every transfer of the route; no signers, no core accounts. */
  extraAccounts?: AccountMeta[];
}

/** Derive the account set for `user` from a synced pool (ATAs for every slot and the LP mint). */
export function plannedZapAccounts(cfg: CofferConfig, pool: PoolInfo, user: PublicKey, extraAccounts?: AccountMeta[]): PlannedZapAccounts {
  const lpTokenProgram = pool.lpTokenProgram ?? TOKEN_PROGRAM_ID;
  return {
    pool: pool.address,
    lpMint: pool.lpMint,
    userLpAccount: deriveAta(user, pool.lpMint, lpTokenProgram),
    user,
    cofferPoolProgram: cfg.programs.cofferPool,
    lpTokenProgram,
    mints: pool.tokens.map((t) => t.mint),
    userTokenAccounts: pool.tokens.map((t) => deriveAta(user, t.mint, t.tokenProgram)),
    vaults: pool.tokens.map((t) => t.vault),
    tokenPrograms: pool.tokens.map((t) => t.tokenProgram),
    extraAccounts,
  };
}

export interface PlannedZapArgs {
  amountIn: bigint;
  tokenInIndex: number;
  minimumLp: bigint;
  plan: AllocationPlan;
}

export function buildPlannedZapIx(cfg: CofferConfig, accounts: PlannedZapAccounts, args: PlannedZapArgs): TransactionInstruction {
  const n = accounts.mints.length;
  if (n < PLANNED_ZAP_MIN_TOKENS || n > PLANNED_ZAP_MAX_TOKENS ||
      [accounts.userTokenAccounts, accounts.vaults, accounts.tokenPrograms, args.plan.allocations].some((a) => a.length !== n)) {
    throw new Error("deposit_single_token_planned: requires 2..10 consistently ordered token slots");
  }
  if (!Number.isInteger(args.tokenInIndex) || args.tokenInIndex < 0 || args.tokenInIndex >= n) throw new Error("deposit_single_token_planned: invalid tokenInIndex");
  if (args.amountIn <= 0n) throw new Error("deposit_single_token_planned: amountIn must be positive");
  if (args.minimumLp <= 0n) throw new Error("deposit_single_token_planned: minimumLp must be positive (the only slippage guard on the route)");
  if (args.plan.expectedState.length !== 32) throw new Error("deposit_single_token_planned: expectedState must be 32 bytes");
  if (args.plan.allocations.reduce((sum, v) => sum + v, 0n) !== args.amountIn) throw new Error("deposit_single_token_planned: allocations must sum to amountIn");
  const programAllowed = (p: PublicKey) => p.equals(TOKEN_PROGRAM_ID) || p.equals(TOKEN_2022_PROGRAM_ID);
  if (![accounts.lpTokenProgram, ...accounts.tokenPrograms].every(programAllowed)) throw new Error("deposit_single_token_planned: unsupported token program");
  if (new Set(accounts.mints.map((k) => k.toBase58())).size !== n) throw new Error("deposit_single_token_planned: duplicate mint");
  if (accounts.mints.some((m) => m.equals(accounts.lpMint))) throw new Error("deposit_single_token_planned: a pool mint cannot be the LP mint");

  const meta = (pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta => ({ pubkey, isWritable, isSigner });
  const keys: AccountMeta[] = [
    meta(accounts.pool, true), meta(accounts.lpMint, true), meta(accounts.userLpAccount, true),
    meta(accounts.user, false, true), meta(accounts.cofferPoolProgram), meta(accounts.lpTokenProgram),
  ];
  for (let i = 0; i < n; i++) keys.push(meta(accounts.mints[i]), meta(accounts.userTokenAccounts[i], true), meta(accounts.vaults[i], true));
  // Exactly the token programs the pool uses that differ from the LP program: at most one.
  const others = [...new Map(accounts.tokenPrograms.filter((p) => !p.equals(accounts.lpTokenProgram)).map((p) => [p.toBase58(), p])).values()];
  if (others.length > 1) throw new Error("deposit_single_token_planned: more than one non-LP token program");
  for (const program of others) keys.push(meta(program));
  const forbidden = new Set([accounts.user, accounts.pool, accounts.lpMint, accounts.userLpAccount].map((k) => k.toBase58()));
  const seen = new Set<string>();
  for (const extra of accounts.extraAccounts ?? []) {
    if (extra.isSigner || forbidden.has(extra.pubkey.toBase58())) throw new Error("deposit_single_token_planned: the extension tail cannot carry signers or core accounts");
    if (seen.has(extra.pubkey.toBase58())) throw new Error(`deposit_single_token_planned: duplicate extra account ${extra.pubkey.toBase58()}`);
    seen.add(extra.pubkey.toBase58());
    keys.push(meta(extra.pubkey, extra.isWritable));
  }
  const data = Buffer.concat([
    DISCRIMINATOR,
    u64(args.amountIn, "amountIn"), Buffer.from([args.tokenInIndex]), u64(args.minimumLp, "minimumLp"),
    encodeAllocationPlan(args.plan),
  ]);
  return new TransactionInstruction({ programId: cfg.programs.singleTokenLiquidity, keys, data });
}
