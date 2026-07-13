/**
 * Off-chain replicas of the cubic-pool v5 sell-off protections:
 *
 *   - max-selloff sliding window — `math/max_selloff.rs::check_and_advance`
 *   - variable surge-fee curve   — `math/surge_fee.rs::calc_surge_fee_pct`
 *
 * Used by routers/quoters to (a) avoid building routes that would revert
 * with `MaxSelloffExceeded` — the window is a HARD cap on how much of a
 * token can be sold into the pool per window — and (b) quote `amount_out`
 * NET of the surge fee, which is the value the contract checks
 * `minimum_amount_out` against.
 *
 * All arithmetic is bigint and mirrors the contract's u128 intermediates
 * and rounding (cap floored, surge fee rounded UP). `powFp` is the same
 * LogExpMath port the pool uses on-chain.
 */

import { powFp } from "./logExp";

/** Scale shared by all `_pct` config fields: 10_000 = 100%. */
export const PERCENT_SCALE = 10_000n;

const ONE = 1_000_000_000_000_000_000n;
/** Convexity base A for the surge curve (contracts: SURGE_FEE_CONVEXITY_FP). */
const SURGE_FEE_CONVEXITY_FP = 4n * ONE;

export interface SelloffWindowInput {
  /** `AssetConfig.max_selloff_pct` (PERCENT_SCALE units). `0` = disabled. */
  maxSelloffPct: number;
  /** `AssetConfig.max_selloff_period_length` (seconds). */
  periodLengthSecs: number;
  /** `AssetDynamics.previous_selloff`. */
  previousSelloff: bigint;
  /** `AssetDynamics.current_selloff`. */
  currentSelloff: bigint;
  /** `AssetDynamics.window_start_timestamp` (unix seconds). */
  windowStartTimestamp: bigint;
  /** `AssetDynamics.selloff_vb_snapshot`. `0` = uninitialised. */
  selloffVbSnapshot: bigint;
  /** The token's CURRENT (pre-swap) `virtual_balance` — becomes the new
   *  snapshot if the window (re)opens at `now`. */
  virtualBalance: bigint;
}

export interface ResolvedSelloffWindow {
  /** `false` ⇒ no cap configured — unlimited headroom, no surge fee. */
  enabled: boolean;
  /** Snapshot the cap resolves against at `now` (re-baselined on rotation). */
  vbSnapshot: bigint;
  /** Absolute cap: `floor(pct × vbSnapshot / PERCENT_SCALE)`. */
  cap: bigint;
  /**
   * `previous × (period − elapsed) / period + current` after applying any
   * window rotation at `now` — EXCLUDING any new trade amount.
   */
  effectiveSelloff: bigint;
  /** Max additional `amount_in` the window accepts now (`cap − effective`,
   *  clamped ≥ 0). The contract requires `effective + amount_in <= cap`. */
  headroom: bigint;
}

/**
 * Resolve a token's sell-off window state at `nowSecs`, WITHOUT mutating
 * anything — the read-only counterpart of the contract's
 * `check_and_advance` (which the real swap will run).
 *
 * Rotation rules (contract-identical):
 *  - `elapsed >= 2×period` → both buckets aged out; cleared, re-snapshot.
 *  - `elapsed >= period`   → `previous = current`, `current = 0`,
 *    `window_start += period` (slides one period, not to `now`), re-snapshot.
 *  - otherwise             → unchanged; reuse stored snapshot (or capture
 *    the live vb when the snapshot is still `0` / uninitialised).
 */
export function resolveSelloffWindow(
  input: SelloffWindowInput,
  nowSecs: number,
): ResolvedSelloffWindow {
  const pct = BigInt(input.maxSelloffPct);
  if (pct === 0n) {
    return {
      enabled: false,
      vbSnapshot: 0n,
      cap: 0n,
      effectiveSelloff: 0n,
      headroom: 0n,
    };
  }
  const period = BigInt(input.periodLengthSecs);
  if (period <= 0n) {
    // Unreachable on-chain (set_max_selloff validates period > 0 when
    // pct > 0); treat defensively as "window accepts nothing".
    return {
      enabled: true,
      vbSnapshot: input.selloffVbSnapshot,
      cap: 0n,
      effectiveSelloff: 0n,
      headroom: 0n,
    };
  }

  const now = BigInt(Math.floor(nowSecs));
  // Clock skew clamps to 0 rather than rotating backwards.
  let elapsed = now - input.windowStartTimestamp;
  if (elapsed < 0n) elapsed = 0n;

  let previous: bigint;
  let current: bigint;
  let elapsedInWindow: bigint;
  let openedWindow: boolean;
  if (elapsed >= 2n * period) {
    previous = 0n;
    current = 0n;
    elapsedInWindow = 0n;
    openedWindow = true;
  } else if (elapsed >= period) {
    previous = input.currentSelloff;
    current = 0n;
    const newWindowStart = input.windowStartTimestamp + period;
    elapsedInWindow = now - newWindowStart;
    if (elapsedInWindow < 0n) elapsedInWindow = 0n;
    openedWindow = true;
  } else {
    previous = input.previousSelloff;
    current = input.currentSelloff;
    elapsedInWindow = elapsed;
    openedWindow = false;
  }

  const vbSnapshot =
    openedWindow || input.selloffVbSnapshot === 0n
      ? input.virtualBalance
      : input.selloffVbSnapshot;

  // Cap floored — a user can never sell more than the configured fraction.
  const cap = (pct * vbSnapshot) / PERCENT_SCALE;

  const weightedPrev = (previous * (period - elapsedInWindow)) / period;
  const effectiveSelloff = weightedPrev + current;

  const headroom = cap > effectiveSelloff ? cap - effectiveSelloff : 0n;
  return { enabled: true, vbSnapshot, cap, effectiveSelloff, headroom };
}

/**
 * Surge-fee percentage (PERCENT_SCALE units, `0..=10_000`) for a swap that
 * pushes the input token's window to `effectiveSelloff` (INCLUDING the
 * swap's own `amount_in`) against `cap`.
 *
 * Curve (contract-identical):
 * ```text
 *   fee(t) = slope_low + (slope_high − slope_low) × (A^t − 1) / (A − 1)
 *   t      = (fill − threshold) / (PERCENT_SCALE − threshold) ∈ [0, 1]
 *   fill   = min(effective × PERCENT_SCALE / cap, PERCENT_SCALE)
 * ```
 * Returns `0` when disabled (`cap == 0`, `slopeHigh == 0`,
 * `threshold >= PERCENT_SCALE`) or fill is at/below the threshold.
 */
export function calcSurgeFeePct(
  effectiveSelloff: bigint,
  cap: bigint,
  thresholdPct: number,
  slopeLowPct: number,
  slopeHighPct: number,
): bigint {
  const slopeHigh = BigInt(slopeHighPct);
  if (cap === 0n || slopeHigh === 0n) return 0n;
  const thr = BigInt(thresholdPct);
  if (thr >= PERCENT_SCALE) return 0n;

  let fill = (effectiveSelloff * PERCENT_SCALE) / cap;
  if (fill > PERCENT_SCALE) fill = PERCENT_SCALE;
  if (fill <= thr) return 0n;

  // Normalized progress t ∈ (0, 1] in 1e18 fixed point.
  const tFp = ((fill - thr) * ONE) / (PERCENT_SCALE - thr);

  // A^t ∈ [ONE, A·ONE] via the shared LogExpMath port.
  const aPowT = powFp(SURGE_FEE_CONVEXITY_FP, tFp);

  // factor = (A^t − 1) / (A − 1) ∈ [0, ONE].
  const aMinusOne = SURGE_FEE_CONVEXITY_FP - ONE;
  let factor = ((aPowT > ONE ? aPowT - ONE : 0n) * ONE) / aMinusOne;
  if (factor > ONE) factor = ONE;

  // surge = slope_low + span × factor, span portion rounded UP.
  const slopeLow = BigInt(slopeLowPct);
  const span = slopeHigh > slopeLow ? slopeHigh - slopeLow : 0n;
  const prod = span * factor;
  const add = prod / ONE + (prod % ONE !== 0n ? 1n : 0n);
  const surge = slopeLow + add;
  return surge > PERCENT_SCALE ? PERCENT_SCALE : surge;
}

/**
 * Split a gross curve output into the surge fee and the NET amount the
 * user receives. Fee rounds UP (protective fee never undercharges) and is
 * capped at `amountOut` — mirrors `instructions/user/swap.rs`.
 */
export function applySurgeFee(
  amountOut: bigint,
  surgeFeePct: bigint,
): { fee: bigint; net: bigint } {
  if (surgeFeePct <= 0n || amountOut <= 0n) return { fee: 0n, net: amountOut };
  const num = amountOut * surgeFeePct;
  let fee = num / PERCENT_SCALE + (num % PERCENT_SCALE !== 0n ? 1n : 0n);
  if (fee > amountOut) fee = amountOut;
  return { fee, net: amountOut - fee };
}
