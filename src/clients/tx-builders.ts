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
import { CofferConfig, MIN_LP_SUPPLY } from "../config";
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
import { deriveAta, deriveLpMint, derivePoolPda } from "../utils/pda";
import { buildContractInstruction } from "./contract-instructions";
import { calcTokensOutGivenLpIn, calcLpOutGivenExactTokensIn } from "../math/poolMath";
import { netOfTransferFee } from "../math/transferFee";
import { assertTokensSupported } from "../utils/extensions";

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
  addLiquidity: computeDiscriminator("add_liquidity"),
  removeLiquidity: computeDiscriminator("remove_liquidity"),
  initializePool: computeDiscriminator("initialize_pool"),
  initializePoolAlt: computeDiscriminator("initialize_pool_alt"),
  setRangeManager: computeDiscriminator("set_range_manager"),
  setRangeManagerConfig: computeDiscriminator("set_range_manager_config"),
  rangeManagerUpdate: computeDiscriminator("range_manager_update"),
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

export function buildSwapIx(
  cfg: CofferConfig,
  pool: PoolInfo,
  params: SwapParams & { minAmountOut: BN }
): TransactionInstruction {
  assertTokensSupported(pool, [params.tokenInIndex, params.tokenOutIndex], "swap");
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

export function buildSwapTx(
  cfg: CofferConfig,
  pool: PoolInfo,
  params: SwapParams & { minAmountOut: BN }
): BuiltTx {
  return {
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      buildSwapIx(cfg, pool, params),
    ],
    suggestedCuLimit: 400_000,
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
  params: AddLiquidityParams
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
  params: AddLiquidityParams
): BuiltTx {
  const userLp = deriveAta(params.user, pool.lpMint, lpProgram(pool));
  return {
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      createAssociatedTokenAccountIdempotentInstruction(
        params.user,
        userLp,
        params.user,
        pool.lpMint,
        lpProgram(pool)
      ),
      buildAddLiquidityIx(cfg, pool, params),
    ],
    suggestedCuLimit: 600_000,
  };
}

// ============================================================
// Remove liquidity
// ============================================================

export function buildRemoveLiquidityIx(
  cfg: CofferConfig,
  pool: PoolInfo,
  params: RemoveLiquidityParams
): TransactionInstruction {
  const supply = pool.lpTotalSupply;
  const maxBurn = BN.max(supply.sub(new BN(MIN_LP_SUPPLY.toString())), new BN(0));
  const effectiveBurn = BN.min(params.lpAmount, maxBurn);
  const transferred = supply.gt(new BN(0))
    ? calcTokensOutGivenLpIn(pool.tokens.map(token => BigInt(token.actualBalance.toString())), BigInt(effectiveBurn.toString()), BigInt(supply.toString()))
        .flatMap((amount, i) => amount > 0n ? [i] : [])
    : [];
  assertTokensSupported(pool, transferred, "remove_liquidity");
  const userLp = deriveAta(params.user, pool.lpMint, lpProgram(pool));
  const mins = requireExplicitMinimums(params.minimumTokenAmounts, pool.tokenCount, "remove_liquidity");

  const data = Buffer.concat([
    COFFER_POOL_DISC.removeLiquidity,
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
    ...tail(params.extraAccounts, "remove_liquidity"),
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
  params: RemoveLiquidityParams
): BuiltTx {
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cfg.defaults.cuLimit }),
  ];

  // The contract transfers every pool token to the user's ATA. Include
  // idempotent creates so a proportional burn works even when the user never
  // held one of the receive tokens before.
  for (const t of pool.tokens) {
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

  ixs.push(buildRemoveLiquidityIx(cfg, pool, params));

  return {
    instructions: ixs,
    suggestedCuLimit: cfg.defaults.cuLimit,
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

export function buildInitializePoolIx(
  cfg: CofferConfig,
  params: DeployPoolParams
): TransactionInstruction {
  const tokenProgram = params.lpTokenProgram ?? TOKEN_PROGRAM_ID;
  const [pool] = derivePoolPda(cfg.programs.cofferPool, params.configKey, params.poolId);
  const [lpMint] = deriveLpMint(cfg.programs.cofferPool, pool);

  // Args: `(normalized_weights: Vec<u64>, initial_virtual_balances: Vec<u64>,
  // swap_fee_rate: u32, pool_id: u64)`. v6.1 (T19) removed the trailing
  // `banned_extensions_override: Option<u64>`; the policy no longer exists,
  // so nothing is encoded after `pool_id`.
  const data = Buffer.concat([
    COFFER_POOL_DISC.initializePool,
    encodeVecU64(params.weightsBps.map((w) => new BN(w))),
    encodeVecU64(params.virtualBalances),
    encodeU32(params.swapFeeRate),
    encodeU64(params.poolId),
  ]);

  // There is no `tokens` ix arg — the pool's token set is defined SOLELY by
  // `params.tokens` via remaining_accounts (one mint per token, in the same
  // order as `weightsBps`/`virtualBalances`).
  const remaining: AccountMeta[] = params.tokens.map((m) => ({
    pubkey: m,
    isSigner: false,
    isWritable: false,
  }));

  const keys: AccountMeta[] = [
    { pubkey: params.configKey, isSigner: false, isWritable: false },
    { pubkey: pool, isSigner: false, isWritable: true },
    { pubkey: lpMint, isSigner: false, isWritable: true },
    { pubkey: params.payer, isSigner: true, isWritable: true },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
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

export function buildDeployPoolTx(cfg: CofferConfig, params: DeployPoolParams): BuiltTx {
  return {
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      buildInitializePoolIx(cfg, params),
    ],
    suggestedCuLimit: 400_000,
  };
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
