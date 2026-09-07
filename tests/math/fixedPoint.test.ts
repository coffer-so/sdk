import { ONE, mulDown, mulUp, divDown, divUp, complement, weightToFp } from "../../src/math/fixedPoint";

describe("fixedPoint", () => {
  test("ONE is 1e18", () => {
    expect(ONE).toBe(1_000_000_000_000_000_000n);
  });

  test("mulDown / mulUp identity for exact products", () => {
    // 0.5 × 0.5 = 0.25 exactly
    const half = ONE / 2n;
    const expected = ONE / 4n;
    expect(mulDown(half, half)).toBe(expected);
    expect(mulUp(half, half)).toBe(expected);
  });

  test("mulDown rounds down on non-exact", () => {
    // (1 × 1) / ONE = 0 (floor)
    expect(mulDown(1n, 1n)).toBe(0n);
  });

  test("mulUp rounds up on non-exact", () => {
    // (1 × 1) / ONE round up = 1
    expect(mulUp(1n, 1n)).toBe(1n);
  });

  test("divDown / divUp bracket exact", () => {
    // 3 / 7 is not exact in fp. divDown <= divUp.
    const a = 3n * ONE;
    const b = 7n * ONE;
    const d = divDown(a, b);
    const u = divUp(a, b);
    expect(u - d).toBeGreaterThanOrEqual(0n);
    expect(u - d).toBeLessThanOrEqual(1n);
  });

  test("complement of 0 is ONE, of ONE is 0", () => {
    expect(complement(0n)).toBe(ONE);
    expect(complement(ONE)).toBe(0n);
    expect(complement(ONE / 2n)).toBe(ONE / 2n);
  });

  test("complement rejects x > ONE, matching the Rust guard", () => {
    expect(() => complement(ONE + 1n)).toThrow();
  });

  test("weightToFp 5000 bps = 0.5 × ONE", () => {
    expect(weightToFp(5000)).toBe(ONE / 2n);
  });

  test("weightToFp 10000 bps = ONE", () => {
    expect(weightToFp(10000)).toBe(ONE);
  });
});
