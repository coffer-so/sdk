import { ONE, U64_MAX } from "../../src/math/fixedPoint";
import { powFp } from "../../src/math/logExp";
import { calcOutGivenIn } from "../../src/math/poolMath";

type Swap = Parameters<typeof calcOutGivenIn>[0];

// Independent oracle: exact rational integer powers, with no ln/exp or
// floating point. These five inputs previously paid 1..5 raw units too much.
const witnesses = [
  [223130160148429829n, 200n, 776869839851570171n, 17528334765347285145n, 17528334765347281475n],
  [416862019678508403n, 200n, 583137980321491597n, 15241180612199914216n, 15241180612199910546n],
  [687289278790972199n, 800n, 312710721209027801n, 17528334765347285141n, 17528334765347281475n],
  [882496902584595403n, 800n, 117503097415404597n, 11660566172440666332n, 11660566172440662662n],
  [882496902584595403n, 1600n, 117503097415404597n, 15950248739700762809n, 15950248739700759142n],
] as const;

function exactIntegerOutput(p: Swap): bigint {
  const exponent = p.weightInBps / p.weightOutBps;
  const denominator = (p.virtualBalanceIn + p.amountIn) ** exponent;
  return p.virtualBalanceOut * (denominator - p.virtualBalanceIn ** exponent) / denominator;
}

function previousOutput(p: Swap): bigint {
  const denominator = p.virtualBalanceIn + p.amountIn;
  const base = (p.virtualBalanceIn * ONE + denominator - 1n) / denominator;
  const raw = p.weightInBps === p.weightOutBps
    ? base : powFp(base, p.weightInBps * ONE / p.weightOutBps);
  const power = raw + 1n > ONE ? ONE : raw + 1n;
  return p.virtualBalanceOut * (ONE - power) / ONE;
}

describe("swap power rounding", () => {
  test.each(witnesses)("exact BigInt witness Vin=%s wi=%s", (virtualBalanceIn, weightInBps, amountIn, reference, candidate) => {
    const p = { virtualBalanceIn, weightInBps, amountIn, weightOutBps: 100n, virtualBalanceOut: U64_MAX, actualBalanceOut: U64_MAX - 1n };
    const ideal = exactIntegerOutput(p);
    expect(ideal).toBe(reference);
    expect(previousOutput(p)).toBeGreaterThan(ideal);
    expect(calcOutGivenIn(p)).toBe(candidate);
    expect(calcOutGivenIn(p)).toBeLessThanOrEqual(ideal);
  });

  const boundaryCases: Swap[] = [];
  for (const exponent of [2n, 3n, 8n, 16n, 32n, 64n, 99n]) {
    for (const virtualBalanceIn of [3n, 1_000_000_000n, ONE, U64_MAX]) {
      for (const amountIn of new Set([0n, 1n, virtualBalanceIn / 100n, virtualBalanceIn / 10n])) {
        for (const virtualBalanceOut of [1n, 1_000_000_000n, U64_MAX]) {
          boundaryCases.push({ virtualBalanceIn, weightInBps: exponent * 100n, virtualBalanceOut, weightOutBps: 100n, amountIn, actualBalanceOut: virtualBalanceOut });
        }
      }
    }
  }
  test.each(boundaryCases.map((p, i) => [i, p] as const))("conservative exact integer boundary %s", (_i, p) => {
    const out = calcOutGivenIn(p);
    expect(out).toBeLessThanOrEqual(exactIntegerOutput(p));
    expect(out).toBeGreaterThanOrEqual(0n);
    const extraMargin = previousOutput(p) - out;
    expect(extraMargin).toBeGreaterThanOrEqual(0n);
    expect(extraMargin).toBeLessThanOrEqual((199n * p.virtualBalanceOut + ONE - 1n) / ONE);
  });

  const equalCases: Swap[] = [];
  for (const weight of [100n, 2500n, 5000n, 9900n, 10000n]) {
    for (const virtualBalanceIn of [1n, 3n, 1_000_000_000n, U64_MAX]) {
      for (const amountIn of [0n, 1n, 999n, U64_MAX]) {
        equalCases.push({ virtualBalanceIn, weightInBps: weight, virtualBalanceOut: U64_MAX, weightOutBps: weight, amountIn, actualBalanceOut: U64_MAX });
      }
    }
  }
  test.each(equalCases.map((p, i) => [i, p] as const))("equal positive weights keep exact-base +1 output %s", (_i, p) => {
    expect(calcOutGivenIn(p)).toBe(previousOutput(p));
    expect(calcOutGivenIn(p)).toBeLessThanOrEqual(exactIntegerOutput(p));
  });

  test("unequal zero input clamps the rounded power to ONE", () => {
    expect(calcOutGivenIn({ virtualBalanceIn: U64_MAX, weightInBps: 9900n, virtualBalanceOut: U64_MAX, weightOutBps: 100n, amountIn: 0n, actualBalanceOut: 0n })).toBe(0n);
  });

  test("large swaps outside the ln/exp exponent domain still reject", () => {
    expect(() => calcOutGivenIn({ virtualBalanceIn: 1n, weightInBps: 9900n, virtualBalanceOut: U64_MAX, weightOutBps: 100n, amountIn: U64_MAX, actualBalanceOut: U64_MAX })).toThrow();
  });
});
