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
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import { CubeConfig } from "../config";
import { CUBIC_POOL_IDL, PROTOCOL_ADMIN_IDL, SINGLE_TOKEN_LIQUIDITY_IDL } from "../idl";
import { PoolInfo } from "../types/pool";
import {
  AddLiquidityParams,
  BuiltTx,
  DeployPoolParams,
  RangeManagerUpdateParams,
  RemoveLiquidityParams,
  SetRangeManagerConfigParams,
  SetRangeManagerParams,
  SingleTokenDepositParams,
  SwapParams,
  TokenChange,
} from "../types/tx";
import { deriveAta, deriveBptMint, deriveHelperPda } from "../utils/pda";

/**
 * Low-level transaction builders. Emit raw `TransactionInstruction`s suitable
 * for combination with others (e.g. versioned transactions with ALTs) in a
 * single tx. Higher-level convenience lives on `CubicPoolClient`.
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
 * NOTE: declared before `CUBIC_POOL_DISC` on purpose. Those maps call
 * `computeDiscriminator` at module-evaluation time, and a `const` declared
 * after them would still be in its temporal dead zone when they run.
 */
const PINNED: Record<string, string> = {
  swap: "f8c69e91e17587c8",
  add_liquidity: "b59d59438fb63448",
  remove_liquidity: "5055d14818ceb16c",
  initialize_cubic_pool: "d79474cf79686f83",
  initialize_pool_alt: "fb874202f4490c90",
  deposit_single_token: "a688a62fc7c056a9",
  initialize_config: "d07f1501c2bec446",
  set_range_manager: "6766ad7008022584",
  set_range_manager_config: "67d300c8a4bdf5cd",
  range_manager_update: "f5b72345c80aac2c",
  pool_initialize_config: "d06eadbc279990b9",
};

function computeDiscriminator(
  ixName: string,
  idl: "cubicPool" | "stld" | "protocolAdmin" = "cubicPool",
): Buffer {
  const source =
    idl === "stld"
      ? SINGLE_TOKEN_LIQUIDITY_IDL
      : idl === "protocolAdmin"
        ? PROTOCOL_ADMIN_IDL
        : CUBIC_POOL_IDL;
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

const CUBIC_POOL_DISC = {
  swap: computeDiscriminator("swap"),
  addLiquidity: computeDiscriminator("add_liquidity"),
  removeLiquidity: computeDiscriminator("remove_liquidity"),
  initializeCubicPool: computeDiscriminator("initialize_cubic_pool"),
  initializePoolAlt: computeDiscriminator("initialize_pool_alt"),
  setRangeManager: computeDiscriminator("set_range_manager"),
  setRangeManagerConfig: computeDiscriminator("set_range_manager_config"),
  rangeManagerUpdate: computeDiscriminator("range_manager_update"),
};

const PROTOCOL_ADMIN_DISC = {
  poolInitializeConfig: computeDiscriminator("pool_initialize_config", "protocolAdmin"),
};

const STLD_DISC = {
  depositSingleToken: computeDiscriminator("deposit_single_token", "stld"),
};

function requirePositiveMinimumBpt(minimumBptAmount: BN | undefined, ixName: string): BN {
  if (!minimumBptAmount || minimumBptAmount.lte(new BN(0))) {
    throw new Error(`${ixName}: minimumBptAmount must be positive`);
  }
  return minimumBptAmount;
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
  cfg: CubeConfig,
  pool: PoolInfo,
  params: SwapParams & { minAmountOut: BN }
): TransactionInstruction {
  const inTok = pool.tokens[params.tokenInIndex];
  const outTok = pool.tokens[params.tokenOutIndex];

  const userTokenIn = deriveAta(params.user, inTok.mint, inTok.tokenProgram);
  const userTokenOut = deriveAta(params.user, outTok.mint, outTok.tokenProgram);

  const data = Buffer.concat([
    CUBIC_POOL_DISC.swap,
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
  ];

  return new TransactionInstruction({
    programId: cfg.programs.cubicPool,
    keys,
    data,
  });
}

export function buildSwapTx(
  cfg: CubeConfig,
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
 * instead (see `CubicPoolClient.quoteAddLiquidity`).
 *
 * The wire format is unchanged, so this is a behaviour note, not an
 * encoding change: the same bytes now mean "at most this much".
 */
export function buildAddLiquidityIx(
  cfg: CubeConfig,
  pool: PoolInfo,
  params: AddLiquidityParams
): TransactionInstruction {
  const userBpt = deriveAta(params.user, pool.bptMint, TOKEN_PROGRAM_ID);
  const minBpt = requirePositiveMinimumBpt(params.minimumBptAmount, "add_liquidity");
  if (params.tokenAmounts.length !== pool.tokenCount) {
    // The program rejects this with `InvalidArrayLength` (6064); catching it
    // here costs a round trip less.
    throw new Error(
      `add_liquidity: tokenAmounts length (${params.tokenAmounts.length}) ` +
        `must equal the pool's token count (${pool.tokenCount})`
    );
  }

  const data = Buffer.concat([
    CUBIC_POOL_DISC.addLiquidity,
    encodeVecU64(params.tokenAmounts),
    encodeU64(minBpt),
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
    { pubkey: pool.bptMint, isSigner: false, isWritable: true },
    { pubkey: userBpt, isSigner: false, isWritable: true },
    { pubkey: params.user, isSigner: true, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ...remaining,
  ];

  return new TransactionInstruction({
    programId: cfg.programs.cubicPool,
    keys,
    data,
  });
}

export function buildAddLiquidityTx(
  cfg: CubeConfig,
  pool: PoolInfo,
  params: AddLiquidityParams
): BuiltTx {
  const userBpt = deriveAta(params.user, pool.bptMint, TOKEN_PROGRAM_ID);
  return {
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      createAssociatedTokenAccountIdempotentInstruction(
        params.user,
        userBpt,
        params.user,
        pool.bptMint,
        TOKEN_PROGRAM_ID
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
  cfg: CubeConfig,
  pool: PoolInfo,
  params: RemoveLiquidityParams
): TransactionInstruction {
  const userBpt = deriveAta(params.user, pool.bptMint, TOKEN_PROGRAM_ID);
  const mins = requireExplicitMinimums(params.minimumTokenAmounts, pool.tokenCount, "remove_liquidity");

  const data = Buffer.concat([
    CUBIC_POOL_DISC.removeLiquidity,
    encodeU64(params.bptAmount),
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
    { pubkey: pool.bptMint, isSigner: false, isWritable: true },
    { pubkey: userBpt, isSigner: false, isWritable: true },
    { pubkey: params.user, isSigner: true, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ...remaining,
  ];

  return new TransactionInstruction({
    programId: cfg.programs.cubicPool,
    keys,
    data,
  });
}

export function buildRemoveLiquidityTx(
  cfg: CubeConfig,
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
// Single-token deposit (helper program)
// ============================================================

/**
 * Largest pool the zap will accept, mirroring `STLD_MAX_TOKENS` in
 * `single-token-liquidity/src/constants.rs` (which is defined as
 * cubic-pool's `MAX_TOKENS`).
 *
 * Raised from 5 to 10 in v5.1 (audit SF-3): the old ceiling existed because
 * the per-leg allocations exhausted the 32 KiB bump heap. Above this the
 * program rejects with `PoolTooLargeForZap` (stld 6032).
 */
export const STLD_MAX_TOKENS = 10;

/**
 * Compute units to request for the zap.
 *
 * Measured on the v5.1 build at the worst case N=10: 1,073,206 CU for
 * classic SPL and 913,986 CU for Token-2022. 1.4M is the per-transaction
 * maximum and leaves headroom for the surge-fee path.
 */
export const STLD_DEPOSIT_CU_LIMIT = 1_400_000;

export function buildSingleTokenDepositIx(
  cfg: CubeConfig,
  pool: PoolInfo,
  params: SingleTokenDepositParams
): TransactionInstruction {
  // v5 / new contract: deposit_single_token args are
  // (amount_in: u64, token_in_index: u8, minimum_bpt_amount: u64).
  // The old per-call `slippage_hundredths_bps: u32` was removed — the single
  // `minimum_bpt_amount` floor now bounds the whole zap (internal swaps +
  // surge fees + join); per-leg swaps use min_out = 0.
  if (pool.tokenCount > STLD_MAX_TOKENS) {
    throw new Error(
      `deposit_single_token: pool has ${pool.tokenCount} tokens, the zap supports at most ` +
        `${STLD_MAX_TOKENS} (PoolTooLargeForZap). Use add_liquidity instead.`
    );
  }
  const minBpt = requirePositiveMinimumBpt(params.minimumBptAmount, "deposit_single_token");
  const [helper] = deriveHelperPda(cfg.programs.singleTokenLiquidity, pool.address);
  const helperBpt = deriveAta(helper, pool.bptMint, TOKEN_PROGRAM_ID);
  const userBpt = deriveAta(params.user, pool.bptMint, TOKEN_PROGRAM_ID);

  const data = Buffer.concat([
    STLD_DISC.depositSingleToken,
    encodeU64(params.amountIn),
    encodeU8(params.tokenInIndex),
    encodeU64(minBpt),
  ]);

  // stld remaining_accounts: [mint_i, user_ata_i, helper_ata_i, vault_i, tp_i] × N
  const remaining: AccountMeta[] = [];
  for (let i = 0; i < pool.tokenCount; i++) {
    const t = pool.tokens[i];
    const userAta = deriveAta(params.user, t.mint, t.tokenProgram);
    const helperAta = deriveAta(helper, t.mint, t.tokenProgram);
    remaining.push({ pubkey: t.mint, isSigner: false, isWritable: false });
    remaining.push({ pubkey: userAta, isSigner: false, isWritable: true });
    remaining.push({ pubkey: helperAta, isSigner: false, isWritable: true });
    remaining.push({ pubkey: t.vault, isSigner: false, isWritable: true });
    remaining.push({ pubkey: t.tokenProgram, isSigner: false, isWritable: false });
  }

  const keys: AccountMeta[] = [
    { pubkey: pool.address, isSigner: false, isWritable: true },
    { pubkey: helper, isSigner: false, isWritable: false },
    { pubkey: pool.bptMint, isSigner: false, isWritable: true },
    { pubkey: helperBpt, isSigner: false, isWritable: true },
    { pubkey: userBpt, isSigner: false, isWritable: true },
    { pubkey: params.user, isSigner: true, isWritable: true },
    { pubkey: cfg.programs.cubicPool, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ...remaining,
  ];

  return new TransactionInstruction({
    programId: cfg.programs.singleTokenLiquidity,
    keys,
    data,
  });
}

/**
 * The idempotent ATA creates a zap depends on: the user's and the helper's
 * ATA for every pool token, plus both BPT ATAs. `2N + 2` instructions.
 *
 * The helper validates every user ATA up front because it may refund dust
 * in any pool token, so these cannot be trimmed to just the input token.
 */
export function buildSingleTokenDepositAtaIxs(
  cfg: CubeConfig,
  pool: PoolInfo,
  user: PublicKey
): TransactionInstruction[] {
  const [helper] = deriveHelperPda(cfg.programs.singleTokenLiquidity, pool.address);
  const helperBpt = deriveAta(helper, pool.bptMint, TOKEN_PROGRAM_ID);
  const userBpt = deriveAta(user, pool.bptMint, TOKEN_PROGRAM_ID);

  const ixs: TransactionInstruction[] = [];
  // User + helper ATAs (helper has an off-curve owner). Idempotent — safe to
  // include even when the accounts already exist.
  for (const t of pool.tokens) {
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        user,
        deriveAta(user, t.mint, t.tokenProgram),
        user,
        t.mint,
        t.tokenProgram
      )
    );
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        user,
        deriveAta(helper, t.mint, t.tokenProgram),
        helper,
        t.mint,
        t.tokenProgram
      )
    );
  }
  ixs.push(
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      helperBpt,
      helper,
      pool.bptMint,
      TOKEN_PROGRAM_ID
    )
  );
  ixs.push(
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      userBpt,
      user,
      pool.bptMint,
      TOKEN_PROGRAM_ID
    )
  );
  return ixs;
}

/**
 * Full single-token deposit in ONE transaction: idempotent ATA setup
 * followed by the deposit itself.
 *
 * ⚠ **This only fits for small pools.** Two independent runtime ceilings
 * bite as `N` grows, and neither is a byte-size problem an ALT can fix:
 *
 *  - `MAX_INSTRUCTION_TRACE_LENGTH = 64` counts CPI frames across the whole
 *    transaction. One idempotent ATA create costs 5, and the v5.1 zap alone
 *    uses 52/64 at N=10. The `2N + 2` setup instructions cost `10N + 10`
 *    frames, so the combined transaction blows the limit well before N=10.
 *  - Raw size at N=10 is 1796 bytes (437 with the pool's ALT), over the
 *    1232-byte legacy ceiling.
 *
 * For anything but a small pool use {@link buildSingleTokenDepositTxs},
 * which splits setup and deposit into two transactions, and compile the
 * deposit leg through the pool's ALT via `compileBuiltTx`.
 */
export function buildSingleTokenDepositTx(
  cfg: CubeConfig,
  pool: PoolInfo,
  params: SingleTokenDepositParams
): BuiltTx {
  const cuLimit = cfg.defaults.cuLimit ?? STLD_DEPOSIT_CU_LIMIT;
  return {
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
      ...buildSingleTokenDepositAtaIxs(cfg, pool, params.user),
      buildSingleTokenDepositIx(cfg, pool, params),
    ],
    suggestedCuLimit: cuLimit,
  };
}

/**
 * Single-token deposit split into the two transactions large pools need.
 *
 * Send `setup` first and let it confirm, then send `deposit`. They are
 * separated because the ATA creates and the zap compete for the same
 * 64-frame instruction-trace budget (see {@link buildSingleTokenDepositTx}).
 *
 * `setup` is `null` when there is nothing to create — the caller can check
 * ATA existence itself and skip the leg. Otherwise it is always safe to
 * send: every instruction in it is idempotent.
 *
 * The `deposit` leg should be compiled as a v0 transaction against the
 * pool's Address Lookup Table (`compileBuiltTx(conn, user, deposit, pool)`).
 * At N=10 it is 1796 bytes raw and 437 with the ALT — the ALT is mandatory,
 * not an optimisation. Note that an ALT cannot be referenced in the same
 * slot it was extended, so a freshly-created table needs a slot to settle.
 */
export function buildSingleTokenDepositTxs(
  cfg: CubeConfig,
  pool: PoolInfo,
  params: SingleTokenDepositParams
): { setup: BuiltTx | null; deposit: BuiltTx } {
  const ataIxs = buildSingleTokenDepositAtaIxs(cfg, pool, params.user);
  const cuLimit = cfg.defaults.cuLimit ?? STLD_DEPOSIT_CU_LIMIT;
  // ~30k CU per idempotent create, with headroom.
  const setupCu = Math.min(1_400_000, 50_000 * ataIxs.length);

  return {
    setup:
      ataIxs.length === 0
        ? null
        : {
            instructions: [
              ComputeBudgetProgram.setComputeUnitLimit({ units: setupCu }),
              ...ataIxs,
            ],
            suggestedCuLimit: setupCu,
          },
    deposit: {
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
        buildSingleTokenDepositIx(cfg, pool, params),
      ],
      suggestedCuLimit: cuLimit,
    },
  };
}

// ============================================================
// Deploy new pool (PoolFactory)
// ============================================================

/**
 * Raw `cubic_pool::initialize_config`.
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
  cfg: CubeConfig,
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
    programId: cfg.programs.cubicPool,
    keys,
    data,
  });
}

/**
 * `protocol_admin::pool_initialize_config` — the ONLY way to create a
 * `CubicPoolConfig` that a wallet can actually sign.
 *
 * `cubic_pool::initialize_config` takes the Treasury PDA as a `Signer`
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
  cfg: CubeConfig,
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
    { pubkey: cfg.programs.cubicPool, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({
    programId: cfg.programs.protocolAdmin,
    keys,
    data,
  });
}

export function buildInitializeCubicPoolIx(
  cfg: CubeConfig,
  params: DeployPoolParams
): TransactionInstruction {
  const tokenProgram = params.bptTokenProgram ?? TOKEN_PROGRAM_ID;
  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("cubic_pool"), params.configKey.toBuffer(), params.poolId.toArrayLike(Buffer, "le", 8)],
    cfg.programs.cubicPool
  );
  const [bptMint] = deriveBptMint(cfg.programs.cubicPool, pool);

  const data = Buffer.concat([
    CUBIC_POOL_DISC.initializeCubicPool,
    encodeVecU64(params.weightsBps.map((w) => new BN(w))),
    encodeVecU64(params.virtualBalances),
    encodeU32(params.swapFeeRate),
    encodeU64(params.poolId),
    // Option<u64> banned_extensions_override: 0x00 = None (inherit config
    // default), 0x01 + u64 LE = Some(bitmap) chosen by the creator.
    encodeOptionU64(params.bannedExtensions),
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
    { pubkey: bptMint, isSigner: false, isWritable: true },
    { pubkey: params.payer, isSigner: true, isWritable: true },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ...remaining,
  ];

  return new TransactionInstruction({
    programId: cfg.programs.cubicPool,
    keys,
    data,
  });
}

export function buildDeployPoolTx(cfg: CubeConfig, params: DeployPoolParams): BuiltTx {
  return {
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      buildInitializeCubicPoolIx(cfg, params),
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
  /** `CubicPoolConfig` account this pool is pinned to. Read by the
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
  cfg: CubeConfig,
  params: InitializePoolAltParams,
): TransactionInstruction {
  const altAddr = deriveAltAddress(params.authority, params.recentSlot);

  const data = Buffer.concat([
    CUBIC_POOL_DISC.initializePoolAlt,
    encodeU64(params.recentSlot),
  ]);

  // Account order MUST match cubic-pool's InitializePoolAlt context:
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
    programId: cfg.programs.cubicPool,
    keys,
    data,
  });
}

export function buildInitializePoolAltTx(
  cfg: CubeConfig,
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
 * Pool-admin only — protocol-admin cannot reach this instruction. Combine
 * `newManager = PublicKey.default` with `enabled = false` for the fully
 * disabled state.
 */
export function buildSetRangeManagerIx(
  cfg: CubeConfig,
  pool: PublicKey,
  params: SetRangeManagerParams,
): TransactionInstruction {
  const data = Buffer.concat([
    CUBIC_POOL_DISC.setRangeManager,
    params.newManager.toBuffer(),
    encodeBool(params.enabled),
  ]);
  const keys: AccountMeta[] = [
    { pubkey: params.config, isSigner: false, isWritable: false },
    { pubkey: pool, isSigner: false, isWritable: true },
    { pubkey: params.authority, isSigner: true, isWritable: false },
  ];
  return new TransactionInstruction({ programId: cfg.programs.cubicPool, keys, data });
}

/**
 * `set_range_manager_config` — the range manager's movement envelope.
 *
 * v5.1 appended `max_leverage_bps` and `min_leverage_bps` to the argument
 * list. Both are required; pass `0` to leave a bound disabled.
 */
export function buildSetRangeManagerConfigIx(
  cfg: CubeConfig,
  pool: PublicKey,
  params: SetRangeManagerConfigParams,
): TransactionInstruction {
  const data = Buffer.concat([
    CUBIC_POOL_DISC.setRangeManagerConfig,
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
  return new TransactionInstruction({ programId: cfg.programs.cubicPool, keys, data });
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
  cfg: CubeConfig,
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
    CUBIC_POOL_DISC.rangeManagerUpdate,
    encodeVecTokenChange(vbChanges),
    encodeVecTokenChange(weightChanges),
  ]);
  const keys: AccountMeta[] = [
    { pubkey: pool, isSigner: false, isWritable: true },
    { pubkey: params.authority, isSigner: true, isWritable: false },
  ];
  return new TransactionInstruction({ programId: cfg.programs.cubicPool, keys, data });
}

// ============================================================
// Borsh encoding helpers (subset used above)
// ============================================================

function encodeU8(v: number): Buffer {
  const b = Buffer.alloc(1);
  b.writeUInt8(v & 0xff, 0);
  return b;
}
function encodeU16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v & 0xffff, 0);
  return b;
}
function encodeU32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0, 0);
  return b;
}
function encodeU64(v: BN): Buffer {
  return v.toArrayLike(Buffer, "le", 8);
}
/** Borsh `Option<u64>`: 1 tag byte (0=None, 1=Some) + u64 LE when Some. */
function encodeOptionU64(v?: BN | number | null): Buffer {
  if (v === undefined || v === null) return Buffer.from([0]);
  const bn = BN.isBN(v) ? v : new BN(v);
  return Buffer.concat([Buffer.from([1]), encodeU64(bn)]);
}
function encodeVecU64(vs: BN[]): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(vs.length, 0);
  return Buffer.concat([len, ...vs.map(encodeU64)]);
}
function encodeBool(v: boolean): Buffer {
  return Buffer.from([v ? 1 : 0]);
}
/**
 * Borsh `TokenChange { index: u8, expected_current: u64, new_value: u64 }`.
 *
 * Field order verified against the `TokenChange` type in
 * `src/idl/cubic_pool.json`. `expected_current` sits IN THE MIDDLE — it was
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
