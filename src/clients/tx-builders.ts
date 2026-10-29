import {
  AccountMeta,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import {
  CofferConfig,
  MAX_CREATOR_FEE_BPS,
  MAX_INITIAL_LP_SUPPLY,
  MAX_LIQUIDITY_FEE_BPS,
  MIN_INITIAL_LP_SUPPLY,
  MIN_LP_SUPPLY,
} from "../config";
import { COFFER_POOL_IDL, PROTOCOL_ADMIN_IDL, SINGLE_TOKEN_LIQUIDITY_IDL } from "../idl";
import { PoolInfo } from "../types/pool";
import {
  AddLiquidityParams,
  BuiltTx,
  DeployPoolParams,
  RangeManagerUpdateParams,
  RemoveLiquidityParams,
  SetRangeManagerConfigParams,
  SetRangeManagerParams,
  SwapParams,
  SelloffParams,
  TokenChange,
} from "../types/tx";
import {
  DeployPoolParamsV61,
  FundSidelinedTokenParams,
  HookedParams,
  MigratePoolLayoutParams,
  PoolLayoutOutdatedError,
  SeedLiquidityParams,
  SeedLiquidityRawParams,
  TxBuildOptionsV61,
} from "../types/tx-v61";
import { deriveAta, deriveLpMint, derivePoolPda } from "../utils/pda";
import { buildContractInstruction } from "./contract-instructions";
import { calcTokensOutGivenLpIn, calcLpOutGivenExactTokensIn } from "../math/poolMath";
import { checkFundLeverage, checkSeedLeverage, minVirtualBalance } from "../math/leverage";
import { MathError } from "../math/fixedPoint";
import { netOfTransferFee } from "../math/transferFee";
import { assertTokensSupported } from "../utils/extensions";
import { encodeLpMetadataArgs, validateLpMetadata } from "../utils/lpMetadata";
import { encodeOptionHookConfig, hookCuBudget, requireHookSlice, validateHookConfig } from "../utils/hooks";


/**
 * Low-level transaction builders. Emit raw `TransactionInstruction`s suitable
 * for combination with others (e.g. versioned transactions with ALTs) in a
 * single tx. Higher-level convenience lives on `CofferPoolClient`.
 */

/**
 * Anchor discriminator: sha256("global:<ix_name>")[0..8].
 *
 * Read straight out of the shipped IDL rather than hand-maintained, so a
 * regenerated IDL can never silently disagree with the encoder. This table
 * is a tripwire, not the source of truth: if a refreshed IDL changes bytes
 * for an instruction we already ship, that is either a renamed instruction
 * or a bad IDL copy, and we want a loud failure at import time instead of a
 * transaction the program rejects with `InstructionFallbackNotFound`.
 *
 * NOTE: declared before `COFFER_POOL_DISC` on purpose. Those maps call
 * `computeDiscriminator` at module-evaluation time, and a `const` declared
 * after them would still be in its temporal dead zone when they run.
 */
const PINNED: Record<string, string> = {
  swap: "f8c69e91e17587c8",
  add_liquidity: "b59d59438fb63448",
  remove_liquidity: "5055d14818ceb16c",
  // v6.1 (T18): `initialize_cubic_pool` (d79474cf79686f83) was renamed to
  // `initialize_pool`, which re-cuts its discriminator. A 0.1.x SDK sending
  // the old bytes gets `InstructionFallbackNotFound` from a v6.1 program.
  initialize_pool: "5fb40aac54aee828",
  initialize_pool_alt: "fb874202f4490c90",
  deposit_single_token_planned: "fc0a53ee02ee4b1a",
  initialize_config: "d07f1501c2bec446",
  set_range_manager: "6766ad7008022584",
  set_range_manager_config: "67d300c8a4bdf5cd",
  range_manager_update: "f5b72345c80aac2c",
  pool_initialize_config: "d06eadbc279990b9",
  // v6.1 additions (contracts idl/abi-pins.json `addedInstructions`).
  migrate_pool_layout_v61: "9408318da470c1c7",
  seed_liquidity: "b4395e2349300d0b",
  fund_sidelined_token: "103bfef8cb10bcc2",
  set_creator_fee_bps: "9c0a977111fab10d",
  claim_creator_fees: "00177dea9c768659",
  lock_range_manager: "fd1d12cec0dece9b",
  set_liquidity_fees: "1d1b91f9fa1bce18",
  lock_liquidity_fees: "83f537885078fe72",
  set_pool_admin_delay: "21e7c161237d218c",
  remove_liquidity_bypass_hooks: "6182e9862d4f6f24",
  set_swaps_enabled: "909acd3af1a94028",
  set_hook_disabled: "f78c7bef72feba57",
  rescale_virtual_balances: "dc51a090bd46a9eb",
};

function computeDiscriminator(
  ixName: string,
  idl: "cofferPool" | "stld" | "protocolAdmin" = "cofferPool",
): Buffer {
  const source =
    idl === "stld"
      ? SINGLE_TOKEN_LIQUIDITY_IDL
      : idl === "protocolAdmin"
        ? PROTOCOL_ADMIN_IDL
        : COFFER_POOL_IDL;
  const ix = (source.instructions as Array<{ name: string; discriminator: number[] }>).find(
    (candidate) => candidate.name === ixName,
  );
  if (!ix) {
    throw new Error(`tx-builders: no "${ixName}" instruction in the ${idl} IDL`);
  }
  const bytes = Buffer.from(ix.discriminator);
  const pinned = PINNED[ixName];
  if (pinned && bytes.toString("hex") !== pinned) {
    throw new Error(
      `tx-builders: IDL discriminator for "${ixName}" is ${bytes.toString("hex")}, ` +
        `pinned value is ${pinned}. The IDL and this encoder disagree — ` +
        `do not ship until you know which one is right.`,
    );
  }
  return bytes;
}

const COFFER_POOL_DISC = {
  swap: computeDiscriminator("swap"),
  setHookDisabled: computeDiscriminator("set_hook_disabled"),
  rescaleVirtualBalances: computeDiscriminator("rescale_virtual_balances"),
  addLiquidity: computeDiscriminator("add_liquidity"),
  removeLiquidity: computeDiscriminator("remove_liquidity"),
  initializePool: computeDiscriminator("initialize_pool"),
  initializePoolAlt: computeDiscriminator("initialize_pool_alt"),
  setRangeManager: computeDiscriminator("set_range_manager"),
  setRangeManagerConfig: computeDiscriminator("set_range_manager_config"),
  rangeManagerUpdate: computeDiscriminator("range_manager_update"),
  // v6.1
  migratePoolLayoutV61: computeDiscriminator("migrate_pool_layout_v61"),
  seedLiquidity: computeDiscriminator("seed_liquidity"),
  fundSidelinedToken: computeDiscriminator("fund_sidelined_token"),
  claimCreatorFees: computeDiscriminator("claim_creator_fees"),
  removeLiquidityBypassHooks: computeDiscriminator("remove_liquidity_bypass_hooks"),
  setSwapsEnabled: computeDiscriminator("set_swaps_enabled"),
};

const PROTOCOL_ADMIN_DISC = {
  poolInitializeConfig: computeDiscriminator("pool_initialize_config", "protocolAdmin"),
};

function lpProgram(pool: PoolInfo): PublicKey {
  const program = pool.lpTokenProgram ?? TOKEN_PROGRAM_ID;
  if (!program.equals(TOKEN_PROGRAM_ID) && !program.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error("LP mint must be owned by SPL Token or Token-2022");
  }
  return program;
}

function requirePositiveMinimumLp(minimumLpAmount: BN | undefined, ixName: string): BN {
  if (!minimumLpAmount || minimumLpAmount.lte(new BN(0))) {
    throw new Error(`${ixName}: minimumLpAmount must be positive`);
  }
  return minimumLpAmount;
}

/**
 * Require an explicit per-token slippage floor for remove_liquidity.
 *
 * Previously this defaulted to all-zero when omitted, which silently shipped
 * a remove tx with NO slippage protection (sandwich/MEV exposure). Callers
 * must now pass `minimumTokenAmounts` (derive them from a fresh `quoteRemove()`
 * minus tolerance). To intentionally disable protection, pass explicit zeros.
 */
function requireExplicitMinimums(
  minimumTokenAmounts: BN[] | undefined,
  tokenCount: number,
  ixName: string
): BN[] {
  if (!minimumTokenAmounts) {
    throw new Error(
      `${ixName}: minimumTokenAmounts must be provided (one per token). ` +
        `Derive per-token floors from a fresh quoteRemove(); pass explicit zeros ` +
        `only to intentionally disable slippage protection.`
    );
  }
  if (minimumTokenAmounts.length !== tokenCount) {
    throw new Error(
      `${ixName}: minimumTokenAmounts length (${minimumTokenAmounts.length}) must equal token count (${tokenCount})`
    );
  }
  return minimumTokenAmounts;
}

// ============================================================
// Swap
// ============================================================

/**
 * `swap`. v6.1 (T9): when `pool.hook.active` the remaining-accounts tail
 * MUST start with the hook slice (`params.hookAccounts`, see
 * `utils/hooks.ts`); the Token-2022 `extraAccounts` follow it. A hooked pool
 * built without a slice throws here (the program would fail with
 * `HookAccountsInvalid`). Raw: never prepends the layout migration.
 */
export function buildSwapIx(
  cfg: CofferConfig,
  pool: PoolInfo,
  params: SwapParams & { minAmountOut: BN } & HookedParams
): TransactionInstruction {
  assertTokensSupported(pool, [params.tokenInIndex, params.tokenOutIndex], "swap");
  if (params.tokenInIndex === params.tokenOutIndex) throw new Error("swap: tokenInIndex and tokenOutIndex must differ");
  if (pool.tokens[params.tokenOutIndex]?.sidelined) {
    // T10: a sidelined slot (`actual_balance == 0`) cannot be a swap output.
    throw new Error(`swap: token ${params.tokenOutIndex} is sidelined (no reserves) — InsufficientLiquidity`);
  }
  const inTok = pool.tokens[params.tokenInIndex];
  const outTok = pool.tokens[params.tokenOutIndex];

  const userTokenIn = deriveAta(params.user, inTok.mint, inTok.tokenProgram);
  const userTokenOut = deriveAta(params.user, outTok.mint, outTok.tokenProgram);

  const data = Buffer.concat([
    COFFER_POOL_DISC.swap,
    encodeU64(params.amountIn),
    encodeU64(params.minAmountOut),
    encodeU8(params.tokenInIndex),
    encodeU8(params.tokenOutIndex),
  ]);

  const keys: AccountMeta[] = [
    { pubkey: pool.address, isSigner: false, isWritable: true },
    { pubkey: inTok.mint, isSigner: false, isWritable: false },
    { pubkey: outTok.mint, isSigner: false, isWritable: false },
    { pubkey: userTokenIn, isSigner: false, isWritable: true },
    { pubkey: userTokenOut, isSigner: false, isWritable: true },
    { pubkey: inTok.vault, isSigner: false, isWritable: true },
    { pubkey: outTok.vault, isSigner: false, isWritable: true },
    { pubkey: params.user, isSigner: true, isWritable: true },
    { pubkey: inTok.tokenProgram, isSigner: false, isWritable: false },
    { pubkey: outTok.tokenProgram, isSigner: false, isWritable: false },
    ...requireHookSlice(cfg, pool, params.hookAccounts, "swap"),
    ...tail(params.extraAccounts, "swap"),
  ];

  return new TransactionInstruction({
    programId: cfg.programs.cofferPool,
    keys,
    data,
  });
}

/**
 * v6 remaining-account tail: forwarded to every `transfer_checked` CPI of
 * the instruction (hook extras, memo program). Never signers.
 */
function tail(extraAccounts: AccountMeta[] | undefined, ixName: string): AccountMeta[] {
  if (!extraAccounts?.length) return [];
  const seen = new Set<string>();
  return extraAccounts.map((meta) => {
    if (meta.isSigner) throw new Error(`${ixName}: extra accounts cannot be signers (${meta.pubkey.toBase58()})`);
    if (seen.has(meta.pubkey.toBase58())) throw new Error(`${ixName}: duplicate extra account ${meta.pubkey.toBase58()}`);
    seen.add(meta.pubkey.toBase58());
    return { pubkey: meta.pubkey, isSigner: false, isWritable: meta.isWritable };
  });
}

/**
 * v6.1 (L0): `autoMigrate` handling shared by the `build*Tx` helpers. On a
 * 1683-byte pool (`layoutVersion === 0`) returns the permissionless
 * `migrate_pool_layout_v61` to run first, or throws when the caller opted
 * out. `undefined` layoutVersion (manually supplied v5 snapshot) = no-op.
 */
function layoutMigrationPrefix(cfg: CofferConfig, pool: PoolInfo, payer: PublicKey, options: TxBuildOptionsV61 | undefined): TransactionInstruction[] {
  if (pool.layoutVersion !== 0) return [];
  if (options?.autoMigrate === false) throw new PoolLayoutOutdatedError(pool.address);
  return [buildMigratePoolLayoutV61Ix(cfg, { pool: pool.address, payer, mints: pool.tokens.map((t) => t.mint), tokenPrograms: pool.tokens.map((t) => t.tokenProgram) })];
}

export function buildSwapTx(
  cfg: CofferConfig,
  pool: PoolInfo,
  params: SwapParams & { minAmountOut: BN } & HookedParams & TxBuildOptionsV61
): BuiltTx {
  const units = hookCuBudget(pool, "swap", 400_000);
  return {
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
      ...layoutMigrationPrefix(cfg, pool, params.user, params),
      buildSwapIx(cfg, pool, params),
    ],
    suggestedCuLimit: units,
  };
}

// ============================================================
// Add liquidity (proportional)
// ============================================================

/**
 * `add_liquidity` — proportional join.
 *
 * ⚠ **`params.tokenAmounts` is a CEILING, not an exact amount** (v5.1,
 * audit M-4 / I-1). The program takes the largest strictly-proportional
 * basket that fits inside the vector you pass and leaves the remainder in
 * the wallet; it does NOT pull the full amounts. Any UI copy of the form
 * "you will deposit exactly X" is wrong — quote the proportional basket
 * instead (see `CofferPoolClient.quoteAddLiquidity`).
 *
 * The wire format is unchanged, so this is a behaviour note, not an
 * encoding change: the same bytes now mean "at most this much".
 */
export function buildAddLiquidityIx(
  cfg: CofferConfig,
  pool: PoolInfo,
  params: AddLiquidityParams & HookedParams
): TransactionInstruction {
  assertTokensSupported(pool, params.tokenAmounts.flatMap((amount, i) => amount.gt(new BN(0)) ? [i] : []), "add_liquidity");
  const userLp = deriveAta(params.user, pool.lpMint, lpProgram(pool));
  const minLp = requirePositiveMinimumLp(params.minimumLpAmount, "add_liquidity");
  if (params.tokenAmounts.length !== pool.tokenCount) {
    // The program rejects this with `InvalidArrayLength` (6064); catching it
    // here costs a round trip less.
    throw new Error(
      `add_liquidity: tokenAmounts length (${params.tokenAmounts.length}) ` +
        `must equal the pool's token count (${pool.tokenCount})`
    );
  }

  // Mirror the program's early refusals: liveness mismatch, a ceiling fully
  // consumed by its transfer fee, and a basket that rounds to zero LP
  // (`DepositTooSmall`). v6 credits live legs UP from the ratio, so a
  // positive LP amount never leaves a live leg unmoved.
  if (pool.lpTotalSupply.gt(new BN(0))) {
    const balances = pool.tokens.map(token => BigInt(token.actualBalance.toString()));
    const amounts = params.tokenAmounts.map(amount => BigInt(amount.toString()));
    const net = amounts.map((amount, i) => netOfTransferFee(pool.tokens[i].transferFee, amount));
    balances.forEach((balance, i) => {
      if ((balance > 0n) !== (amounts[i] > 0n)) throw new Error("add_liquidity: token liveness mismatch");
      if (amounts[i] > 0n && net[i] === 0n) throw new Error(`add_liquidity: ceiling at token index ${i} is fully consumed by its transfer fee`);
    });
    if (calcLpOutGivenExactTokensIn(balances, net, BigInt(pool.lpTotalSupply.toString())) === 0n) {
      throw new Error("add_liquidity: deposit too small after proportional rounding");
    }
  }

  const data = Buffer.concat([
    COFFER_POOL_DISC.addLiquidity,
    encodeVecU64(params.tokenAmounts),
    encodeU64(minLp),
  ]);

  // remaining_accounts layout:
  //   [user_token_i, vault_i] × N, mint_i × N, token_program_i × N
  const remaining: AccountMeta[] = [];
  for (let i = 0; i < pool.tokenCount; i++) {
    const t = pool.tokens[i];
    const userAta = deriveAta(params.user, t.mint, t.tokenProgram);
    remaining.push({ pubkey: userAta, isSigner: false, isWritable: true });
    remaining.push({ pubkey: t.vault, isSigner: false, isWritable: true });
  }
  for (let i = 0; i < pool.tokenCount; i++) {
    remaining.push({ pubkey: pool.tokens[i].mint, isSigner: false, isWritable: false });
  }
  for (let i = 0; i < pool.tokenCount; i++) {
    remaining.push({ pubkey: pool.tokens[i].tokenProgram, isSigner: false, isWritable: false });
  }

  const keys: AccountMeta[] = [
    { pubkey: pool.address, isSigner: false, isWritable: true },
    { pubkey: pool.lpMint, isSigner: false, isWritable: true },
    { pubkey: userLp, isSigner: false, isWritable: true },
    { pubkey: params.user, isSigner: true, isWritable: true },
    { pubkey: lpProgram(pool), isSigner: false, isWritable: false },
    ...remaining,
    ...requireHookSlice(cfg, pool, params.hookAccounts, "add_liquidity"),
    ...tail(params.extraAccounts, "add_liquidity"),
  ];

  return new TransactionInstruction({
    programId: cfg.programs.cofferPool,
    keys,
    data,
  });
}

export function buildAddLiquidityTx(
  cfg: CofferConfig,
  pool: PoolInfo,
  params: AddLiquidityParams & HookedParams & TxBuildOptionsV61
): BuiltTx {
  const userLp = deriveAta(params.user, pool.lpMint, lpProgram(pool));
  const units = hookCuBudget(pool, "add", 600_000);
  return {
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
      ...layoutMigrationPrefix(cfg, pool, params.user, params),
      createAssociatedTokenAccountIdempotentInstruction(
        params.user,
        userLp,
        params.user,
        pool.lpMint,
        lpProgram(pool)
      ),
      buildAddLiquidityIx(cfg, pool, params),
    ],
    suggestedCuLimit: units,
  };
}

// ============================================================
// Seed liquidity (v6.1, T2 / T10)
// ============================================================

/**
 * `seed_liquidity(token_amounts, lp_amount)` from raw accounts — what the
 * atomic deploy uses before a `PoolInfo` exists. Remaining accounts: the
 * add_liquidity ×4 layout `[user_i, vault_i]×n, mint×n, program×n` then the
 * tail (hook slice first iff the pool has a hook, then Token-2022 extras).
 */
export function buildSeedLiquidityRawIx(cfg: CofferConfig, p: SeedLiquidityRawParams): TransactionInstruction {
  const n = p.mints.length;
  if (n < 2 || n > 10) throw new Error(`seed_liquidity: token count ${n} outside [2, 10]`);
  if (p.tokenPrograms.length !== n || p.userTokenAccounts.length !== n || p.vaults.length !== n || p.amounts.length !== n) {
    throw new Error("seed_liquidity: tokenPrograms / userTokenAccounts / vaults / amounts must match mints length");
  }
  const amounts = p.amounts.map((a) => (BN.isBN(a) ? a : new BN(a.toString())));
  const lpAmount = BN.isBN(p.lpAmount) ? p.lpAmount : new BN(p.lpAmount.toString());
  if (!amounts.some((a) => !a.isZero())) throw new Error("seed_liquidity: at least one amount must be non-zero (FirstDepositRequiresNonzero)");
  requireInitialLpSupply(lpAmount);
  const lpTokenProgram = p.lpTokenProgram ?? TOKEN_2022_PROGRAM_ID;
  if (!lpTokenProgram.equals(TOKEN_PROGRAM_ID) && !lpTokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error("seed_liquidity: LP mint must be owned by SPL Token or Token-2022");
  }
  const remaining: AccountMeta[] = [];
  for (let i = 0; i < n; i++) {
    remaining.push({ pubkey: p.userTokenAccounts[i], isSigner: false, isWritable: true });
    remaining.push({ pubkey: p.vaults[i], isSigner: false, isWritable: true });
  }
  for (let i = 0; i < n; i++) remaining.push({ pubkey: p.mints[i], isSigner: false, isWritable: false });
  for (let i = 0; i < n; i++) remaining.push({ pubkey: p.tokenPrograms[i], isSigner: false, isWritable: false });
  for (const extra of p.extraAccounts ?? []) {
    if (extra.isSigner) throw new Error(`seed_liquidity: tail accounts cannot be signers (${extra.pubkey.toBase58()})`);
    remaining.push({ pubkey: extra.pubkey, isSigner: false, isWritable: extra.isWritable });
  }
  return new TransactionInstruction({
    programId: cfg.programs.cofferPool,
    keys: [
      { pubkey: p.pool, isSigner: false, isWritable: true },
      { pubkey: p.lpMint, isSigner: false, isWritable: true },
      { pubkey: p.userLpAccount, isSigner: false, isWritable: true },
      { pubkey: p.user, isSigner: true, isWritable: false },
      { pubkey: lpTokenProgram, isSigner: false, isWritable: false },
      ...remaining,
    ],
    data: Buffer.concat([COFFER_POOL_DISC.seedLiquidity, encodeVecU64(amounts), encodeU64(lpAmount)]),
  });
}

/**
 * v6.1 (T22) `check_seed_leverage`: the seed books `actual_i = net_i`
 * against the untouched `virtual_i`, so every slot needs `net_i < virtual_i`
 * (Token-2022 transfer fees netted first; a zero slot passes for any `V > 0`).
 */
function requireSeedLeverage(pool: PoolInfo, amounts: BN[], op: string): void {
  const nets = amounts.map((a, i) => netOfTransferFee(pool.tokens[i].transferFee, BigInt(a.toString())));
  try {
    checkSeedLeverage(pool.tokens.map((t) => BigInt(t.virtualBalance.toString())), nets);
  } catch (e) {
    if (!(e instanceof MathError)) throw e;
    const bad = nets.findIndex((net, i) => net >= BigInt(pool.tokens[i].virtualBalance.toString()));
    throw new Error(`${op}: net seed amount ${nets[bad]} for slot ${bad} must stay below its virtual balance ${pool.tokens[bad].virtualBalance} (VirtualBalanceNotAboveActual, 6104) — lower the amount or raise the virtual balance`);
  }
}

function requireInitialLpSupply(lpAmount: BN): void {
  const min = new BN(MIN_INITIAL_LP_SUPPLY.toString());
  const max = new BN(MAX_INITIAL_LP_SUPPLY.toString());
  if (!BN.isBN(lpAmount) || lpAmount.isNeg() || lpAmount.bitLength() > 64) throw new Error("seed_liquidity: lpAmount must be an unsigned 64-bit BN");
  if (lpAmount.lt(min)) throw new Error(`seed_liquidity: lpAmount ${lpAmount} < MIN_INITIAL_LP_SUPPLY ${min} (InitialLiquidityTooSmall)`);
  if (lpAmount.gt(max)) throw new Error(`seed_liquidity: lpAmount ${lpAmount} > MAX_INITIAL_LP_SUPPLY ${max} (InitialLpSupplyTooLarge)`);
}

/**
 * `seed_liquidity` against a synced pool: the creator's first deposit,
 * exactly once (`lp_mint.supply == 0`), minting a creator-chosen LP supply.
 * Zero slots are allowed (they start sidelined, T10) as long as one amount
 * is non-zero. `params.user` must be the pool admin (checked when the
 * snapshot carries `poolAdmin`). Hooked pools carry the slice
 * (`before/after-add-liquidity` run with `is_seed = true`).
 */
export function buildSeedLiquidityIx(cfg: CofferConfig, pool: PoolInfo, params: SeedLiquidityParams): TransactionInstruction {
  if (params.tokenAmounts.length !== pool.tokenCount) {
    throw new Error(`seed_liquidity: tokenAmounts length (${params.tokenAmounts.length}) must equal the pool's token count (${pool.tokenCount})`);
  }
  if (pool.poolAdmin) {
    if (pool.poolAdmin.equals(PublicKey.default)) throw new Error("seed_liquidity: PoolAdminDisabled");
    if (!pool.poolAdmin.equals(params.user)) throw new Error("seed_liquidity: user must be the pool admin (SeedDepositNotPoolAdmin)");
  }
  if (!pool.lpTotalSupply.isZero()) throw new Error("seed_liquidity: pool already seeded (PoolAlreadySeeded); use add_liquidity");
  assertTokensSupported(pool, params.tokenAmounts.flatMap((a, i) => (a.isZero() ? [] : [i])), "seed_liquidity");
  requireSeedLeverage(pool, params.tokenAmounts, "seed_liquidity");
  const slice = requireHookSlice(cfg, pool, params.hookAccounts, "seed_liquidity");
  return buildSeedLiquidityRawIx(cfg, {
    pool: pool.address,
    lpMint: pool.lpMint,
    userLpAccount: deriveAta(params.user, pool.lpMint, lpProgram(pool)),
    user: params.user,
    mints: pool.tokens.map((t) => t.mint),
    tokenPrograms: pool.tokens.map((t) => t.tokenProgram),
    userTokenAccounts: pool.tokens.map((t) => deriveAta(params.user, t.mint, t.tokenProgram)),
    vaults: pool.tokens.map((t) => t.vault),
    amounts: params.tokenAmounts,
    lpAmount: params.lpAmount,
    lpTokenProgram: lpProgram(pool),
    extraAccounts: [...slice, ...tail(params.extraAccounts, "seed_liquidity")],
  });
}

/**
 * Seed transaction: idempotent vault ATAs for the NON-ZERO slots only (a
 * zero slot's vault is created when it is funded), the user's LP ATA, then
 * `seed_liquidity`. Never migrates (a pool that needs seeding is a v6.1 pool).
 */
export function buildSeedLiquidityTx(cfg: CofferConfig, pool: PoolInfo, params: SeedLiquidityParams): BuiltTx {
  const ixs: TransactionInstruction[] = [];
  pool.tokens.forEach((t, i) => {
    if (params.tokenAmounts[i]?.isZero()) return;
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(params.user, t.vault, pool.address, t.mint, t.tokenProgram));
  });
  const userLp = deriveAta(params.user, pool.lpMint, lpProgram(pool));
  ixs.push(createAssociatedTokenAccountIdempotentInstruction(params.user, userLp, params.user, pool.lpMint, lpProgram(pool)));
  ixs.push(buildSeedLiquidityIx(cfg, pool, params));
  const units = hookCuBudget(pool, "seed", Math.min(1_400_000, 200_000 + pool.tokenCount * 60_000));
  return { instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...ixs], suggestedCuLimit: units };
}

// ============================================================
// Fund a sidelined slot (v6.1, T10)
// ============================================================

/**
 * `fund_sidelined_token(token_index, amount)`: pool-admin only; transfers
 * `amount` into a slot whose `actual_balance == 0` at the curve price,
 * minting no LP. Fixed accounts `[pool w, lp_mint, authority s, user_token w,
 * vault w, mint, token_program]`; remaining = Token-2022 tail only (no hook
 * slice — T9 runs no hook for it). Data = 8 + 1 + 8 = 17 bytes.
 */
export function buildFundSidelinedTokenIx(cfg: CofferConfig, pool: PoolInfo, params: FundSidelinedTokenParams): TransactionInstruction {
  const t = pool.tokens[params.tokenIndex];
  if (!t || params.tokenIndex >= pool.tokenCount) throw new Error(`fund_sidelined_token: tokenIndex ${params.tokenIndex} out of range (InvalidTokenIndex)`);
  if (t.sidelined === false || (t.sidelined === undefined && !t.actualBalance.isZero())) {
    throw new Error(`fund_sidelined_token: slot ${params.tokenIndex} is not sidelined (TokenNotSidelined)`);
  }
  if (pool.poolAdmin && !pool.poolAdmin.equals(params.authority)) throw new Error("fund_sidelined_token: authority must be the pool admin (Unauthorized)");
  if (!BN.isBN(params.amount) || params.amount.isZero()) throw new Error("fund_sidelined_token: amount must be > 0 (ZeroAmount)");
  assertTokensSupported(pool, [params.tokenIndex], "fund_sidelined_token");
  // v6.1 (T22) `check_fund_leverage`: the slot books `actual = net`, so `net < virtual`.
  const net = netOfTransferFee(t.transferFee, BigInt(params.amount.toString()));
  try {
    checkFundLeverage(BigInt(t.virtualBalance.toString()), net);
  } catch (e) {
    if (!(e instanceof MathError)) throw e;
    throw new Error(`fund_sidelined_token: net amount ${net} must stay below slot ${params.tokenIndex}'s virtual balance ${t.virtualBalance} (VirtualBalanceNotAboveActual, 6104) — a sidelined slot takes at most virtual − 1 raw units this way; rescale first for more depth`);
  }
  const userToken = params.userToken ?? deriveAta(params.authority, t.mint, t.tokenProgram);
  const data = Buffer.concat([COFFER_POOL_DISC.fundSidelinedToken, encodeU8(params.tokenIndex), encodeU64(params.amount)]);
  const keys: AccountMeta[] = [
    { pubkey: pool.address, isSigner: false, isWritable: true },
    { pubkey: pool.lpMint, isSigner: false, isWritable: false },
    { pubkey: params.authority, isSigner: true, isWritable: false },
    { pubkey: userToken, isSigner: false, isWritable: true },
    { pubkey: t.vault, isSigner: false, isWritable: true },
    { pubkey: t.mint, isSigner: false, isWritable: false },
    { pubkey: t.tokenProgram, isSigner: false, isWritable: false },
    ...tail(params.extraAccounts, "fund_sidelined_token"),
  ];
  return new TransactionInstruction({ programId: cfg.programs.cofferPool, keys, data });
}

/** `fund_sidelined_token` with the idempotent vault ATA creation in front. */
export function buildFundSidelinedTokenTx(cfg: CofferConfig, pool: PoolInfo, params: FundSidelinedTokenParams & TxBuildOptionsV61): BuiltTx {
  const t = pool.tokens[params.tokenIndex];
  if (!t) throw new Error(`fund_sidelined_token: tokenIndex ${params.tokenIndex} out of range (InvalidTokenIndex)`);
  return {
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ...layoutMigrationPrefix(cfg, pool, params.authority, params),
      createAssociatedTokenAccountIdempotentInstruction(params.authority, t.vault, pool.address, t.mint, t.tokenProgram),
      buildFundSidelinedTokenIx(cfg, pool, params),
    ],
    suggestedCuLimit: 200_000,
  };
}

// ============================================================
// Layout migration (v6.1, L0)
// ============================================================

/**
 * `migrate_pool_layout_v61`: grow a 1683-byte v4/v5 pool to 2304 bytes in
 * place. Permissionless, one-shot, no semantic change; `payer` funds the
 * rent delta. Accounts `[pool w, payer w s, system_program]`; remaining =
 * the pool's mints in slot order (read-only; the handler pins decimals from
 * them). Until it runs every other instruction fails with
 * `LayoutVersionMismatch` (6070).
 */
export function buildMigratePoolLayoutV61Ix(cfg: CofferConfig, params: MigratePoolLayoutParams): TransactionInstruction {
  const n = params.mints.length;
  if (n < 2 || n > 10) throw new Error(`migrate_pool_layout_v61: expected 2..10 mints, got ${n}`);
  if (params.tokenPrograms && params.tokenPrograms.length !== n) throw new Error("migrate_pool_layout_v61: tokenPrograms length mismatch");
  return buildContractInstruction(
    cfg,
    "cofferPool",
    "migrate_pool_layout_v61",
    {},
    { pool: params.pool, payer: params.payer, system_program: SystemProgram.programId },
    params.mints.map((mint) => ({ pubkey: mint, isSigner: false, isWritable: false })),
  );
}

/**
 * Prepend `migrate_pool_layout_v61` to `instructions` when `pool` is still
 * on the v5 layout (`layoutVersion === 0`); returns `instructions` unchanged
 * otherwise. Pure.
 */
export function prependLayoutMigration(cfg: CofferConfig, pool: PoolInfo, payer: PublicKey, instructions: TransactionInstruction[]): TransactionInstruction[] {
  if (pool.layoutVersion !== 0) return instructions;
  return [
    buildMigratePoolLayoutV61Ix(cfg, { pool: pool.address, payer, mints: pool.tokens.map((t) => t.mint), tokenPrograms: pool.tokens.map((t) => t.tokenProgram) }),
    ...instructions,
  ];
}

// ============================================================
// Remove liquidity
// ============================================================

export function buildRemoveLiquidityIx(
  cfg: CofferConfig,
  pool: PoolInfo,
  params: RemoveLiquidityParams & HookedParams
): TransactionInstruction {
  return buildRemoveLiquidityIxInner(cfg, pool, params, false);
}

/**
 * v6.1 (T9) `remove_liquidity_bypass_hooks`: same accounts, data layout and
 * math (exit fee, surge bucket) as `remove_liquidity`, but NO hook slice and
 * no hook CPI — always available, so a broken / denying / paused hook can
 * never trap an LP. A `hookAccounts` value is refused.
 */
export function buildRemoveLiquidityBypassHooksIx(
  cfg: CofferConfig,
  pool: PoolInfo,
  params: RemoveLiquidityParams & HookedParams
): TransactionInstruction {
  return buildRemoveLiquidityIxInner(cfg, pool, params, true);
}

function buildRemoveLiquidityIxInner(
  cfg: CofferConfig,
  pool: PoolInfo,
  params: RemoveLiquidityParams & HookedParams,
  bypass: boolean,
): TransactionInstruction {
  const ixName = bypass ? "remove_liquidity_bypass_hooks" : "remove_liquidity";
  const supply = pool.lpTotalSupply;
  const maxBurn = BN.max(supply.sub(new BN(MIN_LP_SUPPLY.toString())), new BN(0));
  const effectiveBurn = BN.min(params.lpAmount, maxBurn);
  const transferred = supply.gt(new BN(0))
    ? calcTokensOutGivenLpIn(pool.tokens.map(token => BigInt(token.actualBalance.toString())), BigInt(effectiveBurn.toString()), BigInt(supply.toString()))
        .flatMap((amount, i) => amount > 0n ? [i] : [])
    : [];
  assertTokensSupported(pool, transferred, ixName);
  const userLp = deriveAta(params.user, pool.lpMint, lpProgram(pool));
  const mins = requireExplicitMinimums(params.minimumTokenAmounts, pool.tokenCount, ixName);

  const data = Buffer.concat([
    bypass ? COFFER_POOL_DISC.removeLiquidityBypassHooks : COFFER_POOL_DISC.removeLiquidity,
    encodeU64(params.lpAmount),
    encodeVecU64(mins),
  ]);

  // remove_liquidity remaining_accounts format:
  //   [vault_i, user_token_i] × N, mint_i × N, token_program_i × N
  const remaining: AccountMeta[] = [];
  for (let i = 0; i < pool.tokenCount; i++) {
    const t = pool.tokens[i];
    const userAta = deriveAta(params.user, t.mint, t.tokenProgram);
    remaining.push({ pubkey: t.vault, isSigner: false, isWritable: true });
    remaining.push({ pubkey: userAta, isSigner: false, isWritable: true });
  }
  for (let i = 0; i < pool.tokenCount; i++) {
    remaining.push({ pubkey: pool.tokens[i].mint, isSigner: false, isWritable: false });
  }
  for (let i = 0; i < pool.tokenCount; i++) {
    remaining.push({ pubkey: pool.tokens[i].tokenProgram, isSigner: false, isWritable: false });
  }

  const keys: AccountMeta[] = [
    { pubkey: pool.address, isSigner: false, isWritable: true },
    { pubkey: pool.lpMint, isSigner: false, isWritable: true },
    { pubkey: userLp, isSigner: false, isWritable: true },
    { pubkey: params.user, isSigner: true, isWritable: true },
    { pubkey: lpProgram(pool), isSigner: false, isWritable: false },
    ...remaining,
    ...requireHookSlice(cfg, pool, params.hookAccounts, ixName, bypass),
    ...tail(params.extraAccounts, ixName),
  ];

  return new TransactionInstruction({
    programId: cfg.programs.cofferPool,
    keys,
    data,
  });
}

export function buildRemoveLiquidityTx(
  cfg: CofferConfig,
  pool: PoolInfo,
  params: RemoveLiquidityParams & HookedParams & TxBuildOptionsV61 & { bypassHooks?: boolean }
): BuiltTx {
  const bypass = params.bypassHooks === true;
  const units = bypass ? cfg.defaults.cuLimit : hookCuBudget(pool, "remove", cfg.defaults.cuLimit);
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ...layoutMigrationPrefix(cfg, pool, params.user, params),
  ];

  // The contract transfers every pool token to the user's ATA. Include
  // idempotent creates so a proportional burn works even when the user never
  // held one of the receive tokens before. Sidelined slots (T10) pay
  // nothing and are skipped.
  for (const t of pool.tokens) {
    if (t.sidelined) continue;
    const userAta = deriveAta(params.user, t.mint, t.tokenProgram);
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        params.user,
        userAta,
        params.user,
        t.mint,
        t.tokenProgram
      )
    );
  }

  ixs.push(bypass ? buildRemoveLiquidityBypassHooksIx(cfg, pool, params) : buildRemoveLiquidityIx(cfg, pool, params));

  return {
    instructions: ixs,
    suggestedCuLimit: units,
  };
}

// ============================================================
// Deploy new pool (PoolFactory)
// ============================================================

/**
 * Raw `coffer_pool::initialize_config`.
 *
 * ⚠ **This instruction is no longer directly callable from a wallet.** In
 * v5.1 (audit H-2) the `protocol_admin: Pubkey` ARGUMENT was removed and
 * the Treasury PDA account became a `Signer`. The config's admin is now
 * whoever signs, which by construction can only be protocol-admin's
 * Treasury PDA via `invoke_signed` — no keypair exists for it.
 *
 * Sending this instruction from a wallet fails signature verification. The
 * only working path is `AdminClient.poolInitializeConfigIx()`, which calls
 * `protocol_admin::pool_initialize_config` and CPIs in here. This builder
 * is kept so the wire format stays documented and testable, and so the
 * treasury meta carries `isSigner: true` — Anchor derives CPI account
 * metas from the field type, and emitting it as a non-signer would strand
 * the outer `invoke_signed` signature.
 */
export function buildInitializeConfigIx(
  cfg: CofferConfig,
  params: { config: PublicKey; payer: PublicKey; defaultProtocolFeeRate: number }
): TransactionInstruction {
  const [treasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    cfg.programs.protocolAdmin
  );
  // Args are `(default_protocol_fee_rate: u16)` and nothing else. The
  // leading 32-byte `protocol_admin` pubkey this used to encode is gone —
  // leaving it in makes the program read the fee rate out of the middle of
  // a pubkey.
  const data = Buffer.concat([
    computeDiscriminator("initialize_config"),
    encodeU16(params.defaultProtocolFeeRate),
  ]);
  const keys: AccountMeta[] = [
    { pubkey: params.config, isSigner: true, isWritable: true },
    { pubkey: treasuryPda, isSigner: true, isWritable: false },
    { pubkey: params.payer, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({
    programId: cfg.programs.cofferPool,
    keys,
    data,
  });
}

/**
 * `protocol_admin::pool_initialize_config` — the ONLY way to create a
 * `CofferPoolConfig` that a wallet can actually sign.
 *
 * `coffer_pool::initialize_config` takes the Treasury PDA as a `Signer`
 * (audit H-01: an unauthenticated config let anyone open a pool that charged
 * a swap fee and paid the protocol nothing). A PDA cannot sign a transaction
 * — only the program that owns its seeds can, via `invoke_signed`. So the
 * direct instruction is unreachable from a wallet by design, and every caller
 * has to come through this wrapper, where the Treasury `admin` is the human
 * signer and protocol-admin performs the CPI.
 *
 * Signers: `admin` (must equal `Treasury.admin`) and `config` (a freshly
 * generated keypair — the account is `init`, not a PDA).
 */
export function buildPoolInitializeConfigIx(
  cfg: CofferConfig,
  params: { config: PublicKey; admin: PublicKey; defaultProtocolFeeRate: number }
): TransactionInstruction {
  const [treasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    cfg.programs.protocolAdmin
  );
  const data = Buffer.concat([
    PROTOCOL_ADMIN_DISC.poolInitializeConfig,
    encodeU16(params.defaultProtocolFeeRate),
  ]);
  const keys: AccountMeta[] = [
    { pubkey: treasuryPda, isSigner: false, isWritable: false },
    { pubkey: params.admin, isSigner: true, isWritable: true },
    { pubkey: params.config, isSigner: true, isWritable: true },
    { pubkey: cfg.programs.cofferPool, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({
    programId: cfg.programs.protocolAdmin,
    keys,
    data,
  });
}

/** Range check shared by the three bps arguments of `initialize_pool` / the setters. */
function u16Bps(value: number, name: string, max: number, errorName: string): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${name} must be an integer 0..=${max} (${errorName})`);
  }
  return encodeU16(value);
}

/**
 * `initialize_pool` — v6.1 ABI:
 *
 * ```text
 *   (normalized_weights: Vec<u64>, initial_virtual_balances: Vec<u64>,
 *    swap_fee_rate: u32, pool_id: u64,
 *    lp_metadata: LpMetadataArgs,            // T1  (3 Borsh strings)
 *    creator_fee_bps: u16,                   // T14
 *    deposit_fee_bps: u16, withdraw_fee_bps: u16,   // T7
 *    hook_config: Option<HookConfig>)        // T9  (1 tag byte [+ 47])
 * ```
 *
 * Accounts `[config, pool w, lp_mint w, payer w s, lp_token_program,
 * associated_token_program, system_program]`; remaining = one mint per
 * token (THE token set, in `weightsBps` order) then — iff `hookConfig` —
 * the `hookConfig.accountsLen` accounts of the hook slice.
 *
 * `lpTokenProgram` MUST be Token-2022 (v6.1 LP mints carry in-mint
 * metadata); the LP mint's decimals are pinned to 9 on-chain. The metadata
 * and the three bps are validated with the program's rules before encoding
 * (`LpNameInvalid` 6076 / `LpSymbolInvalid` 6077 / `LpUriInvalid` 6078,
 * `CreatorFeeBpsMaxExceeded` 6079, `LiquidityFeeMaxExceeded` 6083,
 * `HookInvalidConfig` 6098).
 */
export function buildInitializePoolIx(
  cfg: CofferConfig,
  params: DeployPoolParamsV61
): TransactionInstruction {
  const lpTokenProgram = params.lpTokenProgram ?? TOKEN_2022_PROGRAM_ID;
  if (!lpTokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error("initialize_pool: lpTokenProgram must be Token-2022 — v6.1 LP mints carry in-mint metadata (TokenProgramMismatch)");
  }
  const n = params.tokens.length;
  if (n < 2 || n > 10) throw new Error(`initialize_pool: token count ${n} outside [2, 10] (InvalidTokenCount)`);
  if (params.weightsBps.length !== n || params.virtualBalances.length !== n) {
    throw new Error("initialize_pool: tokens / weightsBps / virtualBalances must have the same length");
  }
  for (let i = 0; i < n; i++) {
    const vb = params.virtualBalances[i];
    if (!BN.isBN(vb) || vb.isNeg() || vb.bitLength() > 64) throw new Error(`initialize_pool: virtualBalances[${i}] must be an unsigned 64-bit BN`);
    if (vb.isZero()) throw new Error(`initialize_pool: virtualBalances[${i}] must be > 0 (InvalidVirtualBalances)`);
  }
  // v6.1 (T22): a chosen virtual balance must meet the per-slot floor
  // `max(10^decimals, 1000)` raw (`VirtualBalanceBelowFloor`, 6105).
  if (params.tokenDecimals) {
    if (params.tokenDecimals.length !== n) throw new Error("initialize_pool: tokenDecimals must have one entry per token");
    for (let i = 0; i < n; i++) {
      const floor = minVirtualBalance(params.tokenDecimals[i]);
      if (BigInt(params.virtualBalances[i].toString()) < floor) {
        throw new Error(`initialize_pool: virtualBalances[${i}] = ${params.virtualBalances[i]} is below the floor ${floor} for ${params.tokenDecimals[i]} decimals (VirtualBalanceBelowFloor, 6105)`);
      }
    }
  }
  const lpMetadata = validateLpMetadata(params.lpMetadata);
  const hookConfig = params.hookConfig ?? null;
  if (hookConfig) validateHookConfig(hookConfig, cfg.programs.cofferPool);
  const hookAccounts = hookConfig ? (params.hookAccounts ?? []) : [];
  if (hookConfig && hookAccounts.length !== hookConfig.accountsLen) {
    throw new Error(`initialize_pool: hookAccounts length ${hookAccounts.length} != hookConfig.accountsLen ${hookConfig.accountsLen} (HookAccountsInvalid)`);
  }
  if (!hookConfig && params.hookAccounts?.length) {
    throw new Error("initialize_pool: hookAccounts given without a hookConfig — they would be read as extra mints");
  }
  if (hookConfig && !hookAccounts[0].pubkey.equals(hookConfig.program)) {
    throw new Error("initialize_pool: hookAccounts[0] must be the hook program");
  }

  const [pool] = derivePoolPda(cfg.programs.cofferPool, params.configKey, params.poolId);
  const [lpMint] = deriveLpMint(cfg.programs.cofferPool, pool);

  const data = Buffer.concat([
    COFFER_POOL_DISC.initializePool,
    encodeVecU64(params.weightsBps.map((w) => new BN(w))),
    encodeVecU64(params.virtualBalances),
    encodeU32(params.swapFeeRate),
    encodeU64(params.poolId),
    encodeLpMetadataArgs(lpMetadata),
    u16Bps(params.creatorFeeBps ?? 0, "creatorFeeBps", MAX_CREATOR_FEE_BPS, "CreatorFeeBpsMaxExceeded"),
    u16Bps(params.depositFeeBps ?? 0, "depositFeeBps", MAX_LIQUIDITY_FEE_BPS, "LiquidityFeeMaxExceeded"),
    u16Bps(params.withdrawFeeBps ?? 0, "withdrawFeeBps", MAX_LIQUIDITY_FEE_BPS, "LiquidityFeeMaxExceeded"),
    encodeOptionHookConfig(hookConfig),
  ]);

  // There is no `tokens` ix arg — the pool's token set is defined SOLELY by
  // `params.tokens` via remaining_accounts (one mint per token, in the same
  // order as `weightsBps`/`virtualBalances`), followed by the hook slice.
  const remaining: AccountMeta[] = [
    ...params.tokens.map((m) => ({ pubkey: m, isSigner: false, isWritable: false })),
    ...hookAccounts.map((meta) => {
      if (meta.isSigner) throw new Error(`initialize_pool: hook slice accounts cannot be signers (${meta.pubkey.toBase58()})`);
      return { pubkey: meta.pubkey, isSigner: false, isWritable: meta.isWritable };
    }),
  ];

  const keys: AccountMeta[] = [
    { pubkey: params.configKey, isSigner: false, isWritable: false },
    { pubkey: pool, isSigner: false, isWritable: true },
    { pubkey: lpMint, isSigner: false, isWritable: true },
    { pubkey: params.payer, isSigner: true, isWritable: true },
    { pubkey: lpTokenProgram, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ...remaining,
  ];

  return new TransactionInstruction({
    programId: cfg.programs.cofferPool,
    keys,
    data,
  });
}

/**
 * `initialize_pool` alone, with a CU budget. The pool is NOT tradable after
 * this (no reserves, `PoolNotSeeded`): the creator must `seed_liquidity`.
 * Prefer `buildAtomicDeploy` (`clients/atomicDeploy.ts`), which packs init +
 * ATAs + seed into one signing prompt.
 */
export function buildDeployPoolTx(cfg: CofferConfig, params: DeployPoolParamsV61): BuiltTx {
  return {
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      buildInitializePoolIx(cfg, params),
    ],
    suggestedCuLimit: 400_000,
  };
}

/**
 * `set_swaps_enabled(enabled)` signed directly by the pool admin
 * (`[config, pool w, authority s]`). No cooldown (T3): "open trading" after a
 * paused launch is instant. The protocol-admin route is
 * `AdminClient.setSwapsEnabledIx`.
 */
export function buildSetSwapsEnabledIx(cfg: CofferConfig, config: PublicKey, pool: PublicKey, authority: PublicKey, enabled: boolean): TransactionInstruction {
  return buildContractInstruction(cfg, "cofferPool", "set_swaps_enabled", { enabled }, { config, pool, authority });
}

/**
 * v6.1 (T9) raw `coffer_pool::set_hook_disabled(disabled)` —
 * `[config, pool w, authority s]` where `authority` MUST be
 * `config.protocol_admin` (the Treasury PDA). No wallet can sign that: the
 * callable route is `AdminClient.setHookDisabledIx` (`pool_set_hook_disabled`
 * CPIs in here). Kept for the wire format; bypasses every cooldown queue in
 * both directions (an emergency switch).
 */
export function buildSetHookDisabledIx(cfg: CofferConfig, config: PublicKey, pool: PublicKey, authority: PublicKey, disabled: boolean): TransactionInstruction {
  if (typeof disabled !== "boolean") throw new Error("set_hook_disabled: disabled must be a boolean");
  return buildContractInstruction(cfg, "cofferPool", "set_hook_disabled", { disabled }, { config, pool, authority });
}

/**
 * v6.1 (T22) raw `coffer_pool::rescale_virtual_balances(multiplier)` —
 * `[config, pool w, authority s]`, `authority` = `config.protocol_admin` (the
 * Treasury PDA; callable only through
 * `AdminClient.poolRescaleVirtualBalancesIx` / the kind-13 cooldown slot).
 * Multiplies every slot's `virtual_balance` by `multiplier ≥ 2`
 * (`InvalidVirtualRescale`); the result must satisfy `V > A` and the
 * per-slot floor. Allowed on a frozen pool. Preview with
 * `applyRescale` / `CofferPoolClient.quoteRescaleVirtualBalances`.
 */
export function buildRescaleVirtualBalancesIx(cfg: CofferConfig, config: PublicKey, pool: PublicKey, authority: PublicKey, multiplier: BN | bigint | number): TransactionInstruction {
  const m = BN.isBN(multiplier) ? multiplier : new BN(multiplier.toString());
  if (m.isNeg() || m.bitLength() > 64) throw new Error("rescale_virtual_balances: multiplier must be an unsigned 64-bit integer");
  if (m.ltn(2)) throw new Error("rescale_virtual_balances: multiplier must be ≥ 2 (InvalidVirtualRescale)");
  return buildContractInstruction(cfg, "cofferPool", "rescale_virtual_balances", { multiplier: m }, { config, pool, authority });
}

// ============================================================
// initialize_pool_alt — per-pool Address Lookup Table
// ============================================================

export interface InitializePoolAltParams {
  /** Pool PDA. */
  pool: PublicKey;
  /** `CofferPoolConfig` account this pool is pinned to. Read by the
   *  program to gate the alternative-authority path (`config.protocol_admin`). */
  config: PublicKey;
  /** Authority. Must equal either `pool.pool_admin` (per-pool owner
   *  path) or `config.protocol_admin` (Treasury PDA via the
   *  protocol-admin CPI wrapper). The ALT address is derived from
   *  `[authority, recent_slot]`. */
  authority: PublicKey;
  /** Rent payer. Decoupled from `authority` so the wrapper path can
   *  pay from a regular wallet while Treasury PDA acts as authority.
   *  In the pool-admin path pass the same key for both. */
  payer: PublicKey;
  /**
   * Recent slot. Used by the upstream ALT program to derive the table
   * address as `[authority, recent_slot]`. Must be a slot the runtime
   * still has in slot-hashes — caller should pass
   * `await connection.getSlot('finalized')`.
   */
  recentSlot: BN;
}

/**
 * Re-derives the Address Lookup Table address from `(authority, recent_slot)`
 * the same way the upstream ALT program does.
 *
 * `@solana/web3.js` v1 doesn't expose `deriveLookupTableAddress` as a static,
 * so we inline the seed derivation.
 */
export function deriveAltAddress(authority: PublicKey, recentSlot: BN): PublicKey {
  const slotBuf = recentSlot.toArrayLike(Buffer, "le", 8);
  const [addr] = PublicKey.findProgramAddressSync(
    [authority.toBuffer(), slotBuf],
    AddressLookupTableProgram.programId,
  );
  return addr;
}

/**
 * Build the on-chain `initialize_pool_alt` instruction. Performs three
 * upstream CPIs inside the program: create + extend + freeze. After
 * this ix lands, the ALT is immutable and the pool's `lookup_table`
 * field points at it.
 *
 * Caller must NOT use the ALT in the same slot (warmup) — wait at
 * least one slot before sending any v0 tx that references it.
 */
export function buildInitializePoolAltIx(
  cfg: CofferConfig,
  params: InitializePoolAltParams,
): TransactionInstruction {
  const altAddr = deriveAltAddress(params.authority, params.recentSlot);

  const data = Buffer.concat([
    COFFER_POOL_DISC.initializePoolAlt,
    encodeU64(params.recentSlot),
  ]);

  // Account order MUST match coffer-pool's InitializePoolAlt context:
  //   pool, config, authority, payer, lookup_table, system_program, alt_program.
  const keys: AccountMeta[] = [
    { pubkey: params.pool, isSigner: false, isWritable: true },
    { pubkey: params.config, isSigner: false, isWritable: false },
    { pubkey: params.authority, isSigner: true, isWritable: false },
    { pubkey: params.payer, isSigner: true, isWritable: true },
    { pubkey: altAddr, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: AddressLookupTableProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: cfg.programs.cofferPool,
    keys,
    data,
  });
}

export function buildInitializePoolAltTx(
  cfg: CofferConfig,
  params: InitializePoolAltParams,
): BuiltTx & { lookupTable: PublicKey } {
  return {
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      buildInitializePoolAltIx(cfg, params),
    ],
    suggestedCuLimit: 200_000,
    lookupTable: deriveAltAddress(params.authority, params.recentSlot),
  };
}

// ============================================================
// Range manager
// ============================================================

/**
 * `set_range_manager` — appoint or disable a pool's range manager.
 *
 * ⚠ v5.1 (audit L-1) PREPENDED a `config` account before `pool`. The
 * account list is `[config, pool, authority]`. A client still sending
 * `[pool, authority]` has the program read the pool account as the config
 * and fail on the discriminator, or worse pass a lookalike.
 *
 * Pool admin can appoint or change the manager. The contract also accepts a
 * config protocol-admin signer for disable-only updates that retain the current
 * manager key; the deployed protocol-admin program has no CPI wrapper for it. Combine
 * `newManager = PublicKey.default` with `enabled = false` for the fully
 * disabled state.
 */
export function buildSetRangeManagerIx(
  cfg: CofferConfig,
  pool: PublicKey,
  params: SetRangeManagerParams,
): TransactionInstruction {
  const data = Buffer.concat([
    COFFER_POOL_DISC.setRangeManager,
    params.newManager.toBuffer(),
    encodeBool(params.enabled),
  ]);
  const keys: AccountMeta[] = [
    { pubkey: params.config, isSigner: false, isWritable: false },
    { pubkey: pool, isSigner: false, isWritable: true },
    { pubkey: params.authority, isSigner: true, isWritable: false },
  ];
  return new TransactionInstruction({ programId: cfg.programs.cofferPool, keys, data });
}

/**
 * `set_range_manager_config` — the range manager's movement envelope.
 *
 * v5.1 appended `max_leverage_bps` and `min_leverage_bps` to the argument
 * list. Both are required; pass `0` to leave a bound disabled.
 */
export function buildSetRangeManagerConfigIx(
  cfg: CofferConfig,
  pool: PublicKey,
  params: SetRangeManagerConfigParams,
): TransactionInstruction {
  const data = Buffer.concat([
    COFFER_POOL_DISC.setRangeManagerConfig,
    encodeU16(params.maxVbChangePct),
    encodeU16(params.maxWeightChangePct),
    encodeU32(params.minUpdateIntervalSecs),
    encodeU32(params.maxLeverageBps),
    encodeU32(params.minLeverageBps),
  ]);
  const keys: AccountMeta[] = [
    { pubkey: pool, isSigner: false, isWritable: true },
    { pubkey: params.authority, isSigner: true, isWritable: false },
  ];
  return new TransactionInstruction({ programId: cfg.programs.cofferPool, keys, data });
}

/**
 * `range_manager_update` — sparse compare-and-swap over virtual balances
 * and/or weights.
 *
 * Every {@link TokenChange} carries an `expectedCurrent` guard (v5.1, audit
 * M-6). The program reverts the whole instruction with
 * `RangeManagerStaleValue` (6061) if any entry no longer matches the stored
 * value, so a bot MUST derive `expectedCurrent` and `newValue` from the
 * same pool read and retry from a fresh read on failure — never re-send the
 * same payload.
 *
 * The instruction also honours the pool kill switch now: it reverts while
 * `pool_enabled` is false.
 */
export function buildRangeManagerUpdateIx(
  cfg: CofferConfig,
  pool: PublicKey,
  params: RangeManagerUpdateParams,
): TransactionInstruction {
  const vbChanges = params.vbChanges ?? [];
  const weightChanges = params.weightChanges ?? [];
  if (vbChanges.length === 0 && weightChanges.length === 0) {
    // `RangeManagerEmptyUpdate` (6044) — cheaper to catch here.
    throw new Error("range_manager_update: must change at least one virtual balance or weight");
  }
  const data = Buffer.concat([
    COFFER_POOL_DISC.rangeManagerUpdate,
    encodeVecTokenChange(vbChanges),
    encodeVecTokenChange(weightChanges),
  ]);
  const keys: AccountMeta[] = [
    { pubkey: pool, isSigner: false, isWritable: true },
    { pubkey: params.authority, isSigner: true, isWritable: false },
  ];
  return new TransactionInstruction({ programId: cfg.programs.cofferPool, keys, data });
}

/** Set the pool-local swap fee (hundredths of a basis point). */
export function buildSetSwapFeeRateIx(cfg: CofferConfig, pool: PublicKey, authority: PublicKey, swapFeeRate: number): TransactionInstruction {
  return buildContractInstruction(cfg, "cofferPool", "set_swap_fee_rate", { swap_fee_rate: swapFeeRate }, { pool, authority });
}

/** Replace every token's sell-off policy, including both kink parameters. */
export function buildSetMaxSelloffIx(cfg: CofferConfig, pool: PublicKey, authority: PublicKey, params: SelloffParams[]): TransactionInstruction {
  return buildContractInstruction(cfg, "cofferPool", "set_max_selloff", { params: params.map(p => ({
    max_selloff_pct: p.maxSelloffPct, period_length: p.periodLength,
    fee_threshold_pct: p.feeThresholdPct, fee_slope_low_pct: p.feeSlopeLowPct,
    fee_slope_high_pct: p.feeSlopeHighPct, fee_slope_mid_pct: p.feeSlopeMidPct,
    fee_kink_pct: p.feeKinkPct,
  })) }, { pool, authority });
}

export function buildInitiatePoolAdminTransferIx(cfg: CofferConfig, pool: PublicKey, authority: PublicKey, newAdmin: PublicKey): TransactionInstruction {
  return buildContractInstruction(cfg, "cofferPool", "initiate_pool_admin_transfer", { new_admin: newAdmin }, { pool, authority });
}

export function buildAcceptPoolAdminTransferIx(cfg: CofferConfig, pool: PublicKey, newAdmin: PublicKey): TransactionInstruction {
  return buildContractInstruction(cfg, "cofferPool", "accept_pool_admin_transfer", {}, { pool, new_admin: newAdmin });
}

export function buildCancelPoolAdminTransferIx(cfg: CofferConfig, pool: PublicKey, authority: PublicKey): TransactionInstruction {
  return buildContractInstruction(cfg, "cofferPool", "cancel_pool_admin_transfer", {}, { pool, authority });
}

/** Permanently renounce the pool-local admin role. */
export function buildDisablePoolAdminIx(cfg: CofferConfig, pool: PublicKey, authority: PublicKey): TransactionInstruction {
  return buildContractInstruction(cfg, "cofferPool", "disable_pool_admin", {}, { pool, authority });
}

// ============================================================
// v6.1 pool-admin setters (direct instructions; under a non-zero
// `pool_admin_delay_secs` each must go through `propose_pool_action` →
// `execute_*` instead — see `clients/cooldown.ts`)
// ============================================================

/** T14: `set_creator_fee_bps(bps)` — pool admin's share of the LP fee remainder, 0..=10_000. */
export function buildSetCreatorFeeBpsIx(cfg: CofferConfig, pool: PublicKey, authority: PublicKey, creatorFeeBps: number): TransactionInstruction {
  u16Bps(creatorFeeBps, "creatorFeeBps", MAX_CREATOR_FEE_BPS, "CreatorFeeBpsMaxExceeded");
  return buildContractInstruction(cfg, "cofferPool", "set_creator_fee_bps", { creator_fee_bps: creatorFeeBps }, { pool, authority });
}

/**
 * T7: `set_liquidity_fees(deposit_fee_bps, withdraw_fee_bps)`, each
 * 0..=10_000 (`LiquidityFeeMaxExceeded`); refused for ever once
 * `lock_liquidity_fees` ran (`LiquidityFeesLocked`).
 */
export function buildSetLiquidityFeesIx(cfg: CofferConfig, pool: PublicKey, authority: PublicKey, depositFeeBps: number, withdrawFeeBps: number): TransactionInstruction {
  u16Bps(depositFeeBps, "depositFeeBps", MAX_LIQUIDITY_FEE_BPS, "LiquidityFeeMaxExceeded");
  u16Bps(withdrawFeeBps, "withdrawFeeBps", MAX_LIQUIDITY_FEE_BPS, "LiquidityFeeMaxExceeded");
  return buildContractInstruction(cfg, "cofferPool", "set_liquidity_fees", { deposit_fee_bps: depositFeeBps, withdraw_fee_bps: withdrawFeeBps }, { pool, authority });
}

/** T7: `lock_liquidity_fees` — IRREVERSIBLE: the deposit / withdraw fees can never change again. */
export function buildLockLiquidityFeesIx(cfg: CofferConfig, pool: PublicKey, authority: PublicKey): TransactionInstruction {
  return buildContractInstruction(cfg, "cofferPool", "lock_liquidity_fees", {}, { pool, authority });
}

/**
 * T6: `lock_range_manager` — IRREVERSIBLE: the pool can never have a range
 * manager again. Requires the manager to be unset first
 * (`RangeManagerMustBeUnset`).
 */
export function buildLockRangeManagerIx(cfg: CofferConfig, pool: PublicKey, authority: PublicKey): TransactionInstruction {
  return buildContractInstruction(cfg, "cofferPool", "lock_range_manager", {}, { pool, authority });
}

/**
 * T3: `set_pool_admin_delay(secs)` — the pool-admin cooldown (0..=30 days).
 * Raising it from 0 is instant; once non-zero, changing it (and every other
 * admin setter) goes through the propose → wait → execute queue.
 */
export function buildSetPoolAdminDelayIx(cfg: CofferConfig, pool: PublicKey, authority: PublicKey, secs: number): TransactionInstruction {
  if (!Number.isInteger(secs) || secs < 0 || secs > 30 * 86_400) throw new Error("set_pool_admin_delay: secs must be 0..=2_592_000 (DelayTooLarge)");
  return buildContractInstruction(cfg, "cofferPool", "set_pool_admin_delay", { secs }, { pool, authority });
}

export function buildGetPoolInfoIx(cfg: CofferConfig, pool: PublicKey): TransactionInstruction {
  return buildContractInstruction(cfg, "cofferPool", "get_pool_info", {}, { pool });
}

// ============================================================
// Borsh encoding helpers (subset used above)
// ============================================================

function encodeU8(v: number): Buffer {
  const b = Buffer.alloc(1);
  requireUnsignedNumber(v, 8);
  b.writeUInt8(v, 0);
  return b;
}
function encodeU16(v: number): Buffer {
  const b = Buffer.alloc(2);
  requireUnsignedNumber(v, 16);
  b.writeUInt16LE(v, 0);
  return b;
}
function encodeU32(v: number): Buffer {
  const b = Buffer.alloc(4);
  requireUnsignedNumber(v, 32);
  b.writeUInt32LE(v, 0);
  return b;
}
function requireUnsignedNumber(value: number, bits: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** bits) {
    throw new Error(`Expected an unsigned ${bits}-bit integer`);
  }
}
function encodeU64(v: BN): Buffer {
  if (!BN.isBN(v) || v.isNeg() || v.bitLength() > 64) throw new Error("Expected an unsigned 64-bit BN");
  return v.toArrayLike(Buffer, "le", 8);
}
function encodeVecU64(vs: BN[]): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(vs.length, 0);
  return Buffer.concat([len, ...vs.map(encodeU64)]);
}
function encodeBool(v: boolean): Buffer {
  if (typeof v !== "boolean") throw new Error("Expected boolean");
  return Buffer.from([v ? 1 : 0]);
}
/**
 * Borsh `TokenChange { index: u8, expected_current: u64, new_value: u64 }`.
 *
 * Field order verified against the `TokenChange` type in
 * `src/idl/coffer_pool.json`. `expected_current` sits IN THE MIDDLE — it was
 * inserted between `index` and `new_value`, not appended. Encoding it last
 * produces a 17-byte record the program happily parses as
 * `(index, new_value=expected, expected=new)`, which either reverts as
 * stale or writes the wrong value.
 */
function encodeTokenChange(c: TokenChange): Buffer {
  return Buffer.concat([encodeU8(c.index), encodeU64(c.expectedCurrent), encodeU64(c.newValue)]);
}
function encodeVecTokenChange(cs: TokenChange[]): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(cs.length, 0);
  return Buffer.concat([len, ...cs.map(encodeTokenChange)]);
}
