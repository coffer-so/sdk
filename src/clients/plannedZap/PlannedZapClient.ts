/**
 * v6 planned single-token deposit: one bank snapshot → local plan → signed
 * `deposit_single_token_planned`.
 *
 * Flow: `quote()` (one `getMultipleAccountsInfoAndContext` of pool, LP
 * mint, every token mint and Clock) → `ensureUserTokenAccountIxs()` (sent
 * first if any account is missing; the program needs every `user_token_i`
 * and the LP account to exist) → `resolveExtraAccounts()` (hook/memo tail,
 * `[]` for classic pools) → `buildIx()`/`buildTx()` → optional wallet ALT
 * (`prepareWalletLookupTable`/`waitForWalletLookupTable`) →
 * `compileTransaction()` → simulate → sign within the plan's validity
 * (≤ 90 s and ≤ `validForSlots` after the snapshot; any change to the pool,
 * LP supply, a mint or the epoch makes it `AllocationPlanStale`).
 */
import { AccountMeta, AddressLookupTableAccount, Commitment, ComputeBudgetProgram, PublicKey, SYSVAR_CLOCK_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import { CofferConfig } from "../../config";
import { SdkResult, err, ok } from "../../types/result";
import { BuiltTx, PlannedZapQuoteOptions, SwapFeeSource } from "../../types/tx";
import { HOOK_FLAGS, MAX_SWAP_FEE_RATE } from "../../config";
import { RpcClient } from "../RpcClient";
import { decodePoolAccount, RawPoolAccount } from "../../parsers/poolAccount";
import { decodeMintAccount } from "../../parsers/mintAccount";
import { deriveAta, deriveLpMint } from "../../utils/pda";
import { tokenTransferBlockers, unsupportedMintExtensions } from "../../utils/extensions";
import { selectEpochFee } from "../../math/transferFee";
import { applySlippage } from "../../math/slippage";
import { MathError } from "../../math/fixedPoint";
import { quoteZap, replay, QuotePool, SimError, ZapQuote } from "../../math/planner";
import { leverageViolations } from "../../math/leverage";
import { SwapLeg } from "../../math/swapSim";
import { resolveTransferExtraAccounts, TransferLeg, UnsupportedTransferProfileError } from "../../utils/transferProfile";
import { MAX_VALID_FOR_SLOTS, SnapshotAccount, stateCommitment } from "./stateCommitment";
import { AllocationPlan, buildPlannedZapIx, PlannedZapAccounts, PLANNED_ZAP_CU_LIMIT, PLANNED_ZAP_MAX_TOKENS, PLANNED_ZAP_MIN_TOKENS } from "./instruction";
import { AltConnection, buildWalletLookupPreparation, compilePlannedZapTransaction, CompiledPlannedZap, resolveWalletLookupTable, waitForWalletLookupTable, WalletLookupPreparation } from "./walletAlt";

const MINT_LEN = 82;
const DEFAULT_VALID_FOR_SLOTS = 120;
const bn = (v: bigint): BN => new BN(v.toString());

export interface PlannedZapClientParams {
  config: CofferConfig;
  poolAddress: PublicKey;
  rpc?: RpcClient | { endpoint?: string; endpoints?: string[]; fallbackEndpoints?: string[]; apiKey?: string; commitment?: Commitment; timeoutMs?: number };
}

/** Everything a caller needs to build, size and sign the planned deposit. */
export interface PlannedZapQuote {
  tokenInIndex: number;
  amountIn: BN;
  /** The signed plan: gross budget per slot, state hash, snapshot timestamp, expiry slot. */
  plan: AllocationPlan;
  /** Exact replay of the plan on the snapshot (bigint). */
  economics: ZapQuote;
  /** `economics.lp` as BN: the LP the user receives, NET of the pool's deposit fee (v6.1 T7). */
  estimatedLp: BN;
  /** LP the proportional join computes before the deposit fee (`economics.lpGross`). */
  estimatedLpGross: BN;
  /** `estimatedLpGross − estimatedLp`: withheld by the deposit fee. */
  depositFeeLp: BN;
  /** `estimatedLp` after slippage — the instruction's only floor; always > 0. */
  minimumLp: BN;
  /**
   * v6.1 (T9): where the legs' swap fee rate came from. `"hook_dynamic_unknown"`
   * means the pool has an active `DYNAMIC_FEE` hook and no `hookFeeOverride`
   * was supplied: the plan was priced at the base rate and the real LP may
   * differ (the `minimumLp` floor absorbs it or the zap fails loudly).
   */
  feeSource: SwapFeeSource;
  /** Plan allocations as BN (sum = `amountIn`). */
  allocations: BN[];
  /** Per-slot net swap output credited to the user's accounts before the join (`0` for the input slot and sidelined slots). */
  expectedOuts: BN[];
  /** Per-slot gross debit of the join (`depositedGross`). */
  depositedAmounts: BN[];
  /** v6.1 (T12): per-slot part of the join's credit that bought into the surge bucket (`surge_buy_in`). */
  surgeBuyInAmounts: BN[];
  /** Per-slot leftovers in the user's accounts after the join. */
  dustAmounts: BN[];
  sidelinedTokenIndices: number[];
  /** Snapshot the plan was hashed on; feed it to the tail resolver and to any re-pricing. */
  snapshots: { pool: SnapshotAccount; lpMint: SnapshotAccount; mints: SnapshotAccount[] };
  /** RPC context slot of the snapshot (equals Clock.slot in the same bank). */
  contextSlot: number;
  chainSlot: bigint;
  chainEpoch: bigint;
  /** Clock `unix_timestamp` of the snapshot (= `plan.quotedAt`). */
  chainTimestamp: bigint;
  /** Account set for the instruction, without the user-specific accounts (see `accountsFor`). */
  layout: Omit<PlannedZapAccounts, "user" | "userTokenAccounts" | "userLpAccount" | "extraAccounts">;
  /** The planner's pool snapshot (for callers that want to re-run `replay`). */
  quotePool: QuotePool;
}

export class PlannedZapClient {
  readonly config: CofferConfig;
  readonly poolAddress: PublicKey;
  readonly rpc: RpcClient;

  constructor(params: PlannedZapClientParams) {
    this.config = params.config;
    this.poolAddress = params.poolAddress;
    this.rpc =
      params.rpc instanceof RpcClient
        ? params.rpc
        : new RpcClient({
            endpoint: params.rpc?.endpoint,
            endpoints: params.rpc?.endpoints ?? (params.rpc?.endpoint ? undefined : params.config.defaults.rpcEndpoints),
            fallbackEndpoints: params.rpc?.fallbackEndpoints,
            apiKey: params.rpc?.apiKey,
            commitment: params.rpc?.commitment ?? params.config.defaults.rpcCommitment,
            timeoutMs: params.rpc?.timeoutMs ?? params.config.defaults.rpcTimeoutMs,
          });
  }

  /**
   * Snapshot, plan and price a single-token deposit. Two RPC calls at most:
   * the pool account (to learn its mints), then one atomic
   * `getMultipleAccountsInfoAndContext` of pool + LP mint + mints + Clock
   * that every byte of the plan, its hash and its timestamps comes from.
   */
  async quote(tokenInIndex: number, amountIn: BN | bigint, options: PlannedZapQuoteOptions = {}): Promise<SdkResult<PlannedZapQuote>> {
    const amount = typeof amountIn === "bigint" ? amountIn : BigInt(amountIn.toString());
    if (amount <= 0n || amount > (1n << 64n) - 1n) return err("invalid_input", "amountIn must be a positive u64");
    const slip = options.slippageHundredthsBps ?? this.config.defaults.slippageHundredthsBps;
    const validForSlots = options.validForSlots ?? DEFAULT_VALID_FOR_SLOTS;
    if (!Number.isInteger(validForSlots) || validForSlots < 1 || validForSlots > MAX_VALID_FOR_SLOTS) return err("invalid_input", `validForSlots must be 1..${MAX_VALID_FOR_SLOTS}`);
    if (options.nowSeconds !== undefined && (!Number.isSafeInteger(options.nowSeconds) || options.nowSeconds < 0)) return err("invalid_input", "nowSeconds must be a non-negative integer");

    const conn = this.rpc.connection;
    let mints: PublicKey[];
    try {
      const first = await conn.getAccountInfo(this.poolAddress, "confirmed");
      if (!first) return err("account_not_found", `Pool ${this.poolAddress.toBase58()} does not exist on-chain`);
      if (!first.owner.equals(this.config.programs.cofferPool)) return err("parse_failure", "Pool account has an unexpected owner");
      const raw = decodePoolAccount(first.data);
      mints = raw.tokenMints.slice(0, raw.tokenCount);
    } catch (e) {
      return err(e instanceof Error && /decodePoolAccount/.test(e.message) ? "parse_failure" : "rpc_unavailable", "Could not read the pool account", e);
    }
    const [lpMint] = deriveLpMint(this.config.programs.cofferPool, this.poolAddress);
    const keys = [this.poolAddress, lpMint, ...mints, SYSVAR_CLOCK_PUBKEY];
    let response: Awaited<ReturnType<typeof conn.getMultipleAccountsInfoAndContext>>;
    try {
      response = await conn.getMultipleAccountsInfoAndContext(keys, { commitment: "confirmed" });
    } catch (e) {
      return err("rpc_unavailable", "Could not snapshot the pool, mints and Clock", e);
    }
    const accounts: SnapshotAccount[] = [];
    for (let i = 0; i < keys.length; i++) {
      const account = response.value[i];
      if (!account) return err("account_not_found", `Missing quote account ${keys[i].toBase58()}`);
      accounts.push({ key: keys[i], owner: account.owner, data: Buffer.from(account.data) });
    }
    const snapshots = { pool: accounts[0], lpMint: accounts[1], mints: accounts.slice(2, -1) };
    const clock = Buffer.from(accounts[accounts.length - 1].data);
    if (clock.length !== 40) return err("parse_failure", "Invalid Clock sysvar layout");
    const chainSlot = clock.readBigUInt64LE(0), chainEpoch = clock.readBigUInt64LE(16), chainTimestamp = clock.readBigInt64LE(32);

    // Decode the snapshot into the planner's pool.
    if (!snapshots.pool.owner.equals(this.config.programs.cofferPool)) return err("parse_failure", "Pool account has an unexpected owner");
    let raw: RawPoolAccount;
    try { raw = decodePoolAccount(Buffer.from(snapshots.pool.data)); } catch (e) { return err("parse_failure", "Could not decode pool account", e); }
    const n = raw.tokenCount;
    if (n < PLANNED_ZAP_MIN_TOKENS || n > PLANNED_ZAP_MAX_TOKENS) return err("unsupported_pool_state", `Planned zap supports 2..${PLANNED_ZAP_MAX_TOKENS} tokens`);
    if (!raw.poolEnabled) return err("pool_disabled", "Pool is disabled");
    if (!raw.swapsEnabled) return err("swaps_disabled", "Swaps are disabled");
    if (!Number.isInteger(tokenInIndex) || tokenInIndex < 0 || tokenInIndex >= n) return err("invalid_input", "Invalid tokenInIndex");
    if (raw.actualBalances[tokenInIndex].isZero()) return err("invalid_input", "Input token is sidelined (zero actual balance)");
    if (snapshots.lpMint.data.length !== MINT_LEN) return err("unsupported_token_extension", "The LP mint carries extensions; the planned zap requires a plain mint (ZapTokenExtensionsUnsupported)");
    let lpSupply: bigint;
    try { lpSupply = BigInt(decodeMintAccount(Buffer.from(snapshots.lpMint.data)).supply.toString()); } catch (e) { return err("parse_failure", "Could not decode the LP mint", e); }
    if (lpSupply === 0n) return err("invalid_input", "PoolNotSeeded");
    const tokens: SwapLeg[] = [];
    const tokenPrograms: PublicKey[] = [];
    for (let i = 0; i < n; i++) {
      const snapshot = snapshots.mints[i];
      if (!snapshot.key.equals(raw.tokenMints[i])) return err("parse_failure", `Mint order mismatch at index ${i}`);
      if (!snapshot.owner.equals(raw.tokenPrograms[i])) return err("parse_failure", `Mint token program mismatch at index ${i}`);
      if (snapshot.key.equals(lpMint)) return err("unsupported_pool_state", "A pool mint equals the LP mint");
      let mint;
      try { mint = decodeMintAccount(Buffer.from(snapshot.data)); } catch (e) { return err("parse_failure", `Could not decode mint ${snapshot.key.toBase58()}`, e); }
      const blockers = tokenTransferBlockers({ index: i, mint: snapshot.key, tokenProgram: snapshot.owner, unsupportedExtensions: unsupportedMintExtensions(mint.extensions), paused: mint.pausableConfig?.paused ?? false });
      if (blockers.length) return err("unsupported_token_extension", `token[${i}] ${snapshot.key.toBase58()}: ${blockers.join("; ")}`);
      tokens.push({
        virtualBalance: BigInt(raw.virtualBalances[i].toString()),
        actualBalance: BigInt(raw.actualBalances[i].toString()),
        protocolFeesOwed: BigInt(raw.protocolFeesOwed[i].toString()),
        // v6.1 (T14 / T12): the pool-level buckets, 0 on an unmigrated account.
        creatorFeesOwed: BigInt(raw.creatorFeesOwed[i]?.toString() ?? "0"),
        surgeFeesOwed: BigInt(raw.surgeFeesOwed[i]?.toString() ?? "0"),
        weightBps: BigInt(raw.normalizedWeights[i].toString()),
        isActive: raw.isActive[i],
        maxSelloffPct: raw.maxSelloffPct[i],
        maxSelloffPeriodLength: raw.maxSelloffPeriodLength[i],
        curve: { thresholdPct: raw.variableFeeThresholdPct[i], slopeLowPct: raw.variableFeeSlopeLowPct[i], slopeMidPct: raw.variableFeeSlopeMidPct[i], slopeHighPct: raw.variableFeeSlopeHighPct[i], kinkPct: raw.variableFeeKinkPct[i] },
        window: { previousSelloff: BigInt(raw.previousSelloff[i].toString()), currentSelloff: BigInt(raw.currentSelloff[i].toString()), windowStartTimestamp: BigInt(raw.windowStartTimestamp[i].toString()), selloffVbSnapshot: BigInt(raw.selloffVbSnapshot[i].toString()) },
        transferFee: mint.transferFeeConfig ? selectEpochFee(mint.transferFeeConfig, chainEpoch) : null,
      });
      tokenPrograms.push(raw.tokenPrograms[i]);
    }
    // v6.1 (T9): hook gate (a disabled fail-closed hook pauses swaps and
    // deposits) and the dynamic-fee rate the zap's legs will run on.
    const hookActive = !raw.hookProgram.equals(PublicKey.default) && raw.hookDisabled === 0;
    if (!raw.hookProgram.equals(PublicKey.default) && raw.hookDisabled !== 0 && (raw.hookFlags & HOOK_FLAGS.PAUSE_WHEN_DISABLED) !== 0) {
      return err("hook_rejected", "The pool's hook is disabled and fail-closed (HookPaused): swaps and deposits are paused");
    }
    const dynamicFee = hookActive && (raw.hookFlags & HOOK_FLAGS.DYNAMIC_FEE) !== 0;
    if (options.hookFeeOverride !== undefined) {
      if (!Number.isSafeInteger(options.hookFeeOverride) || options.hookFeeOverride < 0 || options.hookFeeOverride > MAX_SWAP_FEE_RATE) return err("invalid_input", `hookFeeOverride must be an integer in 0..=${MAX_SWAP_FEE_RATE}`);
      if (!dynamicFee) return err("invalid_input", "hookFeeOverride given but the pool has no active DYNAMIC_FEE hook");
    }
    const feeSource: SwapFeeSource = options.hookFeeOverride !== undefined ? "hook_override" : dynamicFee ? "hook_dynamic_unknown" : "pool";
    const quotePool: QuotePool = {
      tokens, lpSupply, swapFeeRate: raw.swapFeeRate, protocolFeeRate: raw.protocolFeeRate,
      creatorFeeBps: raw.creatorFeeBps, depositFeeBps: raw.depositFeeBps,
      hookFeeOverride: options.hookFeeOverride, hookFeeMin: raw.hookFeeMin, hookFeeMax: raw.hookFeeMax,
      now: options.nowSeconds !== undefined ? BigInt(options.nowSeconds) : chainTimestamp,
    };

    // v6.1 (T22): `QuotePool::from_pool` refuses a pool that already violates
    // the strict leverage invariant (every swap / join CPI would revert).
    const violating = leverageViolations(tokens.map((t) => t.virtualBalance), tokens.map((t) => t.actualBalance));
    if (violating.length) return err("leverage_invariant", `VirtualBalanceNotAboveActual: slot${violating.length > 1 ? "s" : ""} ${violating.join(", ")} at virtual ≤ actual; the pool cannot trade until the protocol admin runs rescale_virtual_balances`);
    let economics: ZapQuote;
    try {
      economics = quoteZap(quotePool, tokenInIndex, amount);
    } catch (e) {
      if (e instanceof SimError || e instanceof MathError) return err(e instanceof SimError && e.code === "AmountTooSmall" ? "amount_too_small" : "invalid_input", `Planned zap quote failed: ${e.message}`, e);
      throw e;
    }
    // `economics.lp` is NET of the deposit fee (T7); the floor must be > 0
    // (a zero `minimum_lp` would disable the only slippage guard, T8).
    const minimumLp = applySlippage(economics.lp, slip);
    if (minimumLp <= 0n) return err("amount_too_small", "Quote is too small for a positive LP floor");
    const plan: AllocationPlan = {
      allocations: economics.allocations.slice(),
      expectedState: stateCommitment(snapshots.pool, snapshots.lpMint, snapshots.mints, chainEpoch),
      quotedAt: chainTimestamp,
      validUntilSlot: chainSlot + BigInt(validForSlots),
    };
    const expectedOuts = tokens.map((_, i) => (i === tokenInIndex ? 0n : economics.available[i]));
    return ok({
      tokenInIndex,
      amountIn: bn(amount),
      plan,
      economics,
      estimatedLp: bn(economics.lp),
      estimatedLpGross: bn(economics.lpGross),
      depositFeeLp: bn(economics.depositFeeLp),
      minimumLp: bn(minimumLp),
      feeSource,
      allocations: economics.allocations.map(bn),
      expectedOuts: expectedOuts.map(bn),
      depositedAmounts: economics.depositedGross.map(bn),
      surgeBuyInAmounts: economics.surgeBuyIn.map(bn),
      dustAmounts: economics.dust.map(bn),
      sidelinedTokenIndices: tokens.flatMap((t, i) => (t.actualBalance === 0n ? [i] : [])),
      snapshots,
      contextSlot: response.context.slot,
      chainSlot,
      chainEpoch,
      chainTimestamp,
      layout: {
        pool: this.poolAddress,
        lpMint,
        cofferPoolProgram: this.config.programs.cofferPool,
        lpTokenProgram: snapshots.lpMint.owner,
        mints: mints.slice(),
        vaults: mints.map((mint, i) => deriveAta(this.poolAddress, mint, tokenPrograms[i])),
        tokenPrograms,
      },
      quotePool,
    });
  }

  /** Re-price a fixed plan at another Clock second on the same snapshot (window decay only). */
  replayAt(quote: PlannedZapQuote, nowSeconds: number): SdkResult<ZapQuote> {
    try {
      return ok(replay({ ...quote.quotePool, now: BigInt(nowSeconds) }, quote.tokenInIndex, BigInt(quote.amountIn.toString()), quote.plan.allocations));
    } catch (e) {
      if (e instanceof SimError || e instanceof MathError) return err("invalid_input", `Plan is infeasible at ${nowSeconds}: ${e.message}`, e);
      throw e;
    }
  }

  /** Full account set for `user` (ATAs for every slot and the LP mint). */
  accountsFor(quote: PlannedZapQuote, user: PublicKey, extraAccounts?: AccountMeta[]): PlannedZapAccounts {
    const { layout } = quote;
    return {
      ...layout,
      user,
      userLpAccount: deriveAta(user, layout.lpMint, layout.lpTokenProgram),
      userTokenAccounts: layout.mints.map((mint, i) => deriveAta(user, mint, layout.tokenPrograms[i])),
      extraAccounts,
    };
  }

  /**
   * Idempotent ATA creates for every pool token and the LP mint. The
   * program requires all of them to exist (writable, even for sidelined
   * slots). Send them in a separate, earlier transaction: together with the
   * zap they do not fit the 1232-byte packet on larger pools.
   */
  ensureUserTokenAccountIxs(quote: PlannedZapQuote, user: PublicKey, payer: PublicKey = user): TransactionInstruction[] {
    const accounts = this.accountsFor(quote, user);
    const ixs = accounts.mints.map((mint, i) =>
      createAssociatedTokenAccountIdempotentInstruction(payer, accounts.userTokenAccounts[i], user, mint, accounts.tokenPrograms[i])
    );
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(payer, accounts.userLpAccount, user, accounts.lpMint, accounts.lpTokenProgram));
    return ixs;
  }

  /**
   * Hook/memo tail for every transfer of the planned route (swap legs in
   * both directions and the join debits), resolved against the quote's own
   * mint snapshots. `[]` for pools without Token-2022 mints.
   */
  async resolveExtraAccounts(quote: PlannedZapQuote, user: PublicKey): Promise<SdkResult<AccountMeta[]>> {
    const accounts = this.accountsFor(quote, user);
    const legs: TransferLeg[] = [];
    for (const swap of quote.economics.swaps) {
      legs.push({ mint: accounts.mints[swap.input], tokenProgram: accounts.tokenPrograms[swap.input], source: accounts.userTokenAccounts[swap.input], destination: accounts.vaults[swap.input], authority: user, amount: swap.grossInput });
      // `ensureUserTokenAccountIxs` creates the user's output ATA in the same transaction; it may not exist yet.
      legs.push({ mint: accounts.mints[swap.output], tokenProgram: accounts.tokenPrograms[swap.output], source: accounts.vaults[swap.output], destination: accounts.userTokenAccounts[swap.output], authority: accounts.pool, amount: swap.grossOutput, destinationCreatedInTx: true });
    }
    quote.economics.depositedGross.forEach((gross, i) => {
      if (gross > 0n) legs.push({ mint: accounts.mints[i], tokenProgram: accounts.tokenPrograms[i], source: accounts.userTokenAccounts[i], destination: accounts.vaults[i], authority: user, amount: gross });
    });
    try {
      const mints = quote.snapshots.mints.map((m) => ({ address: m.key, owner: m.owner, data: m.data }));
      return ok(await resolveTransferExtraAccounts(this.rpc.connection, legs, mints, [user, accounts.pool, accounts.lpMint, accounts.userLpAccount]));
    } catch (e) {
      if (e instanceof UnsupportedTransferProfileError) return err("unsupported_token_extension", e.message, e);
      return err("tx_build_failed", `Could not resolve the transfer-hook/memo tail: ${e instanceof Error ? e.message : String(e)}`, e);
    }
  }

  /** The `deposit_single_token_planned` instruction for `user`. */
  buildIx(quote: PlannedZapQuote, user: PublicKey, extraAccounts: AccountMeta[] = []): TransactionInstruction {
    return buildPlannedZapIx(this.config, this.accountsFor(quote, user, extraAccounts), {
      amountIn: BigInt(quote.amountIn.toString()),
      tokenInIndex: quote.tokenInIndex,
      minimumLp: BigInt(quote.minimumLp.toString()),
      plan: quote.plan,
    });
  }

  /** Compute budget + the zap. ATA creates are NOT included (see `ensureUserTokenAccountIxs`). */
  buildTx(quote: PlannedZapQuote, user: PublicKey, extraAccounts: AccountMeta[] = []): SdkResult<BuiltTx> {
    try {
      return ok({
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: PLANNED_ZAP_CU_LIMIT }), this.buildIx(quote, user, extraAccounts)],
        suggestedCuLimit: PLANNED_ZAP_CU_LIMIT,
      });
    } catch (e) {
      return err("tx_build_failed", `Failed to build the planned zap: ${e instanceof Error ? e.message : String(e)}`, e);
    }
  }

  /** Addresses the pool's own ALT does not cover: the user's token accounts, LP account and the tail. */
  walletLookupAddresses(quote: PlannedZapQuote, user: PublicKey, extraAccounts: AccountMeta[] = []): PublicKey[] {
    const accounts = this.accountsFor(quote, user);
    return [...accounts.userTokenAccounts, accounts.userLpAccount, ...extraAccounts.map((m) => m.pubkey)];
  }

  /** Plan the wallet-owned ALT setup (create/extend batches); see `walletAlt.ts`. */
  prepareWalletLookupTable(user: PublicKey, addresses: PublicKey[], existing?: PublicKey, options?: { walletReserve?: number }): Promise<WalletLookupPreparation> {
    return buildWalletLookupPreparation(this.altConnection(), user, addresses, existing, options);
  }

  waitForWalletLookupTable(preparation: WalletLookupPreparation, user: PublicKey, timeoutMs?: number): Promise<AddressLookupTableAccount> {
    return waitForWalletLookupTable(this.altConnection(), preparation, user, timeoutMs);
  }

  resolveWalletLookupTable(address: PublicKey, user: PublicKey, addresses: PublicKey[]): Promise<AddressLookupTableAccount> {
    return resolveWalletLookupTable(this.altConnection(), address, user, addresses);
  }

  /** Load the pool's ALT (if provisioned) for `compileTransaction`. */
  async poolLookupTable(lookupTable: PublicKey | undefined): Promise<SdkResult<AddressLookupTableAccount | null>> {
    if (!lookupTable || lookupTable.equals(PublicKey.default)) return ok(null);
    try {
      const res = await this.rpc.connection.getAddressLookupTable(lookupTable);
      if (!res.value) return err("alt_fetch_failed", `Lookup table ${lookupTable.toBase58()} not found on-chain`);
      return ok(res.value);
    } catch (e) {
      return err("alt_fetch_failed", `Failed to fetch lookup table ${lookupTable.toBase58()}`, e);
    }
  }

  /** Compile against the given ALTs and refuse when the packet budget is exceeded. */
  compileTransaction(options: { payer: PublicKey; blockhash: string; instructions: TransactionInstruction[]; lookupTables: AddressLookupTableAccount[]; walletReserve?: number; computeUnits?: number }): SdkResult<CompiledPlannedZap> {
    try {
      return ok(compilePlannedZapTransaction(options));
    } catch (e) {
      return err("tx_build_failed", e instanceof Error ? e.message : String(e), e);
    }
  }

  private altConnection(): AltConnection {
    return this.rpc.connection;
  }
}

/** Convenience for callers holding a classic-token-only pool: a plain Token LP program. */
export const DEFAULT_LP_TOKEN_PROGRAM = TOKEN_PROGRAM_ID;
