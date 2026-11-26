# Public Profiles — Frontend Integration Guide

## Overview

Every wallet has a public profile: a unique **username**, a display name, a
bio, an avatar and an X link, plus the number of users it referred. It is
keyed by the **wallet address** and needs no registration — an address that
never set anything up answers the same shape with nulls. Anyone reads a
profile; only its owner (SIWS JWT) edits it.

Since 1.4.7 the SDK has typed methods for all of it, and the rows of the
leaderboards, campaign tops, the referral list and the pool transaction
history carry a short `profile` card (see [Rows that carry `profile`](#rows-that-carry-profile)).
The methods need the backend that ships the profile module (November 2026);
see [backend version scope](BACKEND_COMPATIBILITY.md). Validation rules,
moderation and the on-chain (SNS) names are described in the backend's
`docs/PROFILE.md`.

Since 1.4.8 a profile opens by **username** as well as by address
(`getPublicProfile("@alice")`), and a profile page can show the wallet's
Coffer portfolio — positions, PnL / IL / XP charts, activity and the token
composition of the positions — through four public methods (see
[Portfolio of a profile](#portfolio-of-a-profile)). Both need the backend
that ships the public portfolio (November 2026, a later release than the
profile module).

## Prerequisites

- Reads (`getPublicProfile`, `getProfileCards` and the four
  `getPublicPortfolio*` methods) are public.
- Everything about "my profile" needs SIWS: call `client.setTokens()` first
  (see `docs/SIWS.md`). Without a valid access token these answer 401.

## Reading profiles

### 1. One profile by address or username

```ts
const res = await client.getPublicProfile(ref); // address, "alice" or "@alice"
if (res.ok) {
  const { address, username, displayName, avatarUrl, x, bio, referralCount } = res.data;
  const name = displayName ?? username ?? shortenAddress(address);
} else if ((res.error.cause as { status?: number } | undefined)?.status === 404) {
  // a well-formed username nobody holds → the "profile not found" page
}
```

`ref` is a wallet address, a username or `@` + username: pass the route
parameter of `/user/:ref` as it is, the SDK encodes it. There is no need to
tell the two apart on the client — a username is 3–20 characters, an address
32–44. A username is matched in any letter case, but only as it is held
right now: a former name and a look-alike spelling (`b0b` for `bob`) do not
resolve. The answer always carries the canonical `address` — continue with
it (see [Rendering](#rendering)).

| status | when |
| --- | --- |
| 200 | any valid address — a wallet without a profile comes back with nulls and its `referralCount` — or a username somebody holds |
| 404 | a well-formed username nobody holds |
| 400 | neither an address nor a username (a lone `@` included) |

On a backend before the public portfolio only an address works: a username
is a 400 there.

### 2. Cards for a list of addresses

For views that have addresses but no embedded `profile` (the admin wallet of
a pool, a transfer counterparty, …): one request per view, not one profile
request per address.

```ts
const res = await client.getProfileCards(addresses); // 1–100 addresses
if (res.ok) {
  const cards = new Map(res.data.data.map((item) => [item.address, item.profile]));
  // cards.get(address) === null → nothing set: shortened address + identicon
}
```

One item per distinct address, in request order. More than 100 distinct
addresses or a malformed one is a 400. An empty array resolves to
`{ data: [] }` without a request.

## My profile

### 3. Read

```ts
const res = await client.getMyProfile();
if (res.ok) {
  const me = res.data; // PublicProfile + edit.locked
}
```

A wallet with a primary SNS name and no username gets that name as its
username by itself (`usernameSource: "sns"`), in the background, usually
within minutes of the first sign-in — `getMyProfile()` right after a first
login may still say `username: null`. Refetch on the next visit, do not poll.

### 4. Update display name, bio, X link

```ts
// Sets the name, clears the bio, leaves the X link untouched
const res = await client.updateMyProfile({ displayName: "Alice", bio: "" });
if (res.ok) {
  setProfile(res.data); // every write answers the full profile
}
```

Partial: **absent (or `undefined`) = unchanged, `""` = clear, never `null`**
(400). The backend normalises text — show what the answer returns, not what
was typed. `x` takes what a user would paste: `https://x.com/alice_x`,
`twitter.com/alice_x`, `@alice_x` or `alice_x`; it comes back as
`x: { username, url }`.

### 5. Username

```ts
const res = await client.setUsername("Alice_01"); // stored as "alice_01"
if (!res.ok) {
  const status = (res.error.cause as { status?: number } | undefined)?.status;
  if (status === 409) showError("This username is taken");
  else if (status === 422) showError("This username is not allowed");
}

await client.setUsername(""); // reset to null
```

3–20 English letters and digits with single `_` or `-` between them. Local
check: `/^(?=.{3,20}$)[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*$/`. There is no "is
it free?" call and refused attempts count towards the 429 — validate the
shape locally and submit on save, not per keystroke.

### 6. Avatar

Cropping is the app's job: the backend takes a finished image and stores a
400×400 WebP (centre-cropped when the upload is not square).

```ts
// 1. Draw the crop on a 512×512 canvas, export it
const blob: Blob = await new Promise((resolve, reject) =>
  canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/jpeg", 0.9),
);

// 2. Check the size BEFORE sending — over ~1 MB the proxy cuts the request
//    off without CORS headers and the SDK reports a network error, not a 413
if (blob.size > 512 * 1024) throw new Error("Image is too large");

// 3. Blob → data URL (bare base64 works too)
const image: string = await new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result as string);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

// 4. Upload — answers the full profile with the new avatarUrl
const res = await client.uploadAvatar(image);
if (res.ok) setProfile(res.data);

// Remove — idempotent, allowed while the profile is locked
await client.removeAvatar();
```

Input: PNG, JPEG or WebP (told by the bytes), up to 512 KB decoded and
2048×2048 px.

## Portfolio of a profile

Four public methods (since 1.4.8) feed a profile page with the wallet's
Coffer portfolio. Each is the twin of a [Portfolio v2](PORTFOLIO_V2.md)
method — same options, same response type, so the components of the private
portfolio page render both — and takes the same `ref` as `getPublicProfile`.
No authentication. Only what is connected to Coffer is public: there is no
Net Worth chart and no list of the tokens in the wallet. What differs from
the private calls is listed in
[Public portfolio of any wallet](PORTFOLIO_V2.md#public-portfolio-of-any-wallet).

```ts
// /user/:ref — resolve the profile first, then ask by its address
const profile = await client.getPublicProfile(ref);
if (!profile.ok) return; // 404 → the "profile not found" page, see section 1
const { address } = profile.data;

const [positions, chart, activity, holdings] = await Promise.all([
  client.getPublicPortfolioPositions(address),
  client.getPublicPortfolioChart(address, "pnl", "1m"),
  client.getPublicPortfolioActivity(address, { limit: 4 }),
  client.getPublicPortfolioHoldings(address, { limit: 4 }),
]);
```

The portfolio methods accept a username too, but ask them by the `address`
of the profile answer: a username can move to another wallet between two
requests, an address cannot, so the page never mixes two wallets.

A wallet the backend has never seen answers 200 with empty lists and zero
charts — a valid address is never a 404 here either (a 404 for an address
means the backend does not have these routes yet, see
[backend version scope](BACKEND_COMPATIBILITY.md)). A username nobody holds
is a 404 and a malformed `ref` a 400, as in `getPublicProfile`.

### 7. Positions

```ts
const res = await client.getPublicPortfolioPositions(address, { sort: "pnl" });
if (res.ok) {
  const { total, totalValueUsd, data } = res.data; // PortfolioPositionsResponse
  for (const p of data) {
    console.log(p.pool.name, p.valueUsd, p.feesEarned, p.il, p.netPnl);
  }
}
```

The fields and the sorting of `getPortfolioPositions`. One difference: the
LP balance behind `valueUsd` is the one of the backend's stored position
snapshot, not a live read of the wallet. The two differ for seconds after a
deposit or a withdrawal, and after LP tokens were transferred between
wallets until the snapshot catches up — about a minute after the owner next
opens their own portfolio page, within an hour otherwise.

### 8. Charts

```ts
const pnl = await client.getPublicPortfolioChart(address, "pnl", "1m");
const il = await client.getPublicPortfolioChart(address, "il", "1y", { pool }); // one position
const xp = await client.getPublicPortfolioChart(address, "xp", "all");
if (il.ok) {
  drawLine(il.data.lines!.profit, "green");
  drawLine(il.data.lines!.il, "red");
  drawMarkers(il.data.markers ?? []);
}
```

The answer of `getPortfolioChart`: `series` for `pnl` / `xp`, `lines` for
`il`, `markers` on `pnl` / `il`. The metric is `"pnl" | "il" | "xp"`
(`PublicPortfolioChartMetric`) — `"networth"` is a 400 — and the answer
never has `approximateReasons` (`approximate` itself is there). When too
many charts are being built at once the backend answers 503; the SDK waits
and re-sends it. A 422 is final: the backend does not build that wallet's
chart for a public read. See [Errors](#errors) for both.

### 9. Activity

```ts
const res = await client.getPublicPortfolioActivity(address, { limit: 4 });

// A chart marker click → the page that contains that transaction
const page = await client.getPublicPortfolioActivity(address, { highlight: sig, limit: 20 });
```

The feed of `getPortfolioActivity`, filters, sorting and `highlight`
included. `sent` / `received` rows carry `transfer.counterparty` here too —
`getProfileCards` turns those addresses into names. A 422 is final here as
on the chart, see [Errors](#errors).

### 10. Token composition

```ts
const res = await client.getPublicPortfolioHoldings(address, { limit: 10 });
if (res.ok) {
  for (const h of res.data.data) {
    console.log(`${h.token.symbol}: ${h.balance} = $${h.valueUsd}`);
    for (const p of h.sources.pools) console.log(`  ${p.poolName} ${p.pct}%`);
  }
}
```

The shape of `getPortfolioHoldings`, but only what is held **in pools**:
every row's `sources.wallet` is `{ amount: 0, pct: 0 }`, `balance` and
`valueUsd` are the pool part alone, and a token the wallet holds only
outside pools has no row. The "Wallet" badge and the wallet segment of the
Source bar never show on this page.

## Rendering

Key everything by **address** (query keys, React keys): a username can be
changed, reset or taken by another wallet at any moment. A route may carry a
username (`/user/@alice`): resolve it with `getPublicProfile` and continue
with the `address` of the answer. Such a link is not permanent — after a
rename it is a 404 or, once somebody else takes the name, another wallet's
profile; a link by address always leads to the same wallet.

Every field of a card is null on its own, and an
embedded card is null as a whole when the wallet has set nothing — whichever
name you show, end the fallback at the shortened address. `avatarUrl` is
opaque (never build or parse it); it changes with every new image and the
old URL stops working, so draw an identicon derived from the full address
when it is null **and** in `<img onError>`. Neither `usernameSource: "sns"`
nor `x` is verified — no "verified" mark next to either, and never append
`.sol` to a username.

## Rows that carry `profile`

On a backend with profiles these rows have `profile: UserProfileCard | null`
(the types declare it optional for older backends):

| SDK method | where |
| --- | --- |
| `getLeaderboard` | `data[].profile` |
| `getLeaderboardUser` | `profile` |
| `getLeaderboardEpochSnapshot` | `data[].profile` |
| `getLeaderboardEpochUser` | `profile` |
| `getCampaignTop` | `data[].profile` |
| `getCampaignSnapshotTop` | `data[].profile` |
| `getMyReferrals` | `data[].profile` |
| `getTransactions` | each row — the author's card; this row names the wallet `userAddress`, not `address` (the row type is yours: add `profile?: UserProfileCard \| null` to it) |

The card is read at request time everywhere, **frozen snapshots included**:
an epoch or campaign snapshot freezes places, points and prizes, not names
and avatars. Give those queries a finite `staleTime` instead of `Infinity`
(see [XP snapshots](XP_SNAPSHOTS.md)). After the user edits their own
profile, invalidate what may show this wallet: its public profile, the lists
above, `getProfileCards` batches.

## Errors

The SDK exposes only the HTTP status
(`(res.error.cause as { status?: number } | undefined)?.status`), so show
one message per status:

| status | `updateMyProfile` | `setUsername` | `uploadAvatar` |
| --- | --- | --- | --- |
| 400 | nothing to update, `null`, too long, a character outside the set, `x` is not an X profile link or handle | wrong shape | `image` missing or not base64 |
| 403 | the profile is locked and the body sets a new value | the profile is locked | the profile is locked |
| 409 | — | taken, also by a look-alike spelling (`_` / `-` ignored, `0` = `o`, `1` = `l`) | — |
| 413 | — | — | over 512 KB decoded |
| 422 | display name not allowed (brand or authority words) | not allowed (brand, authority or reserved words, another wallet's referral code) | not a PNG / JPEG / WebP, damaged, or over 2048×2048 px |
| 429 | more than 30 updates in 10 minutes | more than 20 attempts in an hour | more than 20 avatar changes (uploads and removals) in 10 minutes |
| 503 | — | — | the image encoder is busy or unavailable |

**Reads.** `getPublicProfile` and the four `getPublicPortfolio*` methods:

| status | when |
| --- | --- |
| 400 | `ref` is neither an address nor a username; a refused query parameter (`"networth"` on the public chart, `pool` with `"xp"`) |
| 404 | a well-formed username nobody holds — never an address |
| 422 | `getPublicPortfolioChart` (`pnl` / `il`) and `getPublicPortfolioActivity` only: the answer is not in the backend's cache and the wallet has more than 200 withdrawals and LP transfers |
| 503 | `getPublicPortfolioChart` only: too many charts are being built at once |

A 422 is **not** a matter of waiting, and the SDK does not re-send it
(`res.error.code` is `"unknown"`, the status is in `res.error.cause`).
Pricing a wallet's withdrawals and LP transfers one by one is what makes a
chart and a feed expensive, and a profile can be opened by anyone for any
address — so for such a wallet the backend does not build them for a public
read. Show that profile's chart and feed as unavailable, not as loading;
positions, holdings and the `xp` chart of the same wallet work. The same
call does succeed while the answer is in the backend's cache, which the
owner's own portfolio page puts there. No real wallet is near the limit
today.

The SDK rides that 503 out by itself. The backend sends it with
`Retry-After: 2`, and `getPublicPortfolioChart` — this method alone — waits
2 s before its second attempt and 2 s more before its third, where every
other method waits 0.2 s and 0.5 s (see **Retries** below; the header
itself is not read). A busy chart therefore normally just arrives a few
seconds later: keep the previous chart or a skeleton on screen. Only when
the third attempt is a 503 too is the result `backend_unavailable` with
`cause.status === 503`: ask again in a few seconds — nothing is wrong with
the wallet.

**Lock.** `edit.locked: true` means moderation locked the profile. Clearing
still works (`""` for a field, a username reset, `removeAvatar`), any new
value is a 403.

**Retries.** All profile writes are idempotent (the same image even gives
the same `avatarUrl`), so they use the default policy: up to 3 attempts on a
network failure, a timeout, 429 and 5xx — do not add retries of your own.
A timeout does not abort the request: after a write that ended in a timeout
or a network error, refetch `getMyProfile()` before telling the user it
failed. The reads follow the same policy, `getPublicPortfolioChart` with
2 s between its attempts; the one case worth a later retry by the app is a
public chart that still answers 503 (above) — never a 422.

**Rate limit.** The backend counts requests per route: 10 a second and 200
a minute from the app's origin, 5 and 100 without it. Behind Cloudflare the
counter can be keyed by an edge address shared by many visitors, and past
the minute limit that route answers 429 for a full minute — longer than the
SDK's retries wait. Keep a page view to a handful of requests: load the
chart of a position when its row is expanded, not one per row.

## API Reference

### `client.getPublicProfile(ref)`
Public profile of any wallet; `ref` is an address, a username or
`@` + username. No auth. 404 for a username nobody holds.
**Returns:** `SdkResult<PublicProfile>`

### `client.getProfileCards(addresses)`
Cards for 1–100 addresses. No auth.
**Returns:** `SdkResult<UserProfileCardsResponse>`

### `client.getPublicPortfolioPositions(ref, options?)`
Active LP positions of any wallet; `options` as in `getPortfolioPositions`.
The LP balance comes from the stored snapshot. No auth.
**Returns:** `SdkResult<PortfolioPositionsResponse>`

### `client.getPublicPortfolioChart(ref, metric, range, options?)`
`pnl` / `il` / `xp` chart of any wallet; `range` and `options = { pool? }`
as in `getPortfolioChart`. No `networth`, no `approximateReasons`. 503 is
re-sent by the SDK, 422 is final. No auth.
**Returns:** `SdkResult<PortfolioChartResponse>`

### `client.getPublicPortfolioActivity(ref, options?)`
Activity feed of any wallet; `options` as in `getPortfolioActivity`
(`highlight` included). 422 is final. No auth.
**Returns:** `SdkResult<PortfolioActivityResponse>`

### `client.getPublicPortfolioHoldings(ref, options?)`
Token composition of any wallet's LP positions (pools only); `options` as in
`getPortfolioHoldings`. No auth.
**Returns:** `SdkResult<PortfolioHoldingsResponse>`

### `client.getMyProfile()`
The authenticated wallet's profile. Requires auth.
**Returns:** `SdkResult<MyProfile>`

### `client.updateMyProfile(body: UpdateMyProfileBody)`
Partial update of display name, bio, X link. Requires auth.
**Returns:** `SdkResult<MyProfile>`

### `client.setUsername(username)`
Set or change the username; `""` resets it. Requires auth.
**Returns:** `SdkResult<MyProfile>`

### `client.uploadAvatar(image)`
Upload an avatar as base64 or a data URL. Requires auth.
**Returns:** `SdkResult<MyProfile>`

### `client.removeAvatar()`
Remove the avatar. Requires auth.
**Returns:** `SdkResult<MyProfile>`

## Types

```ts
type UsernameSource = "sns" | "custom";

interface UserProfileCard {
  username: string | null;                 // unique, lower-case
  usernameSource: UsernameSource | null;   // null exactly when username is null
  displayName: string | null;              // free text, NOT unique
  avatarUrl: string | null;                // opaque URL of a 400×400 WebP
  x: { username: string; url: string } | null; // format-checked only
}

interface PublicProfile extends UserProfileCard {
  address: string;                         // canonical, also when asked by username
  bio: string | null;
  referralCount: number;                   // direct (level 1) referrals
}

interface MyProfile extends PublicProfile {
  edit: { locked: boolean };
}

interface UserProfileCardsResponse {
  data: Array<{ address: string; profile: UserProfileCard | null }>;
}

interface UpdateMyProfileBody {
  displayName?: string;                    // up to 32 characters
  bio?: string;                            // up to 160 characters
  x?: string;                              // X profile link or handle
}

// Public portfolio: the metric of getPublicPortfolioChart. The response
// types are those of the private methods — see PORTFOLIO_V2.md.
type PublicPortfolioChartMetric = "pnl" | "il" | "xp";
```
