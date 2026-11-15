# Portfolio v2 — Frontend Integration Guide

**Version scope:** this guide describes the SDK-declared interface. The matching
routes are absent from checked local backend `v5.1@a886497`; verify your deployed
server before using them. Response/freshness/empty-state details below are
interface expectations, not verified runtime guarantees. See
[backend compatibility](BACKEND_COMPATIBILITY.md).

## Overview

Endpoints for the redesigned Portfolio page: the tabbed chart card
(Net Worth / PnL / IL–Profit / XP with period switcher) and the on-chain
activity feed (Recent Activity widget + full Activity page). The v1
methods are described in [Portfolio](PORTFOLIO.md). Do not enable v2 until your
server implements its routes. The declared v2 flow uses authentication.

Since 1.4.8 the same four views can be read for ANY wallet without
authentication — the profile page; see
[Public portfolio of any wallet](#public-portfolio-of-any-wallet).

## Prerequisites

- User must be authenticated via SIWS (see `docs/SIWS.md`)
- `client.setTokens()` must be called before using these methods
- Unlike v1, v2 endpoints do NOT return 404 for wallets without positions —
  they return empty/zero data, so no special empty-state error handling
- The `getPublicPortfolio*` twins need none of this: no SIWS, no tokens

## Methods

### 1. Chart Card (`getPortfolioChart`)

One method feeds all four tabs; call it on tab/period switch. Most tabs
return one line in `series`; the **IL tab returns two lines** in `lines`
and no `series` — handle both shapes.

```ts
const res = await client.getPortfolioChart("networth", "1w");
if (!res.ok) return;

const { current, change, series, lines, granularitySec, approximate } = res.data;

// Headline (same for every metric)
console.log(`NET WORTH $${current}`);
console.log(`${change.abs >= 0 ? "▲" : "▼"} $${Math.abs(change.abs)} ${change.pct ?? "—"}% past week`);

// Single-line metrics (networth / pnl / xp): draw `series`
for (const [t, v] of series ?? []) {
  console.log(`${new Date(t * 1000).toISOString()}: $${v}`);
}

// IL metric: draw the two lines from `lines` (both are POSITIVE)
if (lines) {
  drawLine(lines.profit, "green"); // cumulative fees, ≥ 0
  drawLine(lines.il, "red");       // impermanent loss magnitude, ≥ 0
}
```

**Action markers (`pnl` / `il` only).** `markers` lists the user's actions
on the charted position(s) — liquidity added, zapped in, removed, LP tokens
sent / received — to draw on the chart (on the line, under it, in a lane:
your call). Guarantees: every `marker.t` **is a point** of `series` /
`lines` (the grid gets a point per marker, so the line bends exactly where
the action happened — look the Y value up by `t`, no interpolation);
actions closer than one grid step share a marker (`events` lists them, the
tooltip shows all); actions under $1 are left out; the points are no longer
strictly evenly spaced, so pick axis ticks from the regular points, not by
index. `networth` / `xp` have no `markers`.

```ts
const il = await client.getPortfolioChart("il", "1y");
if (il.ok) {
  for (const marker of il.data.markers ?? []) {
    const y = il.data.lines!.il.find(([t]) => t === marker.t)![1]; // always found
    const label =
      marker.events.length === 1
        ? describe(marker.events[0]) // "Removed $500 from 3crypto"
        : `${marker.events.length} actions`;
    drawMarker(marker.t, y, label, () => {
      const sig = marker.events[0].signature;
      if (sig) openActivity(sig); // → getPortfolioActivity({ highlight: sig })
    });
  }
}

function describe(e: PortfolioChartEvent): string {
  const usd = e.usd === null ? "" : ` $${Math.abs(e.usd)}`;
  switch (e.type) {
    case "added":    return `Added${usd} to ${e.pool.name}`;
    case "zap":      return `Zapped${usd} into ${e.pool.name}`;
    case "removed":  return `Removed${usd} from ${e.pool.name}`;
    case "sent":     return `Sent LP${usd && " worth" + usd} from ${e.pool.name}`;
    case "received": return `Received LP${usd && " worth" + usd} in ${e.pool.name}`;
  }
}
```

**Metrics:**

| Metric | Shape | Meaning | Value at point t |
|---|---|---|---|
| `networth` | `series` | Whole portfolio: wallet tokens + LP positions | Σ amount(t) × price(t) over every token |
| `pnl` | `series` | Profit/loss vs the DOLLARS invested | LP value(t) − entry-priced capital(t) + fixations |
| `il` | `lines` | Fees earned vs impermanent loss (vs HODL) | two lines — see below |
| `xp` | `series` | Total XP as of each point (cumulative) | lifetime XP up to t, never decreasing |

**`pnl` vs `il` — different benchmarks, both useful:** `pnl` answers
"how much did I make in dollars?" (includes the basket's market move),
`il` answers "was LPing better than just holding the tokens?" (market
move excluded).

**`pnl` fixation semantics:** every EXIT is a profit-fixation moment —
a withdrawal fixes `received USD − capital share`, a wallet transfer-out
fixes `amount × LP price at that moment − capital share`. Fixed profit
stays in the series (every past fixation, not only the range's — the
line is a LIFETIME level and a month is a zoomed slice of the year), so the line
is CONTINUOUS at exits — profit moves from unrealized to realized
instead of vanishing. Deposits/zaps/received transfers move value and
capital together — no fake jumps on top-ups either. A position that was
fully closed inside the range still shows its whole trajectory and the
profit it locked in (not a flat zero).

**`il` two lines (LIFETIME levels):** `lines.profit` is the LP fees the
positions earned since their first deposit, as of each point (≥ 0, draw
green); `lines.il` is the impermanent loss as a POSITIVE magnitude (≥ 0,
draw red — the red colour already conveys "loss", so no minus sign): the
divergence locked by every past withdrawal plus the open position's, as
of each point. Both on the same grid, and the selected range only changes
which slice you see — a month is a zoomed piece of the year. IL is evaluated at every
point from historical prices: the HODL value of the deposited basket minus
the position's value with its reinvested fees taken out — the same formula
the positions table uses for its `il` column, so the last point of the red
line matches the table and fees are never counted twice. Divergence locked
in by a withdrawal stays on the line forever. Reading the gap between the
lines is the point — when green outweighs red, LPing beat holding.
`current` is the lifetime NET (`profit − il` at the last point, the bottom
line vs HODL) and `change` is how much that net moved over the selected
range — the same split as `xp`. There is no `series` for this metric.

**`xp` is cumulative:** each point is the user's total XP as of that
moment — a monotonic, never-decreasing line (draw as an area/line, not
bars). `current` is the lifetime total (the last point), `change.abs` is
the XP earned within the selected range.

**Ranges:** `"24h"`, `"1w"`, `"1m"`, `"1y"`, `"all"`. Point spacing comes
back in `granularitySec`. Every range returns roughly the same number of
points (~50–60): 24h → 30 min, 1w → 3 h, 1m → 12 h, 1y → 1 week; `all`
picks an adaptive step (1 d … 30 d) that keeps the grid under ~64 points
however long the user's history is. Always read `granularitySec` rather
than assuming a step.
`"all"` is floored at one year, so it is never a shorter window than
`"1y"` even for a user whose first activity was recent.

**`approximate: true`** means part of the data is estimated (wallet
history coverage hit its cap or the history API was unavailable, so
amounts are frozen at the oldest known values; for `pnl` — a position
that predates the range and was fully closed inside it; for `il` — a
basis token with no price history (valued flat at today's price), a
position snapshot older than an LP event, an exit that could not be
priced, or pre-range history that could not be reconstructed exactly; for
`pnl` and `il` — the backend's stored LP history has not caught up with the
wallet's last deposit or withdrawal yet, usually for under a minute, during
which the chart can be off by about that transaction).
Optionally show a subtle "approximate" hint.

**`change.pct: null`** means the percentage is undefined — the range
started from a zero base (e.g. a wallet that was empty at range start,
XP from zero), from a near-zero signed pnl/net-il base, or the value
CROSSED ZERO over the range (e.g. net IL was −$560 early and +$1,193
late — a "%" off a sign-flipping base is meaningless). Render it as "—";
`change.abs` is always present.

### 2. Activity Feed (`getPortfolioActivity`)

Paginated feed of the user's actions in Coffer pools, newest first.

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

**Landing on a transaction (`highlight`):** a chart marker click carries a
signature; pass it as `highlight` and the backend answers with the page
that contains that transaction under the current filter / sort (`page` is
ignored) — read the served page from `page`, the row from
`highlight.index`, and flash every row whose `signature` matches (one
transaction with several LP instructions has several rows). Unknown
signature (e.g. filtered out by `type`) → the requested page and
`highlight: null`.

```ts
const res = await client.getPortfolioActivity({ highlight: sig, limit: 20 });
if (res.ok) {
  setPage(res.data.page);
  if (res.data.highlight) scrollTo(res.data.highlight.index);
}
```

**Rendering by `item.type`:**

| Type | Row example from the design | What to use |
|---|---|---|
| `added` / `removed` | `SOL / USDC · + Added · +$120.00` | `pool.tokens` icons, `pool.feePercent` subtitle, signed `valueUsd` |
| `swap` | `USDC → SOL · Swap · $50.00` | `swap.tokenIn` / `swap.tokenOut` (mint, symbol, logo); subtitle "via Coffer router" is static frontend text |
| `zap` | `USDC / USDT · ⚡ Zap in · +$80.00` | like `added`; asset count = `pool.tokens.length` |
| `sent` / `received` | `USDC / USDT · ↗ Sent · −$500.00` | `transfer.counterparty` for the `→ 4nPz…3xLm` subtitle; `valueUsd` is priced at the HISTORICAL LP-token price of the transfer moment |
| `deployed` | `COFFER / USDC · ◇ Deployed` | `pool.weights` for the "80/20 weights" subtitle; `valueUsd` is `null` by design (the seed deposit shows up as its own `added` row) |

Since 1.4.7 (backend with pool images) `pool.imageUrl` is the image the
pool admin uploaded; `null` or a missing key → compose the picture from
`pool.tokens` logos as before (see [Pool admin](POOL_ADMIN.md)).

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
- `apy` is the POOL-wide APY — the same number the pools page shows for
  that pool (not a personal metric), so the two screens never disagree.
- `pool.imageUrl` (since 1.4.7, backend with pool images) is the image the
  pool admin uploaded; `null` or a missing key → compose it from
  `pool.tokens` logos.

**Sorting:** `sort: "value" | "fees" | "il" | "pnl" | "apy"` (default
`"value"`), `order` default `"desc"`.

## Public portfolio of any wallet

Since 1.4.8 the four views above can be read for ANY wallet, without
authentication — for the profile page (see [Public profiles](PROFILE.md)).
They need the backend that ships the public portfolio (November 2026); see
[backend compatibility](BACKEND_COMPATIBILITY.md). Only what is connected to
Coffer is public: positions, the PnL / IL / XP charts, activity and the
token composition of the positions. Net Worth and the tokens that sit in the
wallet itself are not.

| Private — the signed-in wallet (JWT) | Public — any wallet |
|---|---|
| `getPortfolioChart(metric, range, options?)` | `getPublicPortfolioChart(ref, metric, range, options?)` |
| `getPortfolioActivity(options?)` | `getPublicPortfolioActivity(ref, options?)` |
| `getPortfolioHoldings(options?)` | `getPublicPortfolioHoldings(ref, options?)` |
| `getPortfolioPositions(options?)` | `getPublicPortfolioPositions(ref, options?)` |

`ref` is a wallet address, a username or `@` + username, as in
`getPublicProfile`. On a profile page pass the `address` of the profile
answer rather than the username from the route.

```ts
const chart = await client.getPublicPortfolioChart(address, "il", "1y");
const perPool = await client.getPublicPortfolioChart(address, "pnl", "all", { pool });
const activity = await client.getPublicPortfolioActivity(address, { type: "liquidity" });
const holdings = await client.getPublicPortfolioHoldings(address, { limit: 4 });
const positions = await client.getPublicPortfolioPositions(address, { limit: 20 });
```

**What is the same.** The options and their defaults, the response types
(`PortfolioChartResponse`, `PortfolioActivityResponse`,
`PortfolioHoldingsResponse`, `PortfolioPositionsResponse`) and everything
this guide says about them: the chart shape per metric, ranges and
`granularitySec`, `options.pool`, the markers, `change.pct: null`, the
activity filters, sorting and `highlight`, `transfer.counterparty` on sent /
received rows, `pool.imageUrl`. The formulas and the prices are those of the
private page, so one set of components renders both. A wallet the backend
has never seen answers 200 with empty lists and zero charts — as in the
private calls, there is no 404 for an address.

**What differs.**

| | Private | Public |
|---|---|---|
| LP balance behind positions and holdings | the wallet's live balance, 30 s fresh | the backend's stored position snapshot |
| Holdings rows | wallet + pools | pools only: `sources.wallet` is `{ amount: 0, pct: 0 }` in every row, `balance` / `valueUsd` are the pool part, a token held only in the wallet has no row |
| Chart metrics | `networth`, `pnl`, `il`, `xp` | `pnl`, `il`, `xp` (`PublicPortfolioChartMetric`); `networth` is a 400 |
| Chart `approximateReasons` | present when `approximate` is true | never present; `approximate` itself is |
| `ref` | — | 404 for a well-formed username nobody holds, 400 for a value that is neither an address nor a username |
| Too many cold chart builds at once | — | 503; the SDK waits 2 s and re-sends, twice |
| A `pnl` / `il` chart or a feed that is not cached, of a wallet with more than 200 withdrawals and LP transfers | built | 422, final: not built for a public read |

**Snapshot balance.** The stored balance and the live one differ for
seconds after a deposit or a withdrawal, and after LP tokens were
transferred between wallets until the snapshot catches up: about a minute
after the owner next opens their own portfolio page, within an hour
otherwise. Until then the public tables show the position as it was
before the transfer (a position received by a transfer appears once its
snapshot exists), while the owner's private page already shows the new
balance.

**503 on the public chart.** A chart that is not in the backend's cache has
to be built, and the backend builds only a few public charts at a time; a
request over that limit is answered 503 with `Retry-After: 2`.
`getPublicPortfolioChart` waits for it: three attempts, 2 s apart — a
schedule of its own (the other methods wait 0.2 s and 0.5 s); the header
itself is not read. So a busy chart normally arrives a few seconds late and
the call can take about 4 s longer: keep the previous chart or a skeleton on
screen. When the third attempt is a 503 too, the result is
`backend_unavailable` with `cause.status === 503`: ask again in a few
seconds.

**422 on the public chart and feed.** Pricing a wallet's withdrawals and LP
transfers one by one is what makes a chart and a feed expensive to build,
and a public read takes its address from the URL. For a wallet with more
than 200 of them the backend does not build a `pnl` / `il` chart or a feed
that is not in its cache: `getPublicPortfolioChart` and
`getPublicPortfolioActivity` answer `cause.status === 422` (code
`"unknown"`). The SDK does not re-send it and neither should the app — it
is not a matter of waiting. Show that profile's chart and feed as
unavailable; positions, holdings and the `xp` chart work. The call succeeds
while the answer is in the backend's cache, which the owner's own portfolio
page puts there. No real wallet is near the limit today.

```ts
const res = await client.getPublicPortfolioChart(address, "pnl", "1m");
if (!res.ok) {
  const status = (res.error.cause as { status?: number } | undefined)?.status;
  if (status === 503) {
    // Busy, nothing wrong with this wallet — refetch in a few seconds
  }
}
```

## Data Freshness

| Data | Freshness |
|---|---|
| Chart response | Cached 90 s per (wallet, metric, range, pool) |
| Price series behind networth/pnl | Shared across users, cached 10 min |
| Activity feed | Cached 30 s per wallet |
| Token holdings | Cached 30 s per wallet (wallet balances 30 s, pool state ≤5 min) |
| Position pools | Cached 30 s per wallet (values from wallet BPT, IL live-priced) |
| New indexed events (swap/liquidity/zap) | Appear seconds after the transaction (webhook) |
| LP token transfers | Fetched from wallet history on demand |

## API Reference

### `client.getPortfolioChart(metric, range, options?)`
Series for the chart card tabs. Requires auth. `options = { pool? }`
narrows `pnl` / `il` to a single position — the expanded row of the
positions table; `all` then starts at the first activity in that pool
instead of spanning at least a year. Rejected for `networth` / `xp`. The
response echoes the filter as `pool`; a pool the wallet never touched
returns a flat zero series (no error). `pnl` / `il` responses carry
`markers` (`PortfolioChartMarker[]`): the user's actions, each `marker.t`
a point of the line.
**Returns:** `SdkResult<PortfolioChartResponse>`

### `client.getPortfolioActivity(options?)`
Activity feed; `options = { page? = 1, limit? = 20, type? = "all",
sort? = "time", order? = "desc", highlight? }`. `highlight` (a transaction
signature) serves the page containing it and sets `highlight.index` in the
response. Requires auth.
**Returns:** `SdkResult<PortfolioActivityResponse>`

### `client.getPortfolioHoldings(options?)`
Token holdings with LP positions decomposed; `options = { page? = 1,
limit? = 20, sort? = "value", order? = "desc" }`. Requires auth.
**Returns:** `SdkResult<PortfolioHoldingsResponse>`

### `client.getPortfolioPositions(options?)`
Active LP positions with per-pool metrics; `options = { page? = 1,
limit? = 20, sort? = "value", order? = "desc" }`. Requires auth.
**Returns:** `SdkResult<PortfolioPositionsResponse>`

### `client.getPublicPortfolioChart(ref, metric, range, options?)`
`getPortfolioChart` for any wallet. `metric` is `"pnl" | "il" | "xp"` —
no `"networth"`; `options = { pool? }` for `pnl` / `il`. The answer never
has `approximateReasons`. 503 when too many charts are being built at once
(the SDK waits 2 s and re-sends, twice); 422, final, when the chart is not
cached and the wallet has more than 200 withdrawals and LP transfers. No
auth.
**Returns:** `SdkResult<PortfolioChartResponse>`

### `client.getPublicPortfolioActivity(ref, options?)`
`getPortfolioActivity` for any wallet, same `options` (`highlight`
included). 422, final, when the feed is not cached and the wallet has more
than 200 withdrawals and LP transfers. No auth.
**Returns:** `SdkResult<PortfolioActivityResponse>`

### `client.getPublicPortfolioHoldings(ref, options?)`
Token composition of any wallet's LP positions — the shape and `options` of
`getPortfolioHoldings`, pools only (`sources.wallet` is always zero). No
auth.
**Returns:** `SdkResult<PortfolioHoldingsResponse>`

### `client.getPublicPortfolioPositions(ref, options?)`
`getPortfolioPositions` for any wallet, same `options`; the LP balance comes
from the stored position snapshot. No auth.
**Returns:** `SdkResult<PortfolioPositionsResponse>`

In all four `ref` is a wallet address, a username or `@` + username: 404 for
a well-formed username nobody holds, 400 for a value that is neither.

## Error Handling

```ts
const res = await client.getPortfolioChart("networth", "24h");
if (!res.ok) {
  if ((res.error.cause as { status?: number } | undefined)?.status === 401) {
    // Not authenticated — redirect to connect wallet
  }
  // Empty wallets return zero series, not 404 — no special casing needed
}
```

The public twins need no token; their statuses (400 / 404 for `ref`, 503 for
a busy chart, 422 for a chart or a feed the backend does not build for a
public read) are listed in
[Public portfolio of any wallet](#public-portfolio-of-any-wallet).
