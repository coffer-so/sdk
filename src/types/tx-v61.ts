/**
 * v6.1 transaction-builder parameter / result types (SDK 0.2.0).
 *
 * Everything here is additive to `./tx`: the v5/v6 shapes keep working, the
 * v6.1 builders take these extended shapes. Pure types + one error class;
 * no runtime dependency on the builders (safe to import from anywhere).
 */
import type { AccountMeta, PublicKey, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import type BN from "bn.js";
import type { DeployPoolParams } from "./tx";

// ─── LP metadata (T1) ────────────────────────────────────────────────────────

/** `coffer_pool::util::lp_metadata::LpMetadataArgs` — immutable once the pool exists. */
export interface LpMetadataArgs {
  /** 1..=32 bytes of printable UTF-8, no leading/trailing whitespace. */
  name: string;
  /** 1..=10 bytes of `[A-Za-z0-9._-]`. */
  symbol: string;
  /** 1..=200 bytes, `https://` | `ipfs://` | `ar://`, no whitespace / control bytes. */
  uri: string;
}

export type LpMetadataField = "name" | "symbol" | "uri";

// ─── Hooks (T9) ──────────────────────────────────────────────────────────────

/** `coffer_pool::hooks::HookConfig` (Borsh: pubkey, u16, u32, u32, u32, u8 = 47 B; +1 Option tag). */
export interface HookConfigArgs {
  /** Executable hook program (not coffer-pool / token / System / ATA / ALT / protocol-admin). */
  program: PublicKey;
  /** `HOOK_FLAGS` bitmap; ≥ 1 callback bit, no reserved bits, `DYNAMIC_FEE ⇒ BEFORE_SWAP`. */
  flags: number;
  /** Fee-override clamp (hundredths of bps); both 0 unless `DYNAMIC_FEE`. */
  feeMin: number;
  feeMax: number;
  /** Per-callback CU ceiling, `HOOK_MIN_CU..=HOOK_MAX_CU_CAP`. */
  maxCu: number;
  /** Length of the slice `[hook_program, hook_caller, extras..]`, `HOOK_MIN_ACCOUNTS..=HOOK_MAX_ACCOUNTS`. */
  accountsLen: number;
}

/** Which pool operation a hook slice / CU budget is being built for. */
export type HookOp = "swap" | "add" | "seed" | "remove";

/**
 * Per-hook resolver of the `extras` that follow `[hook_program, hook_caller]`
 * in the slice. The on-chain `ExtraAccountMetaList`-style PDA is NOT part of
 * v6.1: every hook program publishes its own resolver (the fixture rule is
 * `fixtureHookExtras` in `utils/hooks.ts`).
 */
export interface HookExtrasResolver {
  (ctx: HookExtrasContext): AccountMeta[];
}

export interface HookExtrasContext {
  /** Pool PDA. */
  pool: PublicKey;
  /** Hook program (`PoolInfo.hook.program`). */
  hookProgram: PublicKey;
  /** The swap / LP authority as the pool will see it. */
  user: PublicKey;
  op: HookOp;
}

/** Optional hook slice carried by every hooked user operation. */
export interface HookedParams {
  /**
   * v6.1 (T9): the hook account slice `[hook_program, HOOK_CALLER, ...extras]`
   * (`hookAccountSlice`), exactly `pool.hook.accountsLen` metas. REQUIRED
   * when `pool.hook.active`; must be absent otherwise. Prepended BEFORE the
   * Token-2022 `extraAccounts` tail.
   */
  hookAccounts?: AccountMeta[];
}

// ─── Deploy (T1 / T7 / T9 / T14) ─────────────────────────────────────────────

/** `initialize_pool` v6.1 parameters: the v6 shape plus the five appended arguments. */
export interface DeployPoolParamsV61 extends DeployPoolParams {
  /** Immutable LP token metadata (validated client-side with the program's rules). */
  lpMetadata: LpMetadataArgs;
  /** T14: pool admin's share of the LP fee remainder, bps 0..=10_000. Default 0. */
  creatorFeeBps?: number;
  /** T7: deposit fee bps (LP haircut on `add_liquidity`; the seed is exempt). Default 0. */
  depositFeeBps?: number;
  /** T7: withdraw fee bps (payout haircut on `remove_liquidity`). Default 0. */
  withdrawFeeBps?: number;
  /** T9: immutable native hook. Default none. */
  hookConfig?: HookConfigArgs | null;
  /** T9: the hook slice (`hookConfig.accountsLen` metas), appended AFTER the mints. */
  hookAccounts?: AccountMeta[];
  /**
   * T22: the mints' decimals in `tokens` order. When given, every
   * `virtualBalances[i]` is checked against the per-slot floor
   * `minVirtualBalance(decimals)` = `max(10^decimals, 1000)` raw
   * (`VirtualBalanceBelowFloor` 6105) before encoding; `buildAtomicDeploy`
   * reads them from the mint accounts.
   */
  tokenDecimals?: number[];
}

// ─── Layout migration (L0) ───────────────────────────────────────────────────

export interface MigratePoolLayoutParams {
  /** Pool PDA (1683-byte account). */
  pool: PublicKey;
  /** Funds the rent delta (≈ 0.0043 SOL). Any wallet — the instruction is permissionless. */
  payer: PublicKey;
  /** The pool's mints in slot order (read-only remaining accounts). */
  mints: PublicKey[];
  /** Accepted for symmetry with the other builders; the instruction does not take them. */
  tokenPrograms?: PublicKey[];
}

/** Options every `build*Tx` accepts in v6.1. */
export interface TxBuildOptionsV61 {
  /**
   * `true` (default): when `pool.layoutVersion === 0` prepend the
   * permissionless `migrate_pool_layout_v61` (payer = user). `false`: throw
   * `PoolLayoutOutdatedError` instead. The raw `build*Ix` never migrate.
   */
  autoMigrate?: boolean;
}

/** Thrown by the `build*Tx` helpers when `autoMigrate: false` meets a 1683-byte pool. */
export class PoolLayoutOutdatedError extends Error {
  readonly code = "pool_layout_outdated" as const;
  constructor(readonly pool: PublicKey) {
    super(
      `Pool ${pool.toBase58()} is still on the v5 layout (1683 bytes); every instruction fails with ` +
        `LayoutVersionMismatch (6070) until migrate_pool_layout_v61 runs (buildMigratePoolLayoutV61Ix / autoMigrate)`,
    );
    this.name = "PoolLayoutOutdatedError";
  }
}

// ─── Seed / sidelined (T2 / T10) ─────────────────────────────────────────────

export interface SeedLiquidityParams extends HookedParams {
  /** Must be `pool.poolAdmin` (`SeedDepositNotPoolAdmin` otherwise). */
  user: PublicKey;
  /** Per-token seed amounts in pool order; ≥ 1 non-zero (zero slots start sidelined). */
  tokenAmounts: BN[];
  /** Initial LP supply (raw, 9 decimals), `MIN_INITIAL_LP_SUPPLY ≤ x ≤ MAX_INITIAL_LP_SUPPLY`. */
  lpAmount: BN;
  /** Token-2022 transfer-hook / memo tail (after the hook slice). */
  extraAccounts?: AccountMeta[];
}

/** Account-level `seed_liquidity` parameters (no `PoolInfo`): what the atomic deploy uses. */
export interface SeedLiquidityRawParams {
  pool: PublicKey;
  lpMint: PublicKey;
  userLpAccount: PublicKey;
  user: PublicKey;
  mints: PublicKey[];
  tokenPrograms: PublicKey[];
  userTokenAccounts: PublicKey[];
  vaults: PublicKey[];
  amounts: Array<BN | bigint>;
  lpAmount: BN | bigint;
  /** Owner of the LP mint; must be Token-2022 for v6.1 pools (default). */
  lpTokenProgram?: PublicKey;
  /** Tail after the ×4 layout: the hook slice first (iff hooked), then Token-2022 extras. */
  extraAccounts?: AccountMeta[];
}

export interface FundSidelinedTokenParams {
  /** Must be `pool.poolAdmin`. */
  authority: PublicKey;
  /** Slot to fund, `< pool.tokenCount`; must be sidelined (`actualBalance == 0`). */
  tokenIndex: number;
  /** Gross amount transferred (raw units). */
  amount: BN;
  /** Source token account; defaults to the authority's ATA. */
  userToken?: PublicKey;
  /** Token-2022 transfer-hook / memo tail (no hook slice — T9 runs no hook here). */
  extraAccounts?: AccountMeta[];
}

// ─── Cooldown (T3) ───────────────────────────────────────────────────────────

/** `cancel_pool_action(kind)` / `cancel_action(kind)` argument. */
export type ActionKind = number;

// ─── Fee claim (T5 / T14) ────────────────────────────────────────────────────

/**
 * Which `collect_protocol_fees` wire layout the target program speaks:
 * `v5` = `[vault, recipient, token_program] × n` (exactly 3n, no tail);
 * `v61` = `[vault, recipient, mint, token_program] × n` + optional tail.
 */
export type ClaimAbi = "v5" | "v61";

export interface ClaimSlot {
  index: number;
  mint: PublicKey;
  tokenProgram: PublicKey;
  vault: PublicKey;
  /** Protocol fees owed in this slot (raw). */
  owed: BN;
  /** Recipient used for this slot (Treasury vault PDA / admin ATA). */
  recipient: PublicKey;
}

export interface ClaimAccounts {
  remaining: AccountMeta[];
  /** Fee-bearing slots in pool order (placeholders omitted). */
  claims: ClaimSlot[];
}

// ─── Atomic deploy (T8) ──────────────────────────────────────────────────────

export type DeployLayout = "single" | "alt-1" | "alt-2";

/** Identity a creator actually authorised; an address / pool_id alone is insufficient (I-08). */
export interface ExpectedPoolIdentity {
  programId: PublicKey;
  config: PublicKey;
  poolId: bigint;
  poolAdmin: PublicKey;
  mints: PublicKey[];
  tokenPrograms: PublicKey[];
  weights: bigint[];
  swapFeeRate: number;
  /**
   * T8: the launch state the creator signed for (`true` = trade immediately,
   * `false` = paused launch). Checked only when set.
   */
  swapsEnabled?: boolean;
}

export interface VerifiedPoolIdentity {
  config: string;
  poolId: string;
  poolAdmin: string;
  tokenCount: number;
  swapFeeRate: number;
  poolEnabled: boolean;
  swapsEnabled: boolean;
  tokens: { mint: string; tokenProgram: string; normalizedWeight: bigint }[];
}

export interface AtomicDeployParams {
  /** Fee payer + pool admin + seed depositor. Must be the wallet signer. */
  payer: PublicKey;
  /** Existing `CofferPoolConfig`. */
  config: PublicKey;
  /** Pool token mints, in weight order. Defines the pool's token set. */
  mints: PublicKey[];
  /** Owning token program per mint. Auto-detected from chain when omitted. */
  tokenPrograms?: PublicKey[];
  /** Normalized weights, Σ = 10_000. */
  weights: BN[];
  /** Seed virtual balances, each > 0 and (T22) ≥ `max(10^decimals, 1000)` raw; every `seedAmounts[i]` must stay below `virtualBalances[i]`. */
  virtualBalances: BN[];
  /** T22: mint decimals in `mints` order; read from the mint accounts when omitted. */
  tokenDecimals?: number[];
  /** Swap fee in hundredths of a bp. */
  swapFeeRate: number;
  /** T14: pool admin's share of the LP fee remainder, bps 0..=10_000. Default 0. */
  creatorFeeBps?: number;
  /** First-deposit amounts, in pool order. ≥ 1 non-zero (zeros = sidelined slots, T10). */
  seedAmounts: BN[];
  /**
   * Creator-chosen initial LP supply minted by `seed_liquidity` (raw, 9
   * decimals, `MIN_INITIAL_LP_SUPPLY ≤ x ≤ MAX_INITIAL_LP_SUPPLY`). Default
   * `DEFAULT_INITIAL_LP_SUPPLY` (1_000 LP).
   */
  initialLpSupply?: BN;
  /** Pool salt. Defaults to 8 cryptographically random bytes — never pass a guessable value. */
  poolId?: BN;
  /** Immutable LP token metadata (T1); validated client-side. */
  lpMetadata: LpMetadataArgs;
  /** T7: deposit fee bps. Default 0. */
  depositFeeBps?: number;
  /** T7: withdraw fee bps. Default 0. */
  withdrawFeeBps?: number;
  /** T9: immutable native hook (default none) and its account slice. */
  hookConfig?: HookConfigArgs | null;
  hookAccounts?: AccountMeta[];
  /** Token program that owns the LP mint. Must be Token-2022 (default). */
  lpTokenProgram?: PublicKey;
  /**
   * `true` (default): tradable the moment the seed lands. `false`: "paused
   * launch" — `set_swaps_enabled(false)` rides in the seed transaction.
   */
  swapsEnabledAtLaunch?: boolean;
  /** Add the Jito `jitodontfront…` read-only marker to the seed tx's ComputeBudget ix. Default `false`. */
  jitoDontFront?: boolean;
  /** `"auto"` (default): single → alt-1 → alt-2. `"single"`: no ALT. `"alt"`: always an ALT. */
  layout?: "auto" | "single" | "alt";
  /** Allow the alt-2 split (init in its own packet). Default `true`. */
  allowSplit?: boolean;
  /** CU limit for the pool transaction(s). Default scales with the token count. */
  computeUnitLimit?: number;
  /** Micro-lamports per CU. Omitted ⇒ no priority-fee instruction. */
  computeUnitPrice?: number;
  /** Reuse a blockhash instead of fetching one. */
  blockhash?: string;
  /** Recent slot for the ALT PDA seed. Fetched (finalized) when omitted. */
  recentSlot?: number;
}

export interface AtomicDeployResult {
  /** Signed creation intent to verify before reporting a successful deployment. */
  expectedIdentity: ExpectedPoolIdentity;
  /** `[tx]`, `[tx1, tx2]` or `[tx1, tx2, tx3]` — hand straight to `signAllTransactions`. */
  transactions: VersionedTransaction[];
  layout: DeployLayout;
  /** 1-based index of the transaction carrying `seed_liquidity`. Always `transactions.length`. */
  seedTxIndex: 1 | 2 | 3;
  /** Number of transactions that touch pool state (1 or 2). */
  poolTxCount: 1 | 2;
  poolPda: PublicKey;
  lpMint: PublicKey;
  /** `null` in the `single` layout. */
  altAddress: PublicKey | null;
  poolId: BN;
  /** Pool vault ATAs, in pool order. */
  vaults: PublicKey[];
  /** Payer's token accounts the seed deposit is pulled from, in pool order. */
  userTokenAccounts: PublicKey[];
  /** Payer's LP ATA — created in the seed transaction. */
  userLpAccount: PublicKey;
  tokenPrograms: PublicKey[];
  /** Addresses actually written into the ALT (empty in `single`). */
  altAddresses: PublicKey[];
  blockhash: string;
  lastValidBlockHeight: number;
  /** Serialized wire sizes per transaction, in order. */
  txSizes: number[];
  sizes: { tx1: number; tx2?: number; tx3?: number };
  /** Analytic instruction-trace estimate per transaction (≤ TRACE_BUDGET). */
  traces: number[];
  /** Max distinct account keys any transaction touches (static + table-resolved). */
  accountCount: number;
  /** Vault ATA creations pushed out of the seed transaction (0 for small pools). */
  vaultAtasInTx1: number;
  /** Whether the seed transaction carries an explicit `SetComputeUnitLimit`. */
  computeBudgetInTx2: boolean;
  swapsEnabledAtLaunch: boolean;
  /** The raw instructions per transaction (what the `transactions` were compiled from). */
  instructions: TransactionInstruction[][];
}

export interface SendDeployResult {
  /** One signature per transaction, in order (1, 2 or 3). */
  signatures: string[];
  /** `computeUnitsConsumed` read back from the ledger, when available (per transaction). */
  computeUnits: (number | undefined)[];
}
