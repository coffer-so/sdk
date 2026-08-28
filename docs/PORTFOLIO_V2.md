# Portfolio v2 — Frontend Integration Guide

## Overview

Endpoints for the redesigned Portfolio page: the tabbed chart card
(Net Worth / PnL / IL–Profit / XP with period switcher) and the on-chain
activity feed (Recent Activity widget + full Activity page). The v1
methods (`docs/PORTFOLIO.md`) keep working unchanged — migrate at your own
pace. All v2 endpoints require authentication.

## Prerequisites

- User must be authenticated via SIWS (see `docs/SIWS.md`)
- `client.setTokens()` must be called before using these methods
- Unlike v1, v2 endpoints do NOT return 404 for wallets without positions —
  they return empty/zero data, so no special empty-state error handling

## Methods

### 1. Chart Card (`getPortfolioChart`)

One method feeds all four tabs; call it on tab/period switch.

```ts
const res = await client.getPortfolioChart("networth", "1w");
if (!res.ok) return;

const { current, change, series, granularitySec, approximate } = res.data;

// Headline
console.log(`NET WORTH $${current}`);
console.log(`${change.abs >= 0 ? "▲" : "▼"} $${Math.abs(change.abs)} ${change.pct}% past week`);

// Chart: series is [unixSeconds, value][] ascending
for (const [t, v] of series) {
  console.log(`${new Date(t * 1000).toISOString()}: $${v}`);
}
```

**Metrics:**

| Metric | Meaning | Value at point t |
|---|---|---|
| `networth` | Whole portfolio: wallet tokens + LP positions | Σ amount(t) × price(t) over every token |
| `pnl` | Profit/loss vs the DOLLARS invested | LP value(t) − entry-priced capital(t) |
| `il` | Fees earned vs impermanent loss (vs HODL, signed) | fees + IL + realized — same as v1 netPnl |
| `xp` | XP earned PER BUCKET (delta bars, not cumulative) | XP accrued inside that hour/day/month |

**`pnl` vs `il` — different benchmarks, both useful:** `pnl` answers
"how much did I make in dollars?" (includes the basket's market move),
`il` answers "was LPing better than just holding the tokens?" (market
move excluded).

**`pnl` fixation semantics:** every EXIT is a profit-fixation moment —
a withdrawal fixes `received USD − capital share`, a wallet transfer-out
fixes `amount × LP price at that moment − capital share`. Fixed profit
stays in the series (cumulative within the selected range), so the line
is CONTINUOUS at exits — profit moves from unrealized to realized
instead of vanishing. Deposits/zaps/received transfers move value and
capital together — no fake jumps on top-ups either.

**Ranges:** `"24h"`, `"1w"`, `"1m"`, `"1y"`, `"all"`. Point spacing comes
back in `granularitySec` (24h → 5 min, 1w/1m → hourly, 1y/all → daily; XP
buckets: hour for 24h, day for 1w/1m, month for 1y/all).

**XP tab specifics:** each point is the XP earned in that bucket — render
as bars. `current` is the LIFETIME XP total, `change.abs` is the XP earned
within the selected range.

**`approximate: true`** means part of the series is estimated (wallet
history coverage hit its cap or the history API was unavailable, so
amounts are frozen at the oldest known values; for `il` — LP events inside
the range). Optionally show a subtle "approximate" hint.

**`change.pct: null`** means the percentage is undefined — the range
started from a zero base (e.g. a wallet that was empty at range start,
XP from zero) or from a near-zero signed pnl/il base where a percentage
would be meaningless. Render it as "—"; `change.abs` is always present.

### 2. Activity Feed (`getPortfolioActivity`)

Paginated feed of the user's actions in Cube pools, newest first.

```ts
// Recent Activity widget — 4 latest events
const res = await client.getPortfolioActivity({ limit: 4 });

// Full Activity page — filter chips + pagination
const page2 = await client.getPortfolioActivity({
  page: 2,
  limit: 20,
  type: "liquidity",
});

if (res.ok) {
  const { total, page, limit, data } = res.data;
  for (const item of data) {
    console.log(item.type, new Date(item.time * 1000), item.valueUsd);
  }
}
```

**Filters (`type`):** `"all"` (default), `"liquidity"` (added + removed),
`"zap"`, `"swap"`, `"transfer"` (sent + received), `"deployed"`.

**Sorting:** `sort: "time" | "value"` (default `"time"`) +
`order: "desc" | "asc"` (default `"desc"`) — for the column sort arrows.
On `"value"` sort, rows without a USD value (`deployed`) always go last,
whatever the order.

**Rendering by `item.type`:**

| Type | Row example from the design | What to use |
|---|---|---|
| `added` / `removed` | `SOL / USDC · + Added · +$120.00` | `pool.tokens` icons, `pool.feePercent` subtitle, signed `valueUsd` |
| `swap` | `USDC → SOL · Swap · $50.00` | `swap.tokenIn` / `swap.tokenOut` (mint, symbol, logo); subtitle "via Cube router" is static frontend text |
| `zap` | `USDC / USDT · ⚡ Zap in · +$80.00` | like `added`; asset count = `pool.tokens.length` |
| `sent` / `received` | `USDC / USDT · ↗ Sent · −$500.00` | `transfer.counterparty` for the `→ 4nPz…3xLm` subtitle; `valueUsd` is priced at the HISTORICAL LP-token price of the transfer moment |
| `deployed` | `CUBE / USDC · ◇ Deployed` | `pool.weights` for the "80/20 weights" subtitle; `valueUsd` is `null` by design (the seed deposit shows up as its own `added` row) |

Every row links to the transaction via `signature`. There is NO `fees`
event type: LP fees auto-reinvest continuously on every swap (no claim
transaction exists on-chain) — fee earnings live in the `il` chart tab and
the per-pool table instead.

### 3. Token Holdings (`getPortfolioHoldings`)

Every token the user holds. LP positions are shown DECOMPOSED into their
underlying tokens — the per-pool share of pool balances the user would
receive on withdrawal — not as LP tokens (those are never listed).

```ts
// Widget — 4 rows, most valuable first (default sort)
const res = await client.getPortfolioHoldings({ limit: 4 });

// Full table with column sorting
const byBalance = await client.getPortfolioHoldings({
  page: 1,
  limit: 10,
  sort: "balance",
  order: "asc",
});

if (res.ok) {
  console.log(`${res.data.total} assets`);
  for (const h of res.data.data) {
    console.log(`${h.token.symbol} (${h.token.name}): $${h.priceUsd}`);
    console.log(`  balance ${h.balance} = $${h.valueUsd}`);
  }
}
```

**Rendering the SOURCE column** from `sources`:

```ts
const { wallet, pools } = holding.sources;

if (pools.length === 0) {
  // "Wallet" badge
} else if (wallet.pct === 0) {
  // "LP in pools" badge
} else {
  // Progress bar segments: [wallet.pct, ...pools.map(p => p.pct)]
  // Label under the bar = the LARGEST pct of the breakdown (designer's
  // note), e.g. "70% LP" when pools sum to 70%
}

// Source Breakdown tooltip rows:
console.log(`Wallet ${wallet.pct}%`);
for (const p of pools) {
  console.log(`${p.poolName} ${p.pct}%`); // link via p.poolAddress
}
```

**Sorting:** `sort: "value" | "price" | "balance"` (default `"value"`),
`order` default `"desc"`. Asset count for the header = `total`. Dust
below $0.01 is filtered out server-side.

### 4. Position Pools (`getPortfolioPositions`)

The user's ACTIVE LP positions with per-pool metrics. The expandable row
content (Impermanent Loss / Fees Earned / Net PnL cards) uses the same
fields — no extra request needed.

```ts
const res = await client.getPortfolioPositions({ limit: 20 });
if (res.ok) {
  const { total, totalValueUsd, data } = res.data;

  // Header: "2 active positions" + "$593.70"
  console.log(`${total} active positions, $${totalValueUsd}`);

  for (const p of data) {
    console.log(`${p.pool.name} (${p.pool.feePercent}% fee)`);
    console.log(`  value $${p.valueUsd}, fees +$${p.feesEarned}`);
    console.log(`  IL $${p.il}, realized $${p.ilRealized}`);
    console.log(`  Net PnL $${p.netPnl}, APY ${p.apy}%`);
  }
}
```

**Notes:**
- Only ACTIVE positions are listed (wallet BPT > 0). Past/closed
  positions live in the v1 `getPortfolioPools()`.
- `totalValueUsd` covers ALL active positions regardless of pagination —
  safe for the header.
- A freshly received (transferred-in) position appears within ~30 s with
  its real `valueUsd` and zeroed metrics; fees/IL/APY fill in
  automatically once the backend builds its snapshot (seconds later).
- `netPnl = feesEarned + il + ilRealized`; `il` is ≤ 0 by definition.

**Sorting:** `sort: "value" | "fees" | "il" | "pnl" | "apy"` (default
`"value"`), `order` default `"desc"`.

## Data Freshness

| Data | Freshness |
|---|---|
| Chart response | Cached 90 s per (wallet, metric, range) |
| Price series behind networth/pnl | Shared across users, cached 10 min |
| Activity feed | Cached 30 s per wallet |
| Token holdings | Cached 30 s per wallet (wallet balances 30 s, pool state ≤5 min) |
| Position pools | Cached 30 s per wallet (values from wallet BPT, IL live-priced) |
| New indexed events (swap/liquidity/zap) | Appear seconds after the transaction (webhook) |
| LP token transfers | Fetched from wallet history on demand |

## API Reference

### `client.getPortfolioChart(metric, range)`
Series for the chart card tabs. Requires auth.
**Returns:** `SdkResult<PortfolioChartResponse>`

### `client.getPortfolioActivity(options?)`
Activity feed; `options = { page? = 1, limit? = 20, type? = "all",
sort? = "time", order? = "desc" }`. Requires auth.
**Returns:** `SdkResult<PortfolioActivityResponse>`

### `client.getPortfolioHoldings(options?)`
Token holdings with LP positions decomposed; `options = { page? = 1,
limit? = 20, sort? = "value", order? = "desc" }`. Requires auth.
**Returns:** `SdkResult<PortfolioHoldingsResponse>`

### `client.getPortfolioPositions(options?)`
Active LP positions with per-pool metrics; `options = { page? = 1,
limit? = 20, sort? = "value", order? = "desc" }`. Requires auth.
**Returns:** `SdkResult<PortfolioPositionsResponse>`

## Error Handling

```ts
const res = await client.getPortfolioChart("networth", "24h");
if (!res.ok) {
  if (res.error.humanMessage.includes("401")) {
    // Not authenticated — redirect to connect wallet
  }
  // Empty wallets return zero series, not 404 — no special casing needed
}
```
