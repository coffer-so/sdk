# Pool Chart — Frontend Integration Guide

## Overview

One endpoint behind the chart card on the pool page: a historical series
for a single pool — APY, TVL, traded volume or fees collected.

No authentication required.

## Method

### `client.getPoolChart(poolAddress, options?)`

```ts
const res = await client.getPoolChart("6NjpZAqu5BHnNf9xMKgesVS6WBGE4ZLT8DvrdsGCjLg5", {
  metric: "apy",   // "apy" (default) | "tvl" | "volume" | "fees"
  range: "1m",     // "1m" (default) | "6m" | "1y" | "all"  ("24h" | "1w" still accepted)
  basis: "7d",     // "7d" (default) | "24h" — APY only
});
if (!res.ok) return;           // res.error.humanMessage is safe to render
const { current, change, points, granularitySec } = res.data;
```

## Response

```ts
{
  poolAddress: string;
  metric: "apy" | "tvl" | "volume" | "fees";
  range: "24h" | "1w" | "1m" | "6m" | "1y" | "all";
  granularitySec: number;       // spacing between points
  basis?: "24h" | "7d";         // present for apy only
  current: number;              // latest value — the headline
  change: { abs: number; pct: number | null };
  points: Array<{ t: number; v: number }>;  // t = unix MILLISECONDS
}
```

### Units

| metric | `v` and `current` are | Notes |
| --- | --- | --- |
| `apy` | percent (`4.2` = 4.2%) | compounded, see below |
| `tvl` | USD | pool value at that moment |
| `volume` | USD | traded volume within the point's interval |
| `fees` | USD | total fees (LP + protocol share) within the interval |

`tvl` is a level (a snapshot at each point); `volume` and `fees` are flows
(the amount accumulated inside each interval), so their values scale with
`granularitySec` — do not compare points across ranges.

## Rendering notes

**Use `current`, not `points.at(-1)`.** They agree today, but `current` is
the value the backend considers headline; reading the array yourself is
how a chart and its own title drift apart.

**`change.pct` is `null`** when the range starts at zero — a pool with no
activity at the beginning of the window. Render "—", not `Infinity` or
`NaN`. `change.abs` is still meaningful in that case.

**`t` is milliseconds** (unlike the pair chart, which uses seconds) — it
feeds `new Date(t)` directly.

**Point count is stable** at roughly 150 per range: the backend picks the
grid step to fit that budget, so a 24h chart and an all-time chart cost
about the same to fetch and draw. `granularitySec` tells you the actual
spacing — use it for axis labels rather than assuming a step.

## APY specifics

The APY series uses the same compounded formula as the pool card
(`(1 + fees/TVL)^365 − 1` — LP fees auto-reinvest into the pool, so
compounding is what actually happens).

`basis` controls the rolling window the fees are summed over at each point:

- `"7d"` (default) — fees over the trailing 7 days, averaged to a daily
  rate before compounding. This is the smoothed line the pool page shows;
  its trailing point equals `Pool.apy7d` (the number DefiLlama displays as
  `apyBase7d`).
- `"24h"` — fees over the trailing day. Reacts fast: a single large swap
  produces a one-day plateau and quiet days read `0`. Its trailing point
  equals the pool card headline `Pool.apy`.

Because the default is the 7-day basis, the chart's headline `current`
reads differently from the card's 24h APY next to it — that is expected;
pass `basis: "24h"` if the two must match.

Pools below a small TVL floor report `0` rather than a six-digit APY: on a
pool holding a few dollars the ratio is real but meaningless, and one such
series flattens every other pool on a shared axis.

## Ranges

`1m` (default), `6m`, `1y`, `all`. `1y` is the last 365 days; `all` is the
pool's whole indexed history but **never shorter than a year** — a pool
younger than a year gets a year-wide chart with an empty left part, the
same rule the portfolio chart follows. `24h` and `1w` remain accepted for
older UIs but are no longer offered on the pool page.

## Freshness and cost

Points come from 10-minute statistics buckets, so the trailing point is at
most one bucket behind live. Responses are cached server-side for two
minutes — polling more often than that returns the same payload and costs
nothing extra. There is no per-user rate limit beyond the global one.

## Empty pools

A pool with no indexed activity in the range returns `points: []`,
`current: 0`, `change.pct: null`. Show an empty state rather than an error
— it is a valid answer, not a failure.
