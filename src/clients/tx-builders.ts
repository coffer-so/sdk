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
import { PoolInfo } from "../types/pool";
import {
  AddLiquidityParams,
  BuiltTx,
  DeployPoolParams,
  RemoveLiquidityParams,
  SingleTokenDepositParams,
  SwapParams,
} from "../types/tx";
import { deriveAta, deriveBptMint, deriveHelperPda } from "../utils/pda";

/**
 * Low-level transaction builders. Emit raw `TransactionInstruction`s suitable
 * for combination with others (e.g. versioned transactions with ALTs) in a
 * single tx. Higher-level convenience lives on `CubicPoolClient`.
 */

const CUBIC_POOL_DISC = {
  swap: computeDiscriminator("swap"),
  addLiquidity: computeDiscriminator("add_liquidity"),
  removeLiquidity: computeDiscriminator("remove_liquidity"),
  initializeCubicPool: computeDiscriminator("initialize_cubic_pool"),
  initializePoolAlt: computeDiscriminator("initialize_pool_alt"),
};

const STLD_DISC = {
  depositSingleToken: computeDiscriminator("deposit_single_token"),
};

/**
 * Anchor discriminator: sha256("global:<ix_name>")[0..8]. The SDK
 * pre-computes only the cases it needs.
 *
 * Pre-computed values (confirmed against `src/idl/*.json`):
 *   swap                  → f8c69e91e17587c8
 *   add_liquidity         → b59d59438fb63448
 *   remove_liquidity      → 5055d14818ceb16c
 *   initialize_cubic_pool → d79474cf79686f83
 *   deposit_single_token  → a688a62fc7c056a9
 *
 * If you change an instruction name in Rust, regenerate by reading the
 * target/idl/*.json discriminator field.
 */
function computeDiscriminator(ixName: string): Buffer {
  // Fallback: Anchor exposes discriminators in the IDL. We ship the known
  // ones as a static map; callers passing unknown names error clearly.
  const KNOWN: Record<string, string> = {
    swap: "f8c69e91e17587c8",
    add_liquidity: "b59d59438fb63448",
    remove_liquidity: "5055d14818ceb16c",
    initialize_cubic_pool: "d79474cf79686f83",
    initialize_pool_alt: "fb874202f4490c90",
    deposit_single_token: "a688a62fc7c056a9",
    initialize_config: "d07f1501c2bec446",
  };
  const hex = KNOWN[ixName];
  if (!hex) throw new Error(`tx-builders: unknown discriminator for "${ixName}"`);
  return Buffer.from(hex, "hex");
}

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

export function buildAddLiquidityIx(
  cfg: CubeConfig,
  pool: PoolInfo,
  params: AddLiquidityParams
): TransactionInstruction {
  const userBpt = deriveAta(params.user, pool.bptMint, TOKEN_PROGRAM_ID);
  const minBpt = requirePositiveMinimumBpt(params.minimumBptAmount, "add_liquidity");

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
 * Full single-token deposit tx: makes sure helper ATAs and the user's
 * per-token ATAs exist (idempotent create instructions), creates the user's
 * BPT ATA if absent, then the deposit ix itself. The helper program validates
 * all user ATAs up front because it may refund dust for any pool token.
 * CU limit set to 1.4M (mainnet/devnet max).
 */
export function buildSingleTokenDepositTx(
  cfg: CubeConfig,
  pool: PoolInfo,
  params: SingleTokenDepositParams
): BuiltTx {
  const [helper] = deriveHelperPda(cfg.programs.singleTokenLiquidity, pool.address);
  const helperBpt = deriveAta(helper, pool.bptMint, TOKEN_PROGRAM_ID);
  const userBpt = deriveAta(params.user, pool.bptMint, TOKEN_PROGRAM_ID);

  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cfg.defaults.cuLimit }),
  ];
  // User + helper ATAs (helper has an off-curve owner). Idempotent — safe to
  // include even when the accounts already exist.
  for (const t of pool.tokens) {
    const userAta = deriveAta(params.user, t.mint, t.tokenProgram);
    const helperAta = deriveAta(helper, t.mint, t.tokenProgram);
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        params.user,
        userAta,
        params.user,
        t.mint,
        t.tokenProgram
      )
    );
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        params.user,
        helperAta,
        helper,
        t.mint,
        t.tokenProgram
      )
    );
  }
  ixs.push(
    createAssociatedTokenAccountIdempotentInstruction(
      params.user,
      helperBpt,
      helper,
      pool.bptMint,
      TOKEN_PROGRAM_ID
    )
  );
  ixs.push(
    createAssociatedTokenAccountIdempotentInstruction(
      params.user,
      userBpt,
      params.user,
      pool.bptMint,
      TOKEN_PROGRAM_ID
    )
  );
  ixs.push(buildSingleTokenDepositIx(cfg, pool, params));

  return {
    instructions: ixs,
    suggestedCuLimit: cfg.defaults.cuLimit,
  };
}

// ============================================================
// Deploy new pool (PoolFactory)
// ============================================================

export function buildInitializeConfigIx(
  cfg: CubeConfig,
  params: { config: PublicKey; payer: PublicKey; defaultProtocolFeeRate: number }
): TransactionInstruction {
  // cubic_pool v0.6.0 initialize_config:
  //   - the program now enforces `protocol_admin == TreasuryPDA(protocol-admin)`
  //   - the Treasury PDA is passed as an account; Anchor derives it from
  //     seeds [b"treasury"] on the protocol-admin program ID and rejects
  //     anything else, so neither the caller nor the SDK can substitute
  //     a wallet here. The on-chain `config.protocol_admin` field will
  //     always be this PDA.
  const [treasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    cfg.programs.protocolAdmin
  );
  const data = Buffer.concat([
    computeDiscriminator("initialize_config"),
    treasuryPda.toBuffer(),
    encodeU16(params.defaultProtocolFeeRate),
  ]);
  const keys: AccountMeta[] = [
    { pubkey: params.config, isSigner: true, isWritable: true },
    { pubkey: treasuryPda, isSigner: false, isWritable: false },
    { pubkey: params.payer, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({
    programId: cfg.programs.cubicPool,
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
    encodeVecPubkey(params.tokens),
    encodeVecU64(params.weightsBps.map((w) => new BN(w))),
    encodeVecU64(params.virtualBalances),
    encodeU32(params.swapFeeRate),
    encodeU64(params.poolId),
    // Option<u64> banned_extensions_override: 0x00 = None (inherit config
    // default), 0x01 + u64 LE = Some(bitmap) chosen by the creator.
    encodeOptionU64(params.bannedExtensions),
  ]);

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
function encodeVecPubkey(pks: PublicKey[]): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(pks.length, 0);
  return Buffer.concat([len, ...pks.map((p) => p.toBuffer())]);
}
