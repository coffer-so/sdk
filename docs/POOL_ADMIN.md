# Pool Admin — SDK Integration Guide

## Overview

Pool admins can manage their pools through authenticated SDK methods.
Admin status is determined by the on-chain `poolAdmin` field, which is
synced into the backend. This guide covers off-chain metadata administration,
not protocol-admin transaction signing; see [contract compatibility](CONTRACT_COMPATIBILITY.md).
The checked backend revision is `v5.1@a886497`; its pool settings route is absent
although the SDK exposes `updatePoolSettings`. See [backend scope](BACKEND_COMPATIBILITY.md).
The pool image (`uploadPoolImage` / `removePoolImage`, since 1.4.7), the
`additionalUrl` field and the rename rule below need the backend that ships
pool images (November 2026); its own guide is the backend's `docs/POOL_SETTINGS.md`.

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
  "BlueChips",
);
if (res.ok) {
  console.log(`Renamed to: ${res.data.name}`);
} else {
  // Possible errors (HTTP status in res.error.cause.status):
  // - 401: not authenticated
  // - 403: not the admin of this pool
  // - 404: pool not found
  // - 400: invalid name (empty, over 12 characters, anything but English letters and digits)
  console.error(res.error.humanMessage);
}
```

A rename follows the rule of pool creation: **1–12 English letters and
digits** (`/^[a-zA-Z0-9]+$/`), not trimmed — a space is a 400. Give the
rename input the validation of the create form. A longer name saved earlier
stays until it is renamed. (Backends before November 2026 accepted 2–64
characters of any kind.) The answer calls the field `name`; the pool reads
call it `poolName`.

### Update Pool Settings

```ts
// baseAssetMint is not sent, so it stays
const res = await client.updatePoolSettings<{ success: true; data: unknown }>(
  poolAddress,
  { description: "Blue chips, equal weights", additionalUrl: "https://x.com/coffer_so" },
);
if (res.ok) {
  const pool = res.data.data; // the pool object with its tokens, base asset first
}
```

Any of `baseAssetMint`, `description`, `additionalUrl`: **absent =
unchanged, `""` = clear** (returned as `null`). Never send `null` for "no
change": `null` clears a field exactly like `""` — the description, the
link and the base asset alike. This method does not unwrap the answer — `T`
is the whole `{ success, data: <pool> }`.

- `baseAssetMint` — one of the pool's token mints; that token is listed
  first. Any other value is a 400, like every refused value here (backends
  before November 2026 answered 403 for a mint outside the pool, and for
  `null`).
- `description` — up to 280 characters on one line: letters, digits, spaces
  and `. , ! ? ( ) ' : ; % + - – — / # @`. Trimmed by the backend before it
  is checked, so the 280 count what is stored; a blank one is stored as
  none. (Backends before November 2026 counted the 280 as sent — trim
  it yourself to be safe with both.)
- `additionalUrl` — one link of the admin's choice (X account, site, …): an
  absolute `https://` URL of at most 200 characters, a host with a TLD (no
  IP address), no `user:password@`, spaces, quotes or non-ASCII. Send
  `new URL(input).href`; local check of that value:
  `/^https:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=%]+$/`.

A value that breaks these rules is a 400; a 403 from this method means
only "not the pool admin". `additionalUrl` is user-supplied
and not moderated: render it as an external link
(`target="_blank" rel="noopener noreferrer nofollow"`), show its host, never
present it as official.

### Pool Image

Cropping is the app's job; the upload contract is the one of the profile
avatar (see [Public profiles](PROFILE.md), "Avatar" — the same canvas →
blob → data URL steps and the same `blob.size <= 512 * 1024` check).

```ts
// image: "data:image/jpeg;base64,…" from FileReader.readAsDataURL(blob); bare base64 works too
const res = await client.uploadPoolImage(poolAddress, image);
if (res.ok) {
  console.log(res.data.imageUrl); // new public URL of a 400×400 WebP
}

await client.removePoolImage(poolAddress); // idempotent; imageUrl: null
```

- Input: PNG, JPEG or WebP, up to 512 KB decoded and 2048×2048 px. Stored as
  a 400×400 WebP, centre-cropped, metadata stripped.
- `imageUrl` is opaque and cacheable — never build or parse it. It changes
  with every new image and the previous URL stops working; the same image
  gives the same URL.
- The answer is `{ poolAddress, imageUrl }`, not the pool object: put the
  `imageUrl` into the cached pool or invalidate the pool queries.
- `imageUrl: null` → compose the picture from the token icons, and do the
  same in `<img onError>`: a cached list may still hold a replaced URL.
- `imageUrl` is never sent as a string — only the upload sets it.

| status | when (`uploadPoolImage`, `removePoolImage`) |
| --- | --- |
| 400 | `image` missing, empty or not valid base64 |
| 403 / 404 | not the pool admin / the pool is not registered |
| 413 | the image is over 512 KB decoded |
| 422 | not a PNG / JPEG / WebP, a damaged file or one over 2048×2048 px |
| 429 | more than 20 image requests (uploads and removals) for one pool in 10 minutes |
| 503 | the image encoder is busy or unavailable; the SDK re-sends by itself |

### Creating a Pool: Two Requests

```ts
// 1. Register — the body may carry additionalUrl next to description
const body: CreatePoolBody = { poolAddress, poolName, description, additionalUrl };
const created = await client.createPool<unknown>(body);

// 2. If an image was chosen — right after the registration succeeded
if (created.ok && image) {
  const uploaded = await client.uploadPoolImage(poolAddress, image);
  // Not fatal: on failure the pool stays registered without an image and
  // the admin page offers the same control.
}
```

Whoever registers a pool is its admin at once, so the upload needs no wait.
The image never goes into the registration body (that route is limited to
10 KB). Validate `additionalUrl` before the on-chain transaction: a link the
backend refuses is a 400 for the whole registration — drop the field and
register again, the admin can set the link later in settings. The optional
`baseAssetMint` (absent or `""` = none) must be one of the pool's token
mints: any other value is a 400 as well (on backends before November 2026
a mint outside the pool was a 403, and `""` was refused with a 400). The
description is trimmed before its 280 characters are counted, as in settings.

### Where the Fields Come Back

| SDK method | fields |
| --- | --- |
| `listPoolsRaw`, `getPoolRaw`, `getPoolsByTokenPair`, `getPortfolio`; the answers of `createPool` and `updatePoolSettings` | `imageUrl`, `additionalUrl` on the pool object, next to `description` (these methods are untyped — add both to your pool type) |
| `getAdminPools` | `AdminPoolEntry.imageUrl`, `AdminPoolEntry.additionalUrl` |
| `getPortfolioPositions`, `getPortfolioActivity` | `pool.imageUrl` only |

`null` when unset; read a missing key as `null` too. Name-only references
(swap-route legs, holdings sources, chart markers, campaign pools) carry
neither field — load the pool by its address.

## Error Handling

All admin methods return `SdkResult<T>`. Non-admin users get a clear
`403` error — the SDK won't throw, it returns `{ ok: false, error }`.
A 403 from these methods means nothing else: a refused value (a name, a
description, a link, a base asset that is not a token of the pool) is a 400.
The writes here (`renamePool`, `updatePoolSettings`, `uploadPoolImage`,
`removePoolImage`) are idempotent and use the default retry policy (up to 3
attempts on a network failure, a timeout, 429 and 5xx) — add no retries of
your own.

```ts
const res = await client.renamePool(poolAddress, newName);
if (!res.ok) {
  // Match the HTTP status, not "403" in humanMessage: the message contains
  // the request path with the pool address, which may itself contain "403".
  if ((res.error.cause as { status?: number } | undefined)?.status === 403) {
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

### `client.updatePoolSettings<T>(poolAddress, settings: UpdatePoolSettingsBody)`
Update base asset, description, additional link. Requires auth + admin status.
**Returns:** `SdkResult<T>` — the backend's `{ success, data: <pool> }` as is

### `client.uploadPoolImage(poolAddress, image)`
Upload the pool image as base64 or a data URL. Requires auth + admin status.
**Returns:** `SdkResult<PoolImageResponse>`

### `client.removePoolImage(poolAddress)`
Remove the pool image. Requires auth + admin status.
**Returns:** `SdkResult<PoolImageResponse>` with `imageUrl: null`

## Types

```ts
interface AdminPoolEntry {
  poolAddress: string;
  poolName: string;
  baseAssetMint: string | null;
  description: string | null;
  imageUrl?: string | null;       // since 1.4.7; null = compose from the token icons
  additionalUrl?: string | null;  // since 1.4.7; user-supplied https link
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

interface UpdatePoolSettingsBody {
  baseAssetMint?: string;   // "" clears it; a mint outside the pool is a 400
  description?: string;     // "" clears it; trimmed, then up to 280 characters
  additionalUrl?: string;   // since 1.4.7; "" clears it
}

interface CreatePoolBody {
  poolAddress: string;
  poolName: string;         // 1–12 English letters and digits
  baseAssetMint?: string;   // absent or "" = none; a mint outside the pool is a 400
  description?: string;     // trimmed, then up to 280 characters
  additionalUrl?: string;   // since 1.4.7
  protocolVersion?: number; // 5 or 6
}

interface PoolImageResponse {
  poolAddress: string;
  imageUrl: string | null;  // null after a removal
}
```
