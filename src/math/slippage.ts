import { SLIPPAGE_PRECISION, SWAP_FEE_PRECISION, PROTOCOL_FEE_PRECISION, MAX_SWAP_FEE_RATE, MAX_PROTOCOL_FEE_RATE } from "../config";
import { assertInteger, assertU64 } from "./fixedPoint";
export function applySlippage(expected: bigint, slippageHbps: number): bigint {
    assertU64(expected);
    assertInteger(slippageHbps, 0, SLIPPAGE_PRECISION, "slippage");
    return expected * BigInt(SLIPPAGE_PRECISION - slippageHbps) / BigInt(SLIPPAGE_PRECISION);
}
function ceilRatio(amount: bigint, rate: number, scale: number): bigint {
    const numerator = amount * BigInt(rate), denominator = BigInt(scale);
    return numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
}
/** Base fee rounds UP, exactly as swap.rs. Rate is in hundredths of bps. */
export function calculateSwapFee(amount: bigint, swapFeeRate: number): bigint {
    assertU64(amount);
    assertInteger(swapFeeRate, 0, MAX_SWAP_FEE_RATE, "swap fee");
    return assertU64(ceilRatio(amount, swapFeeRate, SWAP_FEE_PRECISION));
}
/** Protocol share of the input fee also rounds UP. Rate is in basis points. */
export function calculateProtocolFee(fee: bigint, protocolFeeRate: number): bigint {
    assertU64(fee);
    assertInteger(protocolFeeRate, 0, MAX_PROTOCOL_FEE_RATE, "protocol fee");
    return assertU64(ceilRatio(fee, protocolFeeRate, PROTOCOL_FEE_PRECISION));
}
export function applySwapFee(amount: bigint, swapFeeRate: number): bigint {
    return amount - calculateSwapFee(amount, swapFeeRate);
}
/** Stored actual balances already exclude protocol fees. The third argument is retained for compatibility. */
export function lpBalances(actual: bigint, virtualBal: bigint, _protocolFeesOwed?: bigint): {
    lpActual: bigint;
    lpVirtual: bigint;
} {
    return { lpActual: assertU64(actual), lpVirtual: assertU64(virtualBal) };
}
export function priceImpactHbps(spot: bigint, actual: bigint): number {
    if (spot <= 0n || actual >= spot)
        return 0;
    return Number((spot - actual) * BigInt(SLIPPAGE_PRECISION) / spot);
}
