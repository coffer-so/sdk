/**
 * atomicDeploy — `buildAtomicDeploy`: a pool deployment that costs the
 * creator exactly ONE wallet approval and is never tradable before the
 * creator's last transaction lands (v6.1, T8 launch protection). Faithful
 * port of `contracts/tests/utils/one-tx-deploy.ts`.
 *
 * ## What one deploy is
 *
 * ```text
 *   initialize_pool(weights, virtual balances, fee, pool_id, lp_metadata, fees, hook)
 *   + idempotent ATA creation (n vaults + creator LP account)
 *   + seed_liquidity(token_amounts, lp_amount)
 *   [+ set_swaps_enabled(false)]            ← "paused launch"
 * ```
 *
 * The pool program never has an "open but unseeded" state a third party
 * can act on (§Launch invariants), so the builder only has to keep the SEED
 * inside the creator's own transactions and, for a paused launch, keep
 * `set_swaps_enabled(false)` in the SAME transaction as the seed.
 *
 * ## Layouts (chosen automatically, smallest first)
 *
 * ```text
 *   single   [tx1 = init + ATAs + seed (+pause)]                 N ≤ 3 (max metadata: N ≤ 2)
 *   alt-1    [tx1 = ALT create+extend (+spilled vault ATAs)]
 *            [tx2 = init + ATAs + seed (+pause)]                 N ≤ 8
 *   alt-2    [tx1 = ALT] [tx2 = init (+spilled vault ATAs)]
 *            [tx3 = ATAs + seed (+pause)]                        N = 9, 10
 * ```
 *
 * `single` is a plain transaction with no Address Lookup Table. Above that
 * the static key array alone exceeds the 1232-byte packet, so an ALT is
 * created in tx1 with the DETERMINISTIC addresses of the pool, LP mint,
 * vaults and user accounts (none has to exist yet). An ALT cannot be
 * referenced in the slot it was extended, so tx1 must land one slot before
 * the rest — `sendAtomicDeploy` waits. All transactions share one
 * blockhash (valid 150 slots) and `wallet.signAllTransactions(txs)` is one
 * popup.
 *
 * ## Launch invariants (why the split layouts are safe)
 *
 * Between `initialize_pool` and `seed_liquidity` the pool exists with
 * `swaps_enabled = true` but zero reserves and `lp_supply = 0`. In that
 * state every third-party instruction reverts (`swap` →
 * `InsufficientLiquidity`, `add_liquidity` → `PoolNotSeeded`,
 * `remove_liquidity` → `InvalidLpAmount`, `seed_liquidity` →
 * `SeedDepositNotPoolAdmin`, `fund_sidelined_token` → `Unauthorized`, zap →
 * `PoolNotSeeded`, every setter → `Unauthorized`). Only the pool admin (=
 * the creator / fee payer) can seed, so the pool becomes tradable exactly
 * when the creator's seed transaction lands — and not at all when that
 * transaction also carries `set_swaps_enabled(false)`.
 *
 * What atomicity does NOT do: stop a back-run of the seed (or of the later
 * "open trading" transaction) at the creator's chosen virtual price. That
 * is economics, not a window in the program.
 *
 * ## Facts baked into the design
 *
 * - Top-level invoked program IDs and the fee payer are always static keys.
 * - tx1 (ALT) has its own size ceiling: one `ExtendLookupTable` carries
 *   ~30 addresses before tx1 passes 1232 B; the builder packs the largest
 *   prefix that fits and lets the rest stay static.
 * - `MAX_INSTRUCTION_TRACE_LENGTH = 64` counts CPIs: an idempotent ATA
 *   creation is 5, `initialize_pool` is 9 (T1 metadata CPIs), the seed is
 *   `2 + n`. The builder spills the MINIMUM number of vault ATA creations
 *   into an earlier transaction.
 * - The ALT is deliberately NOT frozen: a deploy that fails after tx1 can
 *   deactivate + close it and recover the rent.
 * - `poolId` is random (`randomBytes(8)`), never `Date.now()`: a guessable
 *   id lets a squatter create the PDA first. The builder rejects an
 *   existing PDA up front, and `sendAtomicDeploy` verifies the created pool
 *   against the EXACT signed intent (`verifyCreatedPool`) before seeding
 *   (alt-2) / before reporting success. Pending-deploy recovery = rebuild
 *   with the same `poolId`.
 * - `jitoDontFront`: adds the `jitodontfront…` read-only account to the
 *   ComputeBudget instruction of the seed transaction (the ComputeBudget
 *   program ignores accounts), so a Jito bundle cannot place another
 *   transaction in front of it. Harmless on a plain RPC.
 *
 * ## Jito bundles
 *
 * When submitting through a block engine, bundle ONLY the pool
 * transactions (`transactions.slice(layout === "single" ? 0 : 1)`): the ALT
 * creation transaction cannot share a bundle with them (the table must be
 * extended one slot earlier), so land tx1 over RPC first, wait a slot, then
 * bundle the rest with `jitoDontFront: true`. Fall back to
 * `sendAtomicDeploy` over plain RPC when the block engine is unavailable.
 */

import { randomBytes } from "crypto";
import {
  type AccountInfo,
  type AccountMeta,
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  type Commitment,
  ComputeBudgetProgram,
  Connection,
  MessageV0,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import { CofferConfig, DEFAULT_INITIAL_LP_SUPPLY } from "../config";
import type {
  AtomicDeployParams,
  AtomicDeployResult,
  DeployLayout,
  ExpectedPoolIdentity,
  SendDeployResult,
} from "../types/tx-v61";
import { validateLpMetadata } from "../utils/lpMetadata";
import { validateHookConfig } from "../utils/hooks";
import { deriveAta, deriveLpMint, derivePoolPda } from "../utils/pda";
import { verifyCreatedPool, type PoolAccountReader } from "./poolIdentity";
import { buildInitializePoolIx, buildSeedLiquidityRawIx, buildSetSwapsEnabledIx } from "./tx-builders";

/** Legacy packet limit — a serialized transaction must not exceed this. */
export const SOLANA_TX_LIMIT = 1232;

/**
 * `MAX_INSTRUCTION_TRACE_LENGTH` from the Solana runtime: the total number of
 * instructions a single transaction may process, top-level AND CPI. Budget a
 * couple of slots below it.
 */
export const TRACE_BUDGET = 62;

/**
 * Trace slots one `AssociatedTokenAccount::CreateIdempotent` costs when the
 * account does not exist yet: the ATA program itself, plus its CPIs to
 * `GetAccountDataSize`, `SystemProgram::CreateAccount`,
 * `InitializeImmutableOwner` and `InitializeAccount3`.
 */
export const ATA_CREATE_TRACE = 5;

/**
 * Trace slots `initialize_pool` costs (v6.1, T1): itself, the pool
 * account's `CreateAccount`, the LP mint's `CreateAccount` +
 * `MetadataPointer::Initialize` + `InitializeMint2`, the rent top-up
 * `Transfer`, then `TokenMetadata::Initialize`, `UpdateField("pool")` and
 * `UpdateAuthority(None)`.
 */
export const INIT_POOL_TRACE = 9;

/** Trace slots `seed_liquidity` costs: itself, n `transfer_checked`, one `mint_to`. */
export const seedTrace = (n: number): number => 2 + n;

/** Bytes of slack the seed transaction must retain before the builder spends them on an optional instruction. */
const SIZE_HEADROOM = 32;

/**
 * Jito "don't front" marker account: any transaction referencing it is
 * rejected by the block engine unless it is the first transaction of its
 * bundle. It does not exist on chain and must be read-only.
 */
export const JITO_DONT_FRONT = new PublicKey("jitodontfront111111111111111111111111111111");

/** `CofferPoolConfig` account: size and discriminator the builder checks before spending anything. */
export const POOL_CONFIG_LEN = 202;
export const POOL_CONFIG_DISCRIMINATOR = Buffer.from("041df30a8e40e876", "hex");

// ─── Connection subset (stub-able in tests) ─────────────────────────────────

export interface DeployBuildConnection {
  getMultipleAccountsInfo(keys: PublicKey[], commitment?: Commitment): Promise<(AccountInfo<Buffer> | null)[]>;
  getLatestBlockhash(commitment?: Commitment): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getBlockHeight(commitment?: Commitment): Promise<number>;
  getSlot(commitment?: Commitment): Promise<number>;
}

export interface DeploySendConnection extends PoolAccountReader {
  sendRawTransaction(raw: Buffer | Uint8Array | number[], options?: { skipPreflight?: boolean }): Promise<string>;
  confirmTransaction(strategy: { signature: string; blockhash: string; lastValidBlockHeight: number }, commitment?: Commitment): Promise<{ value: { err: unknown } }>;
  getSlot(commitment?: Commitment): Promise<number>;
  getTransaction(signature: string, options: { commitment?: "confirmed" | "finalized"; maxSupportedTransactionVersion?: number }): Promise<{ meta?: { computeUnitsConsumed?: number } | null } | null>;
}

// ─── Size accounting ─────────────────────────────────────────────────────────

/** compact-u16 (shortvec) encoded length of `n`. */
function shortVecLen(n: number): number {
  if (n < 0x80) return 1;
  if (n < 0x4000) return 2;
  return 3;
}

/**
 * Exact wire size of a v0 transaction, computed analytically.
 * `VersionedTransaction.serialize()` encodes into a fixed 1232-byte buffer
 * and throws `RangeError` past it — useless for deciding whether something
 * fits. This reproduces the wire format byte-for-byte instead.
 */
export function v0WireSize(msg: MessageV0): number {
  let size = 1; // version prefix (0x80)
  size += 3; // header
  size += shortVecLen(msg.staticAccountKeys.length) + 32 * msg.staticAccountKeys.length;
  size += 32; // blockhash
  size += shortVecLen(msg.compiledInstructions.length);
  for (const ci of msg.compiledInstructions) {
    size += 1; // program id index
    size += shortVecLen(ci.accountKeyIndexes.length) + ci.accountKeyIndexes.length;
    size += shortVecLen(ci.data.length) + ci.data.length;
  }
  size += shortVecLen(msg.addressTableLookups.length);
  for (const l of msg.addressTableLookups) {
    size += 32;
    size += shortVecLen(l.writableIndexes.length) + l.writableIndexes.length;
    size += shortVecLen(l.readonlyIndexes.length) + l.readonlyIndexes.length;
  }
  const numSigs = msg.header.numRequiredSignatures;
  return shortVecLen(numSigs) + 64 * numSigs + size;
}

/** Total distinct accounts a v0 message touches, table lookups included. */
export function v0AccountCount(msg: MessageV0): number {
  let n = msg.staticAccountKeys.length;
  for (const l of msg.addressTableLookups) {
    n += l.writableIndexes.length + l.readonlyIndexes.length;
  }
  return n;
}

/**
 * 8 cryptographically random bytes as an unsigned 64-bit `pool_id`.
 * `Date.now()` is ~41 bits of fully predictable entropy: an observer can
 * pre-compute the pool PDA for every plausible timestamp and squat it.
 */
export function randomPoolId(): BN {
  return new BN(randomBytes(8), "le");
}

function dedupe(keys: PublicKey[]): PublicKey[] {
  const seen = new Set<string>();
  const out: PublicKey[] = [];
  for (const k of keys) {
    const s = k.toBase58();
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(k);
  }
  return out;
}

// ─── Builder ─────────────────────────────────────────────────────────────────

/**
 * Build the one-approval pool deploy: `initialize_pool (+ LP metadata)` +
 * ATAs + `seed_liquidity` [+ `set_swaps_enabled(false)`], as ONE
 * transaction when it fits and the minimal number otherwise. Transactions
 * are returned unsigned and share one blockhash, so the caller signs them
 * together in a single `signAllTransactions` prompt and lands them with
 * `sendAtomicDeploy`.
 *
 * @throws on inconsistent arrays, an existing pool PDA, an invalid config,
 *   invalid LP metadata, a non-Token-2022 LP program, an invalid hook
 *   config, or when no layout fits the packet / trace limits.
 */
/** Byte offset of `decimals` in an SPL / Token-2022 `Mint` account. */
const MINT_DECIMALS_OFFSET = 44;

export async function buildAtomicDeploy(
  cfg: CofferConfig,
  connection: DeployBuildConnection | Connection,
  params: AtomicDeployParams,
): Promise<AtomicDeployResult> {
  const { payer, config, mints, weights, virtualBalances, swapFeeRate, seedAmounts } = params;
  const programId = cfg.programs.cofferPool;

  const n = mints.length;
  if (n < 2 || n > 10) throw new Error(`token count ${n} outside [2, 10]`);
  if (weights.length !== n || virtualBalances.length !== n || seedAmounts.length !== n) {
    throw new Error("weights / virtualBalances / seedAmounts must match mints length");
  }
  if (!seedAmounts.some((a) => !a.isZero())) {
    throw new Error("seed deposit needs at least one non-zero amount");
  }
  const weightSum = weights.reduce((acc, w) => acc.add(w), new BN(0));
  if (!weightSum.eqn(10_000)) throw new Error(`weights must sum to 10000 (got ${weightSum})`);
  if (virtualBalances.some((vb) => vb.isZero() || vb.isNeg())) throw new Error("virtualBalances must all be > 0");
  // v6.1 (T22): the seed books `actual_i = net_i` against `virtual_i`, so the
  // (gross ≥ net) seed amount must stay below the virtual balance.
  seedAmounts.forEach((a, i) => {
    if (a.isNeg() || a.bitLength() > 64) throw new Error(`seedAmounts[${i}] must be an unsigned 64-bit BN`);
    if (a.gte(virtualBalances[i])) throw new Error(`seedAmounts[${i}] = ${a} must stay below virtualBalances[${i}] = ${virtualBalances[i]} (VirtualBalanceNotAboveActual, 6104)`);
  });

  const initialLpSupply = params.initialLpSupply ?? new BN(DEFAULT_INITIAL_LP_SUPPLY.toString());
  const lpTokenProgram = params.lpTokenProgram ?? TOKEN_2022_PROGRAM_ID;
  if (!lpTokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error("lpTokenProgram must be Token-2022: v6.1 LP mints carry in-mint metadata");
  }
  const lpMetadata = validateLpMetadata(params.lpMetadata);
  const creatorFeeBps = params.creatorFeeBps ?? 0;
  const depositFeeBps = params.depositFeeBps ?? 0;
  const withdrawFeeBps = params.withdrawFeeBps ?? 0;
  const hookConfig = params.hookConfig ?? null;
  if (hookConfig) validateHookConfig(hookConfig, programId);
  const hookAccounts = hookConfig ? (params.hookAccounts ?? []) : [];
  if (hookConfig && hookAccounts.length !== hookConfig.accountsLen) {
    throw new Error(`hookAccounts length ${hookAccounts.length} != hookConfig.accountsLen ${hookConfig.accountsLen}`);
  }
  const poolId = params.poolId ?? randomPoolId();
  const swapsEnabledAtLaunch = params.swapsEnabledAtLaunch ?? true;
  const layoutMode = params.layout ?? "auto";
  const allowSplit = params.allowSplit ?? true;
  const jitoDontFront = params.jitoDontFront ?? false;
  // The seed runs no `pow` per token (v6.1, T2): keep a linear margin per
  // token and cap at the per-transaction ceiling.
  const computeUnitLimit = params.computeUnitLimit ?? Math.min(1_400_000, 200_000 + n * 60_000);

  // Token program per mint — read from the mint account's owner unless the
  // caller already knows it.
  let tokenPrograms = params.tokenPrograms;
  let tokenDecimals = params.tokenDecimals;
  if (!tokenPrograms) {
    const infos = await connection.getMultipleAccountsInfo(mints);
    const decimals: number[] = [];
    tokenPrograms = infos.map((info, i) => {
      if (!info) throw new Error(`mint ${mints[i].toBase58()} does not exist`);
      // SPL / Token-2022 `Mint`: decimals at byte 44 (the base layout precedes any extension).
      if (info.data.length >= MINT_DECIMALS_OFFSET + 1) decimals.push(info.data[MINT_DECIMALS_OFFSET]);
      return info.owner;
    });
    // v6.1 (T22): the per-slot floor is checked by `buildInitializePoolIx`
    // when every mint exposed its decimals (pass `tokenDecimals` to check it
    // with explicit `tokenPrograms`).
    tokenDecimals ??= decimals.length === n ? decimals : undefined;
  }
  if (tokenPrograms.length !== n) throw new Error("tokenPrograms length mismatch");
  if (tokenDecimals && tokenDecimals.length !== n) throw new Error("tokenDecimals length mismatch");

  const [poolPda] = derivePoolPda(programId, config, poolId);
  const [lpMint] = deriveLpMint(programId, poolPda);
  const [existingPool, existingLpMint, configInfo] = await connection.getMultipleAccountsInfo([poolPda, lpMint, config], "confirmed");
  // A pre-funded (system-owned, data-less) address is fine: Anchor `init`
  // absorbs the lamports. Anything else at the pool / LP mint address is
  // either our own earlier deploy or a squat — refuse before building.
  for (const [what, info] of [["Pool", existingPool], ["LP mint", existingLpMint]] as const) {
    if (!info) continue;
    const addr = what === "Pool" ? poolPda : lpMint;
    if (info.owner.equals(programId) || (what === "LP mint" && info.owner.equals(lpTokenProgram))) {
      throw new Error(`${what} ${addr.toBase58()} already exists; choose another pool_id`);
    }
    if (!info.owner.equals(SystemProgram.programId) || info.data.length > 0) {
      throw new Error(`${what} address ${addr.toBase58()} is occupied by a foreign account; choose another pool_id`);
    }
  }
  if (!configInfo || !configInfo.owner.equals(programId)) throw new Error("Invalid pool config owner or missing config");
  if (configInfo.data.length !== POOL_CONFIG_LEN || !configInfo.data.subarray(0, 8).equals(POOL_CONFIG_DISCRIMINATOR)) {
    throw new Error("Invalid pool config layout");
  }
  const expectedIdentity: ExpectedPoolIdentity = {
    programId, config, poolId: BigInt(poolId.toString()), poolAdmin: payer,
    mints: [...mints], tokenPrograms: [...tokenPrograms], weights: weights.map((w) => BigInt(w.toString())),
    swapFeeRate,
    swapsEnabled: swapsEnabledAtLaunch,
  };

  const vaults = mints.map((m, i) => deriveAta(poolPda, m, tokenPrograms![i]));
  const userTokenAccounts = mints.map((m, i) => deriveAta(payer, m, tokenPrograms![i]));
  const userLpAccount = deriveAta(payer, lpMint, lpTokenProgram);

  // ── Instruction pieces ──────────────────────────────────────────────────

  const initIx = buildInitializePoolIx(cfg, {
    payer, configKey: config, poolId, tokens: mints,
    weightsBps: weights.map((w) => w.toNumber()), virtualBalances, swapFeeRate,
    lpTokenProgram, lpMetadata, creatorFeeBps, depositFeeBps, withdrawFeeBps, hookConfig, hookAccounts, tokenDecimals,
  });

  // Vaults are plain ATAs owned by the pool PDA and are NOT created by
  // `initialize_pool` — `seed_liquidity` transfers into them directly, so
  // they must exist by the time it runs. Idempotent; they do not depend on
  // the pool account existing, which is what makes the spill possible.
  const vaultAtaIxs = mints.map((m, i) =>
    createAssociatedTokenAccountIdempotentInstruction(payer, vaults[i], poolPda, m, tokenPrograms![i]),
  );
  // `user_lp_account` is a typed InterfaceAccount — it must already exist.
  // It cannot move ahead of `initialize_pool`: the LP mint is created there.
  const lpAtaIx = createAssociatedTokenAccountIdempotentInstruction(payer, userLpAccount, payer, lpMint, lpTokenProgram);

  // v6.1 (T9): a hooked pool's seed carries the hook slice.
  const seedIx = buildSeedLiquidityRawIx(cfg, {
    pool: poolPda, lpMint, userLpAccount, user: payer, mints, tokenPrograms,
    userTokenAccounts, vaults, amounts: seedAmounts, lpAmount: initialLpSupply, lpTokenProgram,
    extraAccounts: hookAccounts,
  });

  // Paused launch: the pause rides in the SAME transaction as the seed.
  const tailIxs: TransactionInstruction[] = swapsEnabledAtLaunch
    ? []
    : [buildSetSwapsEnabledIx(cfg, config, poolPda, payer, false)];

  // ── ALT contents ────────────────────────────────────────────────────────
  const uniqueTokenPrograms = dedupe(tokenPrograms);
  const candidates: PublicKey[] = dedupe([
    ...vaults,
    ...userTokenAccounts,
    ...mints,
    ...hookAccounts.map((a) => a.pubkey),
    poolPda,
    lpMint,
    userLpAccount,
    config,
    ...uniqueTokenPrograms,
    lpTokenProgram,
    SystemProgram.programId,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  ]).filter((k) => !k.equals(payer));

  const blockhashInfo = params.blockhash
    ? { blockhash: params.blockhash, lastValidBlockHeight: 0 }
    : await connection.getLatestBlockhash();
  const { blockhash } = blockhashInfo;
  let { lastValidBlockHeight } = blockhashInfo;
  if (!lastValidBlockHeight) {
    lastValidBlockHeight = (await connection.getBlockHeight()) + 150;
  }
  let recentSlot = params.recentSlot;

  const extraCb = (withCb: boolean) => (withCb ? 1 : 0) + (params.computeUnitPrice !== undefined ? 1 : 0);

  function budgetIxs(withCb: boolean, dontFront: boolean): TransactionInstruction[] {
    const ixs: TransactionInstruction[] = [];
    if (withCb) {
      const ix = ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit });
      if (dontFront) ix.keys.push({ pubkey: JITO_DONT_FRONT, isSigner: false, isWritable: false });
      ixs.push(ix);
    }
    if (params.computeUnitPrice !== undefined) {
      ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: params.computeUnitPrice }));
    }
    return ixs;
  }

  /** Default CU (200k per top-level ix, capped) still covers the deploy without an explicit budget? */
  const defaultBudgetCovers = (topLevel: number) => Math.min(1_400_000, 200_000 * topLevel) >= computeUnitLimit;

  type Built = {
    layout: DeployLayout;
    transactions: VersionedTransaction[];
    instructions: TransactionInstruction[][];
    altAddress: PublicKey | null;
    altAddresses: PublicKey[];
    txSizes: number[];
    traces: number[];
    accountCount: number;
    vaultAtasInTx1: number;
    computeBudgetInTx2: boolean;
  };

  // ── Layout search ───────────────────────────────────────────────────────
  //
  // Pass 0 — a single transaction without any lookup table.
  // Pass 1 — ALT in tx1 (+ spilled vault ATAs), everything else in tx2.
  // Pass 2 — ALT in tx1, init (+ spilled vault ATAs) in tx2, ATAs + seed
  //          (+ pause) in tx3.
  const bestLayout = await (async (): Promise<Built | null> => {
    const seedTopLevel = (atas: number, withCb: boolean) => atas + 2 /* init + seed */ + tailIxs.length + extraCb(withCb);
    const seedTraceOf = (atas: number, withCb: boolean, withInit: boolean) =>
      (withInit ? INIT_POOL_TRACE : 0) + ATA_CREATE_TRACE * atas + seedTrace(n) + tailIxs.length + extraCb(withCb);

    if (layoutMode !== "alt") {
      for (const withCb of jitoDontFront ? [true] : [true, false]) {
        const atas = n + 1;
        if (seedTraceOf(atas, withCb, true) > TRACE_BUDGET) continue;
        if (!withCb && !defaultBudgetCovers(seedTopLevel(atas, withCb))) continue;
        const ixs = [...budgetIxs(withCb, jitoDontFront), initIx, ...vaultAtaIxs, lpAtaIx, seedIx, ...tailIxs];
        const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
        const size = v0WireSize(msg);
        if (size > SOLANA_TX_LIMIT) continue;
        if (withCb && size > SOLANA_TX_LIMIT - SIZE_HEADROOM) continue;
        return {
          layout: "single",
          transactions: [new VersionedTransaction(msg)],
          instructions: [ixs],
          altAddress: null,
          altAddresses: [],
          txSizes: [size],
          traces: [seedTraceOf(atas, withCb, true)],
          accountCount: v0AccountCount(msg),
          vaultAtasInTx1: 0,
          computeBudgetInTx2: withCb,
        };
      }
      if (layoutMode === "single") return null;
    }

    if (recentSlot === undefined) recentSlot = await connection.getSlot("finalized");

    // Pass 1 — two transactions (init + ATAs + seed together in tx2).
    for (let spill = 0; spill <= n; spill++) {
      for (const withCb of jitoDontFront ? [true] : [true, false]) {
        const ataInTx2 = n + 1 - spill;
        const trace2 = seedTraceOf(ataInTx2, withCb, true);
        if (trace2 > TRACE_BUDGET) continue;
        if (!withCb && !defaultBudgetCovers(seedTopLevel(ataInTx2, withCb))) continue;
        const ixs2 = [...budgetIxs(withCb, jitoDontFront), initIx, ...vaultAtaIxs.slice(spill), lpAtaIx, seedIx, ...tailIxs];
        const c = compileAgainstAlt(spill, [ixs2]);
        if (!c) continue;
        if (withCb && c.sizes[0] > SOLANA_TX_LIMIT - SIZE_HEADROOM) continue;
        return {
          layout: "alt-1",
          transactions: [c.tx1, c.followUps[0]],
          instructions: [c.ixs1, ixs2],
          altAddress: c.altAddress,
          altAddresses: c.altAddresses,
          txSizes: [c.size1, c.sizes[0]],
          traces: [2 + ATA_CREATE_TRACE * spill, trace2],
          accountCount: c.accountCount,
          vaultAtasInTx1: spill,
          computeBudgetInTx2: withCb,
        };
      }
    }
    if (!allowSplit) return null;

    // Pass 2 — three transactions: `initialize_pool` gets its own packet
    // (tx2, with the vault ATAs the seed transaction cannot afford
    // trace-wise), ATAs + seed (+ pause) follow in tx3.
    for (let spill = 0; spill <= n; spill++) {
      for (const withCb of jitoDontFront ? [true] : [true, false]) {
        const trace2 = INIT_POOL_TRACE + ATA_CREATE_TRACE * spill + extraCb(withCb);
        const ataInTx3 = n + 1 - spill;
        const trace3 = seedTraceOf(ataInTx3, withCb, false);
        if (trace2 > TRACE_BUDGET || trace3 > TRACE_BUDGET) continue;
        const topLevel3 = ataInTx3 + 1 + tailIxs.length + extraCb(withCb);
        if (!withCb && !defaultBudgetCovers(topLevel3)) continue;
        const ixs2 = [...budgetIxs(withCb, false), initIx, ...vaultAtaIxs.slice(0, spill)];
        const ixs3 = [...budgetIxs(withCb, jitoDontFront), ...vaultAtaIxs.slice(spill), lpAtaIx, seedIx, ...tailIxs];
        const c = compileAgainstAlt(0, [ixs2, ixs3]);
        if (!c) continue;
        return {
          layout: "alt-2",
          transactions: [c.tx1, c.followUps[0], c.followUps[1]],
          instructions: [c.ixs1, ixs2, ixs3],
          altAddress: c.altAddress,
          altAddresses: c.altAddresses,
          txSizes: [c.size1, c.sizes[0], c.sizes[1]],
          traces: [2, trace2, trace3],
          accountCount: c.accountCount,
          vaultAtasInTx1: spill,
          computeBudgetInTx2: withCb,
        };
      }
    }
    return null;
  })();

  if (!bestLayout) {
    throw new Error(
      `no deploy layout fits for n=${n} (packet limit ${SOLANA_TX_LIMIT} B, ` +
        `instruction trace budget ${TRACE_BUDGET}, layout=${layoutMode}, allowSplit=${allowSplit})`,
    );
  }

  /**
   * Compile tx1 (ALT create + extend with the largest candidate prefix that
   * fits + `spillIntoTx1` vault ATA creations) and every follow-up
   * transaction against the not-yet-existing table. Returns null when no
   * table prefix lets all of them fit.
   */
  function compileAgainstAlt(spillIntoTx1: number, followUps: TransactionInstruction[][]) {
    for (let k = candidates.length; k >= 0; k--) {
      const chosen = candidates.slice(0, k);
      const [createIx, tableAddress] = AddressLookupTableProgram.createLookupTable({
        authority: payer,
        payer,
        recentSlot: recentSlot!,
      });
      const ixs1: TransactionInstruction[] = [createIx];
      if (chosen.length > 0) {
        ixs1.push(AddressLookupTableProgram.extendLookupTable({ payer, authority: payer, lookupTable: tableAddress, addresses: chosen }));
      }
      ixs1.push(...vaultAtaIxs.slice(0, spillIntoTx1));

      const msg1 = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs1 }).compileToV0Message();
      const size1 = v0WireSize(msg1);
      if (size1 > SOLANA_TX_LIMIT) continue;

      // The table does not exist on chain yet, so the follow-ups are
      // compiled against a locally-constructed view of what tx1 writes.
      const alt = new AddressLookupTableAccount({
        key: tableAddress,
        state: {
          deactivationSlot: BigInt("0xffffffffffffffff"),
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
          authority: payer,
          addresses: chosen,
        },
      });
      const msgs = followUps.map((ixs) =>
        new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message([alt]),
      );
      const sizes = msgs.map(v0WireSize);
      // Fewer table entries only make the follow-ups larger: give up.
      if (sizes.some((sz) => sz > SOLANA_TX_LIMIT)) return null;
      return {
        altAddress: tableAddress,
        altAddresses: chosen,
        tx1: new VersionedTransaction(msg1),
        ixs1,
        size1,
        followUps: msgs.map((m) => new VersionedTransaction(m)),
        sizes,
        accountCount: Math.max(...msgs.map(v0AccountCount)),
      };
    }
    return null;
  }

  const txSizes = bestLayout.txSizes;
  const result: AtomicDeployResult = {
    transactions: bestLayout.transactions,
    instructions: bestLayout.instructions,
    layout: bestLayout.layout,
    seedTxIndex: bestLayout.transactions.length as 1 | 2 | 3,
    poolTxCount: bestLayout.layout === "alt-2" ? 2 : 1,
    poolPda,
    lpMint,
    altAddress: bestLayout.altAddress,
    poolId,
    vaults,
    userTokenAccounts,
    userLpAccount,
    tokenPrograms,
    altAddresses: bestLayout.altAddresses,
    blockhash,
    lastValidBlockHeight,
    txSizes,
    sizes: { tx1: txSizes[0], tx2: txSizes[1], tx3: txSizes[2] },
    traces: bestLayout.traces,
    expectedIdentity,
    accountCount: bestLayout.accountCount,
    vaultAtasInTx1: bestLayout.vaultAtasInTx1,
    computeBudgetInTx2: bestLayout.computeBudgetInTx2,
    swapsEnabledAtLaunch,
  };
  if (jitoDontFront) assertDontFrontReadOnly(result.transactions[result.transactions.length - 1]);
  return result;
}

/**
 * The `jitodontfront…` marker must be referenced read-only and never as a
 * signer: a writable reference would make the (non-existent) account a
 * write lock and could be rejected by the runtime. Throws otherwise.
 */
export function assertDontFrontReadOnly(tx: VersionedTransaction): void {
  const msg = tx.message;
  const idx = msg.staticAccountKeys.findIndex((k) => k.equals(JITO_DONT_FRONT));
  if (idx < 0) throw new Error("jitodontfront account missing from the static keys");
  if (msg.isAccountWritable(idx)) throw new Error("jitodontfront account must be read-only");
  if (msg.isAccountSigner(idx)) throw new Error("jitodontfront account must not be a signer");
}

// ─── Sending ─────────────────────────────────────────────────────────────────

/**
 * Land a signed `[tx]`, `[tx1, tx2]` or `[tx1, tx2, tx3]` set over plain RPC.
 *
 * When the first transaction is the ALT creation it is confirmed first and
 * the sender waits for the slot to advance before submitting the rest in
 * order: an ALT is invisible to the runtime during the slot it was extended
 * in. The created pool is verified against the signed intent
 * (`verifyCreatedPool`) right after the transaction carrying
 * `initialize_pool` lands — before the seed goes out in the alt-2 layout,
 * before reporting success otherwise.
 */
export async function sendAtomicDeploy(
  connection: DeploySendConnection | Connection,
  signed: VersionedTransaction[],
  ctx: Pick<AtomicDeployResult, "blockhash" | "lastValidBlockHeight" | "poolPda" | "expectedIdentity"> &
    Partial<Pick<AtomicDeployResult, "altAddress" | "layout">>,
): Promise<SendDeployResult> {
  if (signed.length < 1 || signed.length > 3) {
    throw new Error(`expected 1..3 transactions, got ${signed.length}`);
  }
  const conn = connection as DeploySendConnection;
  const hasAlt = ctx.layout ? ctx.layout !== "single" : signed.length > 1;
  const confirmOpts = { blockhash: ctx.blockhash, lastValidBlockHeight: ctx.lastValidBlockHeight };
  const signatures: string[] = [];
  let first = 0;

  if (hasAlt) {
    const sig1 = await conn.sendRawTransaction(signed[0].serialize(), { skipPreflight: false });
    const confirmation1 = await conn.confirmTransaction({ signature: sig1, ...confirmOpts }, "confirmed");
    if (confirmation1.value.err) throw new Error(`Deploy preparation failed: ${JSON.stringify(confirmation1.value.err)}`);
    signatures.push(sig1);
    await waitForNextSlot(conn);
    first = 1;
  }

  for (let i = first; i < signed.length; i++) {
    const sig = await conn.sendRawTransaction(signed[i].serialize(), { skipPreflight: false });
    const confirmation = await conn.confirmTransaction({ signature: sig, ...confirmOpts }, "confirmed");
    if (confirmation.value.err) {
      const what = signed.length - first === 1
        ? "Atomic pool creation/seed"
        : i === first ? "Pool creation" : "Seed deposit";
      throw new Error(`${what} failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    signatures.push(sig);
    // Verify the created pool before funding it (alt-2) / before reporting.
    if (i === first) await verifyCreatedPool(conn, ctx.poolPda, { ...ctx.expectedIdentity, swapsEnabled: undefined });
  }
  // Final state (incl. the launch flag) against the signed intent.
  await verifyCreatedPool(conn, ctx.poolPda, ctx.expectedIdentity);

  const computeUnits: (number | undefined)[] = [];
  for (const sig of signatures) computeUnits.push(await computeUnitsOf(conn, sig));
  return { signatures, computeUnits };
}

/** Alias (reference-implementation name). */
export const sendSignedDeploy = sendAtomicDeploy;

/** Block until the confirmed slot strictly exceeds the current one. */
export async function waitForNextSlot(connection: Pick<DeploySendConnection, "getSlot">, pollMs = 150, maxPolls = 100): Promise<void> {
  const start = await connection.getSlot("confirmed");
  for (let i = 0; i < maxPolls; i++) {
    if ((await connection.getSlot("confirmed")) > start) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error("slot did not advance");
}

export async function computeUnitsOf(
  connection: Pick<DeploySendConnection, "getTransaction">,
  signature: string,
  pollMs = 400,
  maxPolls = 12,
): Promise<number | undefined> {
  for (let i = 0; i < maxPolls; i++) {
    const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (tx?.meta) return tx.meta.computeUnitsConsumed ?? undefined;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return undefined;
}

/** The transactions to put in a Jito bundle: every pool transaction, never the ALT one. */
export function bundleTransactions(result: Pick<AtomicDeployResult, "transactions" | "layout">): VersionedTransaction[] {
  return result.layout === "single" ? result.transactions : result.transactions.slice(1);
}

/** The hook slice accounts a deploy carries (for callers that inspect the init / seed instructions). */
export function deployHookAccounts(params: Pick<AtomicDeployParams, "hookConfig" | "hookAccounts">): AccountMeta[] {
  return params.hookConfig ? (params.hookAccounts ?? []) : [];
}
