import vectors from "./release-rounding-rust-vectors.json";
import { checkDepositRounding } from "../../src/math/liquidityRounding";
import { calcJoinRatioAndLp } from "../../src/math/poolMath";
import { splitDepositCredit } from "../../src/math/surgeBucket";

describe("2026-11-13 candidate: real Rust helper parity, not handler/runtime proof", () => {
  test("all exported boundaries, deflated joins, NAV buckets and random vectors match", () => {
    let accepted = 0, refused = 0;
    for (const row of vectors) {
      let ok = true;
      try {
        if (row.kind === "bound") {
          checkDepositRounding(BigInt(row.nav!), BigInt(row.credit!), BigInt(row.lp), BigInt(row.supply));
        } else {
          const actual = row.actual!.map(BigInt), surge = row.surge!.map(BigInt), net = row.net!.map(BigInt);
          const navs = actual.map((a,i) => a + surge[i]);
          const { lp, ratio } = calcJoinRatioAndLp(navs, net, BigInt(row.supply));
          expect(lp.toString()).toBe(row.lp);
          const credits = actual.map((a,i) => splitDepositCredit(a,surge[i],ratio).totalCredit);
          expect(credits.map(String)).toEqual(row.credits);
          if (lp === 0n) ok = false;
          else credits.forEach((c,i) => checkDepositRounding(navs[i],c,lp,BigInt(row.supply),i));
        }
      } catch (error) {
        if (!(error instanceof Error) || !/DepositRoundingLossTooLarge|InvalidLpAmount/.test(error.message)) throw error;
        ok = false;
      }
      expect({ id: row.id, ok }).toEqual({ id: row.id, ok: row.ok });
      if (ok) accepted++; else refused++;
    }
    expect(accepted).toBeGreaterThan(500); expect(refused).toBeGreaterThan(100);
  });
});
