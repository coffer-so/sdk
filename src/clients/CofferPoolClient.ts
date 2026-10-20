import { simulatePoolSwap, quoteTimestamp, swapLegOf, u64 } from "./quote-math";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, Commitment, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import BN from "bn.js";
import { CofferConfig } from "../config";
import { PoolInfo, PoolTokenInfo } from "../types/pool";
import { SdkResult, err, ok } from "../types/result";
import { AddLiquidityQuote, PlannedZapQuoteOptions, RemoveLiquidityQuote, SwapQuote } from "../types/tx";
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
  calcLpOutGivenExactTokensIn,
  calcDepositCredit,
  calcEffectiveLpBurn,
  calcJoinRatioAndLp,
  calcTokensOutGivenLpIn,
  virtualBalanceAfterDeposit,
  virtualBalanceAfterWithdrawal,
} from "../math/poolMath";
import { divDown, mulDown } from "../math/fixedPoint";
import { calculateInvariant } from "../math/weightedMath";
import { rescaleWindowOnVbChange, computeSelloffWindow, projectSelloffWindow, SelloffWindowStatus } from "../math/maxSelloff";
import { calcSurgeFeePct } from "../math/surgeFee";
import { applySlippage, priceImpactHbps } from "../math/slippage";
import { MIN_LP_SUPPLY, PERCENT_SCALE, SWAP_FEE_PRECISION } from "../config";
import {
  buildAddLiquidityTx,
  buildRemoveLiquidityTx,
  buildSwapTx,
} from "./tx-builders";
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
    };
    this.cache = info;
    this.rawAccount = raw;
    return ok(info);
  }

  // ---------- Quote helpers (pure, require sync()) ----------

  /**
   * Quote a swap. Requires the cache to be populated (call `sync()` first).
   * Returns exact on-chain math result + spot bound + price impact +
   * slippage-derived minAmountOut.
   */
  quoteSwap(
    tokenInIndex: number,
    tokenOutIndex: number,
    amountIn: BN,
    slippageHundredthsBps?: number,
    nowSeconds?: number
  ): SdkResult<SwapQuote> {
    const pool = this.requireCache();
    if (!pool.ok) return pool;
    const unsupported = this.requireSupported([tokenInIndex, tokenOutIndex], "swap");
    if (!unsupported.ok) return unsupported;
    const slip = slippageHundredthsBps ?? this.config.defaults.slippageHundredthsBps;
    try {
      const q = simulatePoolSwap(pool.data, tokenInIndex, tokenOutIndex, BigInt(amountIn.toString()), quoteTimestamp(pool.data, nowSeconds));
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
      const effectiveFeePct =
        (pool.data.swapFeeRate * PERCENT_SCALE) / SWAP_FEE_PRECISION + surgePct;
      return ok({
        tokenInIndex,
        tokenOutIndex,
        amountIn,
        transferFeeIn: new BN(q.transferFeeIn.toString()),
        amountInNet: new BN(q.amountInNet.toString()),
        amountOut: new BN(q.amountOut.toString()),
        grossAmountOut: new BN(q.grossAmountOut.toString()),
        transferFeeOut: new BN(q.transferFeeOut.toString()),
        amountOutReceived: new BN(q.amountOutReceived.toString()),
        surgeFeeAmount: new BN(q.surgeFeeAmount.toString()),
        feeAmount: new BN(q.feeAmount.toString()),
        protocolFeeAmount: new BN(q.protocolFeeAmount.toString()),
        spotOut: new BN(q.spotOut.toString()),
        // Impact excludes fees and the surge charge (industry standard):
        // measured against the GROSS curve output.
        priceImpactHbps: priceImpactHbps(q.spotOut, q.grossAmountOut),
        // The program checks `minimum_amount_out` against what the user
        // actually receives (post-surge, post-transfer-fee).
        minAmountOut: new BN(applySlippage(q.amountOutReceived, slip).toString()),
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
        : "invalid_input";
      const human =
        code === "selloff_window_full"
          ? "Token max-selloff threshold exceeded for current window"
          : `Swap quote failed: ${msg}`;
      return err(code, human, e);
    }
  }

  /**
   * Read-only status of a token's max-selloff window at `now`
   * (default: current unix seconds). Requires a prior `sync()`.
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
        now: now ?? Math.floor(Date.now() / 1000),
      })
    );
  }

  /** Seed deposit: creator-only, exact amounts, LP derived from virtual reserves. */
  quoteSeedDeposit(user: PublicKey, tokenAmounts: BN[], slippageHundredthsBps?: number): SdkResult<AddLiquidityQuote> {
    const state = this.requireCache();
    if (!state.ok) return state;
    const pool = state.data;
    if (!pool.poolEnabled) return err("pool_disabled", "Pool is disabled");
    if (!pool.lpTotalSupply.isZero()) return err("invalid_input", "Pool already seeded; use quoteAddLiquidity");
    if (!pool.poolAdmin) return err("invalid_input", "Pool admin missing: sync the pool before quoting");
    if (pool.poolAdmin.equals(PublicKey.default)) return err("invalid_input", "PoolAdminDisabled");
    if (!pool.poolAdmin.equals(user)) return err("invalid_input", "SeedDepositNotPoolAdmin");
    if (tokenAmounts.length !== pool.tokenCount || tokenAmounts.some(a => a.isNeg() || a.bitLength() > 64)) return err("invalid_input", "Expected one u64 amount per token");
    if (tokenAmounts.every(a => a.isZero())) return err("invalid_input", "FirstDepositRequiresNonzero");
    const supported = this.requireSupported(tokenAmounts.flatMap((a,i) => a.isZero() ? [] : [i]), "seed deposit");
    if (!supported.ok) return supported;
    try {
      // v6: the vault credits the fee-EXCLUDED amount; LP is invariant-based
      // on the virtual balances (or on the net credits when all are zero).
      const amounts = tokenAmounts.map(a => BigInt(a.toString()));
      const credited = amounts.map((a, i) => netOfTransferFee(pool.tokens[i].transferFee, a));
      if (credited.some((c, i) => amounts[i] > 0n && c === 0n)) return err("amount_too_small", "AmountFullyConsumedByTransferFee");
      const virtual = pool.tokens.map(t => BigInt(t.virtualBalance.toString()));
      const balances = virtual.every(v => v === 0n) ? credited : virtual;
      const lpOut = u64(calculateInvariant(balances, pool.tokens.map(t => t.weightBps), pool.tokens.map(t => t.decimals)), "LP amount");
      if (lpOut < MIN_LP_SUPPLY) return err("invalid_input", "InitialLiquidityTooSmall");
      const zeros = tokenAmounts.map(() => new BN(0));
      const charged = tokenAmounts.map(a => a.clone());
      return ok({ tokenAmounts, depositAmounts: charged, refundAmounts: zeros, chargedAmounts: charged.map(a => a.clone()), unspentAmounts: zeros.map(z => z.clone()),
        creditedAmounts: credited.map(c => new BN(c.toString())), transferFees: amounts.map((a, i) => new BN((a - credited[i]).toString())),
        virtualBalancesAfter: pool.tokens.map(t => t.virtualBalance.clone()),
        lpOut: new BN(lpOut.toString()), minimumLpAmount: new BN(applySlippage(lpOut, slippageHundredthsBps ?? this.config.defaults.slippageHundredthsBps).toString()),
        limitingTokenIndex: -1 });
    } catch (e) { return err("math_overflow", "Seed-deposit quote failed", e); }
  }

  /**
   * Proportional-join quote (v6 `add_liquidity.rs`). `tokenAmounts` is a
   * CEILING: the program nets each ceiling of its mint's transfer fee, takes
   * the limiting ratio `min_i(net_i / actual_i)` over live legs, mints
   * `floor(supply · ratio)` LP, credits each leg `ceil(actual_i · ratio)`
   * and debits that credit grossed up by the transfer fee. Whatever is left
   * of the ceiling stays in the wallet.
   *
   * Two program refusals are reported as errors rather than quotes: a
   * credit above the net ceiling, or a gross-up above the ceiling itself
   * (`MathOverflow` on-chain). Pass `chargedAmounts` as the ceilings to
   * `buildAddLiquidityTx` for a basket that is exact at this state.
   *
   * Not applicable to the seed deposit (LP supply == 0): the program
   * mints invariant-based LP there and takes the full amounts.
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
    if (tokenAmounts.some((a) => a.isNeg() || a.bitLength() > 64)) {
      return err("invalid_input", "tokenAmounts must be u64 values");
    }
    if (pool.tokens.some((t, i) => t.actualBalance.isZero() !== tokenAmounts[i].isZero())) {
      return err("invalid_input", "TokenLivenessMismatch: live tokens need positive amounts; zero-balance tokens need zero amounts");
    }
    const unsupported = this.requireSupported(pool.tokens.filter(t => !t.actualBalance.isZero()).map(t => t.index), "add_liquidity");
    if (!unsupported.ok) return unsupported;
    const slip = slippageHundredthsBps ?? this.config.defaults.slippageHundredthsBps;
    try {
      const bals = pool.tokens.map((t) => BigInt(t.actualBalance.toString()));
      const amounts = tokenAmounts.map((a) => BigInt(a.toString()));
      const supply = BigInt(pool.lpTotalSupply.toString());
      const net = amounts.map((a, i) => netOfTransferFee(pool.tokens[i].transferFee, a));
      if (net.some((n, i) => amounts[i] > 0n && n === 0n)) return err("amount_too_small", "AmountFullyConsumedByTransferFee");
      const { lp: lpOut, ratio } = calcJoinRatioAndLp(bals, net, supply);
      let limiting = -1;
      for (let i = 0; i < bals.length; i++) {
        if (bals[i] > 0n && divDown(net[i], bals[i]) === ratio) { limiting = i; break; }
      }
      if (lpOut === 0n) return err("amount_too_small", "DepositTooSmall");
      u64(supply + lpOut, "LP supply");
      const credited: bigint[] = [], charged: bigint[] = [], virtualAfter: bigint[] = [];
      for (let i = 0; i < bals.length; i++) {
        const credit = bals[i] > 0n ? calcDepositCredit(bals[i], ratio) : 0n;
        if (credit > net[i]) return err("invalid_input", `Credit exceeds the net ceiling at token index ${i} (program would fail with MathOverflow)`);
        const charge = grossOfTransferFee(pool.tokens[i].transferFee, credit);
        if (charge > amounts[i]) return err("invalid_input", `Transfer-fee gross-up exceeds the ceiling at token index ${i}; raise the ceiling by at least ${(charge - amounts[i]).toString()}`);
        u64(bals[i] + credit, "reserve balance");
        const vb = BigInt(pool.tokens[i].virtualBalance.toString());
        const next = virtualBalanceAfterDeposit(vb, bals[i], credit, lpOut, supply);
        rescaleWindowOnVbChange(swapLegOf(pool.tokens[i]).window, vb, next);
        credited.push(credit); charged.push(charge); virtualAfter.push(next);
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
        virtualBalancesAfter: bnList(virtualAfter),
        lpOut: new BN(lpOut.toString()),
        minimumLpAmount: new BN(applySlippage(lpOut, slip).toString()),
        limitingTokenIndex: limiting,
      });
    } catch (e) {
      return err("math_overflow", `Add-liquidity quote failed: ${e instanceof Error ? e.message : String(e)}`, e);
    }
  }

  /**
   * Proportional-withdraw quote (v6 `remove_liquidity.rs`): the burn is
   * clamped to keep `MIN_LP_SUPPLY` in supply, payouts are the
   * floor-rounded proportional share of the raw actual balances, and each
   * leg's transfer fee is withheld from the user. Derive
   * `minimumTokenAmounts` from `receivedAmounts`.
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
      const bals = pool.tokens.map((t) => BigInt(t.actualBalance.toString()));
      const supply = BigInt(pool.lpTotalSupply.toString());
      const requested = BigInt(lpIn.toString());
      if (requested <= 0n || requested > supply) return err("invalid_input", "InvalidLpAmount");
      let effective: bigint;
      try { effective = calcEffectiveLpBurn(requested, supply); } catch { return err("invalid_input", "InvalidLpAmount"); }
      const outs = calcTokensOutGivenLpIn(bals, effective, supply);
      const supported = this.requireSupported(outs.flatMap((amount,i) => amount > 0n ? [i] : []), "remove_liquidity");
      if (!supported.ok) return supported;
      const fees = outs.map((o, i) => transferFeeOf(pool.tokens[i].transferFee, o));
      const virtualAfter = pool.tokens.map((t, i) => {
        const vb = BigInt(t.virtualBalance.toString());
        const next = virtualBalanceAfterWithdrawal(vb, bals[i], outs[i], effective, supply);
        rescaleWindowOnVbChange(swapLegOf(t).window, vb, next);
        return next;
      });
      const bnList = (xs: bigint[]) => xs.map((x) => new BN(x.toString()));
      return ok({ tokenOuts: bnList(outs), transferFees: bnList(fees), receivedAmounts: bnList(outs.map((o, i) => o - fees[i])),
        effectiveLpIn: new BN(effective.toString()), virtualBalancesAfter: bnList(virtualAfter) });
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

  /** Build a swap transaction. Requires `sync()` first. */
  buildSwapTx(params: SwapParams): SdkResult<BuiltTx> {
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

  /** Build a proportional add-liquidity transaction. Requires `sync()` first. */
  buildAddLiquidityTx(params: AddLiquidityParams): SdkResult<BuiltTx> {
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

  /** Build a proportional remove-liquidity transaction. Requires `sync()` first. */
  buildRemoveLiquidityTx(params: RemoveLiquidityParams): SdkResult<BuiltTx> {
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
