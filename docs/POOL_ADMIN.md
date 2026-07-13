# Pool Admin — SDK Integration Guide

## Overview

Pool admins can manage their pools through authenticated SDK methods.
Admin status is determined by the on-chain `poolAdmin` field, which is
synced to the backend every 10 minutes.

All methods require authentication — call `client.setTokens()` first
(see `docs/SIWS.md`).

## Methods

### Check Which Pools You Admin

```ts
const res = await client.getAdminPools();
if (res.ok) {
  for (const pool of res.data.pools) {
    console.log(`${pool.poolName} (${pool.poolAddress})`);
    console.log(`  TVL: $${pool.tvlUsd}, APY: ${pool.apy}%`);
    console.log(`  Tokens: ${pool.tokens.map(t => t.ticker).join(", ")}`);
  }
}
```

Returns all pools where your wallet is the on-chain admin. Empty array
if you don't admin any pools.

### Check Admin Status for a Specific Pool

```ts
const res = await client.isPoolAdmin("8iQtGj9mcUfFUGaiCpPy89swC3s8YTC8FhVZWfgeZhwu");
if (res.ok) {
  console.log(res.data.isAdmin ? "You are the admin" : "Not admin");
}
```

### Rename a Pool

```ts
const res = await client.renamePool(
  "8iQtGj9mcUfFUGaiCpPy89swC3s8YTC8FhVZWfgeZhwu",
  "My Awesome Pool",
);
if (res.ok) {
  console.log(`Renamed to: ${res.data.name}`);
} else {
  // Possible errors:
  // - 401: not authenticated
  // - 403: "You are not the admin of this pool"
  // - 404: pool not found
  // - 400: invalid name (too short, too long, control characters)
  console.error(res.error.humanMessage);
}
```

Pool names must be 2-64 characters, no control characters.

## Error Handling

All admin methods return `SdkResult<T>`. Non-admin users get a clear
`403` error — the SDK won't throw, it returns `{ ok: false, error }`.

```ts
const res = await client.renamePool(poolAddress, newName);
if (!res.ok) {
  if (res.error.humanMessage.includes("403")) {
    // User is not the admin of this pool
  }
}
```

## API Reference

### `client.getAdminPools()`
Get pools where you are the on-chain admin. Requires auth.
**Returns:** `SdkResult<{ pools: AdminPoolEntry[] }>`

### `client.isPoolAdmin(poolAddress)`
Check if you are the admin of a specific pool. Requires auth.
**Returns:** `SdkResult<{ poolAddress: string; isAdmin: boolean }>`

### `client.renamePool(poolAddress, name)`
Rename a pool you admin. Requires auth + admin status.
**Returns:** `SdkResult<{ poolAddress: string; name: string; updated: true }>`

## Types

```ts
interface AdminPoolEntry {
  poolAddress: string;
  poolName: string;
  tvlUsd: number;
  apy: number;
  volume24h: number;
  swapFee: number;
  poolEnabled: boolean;
  swapsEnabled: boolean;
  tokens: Array<{
    mintAddress: string;
    ticker: string;
    imageUrl: string | null;
  }>;
}
```
