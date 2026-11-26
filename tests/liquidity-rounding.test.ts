import BN from "bn.js";
import { CofferPoolClient } from "../src/clients/CofferPoolClient";
import { buildAddLiquidityIx, buildAddLiquidityTx } from "../src/clients/tx-builders";
import { assertDepositRoundingLoss, checkDepositRounding, sizeDepositForLp, DepositRoundingLossError } from "../src/math/liquidityRounding";
import { calcDepositCredit, calcJoinRatioAndLp, calcTokensOutGivenLpIn } from "../src/math/poolMath";
import { cfg, mockPool, pk } from "./helpers/poolFixture";
import type { PoolInfo } from "../src/types/pool";

const amounts = (xs: bigint[]) => xs.map(x => new BN(x.toString()));
function clientFor(pool: PoolInfo) {
  const client = new CofferPoolClient({ config: cfg, poolAddress: pool.address });
  (client as unknown as { cache: PoolInfo }).cache = pool;
  return client;
}

describe("client deposit rounding-loss policy", () => {
  test("reproduces the exact small-supply loss while keeping protocol math unchanged", () => {
    const navs = [1_000n, 2_000n], offered = [1_900n, 3_800n];
    const { lp, ratio } = calcJoinRatioAndLp(navs, offered, 1n);
    const credits = navs.map(nav => calcDepositCredit(nav, ratio));
    expect(lp).toBe(1n); expect(credits).toEqual(offered);
    // At the old NAV price, 1 LP represents [1000, 2000] of a [1900, 3800]
    // credit: 9/19 (47.37%) shortfall. Immediate post-join gross redemption
    // is [1450, 2900]: 9/38 (23.68%) loss before any fees.
    expect(credits[0] - navs[0] * lp).toBe(900n);
    expect(calcTokensOutGivenLpIn(navs.map((nav, i) => nav + credits[i]), lp, 2n)).toEqual([1_450n, 2_900n]);
    const pool = mockPool({ lpSupply: 1n, balances: [[1_000n, 2_000n], [2_000n, 4_000n]] });
    expect(clientFor(pool).quoteAddLiquidity(amounts(offered))).toMatchObject({ ok: false, error: { code: "deposit_rounding_loss" } });
    const params = { user: pk(), tokenAmounts: amounts(offered), minimumLpAmount: new BN(1) };
    expect(() => buildAddLiquidityIx(cfg, pool, params)).toThrow(DepositRoundingLossError);
    expect(() => buildAddLiquidityTx(cfg, pool, params)).toThrow(DepositRoundingLossError);
    expect(clientFor(pool).buildAddLiquidityTx(params)).toMatchObject({ ok: false, error: { code: "deposit_rounding_loss" } });
  });

  test("refuses adversarial fractional joins at every raw supply 1..1000 without using a supply cutoff", () => {
    for (let supply = 1n; supply <= 1_000n; supply++) {
      const navs = [1_000_000n, 2_000_000n];
      const offered = navs.map(nav => (19n * nav) / (10n * supply));
      const { lp, ratio } = calcJoinRatioAndLp(navs, offered, supply);
      expect(lp).toBe(1n);
      const credits = navs.map(nav => calcDepositCredit(nav, ratio));
      expect(() => assertDepositRoundingLoss(navs, credits, supply, lp, cfg.defaults.slippageHundredthsBps)).toThrow(DepositRoundingLossError);
      // The same tiny/custom supply can join EXACTLY, including at 0 tolerance.
      const exact = calcJoinRatioAndLp(navs, navs, supply);
      expect(() => assertDepositRoundingLoss(navs, navs, supply, exact.lp, 0)).not.toThrow();
    }
  });

  test("compares rational loss exactly at the configured boundary", () => {
    // Gross mint 1 vs fair 2 LP: exactly 50%, no floating-point approximation.
    expect(() => assertDepositRoundingLoss([100n], [2n], 100n, 1n, 500_000)).not.toThrow();
    expect(() => assertDepositRoundingLoss([100n], [2n], 100n, 1n, 499_999)).toThrow(DepositRoundingLossError);
    for (const invalid of [-1, 0.5, NaN, Infinity, 1_000_001]) {
      expect(() => assertDepositRoundingLoss([100n], [1n], 100n, 1n, invalid)).toThrow(/slippage/);
    }
    expect(() => assertDepositRoundingLoss([0n], [1n], 1n, 1n, 0)).toThrow(/TokenLivenessMismatch/);
    const max = (1n << 64n) - 1n;
    expect(() => assertDepositRoundingLoss([max], [max], max, max, 0)).not.toThrow();
  });

  test("also includes token-credit ceilings even when LP supply is large", () => {
    const pool = mockPool({ lpSupply: 100_000n, balances: [[1_000n, 2_000n], [1n, 1_000n]] });
    // Ratio 10%, gross LP 10000, credits [100, 1]. Thin leg buys 90% less
    // gross LP than its one-unit credit represents at the old NAV.
    expect(clientFor(pool).quoteAddLiquidity(amounts([100n, 1n]))).toMatchObject({ ok: false, error: { code: "deposit_rounding_loss" } });
  });

  test("custom supply, zero slippage and a one-LP mint stay valid when exact", () => {
    const pool = mockPool({ lpSupply: 1n, balances: [[1_000n, 2_000n], [2_000n, 4_000n]] });
    const client = clientFor(pool);
    for (const slip of [undefined, 0]) {
      const quote = client.quoteAddLiquidity(amounts([1_000n, 2_000n]), slip);
      if (!quote.ok) throw new Error(quote.error.humanMessage);
      expect(quote.data.lpOut.toString()).toBe("1"); expect(quote.data.minimumLpAmount.toString()).toBe("1");
      expect(client.buildAddLiquidityTx({ user: pk(), tokenAmounts: quote.data.tokenAmounts,
        minimumLpAmount: quote.data.minimumLpAmount, slippageHundredthsBps: slip }).ok).toBe(true);
    }
    expect(client.quoteRemove(new BN(1)).ok).toBe(true);
    expect(() => buildAddLiquidityIx(cfg, pool, { user: pk(), tokenAmounts: amounts([1_000n, 2_000n]), minimumLpAmount: new BN(0) })).toThrow(/minimumLpAmount/);
  });

  test("uses NAV including reserve-less surge buckets in builders and quotes", () => {
    const pool = mockPool({ lpSupply: 1n, balances: [[1n, 1_000n], [0n, 1_000n]], surge: [999n, 2_000n] });
    const params = { user: pk(), tokenAmounts: amounts([1_000n, 2_000n]), minimumLpAmount: new BN(1), slippageHundredthsBps: 0 };
    expect(clientFor(pool).quoteAddLiquidity(params.tokenAmounts, 0).ok).toBe(true);
    expect(() => buildAddLiquidityIx(cfg, pool, params)).not.toThrow();
    const unsafe = { ...params, tokenAmounts: amounts([1_900n, 3_800n]) };
    expect(() => buildAddLiquidityIx(cfg, pool, unsafe)).toThrow(DepositRoundingLossError);
    delete pool.tokens[0].surgeFeesOwed; delete pool.tokens[1].surgeFeesOwed;
    expect(() => buildAddLiquidityIx(cfg, pool, params)).not.toThrow(); // pool-level bucket fallback
  });

  test("known transfer and deposit fees remain explicit costs, separate from the rounding budget", () => {
    const pool = mockPool({ lpSupply: 1_000n, balances: [[1_000n, 2_000n], [1_000n, 2_000n]], depositFeeBps: 100 });
    pool.tokens.forEach(t => { t.transferFee = { epoch: 0n, transferFeeBasisPoints: 1_000, maximumFee: 1_000_000n }; });
    const quote = clientFor(pool).quoteAddLiquidity(amounts([1_112n, 1_112n]), 0);
    if (!quote.ok) throw new Error(quote.error.humanMessage);
    expect(quote.data.creditedAmounts.map(String)).toEqual(["1000", "1000"]);
    expect(quote.data.transferFees.map(String)).toEqual(["112", "112"]);
    expect(quote.data.depositFeeLp.toString()).toBe("10"); expect(quote.data.lpOut.toString()).toBe("990");
    expect(() => buildAddLiquidityIx(cfg, pool, { user: pk(), tokenAmounts: quote.data.tokenAmounts,
      minimumLpAmount: quote.data.minimumLpAmount, slippageHundredthsBps: 0 })).not.toThrow();
    pool.depositFeeBps = 10_000;
    expect(clientFor(pool).quoteAddLiquidity(quote.data.tokenAmounts)).toMatchObject({ ok: false, error: { code: "amount_too_small" } });
    expect(() => buildAddLiquidityIx(cfg, pool, { user: pk(), tokenAmounts: quote.data.tokenAmounts, minimumLpAmount: new BN(1) })).toThrow(/DepositFeeConsumesAll/);
  });

  test("explicit tolerance is independent of the positive LP floor; invalid tolerances fail closed", () => {
    const pool = mockPool({ lpSupply: 1n, balances: [[1_000n, 2_000n], [1_000n, 2_000n]] });
    const tokenAmounts = amounts([1_900n, 1_900n]);
    const client = clientFor(pool);
    expect(client.quoteAddLiquidity(tokenAmounts, 500_000)).toMatchObject({ ok: false, error: { code: "deposit_rounding_loss" } });
    expect(() => buildAddLiquidityIx(cfg, pool, { user: pk(), tokenAmounts, minimumLpAmount: new BN(1), slippageHundredthsBps: 500_000 })).toThrow(/6110/);
    for (const slip of [-1, 0.5, 1_000_001]) {
      expect(client.quoteAddLiquidity(tokenAmounts, slip)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(() => buildAddLiquidityIx(cfg, pool, { user: pk(), tokenAmounts, minimumLpAmount: new BN(1), slippageHundredthsBps: slip })).toThrow(/slippage/);
    }
  });

  test("a tiny rounded deposit fee is quoted separately even when it costs half the gross LP", () => {
    const pool = mockPool({ lpSupply: 2n, balances: [[1_000n, 2_000n], [2_000n, 4_000n]], depositFeeBps: 1 });
    const client = clientFor(pool);
    const quote = client.quoteAddLiquidity(amounts([1_000n, 2_000n]), 0);
    if (!quote.ok) throw new Error(quote.error.humanMessage);
    expect(quote.data.lpGross.toString()).toBe("2");
    expect(quote.data.depositFeeLp.toString()).toBe("1");
    expect(quote.data.depositFeeEffectiveHundredthsBpsCeil).toBe(500_000);
    expect(quote.data.lpOut.toString()).toBe("1");
    expect(quote.data.minimumLpAmount.toString()).toBe("1");
    expect(client.buildAddLiquidityTx({ user: pk(), tokenAmounts: quote.data.tokenAmounts,
      minimumLpAmount: quote.data.minimumLpAmount, slippageHundredthsBps: 0 }).ok).toBe(true);
  });
});

describe("proposed F-02 on-chain bound (D6 pending)", () => {
  test("FI-01: supply 1 / gross 2 / declared 1bp exposes a 50% effective LP fee and 25% dilution loss", () => {
    const pool=mockPool({lpSupply:1n,balances:[[1_000n,2_000n],[2_000n,4_000n]],depositFeeBps:1});
    const quote=clientFor(pool).quoteAddLiquidity(amounts([2_000n,4_000n]),0);
    if(!quote.ok)throw new Error(quote.error.humanMessage);
    expect([quote.data.lpGross,quote.data.depositFeeLp,quote.data.lpOut].map(String)).toEqual(["2","1","1"]);
    expect(quote.data.depositFeeEffectiveHundredthsBpsCeil).toBe(500_000);
    const out=calcTokensOutGivenLpIn([3_000n,6_000n],1n,2n);
    expect(out).toEqual([1_500n,3_000n]);
    quote.data.creditedAmounts.forEach((c,i)=>expect((BigInt(c.toString())-out[i])*4n).toBe(BigInt(c.toString())));
  });

  test("FI-04: corrected ceiling increment covers NAV above 1e18 and validates u64/floors", () => {
    const navs=[6_000_000_000_000_000_000n,6_000_000_000_000_000_000n];
    const old=navs.map(n=>(n*2n+2n)/3n+1n);
    const broken=calcJoinRatioAndLp(navs,old,3n);
    expect(broken.lp).toBe(1n);
    const oldCredits=navs.map(n=>calcDepositCredit(n,broken.ratio));
    expect(oldCredits).toEqual([3_999_999_999_999_999_996n,3_999_999_999_999_999_996n]);
    expect(()=>assertDepositRoundingLoss(navs,oldCredits,3n,1n,1_000_000)).toThrow(/6110/);
    const sized=sizeDepositForLp(navs,2n,3n);
    expect(sized).toEqual([4_000_000_000_000_000_006n,4_000_000_000_000_000_006n]);
    const {lp,ratio}=calcJoinRatioAndLp(navs,sized,3n);expect(lp>=2n).toBe(true);
    expect(()=>assertDepositRoundingLoss(navs,navs.map(n=>calcDepositCredit(n,ratio)),3n,lp,1_000_000)).not.toThrow();
    const max=(1n<<64n)-1n;
    expect(()=>sizeDepositForLp([max],max,1n)).toThrow(/u64/);
    expect(()=>sizeDepositForLp([1n],1n,max)).toThrow(/u64/);
  });

  test("FI-05: exact integer bound accepts the documented counterexample to +2 prose", () => {
    const nav=999_000_001n,c=1_002n,s=1_000_000n,l=1n;
    expect(()=>checkDepositRounding(nav,c,l,s)).not.toThrow();
    expect(1_000n*c*s<=1_001n*(nav*l+s)+1_000n*s).toBe(true);
    expect(1_000n*c*s>1_001n*nav*l+2_000n*s).toBe(true);
  });
  test("exact ceiled-fair boundary and full u64 products", () => {
    for (const [nav, lp, supply, limit] of [[1_000_000n, 1n, 1n, 1_001_001n], [10n, 1n, 3n, 5n], [9n, 1n, 3n, 4n]]) {
      expect(() => checkDepositRounding(nav, limit, lp, supply)).not.toThrow();
      expect(() => checkDepositRounding(nav, limit + 1n, lp, supply)).toThrow(/6110/);
    }
    const max = (1n << 64n) - 1n;
    expect(() => checkDepositRounding(max, max, max, 1n)).not.toThrow();
    expect(() => checkDepositRounding(max, 2n, 1n, max)).not.toThrow();
    expect(() => checkDepositRounding(max, 3n, 1n, max)).toThrow(/6110/);
    expect(() => checkDepositRounding(0n, 1n, 0n, 1n)).not.toThrow();
    expect(() => checkDepositRounding(1n, 1n, 1n, 0n)).toThrow(/InvalidLpAmount/);
  });

  test("quotes and stateful builders cannot relax the bound through slippage", () => {
    const pool = mockPool({ lpSupply: 1_000_000_000n, balances: [[500_000_000_000n, 1_000_000_000_000n], [1_000_000_000_000n, 2_000_000_000_000n]] });
    const client = clientFor(pool);
    expect(client.quoteAddLiquidity(amounts([125_000n, 250_000n])).ok).toBe(true);
    for (const slip of [undefined, 50_000, 1_000_000]) {
      const tokenAmounts = amounts([125_250n, 250_500n]);
      expect(client.quoteAddLiquidity(tokenAmounts, slip)).toMatchObject({ ok: false, error: { code: "deposit_rounding_loss" } });
      expect(() => buildAddLiquidityIx(cfg, pool, { user: pk(), tokenAmounts, minimumLpAmount: new BN(1), slippageHundredthsBps: slip })).toThrow(/6110/);
    }
    expect(() => buildAddLiquidityIx(cfg, pool, { user: pk(), tokenAmounts: amounts([125_250n, 250_500n]), minimumLpAmount: new BN(251) })).toThrow(/InsufficientLpOut/);
  });

  test("gross LP bounds are independent of deposit fees; transfer fees use net credit", () => {
    for (const fee of [1, 5_000, 9_999]) {
      const pool = mockPool({ lpSupply: 1_000n, balances: [[1_000_000n, 2_000_000n], [2_000_000n, 4_000_000n]], depositFeeBps: fee });
      pool.tokens.forEach(t => { t.transferFee = { epoch: 0n, transferFeeBasisPoints: 100, maximumFee: 1_000_000n }; });
      const quote = clientFor(pool).quoteAddLiquidity(amounts([20_202_021n, 40_404_041n]));
      if (!quote.ok) throw new Error(quote.error.humanMessage);
      expect(quote.data.lpGross.gt(quote.data.lpOut)).toBe(true);
      quote.data.creditedAmounts.forEach((credit, i) => expect(() => checkDepositRounding(BigInt(quote.data.navBalances[i].toString()), BigInt(credit.toString()), BigInt(quote.data.lpGross.toString()), 1_000n)).not.toThrow());
    }
  });

  test("LP-unit sizing covers low supplies, bucket NAV and sidelined legs", () => {
    for (const supply of [1n, 100n, 1_000n]) {
      const navs = [1_000_000n, 2_000_000n, 0n];
      const net = sizeDepositForLp(navs, 7n, supply);
      const { lp, ratio } = calcJoinRatioAndLp(navs, net, supply);
      expect(lp >= 7n).toBe(true); expect(net[2]).toBe(0n);
      const credits = navs.map(nav => calcDepositCredit(nav, ratio));
      expect(() => assertDepositRoundingLoss(navs, credits, supply, lp, 1_000_000)).not.toThrow();
      const pool = mockPool({ lpSupply: supply, balances: [[1n, 2n], [0n, 1_000n], [0n, 1_000n]], surge: [999_999n, 2_000_000n, 0n] });
      expect(clientFor(pool).quoteAddLiquidity(amounts(net)).ok).toBe(true);
    }
  });
});
