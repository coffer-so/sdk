import { simulatePoolSwap, quoteTimestamp, swapLegOf, u64, hasDynamicFeeHook, hookPaused, tokenSurgeBucket, pendingActionsStatusOf, PendingActionsStatus } from "./quote-math";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, Commitment, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import BN from "bn.js";
import { CofferConfig } from "../config";
import { PoolInfo, PoolTokenInfo } from "../types/pool";
import { SdkResult, err, ok } from "../types/result";
import { AddLiquidityQuote, LpPriceQuote, PlannedZapQuoteOptions, RemoveLiquidityQuote, SwapFeeSource, SwapQuote, SwapQuoteOptions } from "../types/tx";
import { CofferPoolEvent } from "../types/events";
import { RpcClient } from "./RpcClient";
import { decodePoolAccount, RawPoolAccount } from "../parsers/poolAccount";
import { decodeMintAccount } from "../parsers/mintAccount";
import { parseCofferPoolEvents } from "../parsers/events";
import { deriveAta, deriveLpMint } from "../utils/pda";
import { resolveKnownToken } from "../config/tokens";
import { describeUnsupportedToken, isTokenTransferable, unsupportedMintExtensions } from "../utils/extensions";
import { grossOfTransferFee, netOfTransferFee, selectEpochFee, transferFeeOf } from "../math/transferFee";
import {
  calcEffectiveLpBurn,
  calcJoinRatioAndLp,
  calcTokensOutGivenLpIn,
  virtualBalanceAfterDeposit,
  virtualBalanceAfterWithdrawal,
} from "../math/poolMath";
import { divDown } from "../math/fixedPoint";
import { navBalances, splitDepositCredit, splitExitPayout } from "../math/surgeBucket";
import { applyDepositFee, lpBurnNetOfWithdrawFee } from "../math/liquidityFee";
import { lpPositionValue, lpPriceUsd } from "../math/lpPrice";
import { applyRescale, checkFundLeverage, checkSeedLeverage, leverageViolations, minRescaleMultiplier } from "../math/leverage";
import { MathError } from "../math/fixedPoint";
import { rescaleWindowOnVbChange, computeSelloffWindow, SelloffWindowStatus } from "../math/maxSelloff";
import { calcSurgeFeePct } from "../math/surgeFee";
import { applySlippage, priceImpactHbps } from "../math/slippage";
import { DEFAULT_INITIAL_LP_SUPPLY, LIQUIDITY_FEE_LOCK_FROZEN, MAX_INITIAL_LP_SUPPLY, MAX_SWAP_FEE_RATE, MIN_INITIAL_LP_SUPPLY, PERCENT_SCALE, SWAP_FEE_PRECISION } from "../config";
import {
  buildAddLiquidityTx,
  buildFundSidelinedTokenTx,
  buildRemoveLiquidityTx,
  buildSeedLiquidityTx,
  buildSwapTx,
} from "./tx-builders";
import type { FundSidelinedTokenParams, HookedParams, SeedLiquidityParams, TxBuildOptionsV61 } from "../types/tx-v61";
import {
  AddLiquidityParams,
  BuiltTx,
  RemoveLiquidityParams,
  SwapParams,
} from "../types/tx";
import { PlannedZapClient, PlannedZapQuote } from "./plannedZap/PlannedZapClient";
import { resolveAddLiquidityExtraAccounts, resolveRemoveLiquidityExtraAccounts, resolveSwapExtraAccounts, ResolveExtraAccountsParams } from "./extra-accounts";
import { UnsupportedTransferProfileError } from "../utils/transferProfile";
import type { AccountMeta } from "@solana/web3.js";

export interface CofferPoolClientParams {
  config: CofferConfig;
  poolAddress: PublicKey;
  rpc?:
    | RpcClient
    | {
        endpoint?: string;
        endpoints?: string[];
        fallbackEndpoints?: string[];
        apiKey?: string;
        commitment?: Commitment;
        timeoutMs?: number;
      };
}

/**
 * Per-pool client. Fetch the state with `sync()`, then call any of the
 * quote / buildTx methods off the cached snapshot.
 */
export class CofferPoolClient {
  readonly config: CofferConfig;
  readonly poolAddress: PublicKey;
  readonly rpc: RpcClient;

  private cache: PoolInfo | undefined;
  /** Raw decoded account from the last `sync()`; holds per-token window data. */
  private rawAccount: RawPoolAccount | undefined;

  constructor(params: CofferPoolClientParams) {
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

  /** Last-fetched pool state. `undefined` before first `sync()`. */
  getCached(): PoolInfo | undefined {
    return this.cache;
  }

  /**
   * Fetch and decode the pool account + LP mint + per-token mint decimals.
   * Safe to call repeatedly; subsequent calls replace the cache.
   */
  async sync(): Promise<SdkResult<PoolInfo>> {
    const poolInfo = await this.rpc.getAccountInfo(this.poolAddress);
    if (!poolInfo.ok) return poolInfo;
    if (poolInfo.data === null) {
      return err("account_not_found", `Pool ${this.poolAddress.toBase58()} does not exist on-chain`);
    }
    if (!poolInfo.data.owner.equals(this.config.programs.cofferPool)) return err("parse_failure", "Pool account has an unexpected owner");
    let raw;
    try {
      raw = decodePoolAccount(poolInfo.data.data);
    } catch (e) {
      return err("parse_failure", "Could not decode pool account", e);
    }
    const n = raw.tokenCount;
    const mintAddrs = raw.tokenMints.slice(0, n);
    const [lpMint, _lpBump] = deriveLpMint(this.config.programs.cofferPool, this.poolAddress);

    const mintInfos = await this.rpc.getMultipleAccountsWithInfo([lpMint, ...mintAddrs, SYSVAR_CLOCK_PUBKEY]);
    if (!mintInfos.ok) return mintInfos;
    const [lpInfo, ...rest] = mintInfos.data;
    const tokenMintInfos = rest.slice(0, n);
    const clockInfo = rest[n];
    const lpMintData = lpInfo?.data;
    if (lpInfo && ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(p => p.equals(lpInfo.owner))) return err("parse_failure", "Invalid LP token program");
    if (!clockInfo || clockInfo.data.length < 40) return err("parse_failure", "Solana Clock account missing");
    // Clock sysvar: slot u64 @0, epoch_start_timestamp i64 @8, epoch u64 @16,
    // leader_schedule_epoch u64 @24, unix_timestamp i64 @32.
    const chainSlot = Number(clockInfo.data.readBigUInt64LE(0));
    const chainEpoch = Number(clockInfo.data.readBigUInt64LE(16));
    const chainTimestamp = Number(clockInfo.data.readBigInt64LE(32));
    const createdAt = Number(raw.createdAt.toString());
    if (![chainSlot, chainEpoch, chainTimestamp, createdAt].every(Number.isSafeInteger)) {
      return err("parse_failure", "Pool/Clock values cannot be represented exactly by PoolInfo; use the raw account decoder for full integer values");
    }
    if (!lpMintData) {
      return err("account_not_found", "LP mint account missing");
    }
    let lpMintAcc;
    try {
      lpMintAcc = decodeMintAccount(lpMintData);
    } catch (e) {
      return err("parse_failure", "Could not decode LP mint", e);
    }
    const tokens: PoolTokenInfo[] = [];
    for (let i = 0; i < n; i++) {
      const mintInfo = tokenMintInfos[i];
      const mintRaw = mintInfo?.data;
      if (mintInfo && !mintInfo.owner.equals(raw.tokenPrograms[i])) return err("parse_failure", `Mint token program mismatch at index ${i}`);
      if (!mintRaw) {
        return err("account_not_found", `Mint account missing for token index ${i}`);
      }
      let mintAcc;
      try {
        mintAcc = decodeMintAccount(mintRaw);
      } catch (e) {
        return err("parse_failure", `Could not decode mint ${mintAddrs[i].toBase58()}`, e);
      }
      const actualBalance = raw.actualBalances[i];
      const virtualBalance = raw.virtualBalances[i];
      if (raw.normalizedWeights[i].gt(new BN(Number.MAX_SAFE_INTEGER))) {
        return err("parse_failure", `Weight cannot be represented exactly at token index ${i}`);
      }
      const concentration =
        virtualBalance.isZero() ? 0 : Number(actualBalance.toString()) / Number(virtualBalance.toString());
      tokens.push({
        index: i,
        mint: raw.tokenMints[i],
        tokenProgram: raw.tokenPrograms[i],
        decimals: mintAcc.decimals,
        weightBps: raw.normalizedWeights[i].toNumber(),
        virtualBalance,
        actualBalance,
        protocolFeesOwed: raw.protocolFeesOwed[i],
        vault: deriveAta(this.poolAddress, raw.tokenMints[i], raw.tokenPrograms[i]),
        metadata:
          this.config.tokens?.[raw.tokenMints[i].toBase58()] ??
          resolveKnownToken(raw.tokenMints[i].toBase58()),
        concentration,
        isActive: raw.isActive[i],
        maxSelloffPct: raw.maxSelloffPct[i],
        maxSelloffPeriodLength: raw.maxSelloffPeriodLength[i],
        variableFeeThresholdPct: raw.variableFeeThresholdPct[i],
        variableFeeSlopeLowPct: raw.variableFeeSlopeLowPct[i],
        variableFeeSlopeHighPct: raw.variableFeeSlopeHighPct[i],
        previousSelloff: raw.previousSelloff[i],
        currentSelloff: raw.currentSelloff[i],
        windowStartTimestamp: raw.windowStartTimestamp[i],
        selloffVbSnapshot: raw.selloffVbSnapshot[i],
        variableFeeSlopeMidPct: raw.variableFeeSlopeMidPct[i],
        variableFeeKinkPct: raw.variableFeeKinkPct[i],
        extensions: mintAcc.extensions,
        unsupportedExtensions: unsupportedMintExtensions(mintAcc.extensions),
        transferFee: mintAcc.transferFeeConfig ? selectEpochFee(mintAcc.transferFeeConfig, BigInt(chainEpoch)) : null,
        transferHookProgram:
          mintAcc.transferHook && !mintAcc.transferHook.programId.equals(PublicKey.default) ? mintAcc.transferHook.programId : null,
        paused: mintAcc.pausableConfig?.paused ?? false,
        // v6.1 appended state (defaults on an unmigrated 1683-byte pool).
        pinnedDecimals: raw.layoutVersion > 0 ? raw.tokenDecimals[i] : undefined,
        pinnedDecimalsMismatch: raw.layoutVersion > 0 && raw.tokenDecimals[i] !== mintAcc.decimals,
        creatorFeesOwed: raw.creatorFeesOwed[i],
        surgeFeesOwed: raw.surgeFeesOwed[i],
        sidelined: actualBalance.isZero(),
      });
    }

    const info: PoolInfo = {
      address: this.poolAddress,
      config: raw.config,
      bump: raw.bump,
      poolId: raw.poolId,
      tokenCount: n,
      tokens,
      unsupportedTokenIndices: tokens.filter((t) => !isTokenTransferable(t)).map((t) => t.index),
      lpMint,
      lpTokenProgram: lpInfo!.owner,
      poolAdmin: raw.poolAdmin,
      pendingPoolAdmin: raw.pendingPoolAdmin,
      rangeManager: raw.rangeManager,
      rangeManagerEnabled: raw.rangeManagerEnabled,
      rangeManagerMaxVbChangePct: raw.rangeManagerMaxVbChangePct,
      rangeManagerMaxWeightChangePct: raw.rangeManagerMaxWeightChangePct,
      rangeManagerMinUpdateIntervalSecs: raw.rangeManagerMinUpdateIntervalSecs,
      rangeManagerLastUpdated: raw.rangeManagerLastUpdated,
      chainTimestamp,
      chainSlot,
      chainEpoch,
      v5Migrated: raw.v5Migrated,
      lpTotalSupply: lpMintAcc.supply,
      swapFeeRate: raw.swapFeeRate,
      protocolFeeRate: raw.protocolFeeRate,
      poolEnabled: raw.poolEnabled,
      swapsEnabled: raw.swapsEnabled,
      createdAt,
      lookupTable: raw.lookupTable,
      rangeManagerMaxLeverageBps: raw.rangeManagerMaxLeverageBps,
      rangeManagerMinLeverageBps: raw.rangeManagerMinLeverageBps,
      syncedAt: Date.now(),
      // ── v6.1 ──
      dataLen: raw.dataLen,
      layoutVersion: raw.layoutVersion,
      needsLayoutMigration: raw.layoutVersion === 0,
      tokenDecimals: raw.tokenDecimals.slice(0, n),
      creatorFeeBps: raw.creatorFeeBps,
      creatorFeesOwed: raw.creatorFeesOwed.slice(0, n),
      surgeFeesOwed: raw.surgeFeesOwed.slice(0, n),
      depositFeeBps: raw.depositFeeBps,
      withdrawFeeBps: raw.withdrawFeeBps,
      liquidityFeeLock: raw.liquidityFeeLock,
      liquidityFeesLocked: (raw.liquidityFeeLock & LIQUIDITY_FEE_LOCK_FROZEN) !== 0,
      rangeManagerLocked: raw.rangeManagerLocked,
      poolAdminDelaySecs: raw.poolAdminDelaySecs,
      poolAdminEpoch: raw.poolAdminEpoch,
      pendingPoolAdminEta: raw.pendingPoolAdminEta,
      pendingActions: raw.pendingActions,
      pendingActionsMask: raw.pendingActionsMask,
      hook: raw.hookProgram.equals(PublicKey.default) ? null : {
        program: raw.hookProgram,
        flags: raw.hookFlags,
        disabled: raw.hookDisabled !== 0,
        active: raw.hookDisabled === 0,
        feeMin: raw.hookFeeMin,
        feeMax: raw.hookFeeMax,
        maxCu: raw.hookMaxCu,
        accountsLen: raw.hookAccountsLen,
      },
      layoutDrift: raw.layoutDrift,
      lpMetadata: lpMintAcc.tokenMetadata,
      // v6.1 (T22): a legacy pool at `V ≤ A` is frozen for swaps / deposits until rescaled.
      leverageViolations: leverageViolations(tokens.map((t) => BigInt(t.virtualBalance.toString())), tokens.map((t) => BigInt(t.actualBalance.toString()))),
    };
    this.cache = info;
    this.rawAccount = raw;
    return ok(info);
  }

  // ---------- Quote helpers (pure, require sync()) ----------

  /**
   * Quote a swap (v6.1 `swap.rs`). Requires the cache to be populated
   * (call `sync()` first). Returns the exact on-chain math — the T15/T14
   * fee cascade (`protocol` / `creator` / `lp` shares of both the base fee
   * and the surge), the T12 surge-bucket credit — plus the spot bound, the
   * price impact and the slippage-derived `minAmountOut`.
   *
   * Positional form `(in, out, amountIn, slippage?, nowSeconds?, options?)`
   * or `(in, out, amountIn, { slippageHundredthsBps, nowSeconds, hookFeeOverride })`.
   *
   * Dynamic-fee hooks (T9): when the pool's hook is active with
   * `DYNAMIC_FEE` and no `hookFeeOverride` is supplied, the quote runs at
   * the base `swapFeeRate` and reports `feeSource: "hook_dynamic_unknown"`
   * — the program will run the cascade on whatever the hook returns
   * (clamped into `[hook.feeMin, hook.feeMax]`). Read the real rate from a
   * `simulateTransaction` `Swap.effective_fee_rate` log, or replicate the
   * hook's rule off chain, and re-quote with `hookFeeOverride`.
   *
   * A sidelined output slot (`actualBalance == 0`, T10) is a typed
   * `no_liquidity` error — the program reverts with `InsufficientLiquidity`.
   */
  quoteSwap(
    tokenInIndex: number,
    tokenOutIndex: number,
    amountIn: BN,
    slippageOrOptions?: number | SwapQuoteOptions,
    nowSeconds?: number,
    options: SwapQuoteOptions = {}
  ): SdkResult<SwapQuote> {
    const opts: SwapQuoteOptions = typeof slippageOrOptions === "object" && slippageOrOptions !== null
      ? { ...slippageOrOptions }
      : { ...options, slippageHundredthsBps: slippageOrOptions ?? options.slippageHundredthsBps, nowSeconds: nowSeconds ?? options.nowSeconds };
    const pool = this.requireCache();
    if (!pool.ok) return pool;
    const unsupported = this.requireSupported([tokenInIndex, tokenOutIndex], "swap");
    if (!unsupported.ok) return unsupported;
    const levered = this.requireLeverage("swap");
    if (!levered.ok) return levered;
    const slip = opts.slippageHundredthsBps ?? this.config.defaults.slippageHundredthsBps;
    const dynamic = hasDynamicFeeHook(pool.data);
    if (opts.hookFeeOverride !== undefined) {
      if (!Number.isSafeInteger(opts.hookFeeOverride) || opts.hookFeeOverride < 0 || opts.hookFeeOverride > MAX_SWAP_FEE_RATE) {
        return err("invalid_input", `hookFeeOverride must be an integer in 0..=${MAX_SWAP_FEE_RATE} (hundredths of bps)`);
      }
      if (!dynamic) return err("invalid_input", "hookFeeOverride given but the pool has no active DYNAMIC_FEE hook; the program runs the cascade on swapFeeRate");
    }
    const feeSource: SwapFeeSource = opts.hookFeeOverride !== undefined ? "hook_override" : dynamic ? "hook_dynamic_unknown" : "pool";
    try {
      const q = simulatePoolSwap(pool.data, tokenInIndex, tokenOutIndex, BigInt(amountIn.toString()), quoteTimestamp(pool.data, opts.nowSeconds), false, { hookFeeOverride: opts.hookFeeOverride });
      // v5 display contract: post-trade window fill and static+surge fee
      // pct (span-average) — the same fields the pre-merge v5 SDK returned.
      const inTok = pool.data.tokens[tokenInIndex];
      let windowFillPct = 0;
      let surgePct = 0;
      if (q.window && q.window.maxSelloffCap > 0n) {
        const scale = BigInt(PERCENT_SCALE);
        const fillRaw = (q.window.effectiveSelloff * scale) / q.window.maxSelloffCap;
        windowFillPct = Number(fillRaw > scale ? scale : fillRaw);
        surgePct = calcSurgeFeePct(q.window.effectiveSelloffBefore, q.window.effectiveSelloff, q.window.maxSelloffCap, {
          thresholdPct: inTok.variableFeeThresholdPct ?? 0,
          slopeLowPct: inTok.variableFeeSlopeLowPct ?? 0,
          slopeMidPct: inTok.variableFeeSlopeMidPct ?? 0,
          slopeHighPct: inTok.variableFeeSlopeHighPct ?? 0,
          kinkPct: inTok.variableFeeKinkPct ?? 0,
        });
      }
      const effectiveFeePct = (q.effectiveFeeRate * PERCENT_SCALE) / SWAP_FEE_PRECISION + surgePct;
      const b = (v: bigint) => new BN(v.toString());
      return ok({
        tokenInIndex,
        tokenOutIndex,
        amountIn,
        transferFeeIn: b(q.transferFeeIn),
        amountInNet: b(q.amountInNet),
        amountOut: b(q.amountOut),
        grossAmountOut: b(q.grossAmountOut),
        transferFeeOut: b(q.transferFeeOut),
        amountOutReceived: b(q.amountOutReceived),
        surgeFeeAmount: b(q.surgeFeeAmount),
        surgeProtocolFeeAmount: b(q.surgeProtocolFeeAmount),
        surgeCreatorFeeAmount: b(q.surgeCreatorFeeAmount),
        surgeLpFeeAmount: b(q.surgeLpFeeAmount),
        feeAmount: b(q.feeAmount),
        protocolFeeAmount: b(q.protocolFeeAmount),
        creatorFeeAmount: b(q.creatorFeeAmount),
        lpFeeAmount: b(q.lpFeeAmount),
        effectiveFeeRate: q.effectiveFeeRate,
        feeSource,
        spotOut: b(q.spotOut),
        // Impact excludes fees and the surge charge (industry standard):
        // measured against the GROSS curve output.
        priceImpactHbps: priceImpactHbps(q.spotOut, q.grossAmountOut),
        // The program checks `minimum_amount_out` against what the user
        // actually receives (post-surge, post-transfer-fee).
        minAmountOut: b(applySlippage(q.amountOutReceived, slip)),
        effectiveFeePct,
        windowFillPct,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Keep the specific v5 error codes existing consumers rely on.
      const code =
        msg === "MaxSelloffExceeded" ? "selloff_window_full"
        : msg === "TokenInactive" ? "token_swaps_disabled"
        : msg === "PoolDisabled" ? "pool_disabled"
        : msg === "SwapsDisabled" ? "swaps_disabled"
        : msg === "AmountFullyConsumedByTransferFee" ? "amount_too_small"
        : msg === "InsufficientLiquidity" ? "no_liquidity"
        : msg === "HookPaused" ? "hook_rejected"
        : "invalid_input";
      const human =
        code === "selloff_window_full" ? "Token max-selloff threshold exceeded for current window"
        : code === "no_liquidity" ? `Output token ${tokenOutIndex} has no reserves (sidelined); the program reverts with InsufficientLiquidity`
        : code === "hook_rejected" ? "The pool's hook is disabled and fail-closed (HookPaused): swaps are paused"
        : `Swap quote failed: ${msg}`;
      return err(code, human, e);
    }
  }

  /**
   * Read-only status of a token's max-selloff window at `now` (default:
   * the synced `chainTimestamp` — Clock seconds, never browser time).
   * Requires a prior `sync()`.
   */
  getSelloffWindowStatus(tokenIndex: number, now?: number): SdkResult<SelloffWindowStatus> {
    const poolRes = this.requireCache();
    if (!poolRes.ok) return poolRes;
    const raw = this.rawAccount;
    if (!raw) {
      return err("invalid_input", "Call `sync()` first to populate window state");
    }
    const pool = poolRes.data;
    if (tokenIndex < 0 || tokenIndex >= pool.tokens.length) {
      return err("invalid_input", "Invalid tokenIndex");
    }
    const at = now ?? pool.chainTimestamp;
    if (at === undefined || !Number.isSafeInteger(at) || at < 0) {
      return err("invalid_input", "Chain timestamp missing: sync the pool or pass `now` (Clock seconds)");
    }
    const i = tokenIndex;
    return ok(
      computeSelloffWindow({
        maxSelloffPct: raw.maxSelloffPct[i],
        periodLength: raw.maxSelloffPeriodLength[i],
        previousSelloff: raw.previousSelloff[i],
        currentSelloff: raw.currentSelloff[i],
        windowStartTimestamp: raw.windowStartTimestamp[i],
        selloffVbSnapshot: raw.selloffVbSnapshot[i],
        virtualBalance: pool.tokens[i].virtualBalance,
        now: at,
      })
    );
  }

  /**
   * v6.1 (T3): status of every pool-admin pending slot at the chain clock
   * (`chainNow` defaults to the synced `chainTimestamp`; never `Date.now()`).
   * `directPathOpen` is `true` while `poolAdminDelaySecs == 0`.
   */
  pendingActionsStatus(chainNow?: number): SdkResult<PendingActionsStatus> {
    const pool = this.requireCache();
    if (!pool.ok) return pool;
    try {
      return ok(pendingActionsStatusOf(pool.data, chainNow));
    } catch (e) {
      return err("invalid_input", e instanceof Error ? e.message : String(e), e);
    }
  }

  /**
   * v6.1 (T2/T12): USD price of one LP token from per-mint spot prices
   * (`prices[mintBase58]` = USD per whole token), valued on NAV
   * (`actual_balance + surge_fees_owed` per slot) — never on `vault.amount`,
   * which also holds the protocol's and the creator's claims.
   */
  quoteLpPriceUsd(prices: Record<string, number>): SdkResult<LpPriceQuote> {
    const pool = this.requireCache();
    if (!pool.ok) return pool;
    if (pool.data.lpTotalSupply.isZero()) return err("unsupported_pool_state", "Pool is not seeded (LP supply is 0)");
    try {
      const v = lpPriceUsd(pool.data, prices);
      return ok({ lpPriceUsd: v.lpPriceUsd, navUsd: v.navUsd, lpSupplyUi: v.lpSupplyUi, perToken: v.perToken.map((t) => ({ ...t, nav: new BN(t.nav.toString()) })) });
    } catch (e) {
      return err("invalid_input", `LP price failed: ${e instanceof Error ? e.message : String(e)}`, e);
    }
  }

  /** v6.1 (T12): the per-token NAV share `lpAmount` LP represents (`floor(nav_i · lpAmount / supply)`, raw). A valuation, not an exit quote. */
  quoteLpPositionValue(lpAmount: BN): SdkResult<BN[]> {
    const pool = this.requireCache();
    if (!pool.ok) return pool;
    if (pool.data.lpTotalSupply.isZero()) return err("unsupported_pool_state", "Pool is not seeded (LP supply is 0)");
    if (lpAmount.isNeg() || lpAmount.bitLength() > 64) return err("invalid_input", "lpAmount must be a u64");
    try {
      return ok(lpPositionValue(pool.data, lpAmount).map((v) => new BN(v.toString())));
    } catch (e) {
      return err("invalid_input", `LP position value failed: ${e instanceof Error ? e.message : String(e)}`, e);
    }
  }

  /**
   * Seed quote (v6.1 `seed_liquidity.rs`, T2): creator-only, runs exactly
   * once (`lp_supply == 0`), takes `tokenAmounts` verbatim (zero legs stay
   * sidelined, T10; the vault books the NET of any Token-2022 fee) and
   * mints the creator-chosen `lpAmount` EXACTLY — no invariant, no pool
   * ratio, no deposit fee, no `minimum_lp_amount`. The LP price is
   * therefore `Σ seed value / lpAmount`. Gate order mirrors
   * `check_seed_preconditions`.
   */
  quoteSeedDeposit(user: PublicKey, tokenAmounts: BN[], lpAmount: BN | bigint = DEFAULT_INITIAL_LP_SUPPLY): SdkResult<AddLiquidityQuote> {
    const state = this.requireCache();
    if (!state.ok) return state;
    const pool = state.data;
    if (!pool.poolEnabled) return err("pool_disabled", "PoolDisabled");
    if (!pool.lpTotalSupply.isZero()) return err("unsupported_pool_state", "PoolAlreadySeeded: use quoteAddLiquidity");
    if (!pool.poolAdmin) return err("invalid_input", "Pool admin missing: sync the pool before quoting");
    if (pool.poolAdmin.equals(PublicKey.default)) return err("unsupported_pool_state", "PoolAdminDisabled: the pool can never be seeded");
    if (!pool.poolAdmin.equals(user)) return err("auth_failed", "SeedDepositNotPoolAdmin: only the pool admin can seed");
    if (tokenAmounts.length !== pool.tokenCount) return err("invalid_input", "InvalidArrayLength: expected one amount per pool token");
    if (tokenAmounts.some(a => a.isNeg() || a.bitLength() > 64)) return err("invalid_input", "Expected one u64 amount per token");
    if (tokenAmounts.every(a => a.isZero())) return err("invalid_input", "FirstDepositRequiresNonzero: at least one seed leg must be non-zero");
    const lp = typeof lpAmount === "bigint" ? lpAmount : BigInt(lpAmount.toString());
    if (lp < MIN_INITIAL_LP_SUPPLY) return err("invalid_input", `InitialLiquidityTooSmall: lpAmount must be ≥ ${MIN_INITIAL_LP_SUPPLY} (1 LP)`);
    if (lp > MAX_INITIAL_LP_SUPPLY) return err("invalid_input", `InitialLpSupplyTooLarge: lpAmount must be ≤ ${MAX_INITIAL_LP_SUPPLY}`);
    if (hookPaused(pool)) return err("hook_rejected", "The pool's hook is disabled and fail-closed (HookPaused): deposits are paused");
    const supported = this.requireSupported(tokenAmounts.flatMap((a, i) => a.isZero() ? [] : [i]), "seed deposit");
    if (!supported.ok) return supported;
    try {
      const amounts = tokenAmounts.map(a => BigInt(a.toString()));
      const credited = amounts.map((a, i) => netOfTransferFee(pool.tokens[i].transferFee, a));
      if (credited.some((c, i) => amounts[i] > 0n && c === 0n)) return err("amount_too_small", "AmountFullyConsumedByTransferFee");
      // v6.1 (T22) `check_seed_leverage`: the seed books `actual_i = net_i`, so every slot needs `net_i < virtual_i`.
      try {
        checkSeedLeverage(pool.tokens.map((t) => BigInt(t.virtualBalance.toString())), credited);
      } catch (e) {
        if (!(e instanceof MathError)) throw e;
        const bad = credited.findIndex((c, i) => c >= BigInt(pool.tokens[i].virtualBalance.toString()));
        return err("leverage_invariant", `VirtualBalanceNotAboveActual: the net seed amount ${credited[bad]} for slot ${bad} must stay below its virtual balance ${pool.tokens[bad].virtualBalance}; lower the amount or deploy with a larger virtual balance`);
      }
      const bnList = (xs: bigint[]) => xs.map((x) => new BN(x.toString()));
      const zeros = () => tokenAmounts.map(() => new BN(0));
      const lpBn = new BN(lp.toString());
      return ok({
        tokenAmounts,
        depositAmounts: tokenAmounts.map(a => a.clone()),
        refundAmounts: zeros(),
        chargedAmounts: tokenAmounts.map(a => a.clone()),
        unspentAmounts: zeros(),
        creditedAmounts: bnList(credited),
        transferFees: bnList(amounts.map((a, i) => a - credited[i])),
        surgeBuyIn: zeros(),
        actualIn: bnList(credited),
        navBalances: zeros(),
        virtualBalancesAfter: pool.tokens.map(t => t.virtualBalance.clone()),
        lpGross: lpBn.clone(),
        depositFeeLp: new BN(0),
        depositFeeBps: 0,
        lpOut: lpBn.clone(),
        minimumLpAmount: lpBn.clone(),
        limitingTokenIndex: -1,
      });
    } catch (e) { return err("math_overflow", "Seed-deposit quote failed", e); }
  }

  /**
   * v6.1 (T10 / T22): preview `fund_sidelined_token` — the net amount the
   * slot books as its `actual_balance` after the mint's transfer fee, and the
   * gates the program applies (pool admin, sidelined slot, `net < virtual`).
   * No LP is minted. Requires `sync()`.
   */
  quoteFundSidelinedToken(authority: PublicKey, tokenIndex: number, amount: BN): SdkResult<{ tokenIndex: number; amountCharged: BN; amountCredited: BN; transferFee: BN; virtualBalance: BN; actualAfter: BN; maxAmountNet: BN }> {
    const state = this.requireCache();
    if (!state.ok) return state;
    const pool = state.data;
    const t = pool.tokens[tokenIndex];
    if (!t || tokenIndex >= pool.tokenCount) return err("invalid_input", `InvalidTokenIndex: ${tokenIndex} outside 0..${pool.tokenCount - 1}`);
    if (!pool.poolAdmin) return err("invalid_input", "Pool admin missing: sync the pool before quoting");
    if (!pool.poolAdmin.equals(authority)) return err("auth_failed", "Unauthorized: only the pool admin can fund a sidelined slot");
    if (pool.lpTotalSupply.isZero()) return err("unsupported_pool_state", "PoolNotSeeded: seed the pool first");
    if (!t.actualBalance.isZero()) return err("invalid_input", `TokenNotSidelined: slot ${tokenIndex} already holds reserves`);
    if (!BN.isBN(amount) || amount.isNeg() || amount.bitLength() > 64) return err("invalid_input", "amount must be a u64 BN");
    if (amount.isZero()) return err("invalid_input", "ZeroAmount");
    const supported = this.requireSupported([tokenIndex], "fund_sidelined_token");
    if (!supported.ok) return supported;
    const gross = BigInt(amount.toString());
    const net = netOfTransferFee(t.transferFee, gross);
    if (net === 0n) return err("amount_too_small", "AmountFullyConsumedByTransferFee");
    const virtual = BigInt(t.virtualBalance.toString());
    try {
      checkFundLeverage(virtual, net);
    } catch (e) {
      if (!(e instanceof MathError)) throw e;
      return err("leverage_invariant", `VirtualBalanceNotAboveActual: the net amount ${net} must stay below slot ${tokenIndex}'s virtual balance ${virtual} (at most ${virtual - 1n} raw this way; rescale first for more depth)`);
    }
    const b = (v: bigint) => new BN(v.toString());
    return ok({ tokenIndex, amountCharged: amount.clone(), amountCredited: b(net), transferFee: b(gross - net), virtualBalance: t.virtualBalance.clone(), actualAfter: b(net), maxAmountNet: b(virtual - 1n) });
  }

  /**
   * v6.1 (T22): preview `rescale_virtual_balances(multiplier)` — the new
   * virtual balances (`V_i · multiplier`), which slots it repairs, and the
   * program's checks (`multiplier ≥ 2`, no overflow, `V > A` and the
   * per-slot floor afterwards). `multiplier` defaults to the smallest
   * repairing value (`minRescaleMultiplier`); the runbook rounds up to a
   * power of ten. Price-neutral by construction. Requires `sync()`.
   */
  quoteRescaleVirtualBalances(multiplier?: BN | bigint | number): SdkResult<{ multiplier: BN; oldVirtualBalances: BN[]; newVirtualBalances: BN[]; repairedSlots: number[]; minMultiplier: BN | null }> {
    const state = this.requireCache();
    if (!state.ok) return state;
    const pool = state.data;
    const virtuals = pool.tokens.map((t) => BigInt(t.virtualBalance.toString()));
    const actuals = pool.tokens.map((t) => BigInt(t.actualBalance.toString()));
    const decimals = pool.tokenDecimals && pool.tokenDecimals.length === pool.tokenCount ? pool.tokenDecimals : pool.tokens.map((t) => t.decimals);
    let min: bigint | null;
    try { min = minRescaleMultiplier(virtuals, actuals, decimals); } catch (e) { return err("math_overflow", "Rescale quote failed", e); }
    const chosen = multiplier === undefined ? min : BN.isBN(multiplier) ? BigInt(multiplier.toString()) : BigInt(multiplier);
    if (chosen === null) return err("unsupported_pool_state", "No u64 multiplier repairs this pool (a zero virtual balance or an overflowing product)");
    if (chosen < 0n || chosen > (1n << 64n) - 1n) return err("invalid_input", "multiplier must be a u64");
    try {
      const r = applyRescale(virtuals, actuals, chosen, decimals);
      const b = (v: bigint) => new BN(v.toString());
      return ok({ multiplier: b(chosen), oldVirtualBalances: virtuals.map(b), newVirtualBalances: r.newVirtualBalances.map(b), repairedSlots: r.repairedSlots, minMultiplier: min === null ? null : b(min) });
    } catch (e) {
      if (!(e instanceof MathError)) throw e;
      const code = e.message === "InvalidVirtualRescale" ? "invalid_input" : e.message === "MathOverflow" ? "math_overflow" : e.message === "InvalidVirtualBalances" ? "unsupported_pool_state" : "leverage_invariant";
      return err(code, `${e.message}: multiplier ${chosen} ${e.message === "VirtualBalanceBelowFloor" ? "leaves a slot below its floor max(10^decimals, 1000)" : e.message === "VirtualBalanceNotAboveActual" ? "does not lift every slot above its actual balance" : "is rejected"}${min !== null ? ` (smallest repairing multiplier: ${min})` : ""}`, e);
    }
  }

  /** v6.1 (T22): swaps / deposits on a pool with a slot at `V ≤ A` revert with `VirtualBalanceNotAboveActual` (post-state guard on every slot). */
  private requireLeverage(op: string): SdkResult<void> {
    const state = this.requireCache();
    if (!state.ok) return state;
    const pool = state.data;
    const bad = pool.leverageViolations ?? leverageViolations(pool.tokens.map((t) => BigInt(t.virtualBalance.toString())), pool.tokens.map((t) => BigInt(t.actualBalance.toString())));
    if (bad.length === 0) return ok(undefined);
    return err("leverage_invariant", `VirtualBalanceNotAboveActual: slot${bad.length > 1 ? "s" : ""} ${bad.join(", ")} ${bad.length > 1 ? "are" : "is"} at virtual ≤ actual; ${op} reverts until the protocol admin runs rescale_virtual_balances (exits still work)`);
  }

  /**
   * Proportional-join quote (v6.1 `add_liquidity.rs`). `tokenAmounts` is a
   * CEILING: the program nets each ceiling of its mint's transfer fee, takes
   * the limiting ratio `min_i(net_i / nav_i)` over live legs — on NAV,
   * `nav_i = actual_i + surge_fees_owed_i` (T12) — computes
   * `lpGross = floor(supply · ratio)`, withholds the deposit fee
   * (`lpOut = lpGross − ceil(lpGross · depositFeeBps / 1e4)`, T7), credits
   * each leg `ceil(nav_i · ratio)` of which `floor(surge_i · ratio)` buys
   * into the surge bucket (the WHOLE credit on a reserve-less slot) and the
   * rest goes to the reserves, and debits that credit grossed up by the
   * transfer fee. Whatever is left of the ceiling stays in the wallet.
   *
   * Liveness is keyed on NAV: a slot with `nav_i > 0` needs a positive
   * ceiling, a slot with `nav_i == 0` must be `0` (`TokenLivenessMismatch`).
   * `DepositTooSmall` / `DepositFeeConsumesAll` are `amount_too_small`.
   *
   * Not applicable to the seed deposit (LP supply == 0): see `quoteSeedDeposit`.
   */
  quoteAddLiquidity(tokenAmounts: BN[], slippageHundredthsBps?: number): SdkResult<AddLiquidityQuote> {
    const poolRes = this.requireCache();
    if (!poolRes.ok) return poolRes;
    const pool = poolRes.data;
    if (tokenAmounts.length !== pool.tokenCount) {
      return err("invalid_input", "tokenAmounts length must equal pool.tokenCount");
    }
    if (pool.lpTotalSupply.isZero()) {
      return err("invalid_input", "Pool has zero LP supply; use quoteSeedDeposit");
    }
    if (!pool.poolEnabled) return err("pool_disabled", "Pool is disabled");
    if (hookPaused(pool)) return err("hook_rejected", "The pool's hook is disabled and fail-closed (HookPaused): deposits are paused");
    const levered = this.requireLeverage("add_liquidity");
    if (!levered.ok) return levered;
    if (tokenAmounts.some((a) => a.isNeg() || a.bitLength() > 64)) {
      return err("invalid_input", "tokenAmounts must be u64 values");
    }
    const slip = slippageHundredthsBps ?? this.config.defaults.slippageHundredthsBps;
    try {
      const actual = pool.tokens.map((t) => BigInt(t.actualBalance.toString()));
      const surge = pool.tokens.map((t) => tokenSurgeBucket(t, pool));
      const navs = navBalances(actual, surge);
      if (pool.tokens.some((_, i) => (navs[i] > 0n) !== !tokenAmounts[i].isZero())) {
        return err("invalid_input", "TokenLivenessMismatch: live tokens (NAV > 0) need positive amounts; empty tokens need zero amounts");
      }
      const unsupported = this.requireSupported(pool.tokens.flatMap((t, i) => (navs[i] > 0n ? [t.index] : [])), "add_liquidity");
      if (!unsupported.ok) return unsupported;
      const amounts = tokenAmounts.map((a) => BigInt(a.toString()));
      const supply = BigInt(pool.lpTotalSupply.toString());
      const net = amounts.map((a, i) => netOfTransferFee(pool.tokens[i].transferFee, a));
      if (net.some((n, i) => amounts[i] > 0n && n === 0n)) return err("amount_too_small", "AmountFullyConsumedByTransferFee");
      const { lp: lpGross, ratio } = calcJoinRatioAndLp(navs, net, supply);
      let limiting = -1;
      for (let i = 0; i < navs.length; i++) {
        if (navs[i] > 0n && divDown(net[i], navs[i]) === ratio) { limiting = i; break; }
      }
      if (lpGross === 0n) return err("amount_too_small", "DepositTooSmall");
      const depositFeeBps = pool.depositFeeBps ?? 0;
      const { net: lpOut, fee: depositFeeLp } = applyDepositFee(lpGross, depositFeeBps);
      if (lpOut === 0n) return err("amount_too_small", "DepositFeeConsumesAll: the deposit fee withholds the whole LP mint");
      u64(supply + lpOut, "LP supply");
      const credited: bigint[] = [], charged: bigint[] = [], virtualAfter: bigint[] = [], buyIn: bigint[] = [], actualIn: bigint[] = [];
      for (let i = 0; i < navs.length; i++) {
        const leg = splitDepositCredit(actual[i], surge[i], ratio);
        const credit = leg.totalCredit;
        if (credit > net[i]) return err("invalid_input", `Credit exceeds the net ceiling at token index ${i} (program would fail with MathOverflow)`);
        const charge = grossOfTransferFee(pool.tokens[i].transferFee, credit);
        if (charge > amounts[i]) return err("invalid_input", `Transfer-fee gross-up exceeds the ceiling at token index ${i}; raise the ceiling by at least ${(charge - amounts[i]).toString()}`);
        u64(actual[i] + leg.actualIn, "reserve balance");
        u64(surge[i] + leg.bucketIn, "surge bucket");
        const vb = BigInt(pool.tokens[i].virtualBalance.toString());
        // `lpGross`, not the net mint, and the ACTUAL leg only: the bucket
        // buy-in is outside the curve (add_liquidity.rs).
        const next = virtualBalanceAfterDeposit(vb, actual[i], leg.actualIn, lpGross, supply);
        rescaleWindowOnVbChange(swapLegOf(pool.tokens[i], pool).window, vb, next);
        credited.push(credit); charged.push(charge); virtualAfter.push(next); buyIn.push(leg.bucketIn); actualIn.push(leg.actualIn);
      }
      const unspent = amounts.map((a, i) => a - charged[i]);
      const bnList = (xs: bigint[]) => xs.map((x) => new BN(x.toString()));
      return ok({
        tokenAmounts,
        depositAmounts: bnList(charged),
        refundAmounts: bnList(unspent),
        chargedAmounts: bnList(charged),
        unspentAmounts: bnList(unspent),
        creditedAmounts: bnList(credited),
        transferFees: bnList(charged.map((c, i) => c - credited[i])),
        surgeBuyIn: bnList(buyIn),
        actualIn: bnList(actualIn),
        navBalances: bnList(navs),
        virtualBalancesAfter: bnList(virtualAfter),
        lpGross: new BN(lpGross.toString()),
        depositFeeLp: new BN(depositFeeLp.toString()),
        depositFeeBps,
        lpOut: new BN(lpOut.toString()),
        minimumLpAmount: new BN(applySlippage(lpOut, slip).toString()),
        limitingTokenIndex: limiting,
      });
    } catch (e) {
      return err("math_overflow", `Add-liquidity quote failed: ${e instanceof Error ? e.message : String(e)}`, e);
    }
  }

  /**
   * Proportional-withdraw quote (v6.1 `remove_liquidity.rs`): the burn is
   * clamped to keep `MIN_LP_SUPPLY` in supply; per token the exit pays
   * `floor(actual_i · burn / supply)` from the reserves PLUS
   * `floor(surge_i · burn / supply)` from the LP surge bucket (T12), each
   * net of the withdraw fee (`ceil`, T7), in ONE transfer; the Token-2022
   * fee is then withheld from that transfer. Derive `minimumTokenAmounts`
   * from `receivedAmounts`. Zero-payout slots (sidelined with an empty
   * bucket, or dust) report `0` and need no user token account.
   * `WithdrawFeeConsumesAll` (gross > 0 somewhere, nothing paid anywhere)
   * is `amount_too_small`.
   */
  quoteRemove(lpIn: BN): SdkResult<RemoveLiquidityQuote> {
    const poolRes = this.requireCache();
    if (!poolRes.ok) return poolRes;
    const pool = poolRes.data;
    if (pool.lpTotalSupply.isZero()) {
      return err("invalid_input", "Pool has zero LP supply");
    }
    if (!pool.poolEnabled) return err("pool_disabled", "Pool is disabled");
    try {
      const actual = pool.tokens.map((t) => BigInt(t.actualBalance.toString()));
      const surge = pool.tokens.map((t) => tokenSurgeBucket(t, pool));
      const supply = BigInt(pool.lpTotalSupply.toString());
      const requested = BigInt(lpIn.toString());
      if (requested <= 0n || requested > supply) return err("invalid_input", "InvalidLpAmount");
      let effective: bigint;
      try { effective = calcEffectiveLpBurn(requested, supply); } catch { return err("invalid_input", "InvalidLpAmount"); }
      const grossActual = calcTokensOutGivenLpIn(actual, effective, supply);
      const grossSurge = calcTokensOutGivenLpIn(surge, effective, supply);
      const withdrawFeeBps = pool.withdrawFeeBps ?? 0;
      const legs = grossActual.map((g, i) => splitExitPayout(g, grossSurge[i], withdrawFeeBps));
      const feeTookEverything = legs.some((l) => l.actualGross > 0n || l.surgeGross > 0n) && legs.every((l) => l.transferAmount === 0n);
      if (feeTookEverything) return err("amount_too_small", "WithdrawFeeConsumesAll: the withdraw fee withholds every payout");
      const supported = this.requireSupported(legs.flatMap((l, i) => (l.transferAmount > 0n ? [i] : [])), "remove_liquidity");
      if (!supported.ok) return supported;
      const lpBurnForSidelined = lpBurnNetOfWithdrawFee(effective, withdrawFeeBps);
      const fees = legs.map((l, i) => transferFeeOf(pool.tokens[i].transferFee, l.transferAmount));
      const virtualAfter = pool.tokens.map((t, i) => {
        const vb = BigInt(t.virtualBalance.toString());
        // NET reserve payout only: the live leg's `virtual / actual` ratio
        // is preserved and the bucket (outside the curve) never enters.
        const next = virtualBalanceAfterWithdrawal(vb, actual[i], legs[i].actualPayout, lpBurnForSidelined, supply);
        rescaleWindowOnVbChange(swapLegOf(t, pool).window, vb, next);
        return next;
      });
      const bnList = (xs: bigint[]) => xs.map((x) => new BN(x.toString()));
      return ok({
        tokenOuts: bnList(legs.map((l) => l.actualPayout)),
        surgeOuts: bnList(legs.map((l) => l.surgePayout)),
        grossAmounts: bnList(grossActual),
        grossSurgeAmounts: bnList(grossSurge),
        withdrawFeeAmounts: bnList(legs.map((l) => l.feeTotal)),
        withdrawFeeBps,
        transferAmounts: bnList(legs.map((l) => l.transferAmount)),
        transferFees: bnList(fees),
        receivedAmounts: bnList(legs.map((l, i) => l.transferAmount - fees[i])),
        effectiveLpIn: new BN(effective.toString()),
        virtualBalancesAfter: bnList(virtualAfter),
      });
    } catch (e) {
      return err("math_overflow", `Remove quote failed: ${e instanceof Error ? e.message : String(e)}`, e);
    }
  }

  // ---------- v6 planned zap (single-token deposit) ----------

  /**
   * Planned single-token deposit client for this pool (shares config and
   * RPC). `quote()` takes one bank snapshot, plans the route locally and
   * returns the signed-plan inputs; see `PlannedZapClient`.
   */
  get plannedZap(): PlannedZapClient {
    if (!this._plannedZap) this._plannedZap = new PlannedZapClient({ config: this.config, poolAddress: this.poolAddress, rpc: this.rpc });
    return this._plannedZap;
  }
  private _plannedZap?: PlannedZapClient;

  /** Shorthand for `plannedZap.quote(...)`. */
  quotePlannedZap(tokenInIndex: number, amountIn: BN | bigint, options?: PlannedZapQuoteOptions): Promise<SdkResult<PlannedZapQuote>> {
    return this.plannedZap.quote(tokenInIndex, amountIn, options);
  }

  // ---------- Transaction builders ----------

  /**
   * Build a swap transaction. Requires `sync()` first. v6.1: prepends
   * `migrate_pool_layout_v61` on a 1683-byte pool unless `autoMigrate: false`
   * (then `pool_layout_outdated`); a hooked pool needs `hookAccounts`
   * (`hookAccountSlice` / `resolveHookSlice`).
   */
  buildSwapTx(params: SwapParams & HookedParams & TxBuildOptionsV61): SdkResult<BuiltTx> {
    const poolRes = this.requireCache();
    if (!poolRes.ok) return poolRes;
    const unsupported = this.requireSupported([params.tokenInIndex, params.tokenOutIndex], "swap");
    if (!unsupported.ok) return unsupported;
    const slip = params.slippageHundredthsBps ?? this.config.defaults.slippageHundredthsBps;
    let minOut: BN;
    if (params.minAmountOut) {
      minOut = params.minAmountOut;
    } else {
      const q = this.quoteSwap(
        params.tokenInIndex,
        params.tokenOutIndex,
        params.amountIn,
        slip
      );
      if (!q.ok) {
        return err(
          q.error.code,
          `Cannot build swap without minAmountOut: ${q.error.humanMessage}`,
          q.error.cause
        );
      }
      minOut = q.data.minAmountOut;
    }
    try {
      const tx = buildSwapTx(this.config, poolRes.data, { ...params, minAmountOut: minOut });
      return ok(tx);
    } catch (e) {
      return err("tx_build_failed", "Failed to build swap tx", e);
    }
  }

  /** Build a proportional add-liquidity transaction. Requires `sync()` first (v6.1: see `buildSwapTx` for the migration / hook options). */
  buildAddLiquidityTx(params: AddLiquidityParams & HookedParams & TxBuildOptionsV61): SdkResult<BuiltTx> {
    const poolRes = this.requireCache();
    if (!poolRes.ok) return poolRes;
    if (params.tokenAmounts.length !== poolRes.data.tokenCount) {
      return err("invalid_input", "tokenAmounts length must equal pool.tokenCount");
    }
    const unsupported = this.requireSupported(params.tokenAmounts.flatMap((a,i) => a.isZero() ? [] : [i]), "add_liquidity");
    if (!unsupported.ok) return unsupported;
    try {
      return ok(buildAddLiquidityTx(this.config, poolRes.data, params));
    } catch (e) {
      return err("tx_build_failed", "Failed to build add_liquidity tx", e);
    }
  }

  /**
   * Build a proportional remove-liquidity transaction. Requires `sync()`
   * first. v6.1: `bypassHooks: true` emits `remove_liquidity_bypass_hooks`
   * (same math, no hook CPI — the exit that always works, T9).
   */
  buildRemoveLiquidityTx(params: RemoveLiquidityParams & HookedParams & TxBuildOptionsV61 & { bypassHooks?: boolean }): SdkResult<BuiltTx> {
    const poolRes = this.requireCache();
    if (!poolRes.ok) return poolRes;
    if (!params.minimumTokenAmounts) {
      return err(
        "invalid_input",
        "minimumTokenAmounts is required (one per token). Derive per-token floors from quoteRemove(); pass explicit zeros only to intentionally disable slippage protection."
      );
    }
    if (params.minimumTokenAmounts.length !== poolRes.data.tokenCount) {
      return err("invalid_input", "minimumTokenAmounts length must equal pool.tokenCount");
    }
    const quote = this.quoteRemove(params.lpAmount);
    if (!quote.ok) return quote;
    try {
      return ok(buildRemoveLiquidityTx(this.config, poolRes.data, params));
    } catch (e) {
      return err("tx_build_failed", "Failed to build remove_liquidity tx", e);
    }
  }

  /**
   * v6.1 (T2/T10): the creator's seed deposit — exact amounts, zeros allowed
   * for sidelined slots, creator-chosen `lpAmount`. Requires `sync()`.
   */
  buildSeedLiquidityTx(params: SeedLiquidityParams): SdkResult<BuiltTx> {
    const poolRes = this.requireCache();
    if (!poolRes.ok) return poolRes;
    const quote = this.quoteSeedDeposit(params.user, params.tokenAmounts, params.lpAmount);
    if (!quote.ok) return quote;
    try {
      return ok(buildSeedLiquidityTx(this.config, poolRes.data, params));
    } catch (e) {
      return err("tx_build_failed", "Failed to build seed_liquidity tx", e);
    }
  }

  /** v6.1 (T10): pool-admin funding of a sidelined slot (no LP minted). Requires `sync()`. */
  buildFundSidelinedTokenTx(params: FundSidelinedTokenParams & TxBuildOptionsV61): SdkResult<BuiltTx> {
    const poolRes = this.requireCache();
    if (!poolRes.ok) return poolRes;
    try {
      return ok(buildFundSidelinedTokenTx(this.config, poolRes.data, params));
    } catch (e) {
      return err("tx_build_failed", "Failed to build fund_sidelined_token tx", e);
    }
  }

  // ---------- v6 remaining-account tails (hook extras + memo) ----------

  /**
   * Resolve the remaining-account tail a swap needs for Token-2022 hooks /
   * memo destinations. `[]` for classic pools without an RPC read. Pass the
   * result as `SwapParams.extraAccounts`. `amountOut` defaults to the quote.
   */
  async resolveSwapExtraAccounts(params: Pick<SwapParams, "user" | "tokenInIndex" | "tokenOutIndex" | "amountIn"> & { amountOut?: BN }, options?: ResolveExtraAccountsParams): Promise<SdkResult<AccountMeta[]>> {
    const poolRes = this.requireCache();
    if (!poolRes.ok) return poolRes;
    let amountOut = params.amountOut;
    if (!amountOut) {
      const q = this.quoteSwap(params.tokenInIndex, params.tokenOutIndex, params.amountIn);
      if (!q.ok) return q;
      amountOut = q.data.amountOut;
    }
    return this.resolveTail(() => resolveSwapExtraAccounts(this.rpc.connection, poolRes.data, { ...params, amountOut: amountOut! }, options), "swap");
  }

  /** Tail for `add_liquidity`; pass `quoteAddLiquidity().chargedAmounts` as the ceilings for amount-exact hooks. */
  async resolveAddLiquidityExtraAccounts(params: Pick<AddLiquidityParams, "user" | "tokenAmounts">, options?: ResolveExtraAccountsParams): Promise<SdkResult<AccountMeta[]>> {
    const poolRes = this.requireCache();
    if (!poolRes.ok) return poolRes;
    return this.resolveTail(() => resolveAddLiquidityExtraAccounts(this.rpc.connection, poolRes.data, params, options), "add_liquidity");
  }

  /** Tail for `remove_liquidity` at the synced state. */
  async resolveRemoveLiquidityExtraAccounts(params: Pick<RemoveLiquidityParams, "user" | "lpAmount">, options?: ResolveExtraAccountsParams): Promise<SdkResult<AccountMeta[]>> {
    const poolRes = this.requireCache();
    if (!poolRes.ok) return poolRes;
    return this.resolveTail(() => resolveRemoveLiquidityExtraAccounts(this.rpc.connection, poolRes.data, params, options), "remove_liquidity");
  }

  private async resolveTail(run: () => Promise<AccountMeta[]>, op: string): Promise<SdkResult<AccountMeta[]>> {
    try {
      return ok(await run());
    } catch (e) {
      if (e instanceof UnsupportedTransferProfileError) return err("unsupported_token_extension", `${op}: ${e.message}`, e);
      return err("tx_build_failed", `${op}: could not resolve the transfer-hook/memo tail: ${e instanceof Error ? e.message : String(e)}`, e);
    }
  }

  // ---------- Internals ----------

  /**
   * Refuse when any of `indices` (or every token, for `"all"`) cannot be
   * transferred by the program right now (unsupported extension, paused
   * mint, native mint). The program would revert on transfer, so failing
   * here saves the user a fee.
   */
  private requireSupported(indices: number[] | "all", op: string): SdkResult<void> {
    const pool = this.cache;
    if (!pool) return ok(undefined);
    const idx = indices === "all" ? pool.tokens.map((t) => t.index) : indices;
    const bad = idx.map((i) => pool.tokens[i]).filter((t) => t && !isTokenTransferable(t));
    if (bad.length === 0) return ok(undefined);
    return err(
      "unsupported_token_extension",
      `${op} refused: ${bad.map(describeUnsupportedToken).join("; ")}. ` +
        "The coffer-pool program cannot transfer such tokens; the transaction would revert on-chain."
    );
  }


  private requireCache(): SdkResult<PoolInfo> {
    if (!this.cache) {
      return err("invalid_input", "Call `sync()` first to populate pool state");
    }
    return ok(this.cache);
  }
}
