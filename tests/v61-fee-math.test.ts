/**
 * v6.1 fee math ports vs the Rust unit vectors (`math/fee_split.rs`,
 * `math/liquidity_fee.rs`, `math/surge_bucket.rs`) plus the properties the
 * Rust proptests pin.
 */
import { splitFee, nonLpShare, feeSplitTotal } from "../src/math/feeSplit";
import { applyLiquidityFee, applyDepositFee, applyWithdrawFee, lpBurnNetOfWithdrawFee } from "../src/math/liquidityFee";
import { nav, navBalances, splitDepositCredit, splitExitPayout } from "../src/math/surgeBucket";
import { ONE, MathError } from "../src/math/fixedPoint";
import { calcDepositCredit } from "../src/math/poolMath";

const U64_MAX = (1n << 64n) - 1n;
// Deterministic LCG for property loops (no external deps).
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s; }; }

describe("splitFee (fee_split.rs)", () => {
  test("[P01] Rust vector: split_fee(7, 1000, 5000) = {1, 3, 3}", () => expect(splitFee(7n, 1000, 5000)).toEqual({ protocol: 1n, creator: 3n, lp: 3n }));
  test("[P02] Rust vector: split_fee(5, 1000, 3333) = {1, 1, 3}", () => expect(splitFee(5n, 1000, 3333)).toEqual({ protocol: 1n, creator: 1n, lp: 3n }));
  test("[P03] 100 % protocol gives everything to the protocol (creator 10000 too)", () => {
    for (const fee of [0n, 1n, 7n, U64_MAX]) expect(splitFee(fee, 10_000, 10_000)).toEqual({ protocol: fee, creator: 0n, lp: 0n });
  });
  test("[P04] 0 % protocol / 0 creator gives everything to the LPs", () => {
    for (const fee of [0n, 1n, 7n, U64_MAX]) expect(splitFee(fee, 0, 0)).toEqual({ protocol: 0n, creator: 0n, lp: fee });
  });
  test("[P05] parts always sum to the fee (Rust table)", () => {
    for (const fee of [0n, 1n, 2n, 3n, 9n, 10n, 99n, 10_000n, 123_456_789n, U64_MAX]) {
      for (const pr of [0, 1, 999, 1_000, 2_000, 5_000, 9_999, 10_000]) {
        for (const cr of [0, 1, 5_000, 9_999, 10_000]) {
          const s = splitFee(fee, pr, cr);
          expect(feeSplitTotal(s)).toBe(fee);
          expect(s.protocol <= fee && s.creator <= fee - s.protocol).toBe(true);
          expect(nonLpShare(s)).toBe(s.protocol + s.creator);
        }
      }
    }
  });
  test("[P06] protocol share is the ceiling, creator the floor of the LP remainder (random)", () => {
    const r = rng(7);
    for (let i = 0; i < 2_000; i++) {
      const fee = BigInt(r()) * BigInt(r()); const pr = r() % 10_001; const cr = r() % 10_001;
      const s = splitFee(fee, pr, cr);
      const exactP = (fee * BigInt(pr) + 9_999n) / 10_000n;
      expect(s.protocol).toBe(exactP);
      expect(s.creator).toBe(((fee - exactP) * BigInt(cr)) / 10_000n);
      expect(splitFee(fee, pr, 0).protocol).toBe(s.protocol);
    }
  });
  test("[P07] monotone in the creator share", () => {
    const r = rng(11);
    for (let i = 0; i < 500; i++) {
      const fee = BigInt(r()); const pr = r() % 10_001; const a = r() % 10_001, b = r() % 10_001;
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      const sl = splitFee(fee, pr, lo), sh = splitFee(fee, pr, hi);
      expect(sh.creator >= sl.creator).toBe(true); expect(sh.lp <= sl.lp).toBe(true); expect(sh.protocol).toBe(sl.protocol);
    }
  });
  test("[P08] a split trade never overpays the creator by more than k − 1 units", () => {
    const r = rng(13);
    for (let i = 0; i < 300; i++) {
      const fee = BigInt(r() % 1_000_000_000); const k = 2n + BigInt(r() % 5); const pr = r() % 10_001; const cr = r() % 10_001;
      const whole = splitFee(fee, pr, cr);
      const part = fee / k; const rem = fee - part * (k - 1n);
      let sum = 0n;
      for (let j = 0n; j < k; j++) sum += splitFee(j === k - 1n ? rem : part, pr, cr).creator;
      expect(sum <= whole.creator + (k - 1n)).toBe(true);
    }
  });
  test("[N01] a protocol rate above 10_000 fails closed (never mis-booked)", () => expect(() => splitFee(10n, 10_001, 0)).toThrow(/ProtocolFeeRateMaxExceeded/));
  test("[N02] a creator share above 10_000 fails closed", () => expect(() => splitFee(10n, 1_000, 10_001)).toThrow(/CreatorFeeBpsMaxExceeded/));
  test("[N03] negative / fractional / non-u64 inputs are refused", () => {
    expect(() => splitFee(-1n, 0, 0)).toThrow(MathError);
    expect(() => splitFee(U64_MAX + 1n, 0, 0)).toThrow(MathError);
    expect(() => splitFee(1n, -1, 0)).toThrow(MathError);
    expect(() => splitFee(1n, 0.5, 0)).toThrow(MathError);
    expect(() => splitFee(1n, 0, NaN)).toThrow(MathError);
  });
});

describe("applyLiquidityFee (liquidity_fee.rs)", () => {
  test("[P09] Rust vectors: fee rounds up, net rounds down", () => {
    expect(applyLiquidityFee(1n, 5)).toEqual({ net: 0n, fee: 1n });
    expect(applyLiquidityFee(10_000n, 5)).toEqual({ net: 9_995n, fee: 5n });
    expect(applyLiquidityFee(10_001n, 5)).toEqual({ net: 9_995n, fee: 6n });
  });
  test("[P10] zero rate / zero gross are identities", () => {
    expect(applyLiquidityFee(123_456n, 0)).toEqual({ net: 123_456n, fee: 0n });
    expect(applyLiquidityFee(0n, 5)).toEqual({ net: 0n, fee: 0n });
  });
  test("[P11] 100 % withholds everything", () => {
    expect(applyLiquidityFee(U64_MAX, 10_000)).toEqual({ net: 0n, fee: U64_MAX });
    expect(applyLiquidityFee(1n, 10_000)).toEqual({ net: 0n, fee: 1n });
  });
  test("[P12] net == floor(gross · (1 − bps/1e4)) (Rust identity table)", () => {
    for (const gross of [0n, 1n, 2n, 3n, 999n, 10_000n, 10_001n, 123_456_789n, U64_MAX]) {
      for (const bps of [0, 1, 5, 50, 100, 5_000, 9_999, 10_000]) {
        const { net, fee } = applyLiquidityFee(gross, bps);
        expect(net + fee).toBe(gross);
        expect(net).toBe((gross * BigInt(10_000 - bps)) / 10_000n);
      }
    }
  });
  test("[P13] ceil is super-additive: splitting never lowers the total fee (rounding against the user)", () => {
    const r = rng(17);
    for (let i = 0; i < 500; i++) {
      const gross = BigInt(r()); const bps = 1 + (r() % 9_999); const a = gross / 3n; const b = gross - a;
      expect(applyLiquidityFee(a, bps).fee + applyLiquidityFee(b, bps).fee >= applyLiquidityFee(gross, bps).fee).toBe(true);
    }
  });
  test("[P14] deposit / withdraw / burn-net helpers delegate to the same formula", () => {
    expect(applyDepositFee(10_001n, 5)).toEqual(applyLiquidityFee(10_001n, 5));
    expect(applyWithdrawFee(10_001n, 5)).toEqual(applyLiquidityFee(10_001n, 5));
    expect(lpBurnNetOfWithdrawFee(10_001n, 5)).toBe(9_995n);
  });
  test("[N04] above the cap fails closed", () => {
    expect(() => applyLiquidityFee(1_000n, 10_001)).toThrow(/LiquidityFeeMaxExceeded/);
    expect(() => applyLiquidityFee(0n, 65_535)).toThrow(/LiquidityFeeMaxExceeded/);
  });
  test("[N05] invalid rates / grosses are refused", () => {
    expect(() => applyLiquidityFee(1n, -1)).toThrow(MathError);
    expect(() => applyLiquidityFee(1n, 1.5)).toThrow(MathError);
    expect(() => applyLiquidityFee(-1n, 1)).toThrow(MathError);
    expect(() => applyLiquidityFee(U64_MAX + 1n, 1)).toThrow(MathError);
  });
});

describe("surge bucket (surge_bucket.rs)", () => {
  test("[P15] nav is checked", () => {
    expect(nav(1n, 2n)).toBe(3n); expect(nav(0n, 0n)).toBe(0n);
    expect(navBalances([1n, 2n], [3n, 4n])).toEqual([4n, 6n]);
  });
  test("[P16] Rust vectors: deposit split rounds the total up and the bucket down", () => {
    const r = ONE / 3n;
    expect(splitDepositCredit(6n, 4n, r)).toEqual({ totalCredit: 4n, actualIn: 3n, bucketIn: 1n });
    expect(splitDepositCredit(6n, 0n, r)).toEqual({ totalCredit: 2n, actualIn: 2n, bucketIn: 0n });
    expect(splitDepositCredit(0n, 4n, r)).toEqual({ totalCredit: 2n, actualIn: 0n, bucketIn: 2n });
    expect(splitDepositCredit(0n, 0n, r)).toEqual({ totalCredit: 0n, actualIn: 0n, bucketIn: 0n });
  });
  test("[P17] the ceil residue never lands in the bucket (Rust table)", () => {
    for (const actual of [1n, 2n, 3n, 7n, 999n, 1_000_000n]) {
      for (const surge of [0n, 1n, 2n, 5n, 123n, 999_999n]) {
        for (const ratio of [1n, ONE / 7n, ONE / 3n, ONE / 2n, ONE - 1n, ONE, (3n * ONE) / 2n]) {
          const leg = splitDepositCredit(actual, surge, ratio);
          expect(leg.totalCredit).toBe(leg.actualIn + leg.bucketIn);
          expect(leg.bucketIn).toBe((surge * ratio) / ONE);
          const actualCeil = calcDepositCredit(actual, ratio);
          expect(leg.actualIn >= actualCeil && leg.actualIn <= actualCeil + 1n).toBe(true);
        }
      }
    }
  });
  test("[P18] a reserve-less slot puts the whole credit into the bucket", () => {
    const leg = splitDepositCredit(0n, 1_000n, ONE / 10n);
    expect(leg).toEqual({ totalCredit: 100n, actualIn: 0n, bucketIn: 100n });
  });
  test("[P19] Rust vector: exit split fees both parts and sums", () => {
    const leg = splitExitPayout(10_000n, 1n, 5);
    expect(leg.actualPayout).toBe(9_995n); expect(leg.feeActual).toBe(5n);
    expect(leg.surgePayout).toBe(0n); expect(leg.feeSurge).toBe(1n);
    expect(leg.transferAmount).toBe(9_995n); expect(leg.feeTotal).toBe(6n); expect(leg.grossTotal).toBe(10_001n);
    const zero = splitExitPayout(10_000n, 1n, 0);
    expect([zero.actualPayout, zero.surgePayout, zero.feeTotal]).toEqual([10_000n, 1n, 0n]);
  });
  test("[P20] exit fee per part is never below one ceiling of the sum and at most one unit above", () => {
    const r = rng(19);
    for (let i = 0; i < 1_000; i++) {
      const a = BigInt(r()), s = BigInt(r() % 1_000_000), w = r() % 10_001;
      const leg = splitExitPayout(a, s, w);
      const single = applyLiquidityFee(a + s, w).fee;
      expect(leg.feeTotal >= single && leg.feeTotal <= single + 1n).toBe(true);
      expect(leg.transferAmount + leg.feeTotal).toBe(leg.grossTotal);
    }
  });
  test("[P21] per-share NAV is non-decreasing across random join → exit round trips", () => {
    const r = rng(23);
    for (let i = 0; i < 300; i++) {
      let actual = 1_000_000n + BigInt(r() % 1_000_000), surge = BigInt(r() % 100_000), supply = 1_000_000_000n + BigInt(r() % 1_000_000);
      const d = r() % 10_000, w = r() % 10_000;
      const before = { nav: actual + surge, supply };
      // join at ratio r
      const ratio = (BigInt(1 + (r() % 1_000)) * ONE) / 10_000n;
      const lpGross = (supply * ratio) / ONE;
      const { net: lp } = applyDepositFee(lpGross, d);
      if (lp === 0n || lpGross === 0n) continue;
      const leg = splitDepositCredit(actual, surge, ratio);
      actual += leg.actualIn; surge += leg.bucketIn; supply += lp;
      expect((actual + surge) * before.supply >= before.nav * supply).toBe(true);
      // exit the minted lp
      const burn = lp;
      const ag = (actual * ((burn * ONE) / supply)) / ONE, sg = (surge * ((burn * ONE) / supply)) / ONE;
      const ex = splitExitPayout(ag, sg, w);
      const after = { nav: actual - ex.actualPayout + surge - ex.surgePayout, supply: supply - burn };
      expect(after.nav * supply >= (actual + surge) * after.supply).toBe(true);
      // the round trip never returns more than was put in
      expect(ex.transferAmount <= leg.totalCredit).toBe(true);
    }
  });
  test("[N06] nav overflow and length mismatch are refused", () => {
    expect(() => nav(U64_MAX, 1n)).toThrow(/MathOverflow/);
    expect(() => navBalances([1n], [1n, 2n])).toThrow(/InvalidArrayLength/);
    expect(() => nav(-1n, 0n)).toThrow(MathError);
  });
  test("[N07] an exit fee above the cap fails closed", () => expect(() => splitExitPayout(1n, 1n, 10_001)).toThrow(/LiquidityFeeMaxExceeded/));
  test("[N08] a non-u128 ratio is refused", () => expect(() => splitDepositCredit(1n, 1n, -1n)).toThrow(MathError));
  test("[N09] a bucket buy-in that would overflow u64 is refused", () => expect(() => splitDepositCredit(1n, U64_MAX, 2n * ONE)).toThrow(MathError));
});
