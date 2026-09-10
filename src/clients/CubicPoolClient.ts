import { simulatePoolSwap, quoteTimestamp, u64 } from "./quote-math";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, Commitment, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import BN from "bn.js";
import { CofferConfig } from "../config";
import { PoolInfo, PoolTokenInfo } from "../types/pool";
import { SdkResult, err, ok } from "../types/result";
import { AddLiquidityQuote, SwapQuote, SingleTokenDepositQuote } from "../types/tx";
import { CubicPoolEvent } from "../types/events";
import { RpcClient } from "./RpcClient";
import { decodePoolAccount, RawPoolAccount } from "../parsers/poolAccount";
import { decodeMintAccount } from "../parsers/mintAccount";
import { parseCubicPoolEvents } from "../parsers/events";
import { deriveAta, deriveBptMint, deriveHelperPda } from "../utils/pda";
import { resolveKnownToken } from "../config/tokens";
import { describeUnsupportedToken, unsupportedMintExtensions } from "../utils/extensions";
import {
  calcBptOutGivenExactTokensIn,
  calcTokensOutGivenBptIn,
} from "../math/cubicMath";
import { divDown, mulDown } from "../math/fixedPoint";
import { calculateInvariant } from "../math/weightedMath";
import { rescaleSelloffWindow } from "../math/maxSelloff";
import { applySlippage, priceImpactHbps } from "../math/slippage";
import { capDepositAmountsToLpRatio, computeAllocations } from "../math/singleToken";
import {
  calcSegmentedSurgeFeeAmount,
  calcSurgeFeePct,
  computeSelloffWindow,
  projectSelloffWindow,
  SelloffWindowStatus,
} from "../math/maxSelloff";
import { PERCENT_SCALE, SWAP_FEE_PRECISION } from "../config";
import {
  buildAddLiquidityTx,
  buildRemoveLiquidityTx,
  buildSingleTokenDepositTx,
  buildSingleTokenDepositTxs,
  buildSwapTx,
} from "./tx-builders";
import {
  AddLiquidityParams,
  BuiltTx,
  RemoveLiquidityParams,
  SingleTokenDepositParams,
  SwapParams,
} from "../types/tx";
import { SingleTokenDepositClient } from "./SingleTokenDepositClient";

export interface CubicPoolClientParams {
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
export class CubicPoolClient {
  readonly config: CofferConfig;
  readonly poolAddress: PublicKey;
  readonly rpc: RpcClient;

  private cache: PoolInfo | undefined;
  /** Raw decoded account from the last `sync()`; holds per-token window data. */
  private rawAccount: RawPoolAccount | undefined;

  constructor(params: CubicPoolClientParams) {
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
   * Fetch and decode the pool account + BPT mint + per-token mint decimals.
   * Safe to call repeatedly; subsequent calls replace the cache.
   */
  async sync(): Promise<SdkResult<PoolInfo>> {
    const poolInfo = await this.rpc.getAccountInfo(this.poolAddress);
    if (!poolInfo.ok) return poolInfo;
    if (poolInfo.data === null) {
      return err("account_not_found", `Pool ${this.poolAddress.toBase58()} does not exist on-chain`);
    }
    if (!poolInfo.data.owner.equals(this.config.programs.cubicPool)) return err("parse_failure", "Pool account has an unexpected owner");
    let raw;
    try {
      raw = decodePoolAccount(poolInfo.data.data);
    } catch (e) {
      return err("parse_failure", "Could not decode pool account", e);
    }
    const n = raw.tokenCount;
    const mintAddrs = raw.tokenMints.slice(0, n);
    const [bptMint, _bptBump] = deriveBptMint(this.config.programs.cubicPool, this.poolAddress);

    const mintInfos = await this.rpc.getMultipleAccountsWithInfo([bptMint, ...mintAddrs, SYSVAR_CLOCK_PUBKEY]);
    if (!mintInfos.ok) return mintInfos;
    const [bptInfo, ...rest] = mintInfos.data;
    const tokenMintInfos = rest.slice(0, n);
    const clockInfo = rest[n];
    const bptMintData = bptInfo?.data;
    if (bptInfo && ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(p => p.equals(bptInfo.owner))) return err("parse_failure", "Invalid BPT token program");
    if (!clockInfo || clockInfo.data.length < 40) return err("parse_failure", "Solana Clock account missing");
    const chainTimestamp = Number(clockInfo.data.readBigInt64LE(32));
    const createdAt = Number(raw.createdAt.toString());
    if (!Number.isSafeInteger(chainTimestamp) || !Number.isSafeInteger(createdAt)) {
      return err("parse_failure", "Pool/Clock timestamp cannot be represented exactly by PoolInfo; use the raw account decoder for full i64 values");
    }
    if (!bptMintData) {
      return err("account_not_found", "BPT mint account missing");
    }
    let bptMintAcc;
    try {
      bptMintAcc = decodeMintAccount(bptMintData);
    } catch (e) {
      return err("parse_failure", "Could not decode BPT mint", e);
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
        unsupportedExtensions: unsupportedMintExtensions(mintAcc.extensions, raw.bannedExtensions),
      });
    }

    const info: PoolInfo = {
      address: this.poolAddress,
      config: raw.config,
      bump: raw.bump,
      poolId: raw.poolId,
      tokenCount: n,
      tokens,
      unsupportedTokenIndices: tokens.filter((t) => (t.unsupportedExtensions?.length ?? 0) > 0).map((t) => t.index),
      bptMint,
      bptTokenProgram: bptInfo!.owner,
      poolAdmin: raw.poolAdmin,
      pendingPoolAdmin: raw.pendingPoolAdmin,
      rangeManager: raw.rangeManager,
      rangeManagerEnabled: raw.rangeManagerEnabled,
      rangeManagerMaxVbChangePct: raw.rangeManagerMaxVbChangePct,
      rangeManagerMaxWeightChangePct: raw.rangeManagerMaxWeightChangePct,
      rangeManagerMinUpdateIntervalSecs: raw.rangeManagerMinUpdateIntervalSecs,
      rangeManagerLastUpdated: raw.rangeManagerLastUpdated,
      chainTimestamp,
      bptTotalSupply: bptMintAcc.supply,
      swapFeeRate: raw.swapFeeRate,
      protocolFeeRate: raw.protocolFeeRate,
      poolEnabled: raw.poolEnabled,
      swapsEnabled: raw.swapsEnabled,
      createdAt,
      lookupTable: raw.lookupTable,
      bannedExtensions: raw.bannedExtensions,
      rangeManagerMaxLeverageBps: raw.rangeManagerMaxLeverageBps,
      rangeManagerMinLeverageBps: raw.rangeManagerMinLeverageBps,
      syncedAt: Date.now(),
    };
    this.cache = info;
    this.rawAccount = raw;
    return ok(info);
  }

  /** Derived helper PDA for this pool (used by single-token-deposit). */
  helperPda(): PublicKey {
    return deriveHelperPda(this.config.programs.singleTokenLiquidity, this.poolAddress)[0];
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
        surgePct = calcSurgeFeePct(
          q.window.effectiveSelloffBefore,
          q.window.effectiveSelloff,
          q.window.maxSelloffCap,
          inTok.variableFeeThresholdPct ?? 0,
          inTok.variableFeeSlopeLowPct ?? 0,
          inTok.variableFeeSlopeMidPct ?? 0,
          inTok.variableFeeSlopeHighPct ?? 0,
          inTok.variableFeeKinkPct ?? 0
        );
      }
      const effectiveFeePct =
        (pool.data.swapFeeRate * PERCENT_SCALE) / SWAP_FEE_PRECISION + surgePct;
      return ok({
        tokenInIndex,
        tokenOutIndex,
        amountIn,
        amountOut: new BN(q.amountOut.toString()),
        grossAmountOut: new BN(q.grossAmountOut.toString()),
        surgeFeeAmount: new BN(q.surgeFeeAmount.toString()),
        feeAmount: new BN(q.feeAmount.toString()),
        protocolFeeAmount: new BN(q.protocolFeeAmount.toString()),
        spotOut: new BN(q.spotOut.toString()),
        // Impact excludes fees and the surge charge (industry standard):
        // measured against the GROSS curve output.
        priceImpactHbps: priceImpactHbps(q.spotOut, q.grossAmountOut),
        minAmountOut: new BN(applySlippage(q.amountOut, slip).toString()),
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

  /**
   * Quote a single-token deposit: split amountIn by W-based shares, quote
   * each swap leg, then execute the helper cap and proportional-join math.
   * `helperBalances` supplies existing helper ATA holdings (defaults to zero).
   * Pass them when the helper contains donations or dust; all leftovers are refunded.
   */
  quoteSingleTokenDeposit(
    tokenInIndex: number,
    amountIn: BN,
    slippageHundredthsBps?: number,
    nowSeconds?: number,
    helperBalances?: BN[]
  ): SdkResult<SingleTokenDepositQuote> {
    const poolRes = this.requireCache();
    if (!poolRes.ok) return poolRes;
    const pool = poolRes.data;
    if (!Number.isInteger(tokenInIndex) || tokenInIndex < 0 || tokenInIndex >= pool.tokens.length) {
      return err("invalid_input", "Invalid tokenInIndex");
    }
    if (!pool.poolEnabled) return err("pool_disabled", "Pool is disabled");
    if (!pool.swapsEnabled) return err("invalid_input", "SwapsDisabled");
    if (pool.bptTotalSupply.isZero()) return err("invalid_input", "PoolNotSeeded");
    if (pool.tokens[tokenInIndex].actualBalance.isZero()) return err("invalid_input", "Input token is sidelined");
    const unsupported = this.requireSupported(pool.tokens.filter(t => !t.actualBalance.isZero()).map(t => t.index), "deposit_single_token");
    if (!unsupported.ok) return unsupported;
    const slip = slippageHundredthsBps ?? this.config.defaults.slippageHundredthsBps;
    try {
      const input = u64(BigInt(amountIn.toString()), "amountIn");
      if (input === 0n) return err("invalid_input", "amountIn must be positive");
      const now = quoteTimestamp(pool, nowSeconds);
      const actualBalances = pool.tokens.map(t => BigInt(t.actualBalance.toString()));
      const virtualBalances = pool.tokens.map(t => BigInt(t.virtualBalance.toString()));
      const alloc = computeAllocations({ actualBalances, virtualBalances, weightsBps: pool.tokens.map(t => t.weightBps), amountIn: input, tokenInIndex });
      if (alloc.allocations.some((a, i) => actualBalances[i] > 0n && a === 0n)) throw new Error("AmountTooSmall");
      const simulated: PoolInfo = { ...pool, tokens: pool.tokens.map(t => ({ ...t })) };
      if (helperBalances && helperBalances.length !== pool.tokenCount) throw new Error("Invalid helper balance vector length");
      const helper = pool.tokens.map((_,i) => u64(BigInt(helperBalances?.[i].toString() ?? "0"), "helper balance"));
      const helperSupport = this.requireSupported(helper.flatMap((a,i) => a > 0n ? [i] : []), "helper refund");
      if (!helperSupport.ok) return helperSupport;
      u64(helper[tokenInIndex] + input, "helper input balance");
      const expectedOuts = pool.tokens.map(() => new BN(0));
      const minOuts = pool.tokens.map(() => new BN(0));
      let remainingInput = input;
      for (let i = 0; i < pool.tokenCount; i++) {
        if (i === tokenInIndex || alloc.allocations[i] === 0n) continue;
        const q = simulatePoolSwap(simulated, tokenInIndex, i, alloc.allocations[i], now, true);
        remainingInput -= alloc.allocations[i]; helper[i] = u64(helper[i] + q.amountOut, "helper output balance");
        expectedOuts[i] = new BN(q.amountOut.toString());
        minOuts[i] = new BN(applySlippage(q.amountOut, slip).toString());
      }
      helper[tokenInIndex] = u64(helper[tokenInIndex] + remainingInput, "helper input balance");
      const postActual = simulated.tokens.map(t => BigInt(t.actualBalance.toString()));
      const capped = capDepositAmountsToLpRatio({ helperBalances: helper, actualBalances: postActual });
      // The helper's integer ratio cap is followed by cubic-pool's fixed-point proportional join.
      if (capped.depositAmounts.some((v, i) => (v === 0n) !== (postActual[i] === 0n))) throw new Error("TokenLivenessMismatch");
      let ratio: bigint | null = null;
      for (let i = 0; i < pool.tokenCount; i++) if (postActual[i] > 0n) {
        const r = divDown(capped.depositAmounts[i], postActual[i]); ratio = ratio === null || r < ratio ? r : ratio;
      }
      if (ratio === null) throw new Error("Pool has no live tokens");
      const deposited = postActual.map(a => mulDown(a, ratio!));
      const estBpt = calcBptOutGivenExactTokensIn(postActual, capped.depositAmounts, BigInt(pool.bptTotalSupply.toString()));
      if (estBpt === 0n || deposited.some((d, i) => postActual[i] > 0n && d === 0n)) throw new Error("DepositTooSmall");
      u64(estBpt + BigInt(pool.bptTotalSupply.toString()), "BPT supply");
      for (let i = 0; i < pool.tokenCount; i++) {
        u64(postActual[i] + deposited[i], "reserve balance");
        const vb = BigInt(simulated.tokens[i].virtualBalance.toString()); u64(vb + mulDown(vb, ratio), "virtual balance");
      }
      this.validateDepositWindows(simulated, ratio);
      return ok({ tokenInIndex, amountIn, allocations: alloc.allocations.map(a => new BN(a.toString())),
        expectedOuts, minOuts, depositedAmounts: deposited.map(a => new BN(a.toString())),
        refundAmounts: helper.map((a,i) => new BN((a - deposited[i]).toString())),
        estimatedBpt: new BN(estBpt.toString()),
        sidelinedTokenIndices: pool.tokens.filter(t => t.actualBalance.isZero()).map(t => t.index),
      });
    } catch (e) {
      return err("invalid_input", `Single-token deposit quote failed: ${e instanceof Error ? e.message : String(e)}`, e);
    }
  }

  /** Seed deposit: creator-only, exact amounts, BPT derived from virtual reserves. */
  quoteSeedDeposit(user: PublicKey, tokenAmounts: BN[], slippageHundredthsBps?: number): SdkResult<AddLiquidityQuote> {
    const state = this.requireCache();
    if (!state.ok) return state;
    const pool = state.data;
    if (!pool.poolEnabled) return err("pool_disabled", "Pool is disabled");
    if (!pool.bptTotalSupply.isZero()) return err("invalid_input", "Pool already seeded; use quoteAddLiquidity");
    if (!pool.poolAdmin) return err("invalid_input", "Pool admin missing: sync the pool before quoting");
    if (pool.poolAdmin.equals(PublicKey.default)) return err("invalid_input", "PoolAdminDisabled");
    if (!pool.poolAdmin.equals(user)) return err("invalid_input", "SeedDepositNotPoolAdmin");
    if (tokenAmounts.length !== pool.tokenCount || tokenAmounts.some(a => a.isNeg() || a.bitLength() > 64)) return err("invalid_input", "Expected one u64 amount per token");
    if (tokenAmounts.every(a => a.isZero())) return err("invalid_input", "FirstDepositRequiresNonzero");
    const supported = this.requireSupported(tokenAmounts.flatMap((a,i) => a.isZero() ? [] : [i]), "seed deposit");
    if (!supported.ok) return supported;
    try {
      const virtual = pool.tokens.map(t => BigInt(t.virtualBalance.toString()));
      const balances = virtual.every(v => v === 0n) ? tokenAmounts.map(a => BigInt(a.toString())) : virtual;
      const bptOut = u64(calculateInvariant(balances, pool.tokens.map(t => t.weightBps), pool.tokens.map(t => t.decimals)), "BPT amount");
      if (bptOut < 1000n) return err("invalid_input", "InitialLiquidityTooSmall");
      return ok({ tokenAmounts, depositAmounts: tokenAmounts.map(a => a.clone()), refundAmounts: tokenAmounts.map(() => new BN(0)),
        bptOut: new BN(bptOut.toString()), minimumBptAmount: new BN(applySlippage(bptOut, slippageHundredthsBps ?? this.config.defaults.slippageHundredthsBps).toString()),
        limitingTokenIndex: -1 });
    } catch (e) { return err("math_overflow", "Seed-deposit quote failed", e); }
  }

  /**
   * Proportional-join quote. `tokenAmounts` is a CEILING (v5.1, audit
   * M-4 / I-1): the program takes the largest strictly-proportional basket
   * that fits inside it and leaves the rest in the wallet. This returns the
   * basket it will actually pull, the BPT it will mint, and a
   * slippage-derived `minimumBptAmount` to pass to `buildAddLiquidityTx`.
   *
   * Not applicable to the seed deposit (BPT supply == 0): the program
   * mints invariant-based BPT there and takes the full amounts.
   */
  quoteAddLiquidity(tokenAmounts: BN[], slippageHundredthsBps?: number): SdkResult<AddLiquidityQuote> {
    const poolRes = this.requireCache();
    if (!poolRes.ok) return poolRes;
    const pool = poolRes.data;
    if (tokenAmounts.length !== pool.tokenCount) {
      return err("invalid_input", "tokenAmounts length must equal pool.tokenCount");
    }
    if (pool.bptTotalSupply.isZero()) {
      return err("invalid_input", "Pool has zero BPT supply; use quoteSeedDeposit");
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
      // Same inputs as cubic-pool/add_liquidity.rs: raw stored actual
      // balances, ratio = min over tokens with actual > 0.
      const bals = pool.tokens.map((t) => BigInt(t.actualBalance.toString()));
      const amounts = tokenAmounts.map((a) => BigInt(a.toString()));
      const supply = BigInt(pool.bptTotalSupply.toString());
      let ratioMin: bigint | null = null;
      let limiting = -1;
      for (let i = 0; i < bals.length; i++) {
        if (bals[i] === 0n) continue;
        const r = divDown(amounts[i], bals[i]);
        if (ratioMin === null || r < ratioMin) {
          ratioMin = r;
          limiting = i;
        }
      }
      if (ratioMin === null) return err("invalid_input", "Pool has no token with a non-zero balance");
      const bptOut = calcBptOutGivenExactTokensIn(bals, amounts, supply);
      if (bptOut === 0n || bptOut > ((1n << 64n) - 1n) || supply + bptOut > ((1n << 64n) - 1n)) return err("invalid_input", "DepositTooSmall or BPT supply overflow");
      const deposit = bals.map((b) => (b === 0n ? 0n : mulDown(b, ratioMin as bigint)));
      if (deposit.some((d, i) => bals[i] > 0n && d === 0n || bals[i] + d > ((1n << 64n) - 1n))) return err("invalid_input", "DepositTooSmall or reserve overflow");
      if (pool.tokens.some(t => BigInt(t.virtualBalance.toString()) + mulDown(BigInt(t.virtualBalance.toString()), ratioMin!) > ((1n << 64n) - 1n))) return err("math_overflow", "Virtual balance overflow");
      this.validateDepositWindows(pool, ratioMin);
      const refund = amounts.map((a, i) => a - deposit[i]);
      return ok({
        tokenAmounts,
        depositAmounts: deposit.map((d) => new BN(d.toString())),
        refundAmounts: refund.map((r) => new BN(r.toString())),
        bptOut: new BN(bptOut.toString()),
        minimumBptAmount: new BN(applySlippage(bptOut, slip).toString()),
        limitingTokenIndex: limiting,
      });
    } catch (e) {
      return err("math_overflow", "Add-liquidity quote failed", e);
    }
  }

  /** Proportional-withdraw quote for a given BPT amount. */
  quoteRemove(bptIn: BN): SdkResult<{ tokenOuts: BN[]; effectiveBptIn: BN }> {
    const poolRes = this.requireCache();
    if (!poolRes.ok) return poolRes;
    const pool = poolRes.data;
    if (pool.bptTotalSupply.isZero()) {
      return err("invalid_input", "Pool has zero BPT supply");
    }
    if (!pool.poolEnabled) return err("pool_disabled", "Pool is disabled");
    try {
      // Match cubic-pool/remove_liquidity.rs exactly: it computes
      // token_amounts via divDown(bpt_amount, bpt_supply), then mulDown(actual, ratio)
      // against the raw stored actual (no protocol-fee subtraction). Use
      // the same input here so the SDK quote equals what the contract
      // actually transfers.
      const bals = pool.tokens.map((t) => BigInt(t.actualBalance.toString()));
      const supply = BigInt(pool.bptTotalSupply.toString());
      const requested = BigInt(bptIn.toString());
      if (requested <= 0n || requested > supply || supply <= 1000n) return err("invalid_input", "InvalidBptAmount");
      const effective = requested < supply - 1000n ? requested : supply - 1000n;
      const outs = calcTokensOutGivenBptIn(bals, effective, supply);
      const supported = this.requireSupported(outs.flatMap((amount,i) => amount > 0n ? [i] : []), "remove_liquidity");
      if (!supported.ok) return supported;
      return ok({ tokenOuts: outs.map((o) => new BN(o.toString())), effectiveBptIn: new BN(effective.toString()) });
    } catch (e) {
      return err("math_overflow", "Remove quote failed", e);
    }
  }

  // ---------- Transaction builders ----------
  //
  // For external SDK users, deposit/swap/remove are one-call operations via
  // the CubicPoolClient. The `singleTokenDeposit` field is a proxy into the
  // dedicated SingleTokenDepositClient as the user expects: importing this
  // class is enough, no need to know the helper program exists.

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
    const quote = this.quoteRemove(params.bptAmount);
    if (!quote.ok) return quote;
    try {
      return ok(buildRemoveLiquidityTx(this.config, poolRes.data, params));
    } catch (e) {
      return err("tx_build_failed", "Failed to build remove_liquidity tx", e);
    }
  }

  /**
   * Build a single-token deposit transaction (swaps + add_liquidity via the
   * helper program + BPT forward to user). Requires `sync()` first.
   */
  buildSingleTokenDepositTx(params: SingleTokenDepositParams): SdkResult<BuiltTx> {
    const poolRes = this.requireCache();
    if (!poolRes.ok) return poolRes;
    if (params.amountIn.lten(0)) return err("invalid_input", "amountIn must be > 0");
    const unsupported = this.requireSupported(poolRes.data.tokens.filter(t => !t.actualBalance.isZero() || t.index === params.tokenInIndex).map(t => t.index), "deposit_single_token");
    if (!unsupported.ok) return unsupported;
    try {
      return ok(buildSingleTokenDepositTx(this.config, poolRes.data, params));
    } catch (e) {
      return err("tx_build_failed", "Failed to build single-token deposit tx", e);
    }
  }

  /**
   * Single-token deposit split into `{ setup, deposit }` transactions.
   *
   * Required for pools beyond a handful of tokens: the ATA creates and the
   * zap compete for the same 64-frame instruction-trace budget, and at
   * N=10 the zap alone uses 52 of them. Send `setup` (idempotent, safe to
   * repeat), wait for confirmation, then send `deposit` compiled against
   * the pool's ALT via `compileBuiltTx`.
   */
  buildSingleTokenDepositTxs(
    params: SingleTokenDepositParams
  ): SdkResult<{ setup: BuiltTx | null; deposit: BuiltTx }> {
    const poolRes = this.requireCache();
    if (!poolRes.ok) return poolRes;
    if (params.amountIn.lten(0)) return err("invalid_input", "amountIn must be > 0");
    const unsupported = this.requireSupported(poolRes.data.tokens.filter(t => !t.actualBalance.isZero() || t.index === params.tokenInIndex).map(t => t.index), "deposit_single_token");
    if (!unsupported.ok) return unsupported;
    try {
      return ok(buildSingleTokenDepositTxs(this.config, poolRes.data, params));
    } catch (e) {
      return err("tx_build_failed", "Failed to build single-token deposit txs", e);
    }
  }

  /** Proxy into the dedicated SingleTokenDepositClient for consumers who
   *  want the quote/build methods exposed on a focused object. */
  get singleTokenDeposit(): SingleTokenDepositClient {
    if (!this._std) {
      this._std = new SingleTokenDepositClient({
        config: this.config,
        poolAddress: this.poolAddress,
        poolClient: this,
      });
    }
    return this._std;
  }
  private _std?: SingleTokenDepositClient;

  // ---------- Event helpers ----------

  /** Parse logs from a confirmed transaction into typed events. */
  parseEventsFromLogs(logs: string[]): CubicPoolEvent[] {
    return parseCubicPoolEvents(logs);
  }

  // ---------- Internals ----------

  /**
   * Refuse when any of `indices` (or every token, for `"all"`) has an
   * unsupported Token-2022 extension. The program would revert inside the
   * token program on transfer, so failing here saves the user a fee.
   */
  private requireSupported(indices: number[] | "all", op: string): SdkResult<void> {
    const pool = this.cache;
    if (!pool) return ok(undefined);
    const idx = indices === "all" ? pool.tokens.map((t) => t.index) : indices;
    const bad = idx.map((i) => pool.tokens[i]).filter((t) => t && (t.unsupportedExtensions?.length ?? 0) > 0);
    if (bad.length === 0) return ok(undefined);
    return err(
      "unsupported_token_extension",
      `${op} refused: ${bad.map(describeUnsupportedToken).join("; ")}. ` +
        "The cubic-pool program cannot transfer such tokens; the transaction would revert on-chain."
    );
  }

  private validateDepositWindows(pool: PoolInfo, ratio: bigint): void {
    for (const token of pool.tokens) {
      if (token.maxSelloffPct === 0) continue;
      if ([token.previousSelloff, token.currentSelloff, token.selloffVbSnapshot, token.windowStartTimestamp].some(v => v === undefined)) throw new Error("Selloff state missing: sync the pool before quoting");
      rescaleSelloffWindow({ previousSelloff: BigInt(token.previousSelloff!.toString()), currentSelloff: BigInt(token.currentSelloff!.toString()),
        selloffVbSnapshot: BigInt(token.selloffVbSnapshot!.toString()), windowStartTimestamp: BigInt(token.windowStartTimestamp!.toString()) }, ratio, true, token.maxSelloffPct);
    }
  }

  private requireCache(): SdkResult<PoolInfo> {
    if (!this.cache) {
      return err("invalid_input", "Call `sync()` first to populate pool state");
    }
    return ok(this.cache);
  }
}
