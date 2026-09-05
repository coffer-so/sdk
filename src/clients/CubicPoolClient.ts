import { PublicKey, Commitment } from "@solana/web3.js";
import BN from "bn.js";
import { CubeConfig } from "../config";
import { PoolInfo, PoolTokenInfo } from "../types/pool";
import { SdkResult, err, ok } from "../types/result";
import { SwapQuote, SingleTokenDepositQuote } from "../types/tx";
import { CubicPoolEvent } from "../types/events";
import { RpcClient } from "./RpcClient";
import { decodePoolAccount, RawPoolAccount } from "../parsers/poolAccount";
import { decodeMintAccount } from "../parsers/mintAccount";
import { parseCubicPoolEvents } from "../parsers/events";
import { deriveAta, deriveBptMint, deriveHelperPda } from "../utils/pda";
import { resolveKnownToken } from "../config/tokens";
import {
  calcBptOutGivenExactTokensIn,
  calcOutGivenIn,
  calcSpotOut,
  calcTokensOutGivenBptIn,
} from "../math/cubicMath";
import { applySlippage, applySwapFee, priceImpactHbps } from "../math/slippage";
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
  config: CubeConfig;
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
  readonly config: CubeConfig;
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
    let raw;
    try {
      raw = decodePoolAccount(poolInfo.data.data);
    } catch (e) {
      return err("parse_failure", "Could not decode pool account", e);
    }
    const n = raw.tokenCount;
    const mintAddrs = raw.tokenMints.slice(0, n);
    const [bptMint, _bptBump] = deriveBptMint(this.config.programs.cubicPool, this.poolAddress);

    const mintInfos = await this.rpc.getMultipleAccountsInfo([bptMint, ...mintAddrs]);
    if (!mintInfos.ok) return mintInfos;
    const [bptMintData, ...tokenMintDatas] = mintInfos.data;
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
      const mintRaw = tokenMintDatas[i];
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
      const concentration =
        virtualBalance.isZero() ? 0 : actualBalance.mul(new BN(1_000_000)).div(virtualBalance).toNumber() / 1_000_000;
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
        variableFeeSlopeMidPct: raw.variableFeeSlopeMidPct[i],
        variableFeeKinkPct: raw.variableFeeKinkPct[i],
      });
    }

    const info: PoolInfo = {
      address: this.poolAddress,
      config: raw.config,
      bump: raw.bump,
      poolId: raw.poolId,
      tokenCount: n,
      tokens,
      bptMint,
      bptTotalSupply: bptMintAcc.supply,
      swapFeeRate: raw.swapFeeRate,
      protocolFeeRate: raw.protocolFeeRate,
      poolEnabled: raw.poolEnabled,
      swapsEnabled: raw.swapsEnabled,
      createdAt: raw.createdAt.toNumber(),
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
    now?: number
  ): SdkResult<SwapQuote> {
    const pool = this.requireCache();
    if (!pool.ok) return pool;
    const { tokens, swapFeeRate, protocolFeeRate } = pool.data;
    if (
      tokenInIndex < 0 ||
      tokenInIndex >= tokens.length ||
      tokenOutIndex < 0 ||
      tokenOutIndex >= tokens.length ||
      tokenInIndex === tokenOutIndex
    ) {
      return err("invalid_input", "Invalid tokenInIndex / tokenOutIndex");
    }
    const inTok = tokens[tokenInIndex];
    const outTok = tokens[tokenOutIndex];
    const slip = slippageHundredthsBps ?? this.config.defaults.slippageHundredthsBps;

    // Input-side kill switch (mirrors swap.rs: checked first).
    if (!inTok.isActive) {
      return err("token_swaps_disabled", "Input token is deactivated for swaps");
    }

    try {
      const amountBI = BigInt(amountIn.toString());

      // Mirror cubic-pool's swap.rs: raw virtual balances drive the math,
      // lp_actual_out caps the output amount. Using lp_virtual here would
      // diverge from the on-chain quote on pools with pending protocol fees.
      const virtIn = BigInt(inTok.virtualBalance.toString());
      const virtOut = BigInt(outTok.virtualBalance.toString());
      const actualOut = BigInt(outTok.actualBalance.toString());
      const pfoOut = BigInt(outTok.protocolFeesOwed.toString());
      const lpActualOut = actualOut > pfoOut ? actualOut - pfoOut : 0n;

      // ── Max-selloff window (input side) ────────────────────────────────
      // Projected with the trade's amount_in. On-chain the window advances
      // by `amount_in_net` (post Token-2022 input transfer fee); the quote
      // does not model transfer fees, so net == gross here. Enabled only
      // when maxSelloffPct > 0; otherwise the legacy path is unchanged.
      let windowFillPct = 0;
      let selloffSpan: { cap: bigint; before: bigint; after: bigint } | undefined;
      if (inTok.maxSelloffPct > 0) {
        const raw = this.rawAccount;
        if (!raw) {
          return err("invalid_input", "Call `sync()` first to populate window state");
        }
        const i = tokenInIndex;
        const proj = projectSelloffWindow({
          maxSelloffPct: raw.maxSelloffPct[i],
          periodLength: raw.maxSelloffPeriodLength[i],
          previousSelloff: BigInt(raw.previousSelloff[i].toString()),
          currentSelloff: BigInt(raw.currentSelloff[i].toString()),
          windowStartTimestamp: BigInt(raw.windowStartTimestamp[i].toString()),
          selloffVbSnapshot: BigInt(raw.selloffVbSnapshot[i].toString()),
          virtualBalance: virtIn,
          now: now ?? Math.floor(Date.now() / 1000),
        });
        const before = proj.usedWithoutTrade;
        const after = before + amountBI;
        if (after > proj.cap) {
          return err(
            "selloff_window_full",
            "Token max-selloff threshold exceeded for current window"
          );
        }
        selloffSpan = { cap: proj.cap, before, after };
        if (proj.cap > 0n) {
          const fillRaw = (after * BigInt(PERCENT_SCALE)) / proj.cap;
          windowFillPct = Number(
            fillRaw < BigInt(PERCENT_SCALE) ? fillRaw : BigInt(PERCENT_SCALE)
          );
        }
      }

      const amountAfterFee = applySwapFee(amountBI, swapFeeRate);
      const feeAmount = amountBI - amountAfterFee;
      const protocolFeeAmount =
        (feeAmount * BigInt(protocolFeeRate)) / BigInt(10_000);

      const amountOut = calcOutGivenIn({
        virtualBalanceIn: virtIn,
        weightInBps: BigInt(inTok.weightBps),
        virtualBalanceOut: virtOut,
        weightOutBps: BigInt(outTok.weightBps),
        amountIn: amountAfterFee,
        actualBalanceOut: lpActualOut,
      });

      const spotOut = calcSpotOut({
        virtualBalanceIn: virtIn,
        weightInBps: BigInt(inTok.weightBps),
        virtualBalanceOut: virtOut,
        weightOutBps: BigInt(outTok.weightBps),
        amountIn: amountAfterFee,
      });

      // Surge fee mirrors v5.1 swap.rs: only the output produced above the
      // threshold is taxed, segment by segment along the crossed span
      // (path-independent; one flat rate on the whole output would re-open
      // the M-05 split dodge). surgePct is the span-average, for display.
      let surgeFeeAmount = 0n;
      let surgePct = 0;
      if (selloffSpan) {
        const raw = this.rawAccount!;
        const i = tokenInIndex;
        surgePct = calcSurgeFeePct(
          selloffSpan.before,
          selloffSpan.after,
          selloffSpan.cap,
          raw.variableFeeThresholdPct[i],
          raw.variableFeeSlopeLowPct[i],
          raw.variableFeeSlopeMidPct[i],
          raw.variableFeeSlopeHighPct[i],
          raw.variableFeeKinkPct[i]
        );
        surgeFeeAmount = calcSegmentedSurgeFeeAmount({
          effectiveSelloffBefore: selloffSpan.before,
          effectiveSelloffAfter: selloffSpan.after,
          cap: selloffSpan.cap,
          thresholdPct: raw.variableFeeThresholdPct[i],
          slopeLowPct: raw.variableFeeSlopeLowPct[i],
          slopeMidPct: raw.variableFeeSlopeMidPct[i],
          slopeHighPct: raw.variableFeeSlopeHighPct[i],
          kinkPct: raw.variableFeeKinkPct[i],
          amountInAfterFee: amountAfterFee,
          amountOut,
          curveOut: (x) =>
            calcOutGivenIn({
              virtualBalanceIn: virtIn,
              weightInBps: BigInt(inTok.weightBps),
              virtualBalanceOut: virtOut,
              weightOutBps: BigInt(outTok.weightBps),
              amountIn: x,
              actualBalanceOut: lpActualOut,
            }),
        });
      }
      const amountOutUser = amountOut - surgeFeeAmount;

      const minAmountOut = applySlippage(amountOutUser, slip);
      const impact = priceImpactHbps(spotOut, amountOut);
      const effectiveFeePct =
        (swapFeeRate * PERCENT_SCALE) / SWAP_FEE_PRECISION + surgePct;
      return ok({
        tokenInIndex,
        tokenOutIndex,
        amountIn,
        amountOut: new BN(amountOutUser.toString()),
        spotOut: new BN(spotOut.toString()),
        priceImpactHbps: impact,
        feeAmount: new BN(feeAmount.toString()),
        protocolFeeAmount: new BN(protocolFeeAmount.toString()),
        minAmountOut: new BN(minAmountOut.toString()),
        surgeFeeAmount: new BN(surgeFeeAmount.toString()),
        effectiveFeePct,
        windowFillPct,
      });
    } catch (e) {
      return err("math_overflow", "Swap quote math overflow", e);
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
   * each swap leg, estimate resulting BPT.
   */
  quoteSingleTokenDeposit(
    tokenInIndex: number,
    amountIn: BN,
    slippageHundredthsBps?: number,
    now?: number
  ): SdkResult<SingleTokenDepositQuote> {
    const poolRes = this.requireCache();
    if (!poolRes.ok) return poolRes;
    const pool = poolRes.data;
    if (tokenInIndex < 0 || tokenInIndex >= pool.tokens.length) {
      return err("invalid_input", "Invalid tokenInIndex");
    }
    const inTok = pool.tokens[tokenInIndex];
    if (inTok.actualBalance.isZero()) {
      return err("invalid_input", "Input token is sidelined (actualBalance=0); pick a live token");
    }
    const slip = slippageHundredthsBps ?? this.config.defaults.slippageHundredthsBps;

    // ── Max-selloff window across internal legs ─────────────────────────
    // Each swapped leg CPIs into the same swap handler, so every leg adds
    // its allocation (gross amount_in of the INPUT token) to the SAME
    // window SEQUENTIALLY. Within one tx the clock is constant: project
    // once, then accumulate leg allocations. The input token's retained
    // allocation is deposited directly (no swap) and never hits the window.
    let selloffCtx:
      | {
          cap: bigint;
          base: bigint;
          thresholdPct: number;
          slopeLowPct: number;
          slopeMidPct: number;
          slopeHighPct: number;
          kinkPct: number;
        }
      | undefined;
    if (inTok.maxSelloffPct > 0) {
      if (!inTok.isActive) {
        return err("token_swaps_disabled", "Input token is deactivated for swaps");
      }
      const raw = this.rawAccount;
      if (!raw) {
        return err("invalid_input", "Call `sync()` first to populate window state");
      }
      const proj = projectSelloffWindow({
        maxSelloffPct: raw.maxSelloffPct[tokenInIndex],
        periodLength: raw.maxSelloffPeriodLength[tokenInIndex],
        previousSelloff: BigInt(raw.previousSelloff[tokenInIndex].toString()),
        currentSelloff: BigInt(raw.currentSelloff[tokenInIndex].toString()),
        windowStartTimestamp: BigInt(raw.windowStartTimestamp[tokenInIndex].toString()),
        selloffVbSnapshot: BigInt(raw.selloffVbSnapshot[tokenInIndex].toString()),
        virtualBalance: BigInt(inTok.virtualBalance.toString()),
        now: now ?? Math.floor(Date.now() / 1000),
      });
      selloffCtx = {
        cap: proj.cap,
        base: proj.usedWithoutTrade,
        thresholdPct: raw.variableFeeThresholdPct[tokenInIndex],
        slopeLowPct: raw.variableFeeSlopeLowPct[tokenInIndex],
        slopeMidPct: raw.variableFeeSlopeMidPct[tokenInIndex],
        slopeHighPct: raw.variableFeeSlopeHighPct[tokenInIndex],
        kinkPct: raw.variableFeeKinkPct[tokenInIndex],
      };
    }
    let cumulativeSelloff = 0n;

    try {
      const actualBalances = pool.tokens.map((t) => BigInt(t.actualBalance.toString()));
      const virtualBalances = pool.tokens.map((t) => BigInt(t.virtualBalance.toString()));
      const protocolFeesOwed = pool.tokens.map((t) => BigInt(t.protocolFeesOwed.toString()));
      const weightsBps = pool.tokens.map((t) => t.weightBps);
      const amountInBI = BigInt(amountIn.toString());
      // Mirror the helper contract: weight by LP-accessible balances
      // (actual - protocolFeesOwed). This avoids the heavy 2-token optimizer
      // which used to live here but exceeded the program's BPF CU budget.
      const lpAccessibleBalances = actualBalances.map((actual, i) =>
        actual > protocolFeesOwed[i] ? actual - protocolFeesOwed[i] : 0n
      );
      const alloc = computeAllocations({
        actualBalances: lpAccessibleBalances,
        virtualBalances,
        weightsBps,
        amountIn: amountInBI,
        tokenInIndex,
      });

      const expectedOuts: BN[] = [];
      const minOuts: BN[] = [];
      const sidelined: number[] = [];
      const simActual = [...actualBalances];
      const simVirtual = [...virtualBalances];
      const simProtocolFees = [...protocolFeesOwed];
      const depositAmounts = pool.tokens.map(() => 0n);
      let remainingInput = amountInBI;
      for (let i = 0; i < pool.tokens.length; i++) {
        if (actualBalances[i] === 0n) {
          sidelined.push(i);
          expectedOuts.push(new BN(0));
          minOuts.push(new BN(0));
          continue;
        }
        if (i === tokenInIndex || alloc.allocations[i] === 0n) {
          expectedOuts.push(new BN(0));
          minOuts.push(new BN(0));
          continue;
        }
        const swapAmount = alloc.allocations[i];
        remainingInput -= swapAmount;
        const amountAfterFee = applySwapFee(swapAmount, pool.swapFeeRate);
        const feeAmount = swapAmount - amountAfterFee;
        const protocolFeeAmount =
          (feeAmount * BigInt(pool.protocolFeeRate)) / 10_000n;
        // Match cubic-pool/swap.rs exactly: it uses RAW virtual balances and
        // takes lp_actual_out only as the output cap. Earlier the SDK used
        // LP-virtuals here (and the helper did too), causing slippage drift
        // on pools with pending protocol fees.
        const lpActualOut =
          simActual[i] > simProtocolFees[i] ? simActual[i] - simProtocolFees[i] : 0n;
        const out = calcOutGivenIn({
          virtualBalanceIn: simVirtual[tokenInIndex],
          weightInBps: BigInt(weightsBps[tokenInIndex]),
          virtualBalanceOut: simVirtual[i],
          weightOutBps: BigInt(weightsBps[i]),
          amountIn: amountAfterFee,
          actualBalanceOut: lpActualOut,
        });
        // Per-leg max-selloff check + surge fee: on-chain each leg's
        // check_and_advance sees `current` already incremented by the prior
        // legs, so effective for leg k = base + sum(alloc_1..k). The surge
        // fee is carved from this leg's gross amount_out (CEIL, clamp); the
        // helper receives the NET out while the pool's trading reserves move
        // by the GROSS out (surge re-credited to protocol_fees_owed).
        let surgeFee = 0n;
        if (selloffCtx) {
          const before = selloffCtx.base + cumulativeSelloff;
          const after = before + swapAmount;
          if (after > selloffCtx.cap) {
            return err(
              "selloff_window_full",
              "Token max-selloff threshold exceeded for current window"
            );
          }
          // Each leg is its own on-chain swap: charged segment-by-segment
          // over ITS span [before, after) of the shared window (v5.1).
          surgeFee = calcSegmentedSurgeFeeAmount({
            effectiveSelloffBefore: before,
            effectiveSelloffAfter: after,
            cap: selloffCtx.cap,
            thresholdPct: selloffCtx.thresholdPct,
            slopeLowPct: selloffCtx.slopeLowPct,
            slopeMidPct: selloffCtx.slopeMidPct,
            slopeHighPct: selloffCtx.slopeHighPct,
            kinkPct: selloffCtx.kinkPct,
            amountInAfterFee: amountAfterFee,
            amountOut: out,
            curveOut: (x) =>
              calcOutGivenIn({
                virtualBalanceIn: simVirtual[tokenInIndex],
                weightInBps: BigInt(weightsBps[tokenInIndex]),
                virtualBalanceOut: simVirtual[i],
                weightOutBps: BigInt(weightsBps[i]),
                amountIn: x,
                actualBalanceOut: lpActualOut,
              }),
          });
          cumulativeSelloff += swapAmount;
        }
        const netOut = out - surgeFee;
        const min = applySlippage(netOut > 0n ? netOut - 1n : 0n, slip);
        expectedOuts.push(new BN(netOut.toString()));
        minOuts.push(new BN(min.toString()));

        simActual[tokenInIndex] += swapAmount;
        simVirtual[tokenInIndex] += amountAfterFee;
        simProtocolFees[tokenInIndex] += protocolFeeAmount;
        simActual[i] -= out;
        simVirtual[i] -= out;
        simProtocolFees[i] += surgeFee;
        depositAmounts[i] = netOut;
      }
      depositAmounts[tokenInIndex] = remainingInput;

      const capped = capDepositAmountsToLpRatio({
        helperBalances: depositAmounts,
        actualBalances: simActual,
        protocolFeesOwed: simProtocolFees,
      });
      const estBpt = calcBptOutGivenExactTokensIn(
        capped.lpBalancesForAdd,
        capped.depositAmounts,
        BigInt(pool.bptTotalSupply.toString())
      );

      return ok({
        tokenInIndex,
        amountIn,
        allocations: alloc.allocations.map((b) => new BN(b.toString())),
        expectedOuts,
        minOuts,
        depositedAmounts: capped.depositAmounts.map((b) => new BN(b.toString())),
        refundAmounts: capped.refundAmounts.map((b) => new BN(b.toString())),
        estimatedBpt: new BN(estBpt.toString()),
        sidelinedTokenIndices: sidelined,
      });
    } catch (e) {
      return err("math_overflow", "Single-token deposit quote failed", e);
    }
  }

  /** Proportional-withdraw quote for a given BPT amount. */
  quoteRemove(bptIn: BN): SdkResult<{ tokenOuts: BN[] }> {
    const poolRes = this.requireCache();
    if (!poolRes.ok) return poolRes;
    const pool = poolRes.data;
    if (pool.bptTotalSupply.isZero()) {
      return err("invalid_input", "Pool has zero BPT supply");
    }
    try {
      // Match cubic-pool/remove_liquidity.rs exactly: it computes
      // token_amounts as `actual_balances[i] * bpt_amount / bpt_supply`
      // against the raw stored actual (no protocol-fee subtraction). Use
      // the same input here so the SDK quote equals what the contract
      // actually transfers.
      const bals = pool.tokens.map((t) => BigInt(t.actualBalance.toString()));
      const outs = calcTokensOutGivenBptIn(bals, BigInt(bptIn.toString()), BigInt(pool.bptTotalSupply.toString()));
      return ok({ tokenOuts: outs.map((o) => new BN(o.toString())) });
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

  private requireCache(): SdkResult<PoolInfo> {
    if (!this.cache) {
      return err("invalid_input", "Call `sync()` first to populate pool state");
    }
    return ok(this.cache);
  }
}
