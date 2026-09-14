# Pool Page Charts — Integration Guide

Two endpoints feed the charts on a pool page. They answer different
questions and are fetched differently, so this guide covers both together.

| What | Method | Detail |
|---|---|---|
| Pool performance over time (APY, TVL, volume, fees) | `getPoolChart` | [POOL_CHART.md](POOL_CHART.md) |
| Each token's price against the pool's base token, plus range bounds | `getPoolTokenChart` | [POOL_TOKEN_CHART.md](POOL_TOKEN_CHART.md) |

Both are public — no authentication.

## 1. The performance chart

The card under the pool's stats sidebar: one line, switchable between
metrics.

```ts
const res = await client.getPoolChart(poolAddress, {
  metric: "apy",   // "apy" | "tvl" | "volume" | "fees"
  range: "1m",     // "24h" | "1w" | "1m" | "1y" | "all"
});
if (!res.ok) return;
const { current, change, points } = res.data;
```

Render `current` as the headline rather than reading `points.at(-1)`, and
show "—" when `change.pct` is `null` (the range started at zero).

**The default APY series matches the APY number in the sidebar.** Both use
the same compounded 24-hour formula, so the chart and the figure above it
agree without any reconciliation on your side. `basis: "7d"` gives a
smoother line but will read differently from that number — only use it
where the number is not shown next to the chart.

## 2. The token price charts (composition rows)

Every token of the pool priced in the pool's base token, plus the bounds
behind each row's price-range slider:

```ts
const res = await client.getPoolTokenChart(poolAddress, { range: "1m" });
if (!res.ok) return;
for (const t of res.data.tokens) {
  if (t.mint === res.data.base.mint) continue;   // base row: badge, no chart
  renderRow(t.symbol, t.bounds, t.currentRatio, t.series);
}
```

One call returns the whole table. Pass `token` to refresh a single row.

### Price bounds are live state, not settings

`bounds.min` / `spot` / `max` come from the pool's current virtual and
actual balances — **they move with every swap**. They are not a
configuration the creator chose and must not be cached as pool metadata.
A creator influences them only indirectly, through leverage.

`bounds: null` means there is nothing meaningful to show (the base token
itself, or a drained side) — render "—".

## How to fetch these alongside the token table

**Fetch them separately, after the table renders.** Concretely: render the
composition rows from the pool state you already have, then load
`getPoolTokenChart` and fill in the charts and bounds as they arrive.

The reason is that the two sources have different lifetimes. The token
table is read straight from the chain and refreshes on its own cadence;
these series come from indexed price history and are cached server-side
for minutes. Blocking the table on the charts would make an
always-available table wait on data that is, by design, slightly stale —
and a price-feed hiccup would take the whole composition panel down with
it.

Two consequences worth designing for:

- **Charts are progressive, not required.** A row must be complete and
  useful with `series` still loading. Reserve the space, show a skeleton
  in it, and never gate the row's own numbers (weight, balances,
  leverage) on the chart request.
- **Fetch the table once, not per row.** Call `getPoolTokenChart` without
  `token` on mount: it returns every row in one request, shares the
  cached per-mint price series between them, and is charged once against
  the per-IP limit. Looping `getTokenPairChart` per token costs N requests
  and N limiter hits for the same data. Keep `token` for refreshing one
  expanded row.

### Bounds without waiting

If you already decode pool state on the client, the bounds are derivable
from it — the backend computes them from exactly the same inputs
(virtual/actual balances, weights, decimals). Using the endpoint's
`bounds` keeps one implementation of that maths behind the API, which is
why it is returned here; deriving them locally is a reasonable trade if
you want the slider filled on first paint, with the response as the
source of truth once it lands. Do not mix the two in one render — pick
one per surface, or the slider will jump.

## Point counts and timing

Both endpoints return comparable detail, so two cards on one screen look
consistent:

Both take the same range vocabulary (`24h | 1w | 1m | 1y | all`):

| Range | `getPoolChart` | `getPoolTokenChart` |
|---|---|---|
| `24h` | ~145 | 49 |
| `1w` | ~85 | 85 |
| `1m` | ~121 | 121 |
| `1y` | ~122 | ~122 |
| `all` | ~122 | ~122 |

Read `granularitySec` for axis labels instead of assuming a step.

**Timestamp units differ** — this is the most common mistake when wiring
both on one page:

- `getPoolChart` → `points[].t` in **milliseconds** (`new Date(t)`)
- `getPoolTokenChart` → `series[i][0]` in **seconds** (`new Date(t * 1000)`)

Typical latency is well under a second, and responses are cached
server-side (two minutes for the performance chart, five for the token
charts), so re-fetching on range switches is cheap.
