import {ONE, assertU64, assertInteger, assertU128, mulDivDown, weightToFp} from "./fixedPoint";
import {powFp} from "./logExp";
import { MAX_WEIGHT, MIN_WEIGHT, WEIGHT_SCALE } from "../config";

/**
 * Validate a weight vector. Must sum exactly to 10_000 (WEIGHT_SCALE) and
 * every entry must be in [MIN_WEIGHT, MAX_WEIGHT].
 */
export function validateWeights(weights: number[]): void {
  if (!Array.isArray(weights) || weights.length < 2) {
    throw new Error("weightedMath: at least 2 weights required");
  }
  let sum = 0;
  for (const w of weights) {
    if (!Number.isInteger(w)) {
      throw new Error("weightedMath: weights must be integers (bps)");
    }
    if (w < MIN_WEIGHT || w > MAX_WEIGHT) {
      throw new Error(`weightedMath: weight ${w} out of [${MIN_WEIGHT}, ${MAX_WEIGHT}]`);
    }
    sum += w;
  }
  if (sum !== WEIGHT_SCALE) {
    throw new Error(`weightedMath: weights sum to ${sum}, expected ${WEIGHT_SCALE}`);
  }
}

/**
 * Weighted spot price of token_out priced in token_in, normalised to 18
 * decimals. Used only for display; on-chain quoting uses calcOutGivenIn.
 */
export function calcSpotPrice(params: {
  balanceIn: bigint;
  weightInBps: bigint;
  balanceOut: bigint;
  weightOutBps: bigint;
  decimalsIn: number;
  decimalsOut: number;
}): bigint {
  const { balanceIn, weightInBps, balanceOut, weightOutBps, decimalsIn, decimalsOut } = params;
  const scaleIn = 10n ** BigInt(18 - decimalsIn);
  const scaleOut = 10n ** BigInt(18 - decimalsOut);
  const bI = balanceIn * scaleIn;
  const bO = balanceOut * scaleOut;
  if (bO === 0n || weightOutBps === 0n) return 0n;
  // price = (bI / wI) / (bO / wO)
  const numer = bI * weightOutBps * 10n ** 18n;
  const denom = bO * weightInBps;
  return numer / denom;
}

/** Exact seed-deposit invariant from weighted_math.rs; returns raw BPT before u64/minimum-supply checks. */
export function calculateInvariant(balances:bigint[], normalizedWeights:number[], decimals:number[]):bigint {
  if(balances.length!==normalizedWeights.length||balances.length!==decimals.length||balances.length<2)throw new Error("invariant: invalid vector lengths");
  let invariant=ONE;
  for(let i=0;i<balances.length;i++) {
    const raw=assertU64(balances[i]);assertInteger(decimals[i],0,18,"decimals");assertInteger(normalizedWeights[i],0,10000,"weight");
    if(raw===0n)return 0n;
    const balance=decimals[i]>=6?raw/(10n**BigInt(decimals[i]-6)):assertU128(raw*10n**BigInt(6-decimals[i]));
    if(balance===0n)return 0n;
    invariant=mulDivDown(invariant,powFp(balance,weightToFp(normalizedWeights[i])),ONE);
  }
  return invariant;
}
