# Token Pair Chart — Frontend Integration Guide

## Overview

One endpoint for the range-picker charts on the pool creation page: the
price of one token expressed in another token, over time, as a single
line. Works for ANY two Solana mints — the backend has no notion of a
"base token"; which token goes on which side is purely the frontend's
choice.

No authentication required.

## Method

### `client.getTokenPairChart(a, b, range)`

`a` is the token being priced, `b` is the token it is priced in.
For a "SOL/USDT" chart: `a` = SOL mint, `b` = USDT mint — every point
is "how many USDT one SOL is worth at that moment".

```ts
const res = await client.getTokenPairChart(
  "So11111111111111111111111111111111111111112", // a = SOL
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // b = USDT
  "1w",
);
if (!res.ok) return;

const { current, change, series, granularitySec } = res.data;

// Header: "1,284.52 SOL/USDT  $345.44"
console.log(`${current.ratio} SOL/USDT`);   // big number
console.log(`$${current.aUsd}`);            // grey USD price of `a`

// The chart line: [unixSeconds, priceAinB] ascending
for (const [t, price] of series) {
  console.log(new Date(t * 1000).toISOString(), price);
}
```

**Returns:** `SdkResult<TokenPairChartResponse>`

## Rendering notes (matching the design)

- **One line only.** `series` is the green price line. The +% / −% range
  bounds and the dashed mid-line are frontend-drawn UI around the
  user's chosen range — the backend does not return them.
- **Header numbers:** `current.ratio` is the big "1,284.52" figure;
  `current.aUsd` is the grey dollar price next to it. `current.bUsd` is
  also provided if you need it.
- **Values can be tiny or huge.** A BONK/SOL chart lives around 1e-9,
  SOL/BONK around 1e9. Values come rounded to 6 significant digits —
  format with adaptive precision, not `toFixed(2)`.
- **`change.pct: null`** means the pair had no known price at the range
  start — render "—".

## Ranges and point counts

Point counts are deliberately small — the creation page fetches one
chart per pool token and refetches all of them when the user flips the
base token:

| Range | Step | Points |
|---|---|---|
| `1d` | 1 hour | 25 |
| `1w` | 6 hours | 29 |
| `1m` | 1 day | 31 |
| `1y` | 1 week | ~53 |
| `all` | 1 week | ~53 |

`all` is capped at one year: historical prices for arbitrary mints are
only available that far back. Read `granularitySec` rather than
assuming a step.

## Performance behaviour

- Price history is cached **per token** on the backend, shared across
  pairs and users. Charting all tokens of a pool against one base costs
  at most one upstream fetch per unique mint; flipping the base token
  reuses everything already cached. Warm responses are served from
  cache in milliseconds.
- Full responses are cached for 5 minutes per (a, b, range).
- The endpoint is rate-limited **per IP: 90 requests/min** (on top of
  the global API limits). A full creation-flow burst — 9 tokens ×
  several range flips — fits comfortably; hitting 429 means a runaway
  refetch loop on the frontend.

## Limitations

- A token with no known price history (e.g. a freshly launched token
  not yet tracked by price providers) charts as a flat line at its
  current price.
- A pair of two USD stablecoins (USDC/USDT) charts as a flat 1.0 —
  sub-0.1% stable wobble is not tracked.
- Points where either token's price is unknown carry the last known
  value forward instead of dipping to zero; if the pair has no known
  price at the range start, leading points are 0 until the first real
  price appears.

## Error handling

```ts
const res = await client.getTokenPairChart(a, b, "1d");
if (!res.ok) {
  // 400 — invalid mint address, or a === b
  // 429 — per-IP rate limit; back off, do not retry in a tight loop
}
```
