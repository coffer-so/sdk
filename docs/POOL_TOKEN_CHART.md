# Pool Token Chart — Frontend Integration Guide

## Overview

Every token of an existing pool, priced in that pool's **base token**,
together with the curve bounds the price-range slider shows. This is the
data behind the composition table on the pool page.

Use this rather than [the generic pair chart](PAIR_CHART.md) whenever the
pool already exists: there, the caller picks both sides of the pair; here
the pool fixes them, so the base is resolved server-side and each row
arrives correctly paired.

No authentication required.

## Method

### `client.getPoolTokenChart(poolAddress, options?)`

```ts
// Whole composition table in one call.
const res = await client.getPoolTokenChart(poolAddress, { range: "1m" });

// Just one row (e.g. the one the user expanded).
const one = await client.getPoolTokenChart(poolAddress, {
  range: "1m",
  token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
});
```

Ranges are the same as the pair chart: `1d | 1w | 1m | 1y | all`
(default `1m`).

## Response

```ts
{
  poolAddress: string;
  range: PairChartRange;
  granularitySec: number;            // 0 when nothing is charted
  base: { mint: string; symbol: string | null };
  tokens: Array<{
    mint: string;
    symbol: string | null;
    orderIndex: number;              // base token is 0
    weight: number;                  // percent, e.g. 33.33
    bounds: { min: number; spot: number; max: number | null } | null;
    currentRatio: number;            // base units per 1 token
    change: { abs: number; pct: number | null };
    series: Array<[number, number]>; // [unixSeconds, ratio]
  }>;
}
```

`tokens` is ordered by `orderIndex`, matching the pool's own token order,
so it maps straight onto the composition rows.

## The base token

A pool has no on-chain "base token" field — the convention is **its first
token** (`orderIndex === 0`), and the backend applies it so every consumer
agrees. It is returned as `base` and is also present in `tokens` for
ordering, with:

- `currentRatio: 1` — its price in its own units,
- `series: []` — a flat line at 1 carries no information,
- `bounds: null` — there is nothing to quote it against.

Render that row as the "BASE" badge, not as a chart.

## Price bounds — these move

`bounds` are the floor and ceiling of the AMM curve for that token against
the base, with the current `spot` in between. They are **derived from live
virtual/actual balances, not stored settings**: every swap shifts them.

Do not cache them as pool configuration or present them as a choice the
creator made — a creator only influences them indirectly, through
leverage. `null` means the pair has no usable state (a drained or unseeded
side); render "—" rather than zeros.

## Rendering notes

**`series` timestamps are SECONDS** (the pair chart's convention), unlike
the [pool APY/TVL chart](POOL_CHART.md), whose points are in
milliseconds. Multiply by 1000 before `new Date()`.

**Ratios are rounded to 6 significant digits**, not to a fixed number of
decimals — pairs span from ~1e-9 (BONK/SOL) to ~1e9 (SOL/BONK), and
`toFixed(2)` would flatten one end to zeros. Format relative to the
value's own magnitude.

**`change.pct` is null** when the range starts from an unknown price —
show "—", not `Infinity`.

**Gaps carry forward.** A token younger than the range, or a hole in the
price feed, repeats the last known ratio instead of dropping to zero, so
the line has no fake cliffs.

## Cost

One call covers the whole pool: the USD price series behind each token are
cached per mint and shared with every other chart, so a pool of N tokens
costs at most N−1 cross-rate computations over cached data, not N upstream
fetches. Responses are cached for five minutes.

Rate limiting is per IP (90 requests/minute), charged **once per call**
rather than once per token — so fetching the whole table is cheaper than
looping `getTokenPairChart` yourself, which is the other reason to prefer
this endpoint.
