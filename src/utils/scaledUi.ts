import type { ScaledUiAmountConfig } from '../parsers/mintAccount';
const U64_MAX = 0xffff_ffff_ffff_ffffn;
/** Use the quote's cluster Clock time; never wall-clock time. Re-quote at activation. */
export function effectiveScaledUiMultiplier(config: ScaledUiAmountConfig | null, unixTimestamp: bigint): number {
  if (!config) return 1;
  const value = unixTimestamp >= config.newMultiplierEffectiveTimestamp ? config.newMultiplier : config.multiplier;
  if (!Number.isFinite(value) || value < 2.2250738585072014e-308) throw new RangeError('Invalid ScaledUI multiplier');
  return value;
}
/** Exact rational value of the stored IEEE754 multiplier. Raw balances never become Number. */
function ratio(value: number): [bigint, bigint] {
  const bytes = new ArrayBuffer(8); const view = new DataView(bytes); view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false), exponent = Number((bits >> 52n) & 2047n);
  let numerator = (bits & ((1n << 52n) - 1n)) | (exponent ? 1n << 52n : 0n);
  const shift = (exponent || 1) - 1023 - 52;
  return shift >= 0 ? [numerator << BigInt(shift), 1n] : [numerator, 1n << BigInt(-shift)];
}
function places(n: number): void { if (!Number.isInteger(n) || n < 0 || n > 255) throw new RangeError('Invalid decimal places'); }
function decimal(value: string): [bigint, bigint] {
  if (value.length > 1024 || !/^\d+(\.\d+)?$/.test(value)) throw new RangeError('Expected nonnegative decimal string');
  const [whole, fraction = ''] = value.split('.'); return [BigInt(whole + fraction), 10n ** BigInt(fraction.length)];
}
function format(value: bigint, decimals: number): string {
  if (!decimals) return value.toString(); const text = value.toString().padStart(decimals + 1, '0');
  return (text.slice(0, -decimals) + '.' + text.slice(-decimals)).replace(/\.?0+$/, '') || '0';
}
/** Exact-rational display, truncated to mint decimals. RPC/Token2022 float
 * amountToUiAmount may differ in its last digits for huge balances; this
 * helper deliberately preserves integers instead of replicating f64 loss. */
export function rawAmountToScaledUiString(raw: bigint, decimals: number, config: ScaledUiAmountConfig | null, unixTimestamp: bigint): string {
  places(decimals); if (raw < 0n || raw > U64_MAX) throw new RangeError('Raw amount outside u64');
  const [n, d] = ratio(effectiveScaledUiMultiplier(config, unixTimestamp)); return format(raw * n / d, decimals);
}
/** Floor UI input to raw units; no multiplier is applied in AMM/LP math. */
export function scaledUiAmountToRaw(ui: string, decimals: number, config: ScaledUiAmountConfig | null, unixTimestamp: bigint): bigint {
  places(decimals); const [a, b] = decimal(ui), [n, d] = ratio(effectiveScaledUiMultiplier(config, unixTimestamp));
  const raw = a * 10n ** BigInt(decimals) * d / (b * n); if (raw > U64_MAX) throw new RangeError('Raw amount outside u64'); return raw;
}
/** Price per displayed token → price per unscaled whole token (10^decimals raw units). */
export function scaledUiPriceToUnscaledPrice(price: string, config: ScaledUiAmountConfig | null, unixTimestamp: bigint, precision = 18): string {
  places(precision); const [a,b] = decimal(price), [n,d] = ratio(effectiveScaledUiMultiplier(config, unixTimestamp));
  return format(a * n * 10n ** BigInt(precision) / (b * d), precision);
}
/** Unscaled whole-token price → displayed-token price; apply once at the UI boundary. */
export function unscaledPriceToScaledUiPrice(price: string, config: ScaledUiAmountConfig | null, unixTimestamp: bigint, precision = 18): string {
  places(precision); const [a,b] = decimal(price), [n,d] = ratio(effectiveScaledUiMultiplier(config, unixTimestamp));
  return format(a * d * 10n ** BigInt(precision) / (b * n), precision);
}
