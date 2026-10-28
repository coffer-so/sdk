/**
 * hooks — v6.1 (T9) native pool hooks, client side: the `HookConfig`
 * encoder, the HOOK_CALLER PDA, the account slice every hooked operation
 * carries, and the CU heuristic.
 *
 * ## Account slice
 *
 * While a pool's hook is ACTIVE (`hook_program != default && !hook_disabled`,
 * i.e. `PoolInfo.hook.active`) the remaining-accounts tail of `swap`,
 * `add_liquidity`, `seed_liquidity` and `remove_liquidity` BEGINS with
 * exactly `hook.accountsLen` accounts:
 *
 * ```text
 *   [hook_program (ro), HOOK_CALLER (ro), extra_0, extra_1, ..]   then the Token-2022 transfer-hook / memo tail
 * ```
 *
 * At `initialize_pool` the slice comes AFTER the mints. While the hook is
 * disabled the slice is ABSENT (the tail is the Token-2022 tail only);
 * `remove_liquidity_bypass_hooks` never takes a slice; `fund_sidelined_token`
 * runs no hook.
 *
 * ## Where the extras come from
 *
 * v6.1 does NOT implement an on-chain `ExtraAccountMetaList`-style PDA for
 * pool hooks (unlike Token-2022 transfer hooks). Every hook program publishes
 * its own resolver — a pure function `(ctx) => AccountMeta[]` implementing
 * the {@link HookExtrasResolver} interface — and the integrator picks it by
 * `PoolInfo.hook.program`. `fixtureHookExtras` is the resolver for the
 * reference / adversarial fixture program (`[cfg(pool) writable, kyc(user)?]`).
 * Extras are never signers; writable only when owned by the hook program.
 */

import { PublicKey, type AccountMeta } from "@solana/web3.js";
import {
  HOOK_CALLER_SEED,
  HOOK_FLAGS,
  HOOK_MAX_ACCOUNTS,
  HOOK_MAX_CU_CAP,
  HOOK_MIN_ACCOUNTS,
  HOOK_MIN_CU,
  MAX_SWAP_FEE_RATE,
  type CofferConfig,
} from "../config";
import { NETWORK_PROGRAMS } from "../config/networks";
import type { PoolHookInfo, PoolInfo } from "../types/pool";
import type { HookConfigArgs, HookExtrasContext, HookExtrasResolver, HookOp } from "../types/tx-v61";

/** Borsh `HookConfig` size: pubkey + u16 + u32 + u32 + u32 + u8. */
export const HOOK_CONFIG_LEN = 32 + 2 + 4 + 4 + 4 + 1; // 47

/** The `[b"coffer_hook_caller"]` PDA under `cofferPoolProgramId` — the only signer of a hook CPI. */
export function hookCallerPda(cofferPoolProgramId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([HOOK_CALLER_SEED], cofferPoolProgramId);
}

/** HOOK_CALLER of the historical / production coffer-pool id (`E92oov7r…`, bump 255). */
export const HOOK_CALLER_LOCALNET = hookCallerPda(NETWORK_PROGRAMS.localnet.cofferPool)[0];

export const readonlyMeta = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
export const writableMeta = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });

// ─── HookConfig ──────────────────────────────────────────────────────────────

/** Mirror of `hooks::validate_hook_config` minus the executable check (needs chain). Throws on the first violation. */
export function validateHookConfig(cfg: HookConfigArgs, cofferPoolProgramId?: PublicKey): HookConfigArgs {
  if (!cfg || !(cfg.program instanceof PublicKey)) throw new Error("hookConfig.program must be a PublicKey");
  if (cfg.program.equals(PublicKey.default)) throw new Error("hookConfig.program cannot be the default pubkey (HookProgramInvalid)");
  if (cofferPoolProgramId && cfg.program.equals(cofferPoolProgramId)) throw new Error("hookConfig.program cannot be coffer-pool itself (HookProgramInvalid)");
  for (const [name, value, bits] of [["flags", cfg.flags, 16], ["feeMin", cfg.feeMin, 32], ["feeMax", cfg.feeMax, 32], ["maxCu", cfg.maxCu, 32], ["accountsLen", cfg.accountsLen, 8]] as const) {
    if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** bits) throw new Error(`hookConfig.${name} must be an unsigned ${bits}-bit integer`);
  }
  if ((cfg.flags & ~HOOK_FLAGS.VALID_MASK) !== 0) throw new Error("hookConfig.flags has reserved bits set (HookInvalidConfig)");
  if ((cfg.flags & HOOK_FLAGS.ALL_CALLBACKS) === 0) throw new Error("hookConfig.flags must enable at least one callback (HookInvalidConfig)");
  const dynamic = (cfg.flags & HOOK_FLAGS.DYNAMIC_FEE) !== 0;
  if (dynamic && (cfg.flags & HOOK_FLAGS.BEFORE_SWAP) === 0) throw new Error("hookConfig: DYNAMIC_FEE requires BEFORE_SWAP (HookInvalidConfig)");
  if (dynamic) {
    if (!(cfg.feeMin <= cfg.feeMax && cfg.feeMax <= MAX_SWAP_FEE_RATE)) throw new Error(`hookConfig: need 0 ≤ feeMin ≤ feeMax ≤ ${MAX_SWAP_FEE_RATE} (HookInvalidConfig)`);
  } else if (cfg.feeMin !== 0 || cfg.feeMax !== 0) {
    throw new Error("hookConfig: feeMin / feeMax must be 0 without DYNAMIC_FEE (HookInvalidConfig)");
  }
  if (cfg.maxCu < HOOK_MIN_CU || cfg.maxCu > HOOK_MAX_CU_CAP) throw new Error(`hookConfig.maxCu must be in ${HOOK_MIN_CU}..=${HOOK_MAX_CU_CAP} (HookInvalidConfig)`);
  if (cfg.accountsLen < HOOK_MIN_ACCOUNTS || cfg.accountsLen > HOOK_MAX_ACCOUNTS) throw new Error(`hookConfig.accountsLen must be in ${HOOK_MIN_ACCOUNTS}..=${HOOK_MAX_ACCOUNTS} (HookInvalidConfig)`);
  return cfg;
}

/** Borsh `HookConfig` (47 bytes). No validation — see `validateHookConfig`. */
export function encodeHookConfig(cfg: HookConfigArgs): Buffer {
  const b = Buffer.alloc(HOOK_CONFIG_LEN);
  cfg.program.toBuffer().copy(b, 0);
  b.writeUInt16LE(cfg.flags, 32);
  b.writeUInt32LE(cfg.feeMin, 34);
  b.writeUInt32LE(cfg.feeMax, 38);
  b.writeUInt32LE(cfg.maxCu, 42);
  b.writeUInt8(cfg.accountsLen, 46);
  return b;
}

/** Borsh `Option<HookConfig>`: `[0]` or `[1] ++ 47 bytes`. */
export function encodeOptionHookConfig(cfg: HookConfigArgs | null | undefined): Buffer {
  return cfg ? Buffer.concat([Buffer.from([1]), encodeHookConfig(cfg)]) : Buffer.from([0]);
}

/** The IDL-coder argument shape (`buildContractInstruction` / Anchor `methods.initializePool`). */
export function hookConfigArg(cfg: HookConfigArgs | null | undefined): { program: PublicKey; flags: number; fee_min: number; fee_max: number; max_cu: number; accounts_len: number } | null {
  return cfg ? { program: cfg.program, flags: cfg.flags, fee_min: cfg.feeMin, fee_max: cfg.feeMax, max_cu: cfg.maxCu, accounts_len: cfg.accountsLen } : null;
}

// ─── Account slice ───────────────────────────────────────────────────────────

/**
 * `[hook.program ro, HOOK_CALLER ro, ...extras]` for a pool whose hook is
 * active. Length must equal `hook.accountsLen` (throws otherwise, mirroring
 * `HookAccountsInvalid`). Returns `[]` for a pool without an active hook —
 * `extras` are then refused (they would be read as the Token-2022 tail).
 *
 * `cofferPoolProgramId` derives HOOK_CALLER; pass `cfg.programs.cofferPool`
 * (default: the production / localnet id `8iQt…`).
 */
export function hookAccountSlice(
  pool: Pick<PoolInfo, "hook">,
  extras: AccountMeta[] = [],
  cofferPoolProgramId: PublicKey = NETWORK_PROGRAMS.localnet.cofferPool,
): AccountMeta[] {
  const hook = pool.hook;
  if (!hook || !hook.active) {
    if (extras.length) throw new Error("hookAccountSlice: the pool has no active hook; extras would be misread as the Token-2022 tail");
    return [];
  }
  const slice: AccountMeta[] = [readonlyMeta(hook.program), readonlyMeta(hookCallerPda(cofferPoolProgramId)[0])];
  for (const extra of extras) {
    if (extra.isSigner) throw new Error(`hookAccountSlice: extras cannot be signers (${extra.pubkey.toBase58()})`);
    slice.push({ pubkey: extra.pubkey, isSigner: false, isWritable: extra.isWritable });
  }
  if (slice.length !== hook.accountsLen) {
    throw new Error(`hookAccountSlice: slice length ${slice.length} != hook.accountsLen ${hook.accountsLen} (HookAccountsInvalid)`);
  }
  return slice;
}

/** Same as `hookAccountSlice` but reads the coffer-pool id from a config. */
export function hookAccountSliceFor(cfg: CofferConfig, pool: Pick<PoolInfo, "hook">, extras: AccountMeta[] = []): AccountMeta[] {
  return hookAccountSlice(pool, extras, cfg.programs.cofferPool);
}

/**
 * Validate a caller-supplied slice against the pool: present iff the hook
 * is active, exact length, `[0] == hook.program`, `[1] == HOOK_CALLER`, no
 * signers. Returns the normalised slice to prepend (or `[]`).
 *
 * `bypass = true` (`remove_liquidity_bypass_hooks`) never takes a slice.
 */
export function requireHookSlice(
  cfg: CofferConfig,
  pool: Pick<PoolInfo, "hook" | "address">,
  hookAccounts: AccountMeta[] | undefined,
  op: string,
  bypass = false,
): AccountMeta[] {
  const hook = pool.hook;
  const active = !!hook && hook.active;
  if (bypass) {
    if (hookAccounts?.length) throw new Error(`${op}: remove_liquidity_bypass_hooks never takes a hook slice`);
    return [];
  }
  if (!active) {
    if (hookAccounts?.length) {
      throw new Error(`${op}: pool ${pool.address.toBase58()} has no active hook (${hook ? "disabled" : "none"}); the slice must be absent`);
    }
    return [];
  }
  if (!hookAccounts || hookAccounts.length === 0) {
    throw new Error(
      `${op}: pool ${pool.address.toBase58()} has an active hook (${hook!.program.toBase58()}); pass hookAccounts = ` +
        `hookAccountSlice(pool, extras) (${hook!.accountsLen} accounts) — the program rejects a missing slice with HookAccountsInvalid`,
    );
  }
  if (hookAccounts.length !== hook!.accountsLen) {
    throw new Error(`${op}: hookAccounts length ${hookAccounts.length} != hook.accountsLen ${hook!.accountsLen} (HookAccountsInvalid)`);
  }
  if (!hookAccounts[0].pubkey.equals(hook!.program)) throw new Error(`${op}: hookAccounts[0] must be the hook program ${hook!.program.toBase58()}`);
  const [caller] = hookCallerPda(cfg.programs.cofferPool);
  if (!hookAccounts[1].pubkey.equals(caller)) throw new Error(`${op}: hookAccounts[1] must be HOOK_CALLER ${caller.toBase58()}`);
  return hookAccounts.map((meta, i) => {
    if (meta.isSigner) throw new Error(`${op}: hook slice accounts cannot be signers (${meta.pubkey.toBase58()})`);
    if (i < 2 && meta.isWritable) throw new Error(`${op}: hook program / HOOK_CALLER must be read-only`);
    return { pubkey: meta.pubkey, isSigner: false, isWritable: meta.isWritable };
  });
}

// ─── Fixture resolver ────────────────────────────────────────────────────────

/** Reference / adversarial hook fixture program (local validator). */
export const HOOK_FIXTURE_PROGRAM_ID = new PublicKey("4Q7yKEp1MsxY8QUB4bHBNHaMdo3ZjPcBumPjgkFi3TJr");

export function hookFixtureCfgAddress(pool: PublicKey, program: PublicKey = HOOK_FIXTURE_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("hook-cfg"), pool.toBuffer()], program)[0];
}

export function hookFixtureKycAddress(user: PublicKey, program: PublicKey = HOOK_FIXTURE_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("kyc"), user.toBuffer()], program)[0];
}

/**
 * Resolver for the fixture rule `[cfg(pool) writable, kyc(user)?]`: the
 * hook-owned config PDA `["hook-cfg", pool]` (always, writable) and the
 * allowlist attestation `["kyc", user]` (read-only) when `withKyc`.
 */
export function fixtureHookExtras(withKyc = false): HookExtrasResolver {
  return (ctx: HookExtrasContext): AccountMeta[] => {
    const extras = [writableMeta(hookFixtureCfgAddress(ctx.pool, ctx.hookProgram))];
    if (withKyc) extras.push(readonlyMeta(hookFixtureKycAddress(ctx.user, ctx.hookProgram)));
    return extras;
  };
}

/** Resolve a full slice for `pool` with a resolver (convenience over `hookAccountSlice`). */
export function resolveHookSlice(cfg: CofferConfig, pool: Pick<PoolInfo, "hook" | "address">, user: PublicKey, op: HookOp, resolver: HookExtrasResolver): AccountMeta[] {
  if (!pool.hook?.active) return [];
  const extras = resolver({ pool: pool.address, hookProgram: pool.hook.program, user, op });
  return hookAccountSlice(pool, extras, cfg.programs.cofferPool);
}

// ─── CU heuristic ────────────────────────────────────────────────────────────

/** Flag bits of the callbacks that run for `op`. */
export function hookOpFlags(op: HookOp): number {
  switch (op) {
    case "swap": return HOOK_FLAGS.BEFORE_SWAP | HOOK_FLAGS.AFTER_SWAP;
    case "add":
    case "seed": return HOOK_FLAGS.BEFORE_ADD_LIQUIDITY | HOOK_FLAGS.AFTER_ADD_LIQUIDITY;
    case "remove": return HOOK_FLAGS.BEFORE_REMOVE_LIQUIDITY | HOOK_FLAGS.AFTER_REMOVE_LIQUIDITY;
  }
}

/** Number of callbacks the hook runs for `op` (0 when the hook is absent / disabled). */
export function hookCallbackCount(hook: PoolHookInfo | null | undefined, op: HookOp): number {
  if (!hook || !hook.active) return 0;
  let n = 0;
  let bits = hook.flags & hookOpFlags(op);
  while (bits) { n += bits & 1; bits >>>= 1; }
  return n;
}

/** Per-op base CU the SDK's `build*Tx` helpers use without a hook. */
export const HOOK_BASE_CU: Record<HookOp, number> = { swap: 400_000, add: 600_000, seed: 600_000, remove: 1_400_000 };

/** Overhead per callback on top of `max_cu` (invoke base cost + slice checks + event). */
export const HOOK_CALLBACK_OVERHEAD_CU = 5_000;

/**
 * `base + callbacks × (max_cu + 5_000)`, capped at 1.4M (docs/hooks.md §5).
 * `base` defaults to the SDK's per-op default (`HOOK_BASE_CU`); pass
 * `cfg.defaults.cuLimit` for remove to keep the config's ceiling.
 */
export function hookCuBudget(pool: Pick<PoolInfo, "hook">, op: HookOp, base: number = HOOK_BASE_CU[op]): number {
  const callbacks = hookCallbackCount(pool.hook, op);
  if (callbacks === 0) return base;
  return Math.min(1_400_000, base + callbacks * (pool.hook!.maxCu + HOOK_CALLBACK_OVERHEAD_CU));
}
