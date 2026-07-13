# Portfolio — Frontend Integration Guide

## Overview

The Portfolio page shows LP providers their performance: value of positions,
fees earned, impermanent loss, and token exposure. All endpoints require
authentication.

## Prerequisites

- User must be authenticated via SIWS (see `docs/SIWS.md`)
- `client.setTokens()` must be called before using portfolio methods
- User must have at least one LP position (past or current) — otherwise endpoints return 404

## Methods

### 1. Portfolio Summary (Hero block)

```ts
const res = await client.getPortfolioSummary();
if (!res.ok) {
  if (res.error.humanMessage.includes("404")) {
    // User has never provided liquidity
  }
  return;
}

const { value, totalPnl } = res.data;

// Left card — Portfolio Value
console.log(`Total: $${value.total}`);
console.log(`In LP: $${value.inPositions}`);
console.log(`On wallet: $${value.inWallet}`);
console.log(`24h: ${value.change.d1.abs > 0 ? "+" : ""}$${value.change.d1.abs} (${value.change.d1.pct}%)`);

// Right card — Total PnL
console.log(`Net PnL: $${totalPnl.net}`);
console.log(`On capital: ${totalPnl.pct}%`);
console.log(`Fees earned: +$${totalPnl.components.feesEarned}`);
console.log(`IL current: $${totalPnl.components.ilCurrent}`);
console.log(`IL realized: $${totalPnl.components.ilRealized}`);
```

### 2. Token Exposure (Exposure bar)

```ts
const res = await client.getPortfolioExposure();
if (res.ok) {
  console.log(`Total exposure: $${res.data.totalUsd}`);

  for (const token of res.data.tokens) {
    console.log(`${token.symbol}: $${token.usd} (${token.pct.toFixed(1)}%)`);
    console.log(`  In LP: $${token.inLp}, On wallet: $${token.inWallet}`);
    console.log(`  Pools: ${token.pools.join(", ")}`);
  }
}
```

Each token has `inLp` (purple segment) and `inWallet` (grey segment) for the
exposure bar visualization.

### 3. History Charts (Fees + IL)

```ts
// One endpoint feeds both charts
const res = await client.getPortfolioHistory("30d");
if (res.ok) {
  for (const point of res.data.series) {
    const date = new Date(point.t * 1000);
    console.log(`${date}: fees=$${point.feesCumulative}, IL=$${point.ilCumulative}`);
  }
}
```

Range options: `"7d"`, `"30d"`, `"90d"`, `"all"`.

Left chart draws `feesCumulative` (cumulative, always growing).
Right chart draws `ilCumulative` (unrealized IL at that date).

### 4. Per-Pool Table

```ts
const res = await client.getPortfolioPools();
if (res.ok) {
  for (const pool of res.data.pools) {
    console.log(`${pool.poolName}: value=$${pool.value}`);
    console.log(`  Fees: +$${pool.feesEarned}, IL: $${pool.il}`);
    console.log(`  Net PnL: $${pool.netPnl}, APR: ${pool.apr}%`);
  }
}
```

### 5. Per-Pool History (lazy, on row expand)

```ts
// Only fetch when user clicks to expand a pool row
const res = await client.getPortfolioPoolHistory("8iQt...", "30d");
if (res.ok) {
  // Left mini-chart: fees cumulative for this pool
  // Right mini-chart: IL for this pool
  for (const point of res.data.series) {
    console.log(`${new Date(point.t * 1000)}: fees=${point.feesCumulative}, IL=${point.ilCumulative}`);
  }
}
```

## Key Concepts

### Fees Earned
LP fees auto-reinvest into the pool (no claim needed). BPT becomes more
valuable as swap fees accumulate. Fees are tracked precisely using BPT Value
Growth — how much `actualBalance / bptSupply` grew during each holding period.

### Impermanent Loss (IL)
IL measures how much LP underperforms simply holding (HODL). Calculated using
the weighted pool IL formula with actual pool weights.

- **IL Current** (unrealized): what you'd lose if you withdrew now
- **IL Realized**: locked in when you actually withdraw

### Net PnL
```
net = feesEarned + ilCurrent + ilRealized
```
Positive = LP is profitable. The `pct` field shows this relative to total
capital invested ("on capital").

## Data Freshness

| Data | Update frequency |
|---|---|
| Fees earned | Cached, updated every 10 min + on LP events |
| IL current | Computed live with current token prices (~60s cache) |
| IL realized | Cached, updated on withdraw events |
| Wallet balances | On-chain fetch, cached 30 seconds |
| History charts | Daily snapshots |

## API Reference

### `client.getPortfolioSummary()`
Portfolio value + total PnL with components. Requires auth.
**Returns:** `SdkResult<PortfolioSummaryResponse>`

### `client.getPortfolioExposure()`
Per-token exposure breakdown (LP + wallet). Requires auth.
**Returns:** `SdkResult<PortfolioExposureResponse>`

### `client.getPortfolioHistory(range?)`
Daily series for fees and IL charts. Requires auth.
**Returns:** `SdkResult<PortfolioHistoryResponse>`

### `client.getPortfolioPools()`
Per-pool metrics table. Requires auth.
**Returns:** `SdkResult<PortfolioPoolsResponse>`

### `client.getPortfolioPoolHistory(poolAddress, range?)`
Per-pool history (lazy-loaded on row expand). Requires auth.
**Returns:** `SdkResult<PortfolioPoolHistoryResponse>`

## Error Handling

```ts
const res = await client.getPortfolioSummary();
if (!res.ok) {
  if (res.error.humanMessage.includes("404")) {
    // User has never provided liquidity — show empty state
  } else if (res.error.humanMessage.includes("401")) {
    // Not authenticated — redirect to connect wallet
  }
}
```
