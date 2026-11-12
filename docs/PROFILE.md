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

## Prerequisites

- Reads (`getPublicProfile`, `getProfileCards`) are public.
- Everything about "my profile" needs SIWS: call `client.setTokens()` first
  (see `docs/SIWS.md`). Without a valid access token these answer 401.

## Reading profiles

### 1. One profile by address

```ts
const res = await client.getPublicProfile(address);
if (res.ok) {
  const { username, displayName, avatarUrl, x, bio, referralCount } = res.data;
  const name = displayName ?? username ?? shortenAddress(address);
}
```

Any valid address answers 200 — there is no 404, a wallet without a profile
comes back with nulls and its `referralCount`. 400 only for a malformed
address.

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

## Rendering

Key everything by **address** (routes, query keys, React keys): a username
can be changed, reset or taken by another wallet at any moment, and there is
no lookup by username. Every field of a card is null on its own, and an
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

**Lock.** `edit.locked: true` means moderation locked the profile. Clearing
still works (`""` for a field, a username reset, `removeAvatar`), any new
value is a 403.

**Retries.** All profile writes are idempotent (the same image even gives
the same `avatarUrl`), so they use the default policy: up to 3 attempts on a
network failure, a timeout, 429 and 5xx — do not add retries of your own.
A timeout does not abort the request: after a write that ended in a timeout
or a network error, refetch `getMyProfile()` before telling the user it
failed.

## API Reference

### `client.getPublicProfile(address)`
Public profile of any address. No auth.
**Returns:** `SdkResult<PublicProfile>`

### `client.getProfileCards(addresses)`
Cards for 1–100 addresses. No auth.
**Returns:** `SdkResult<UserProfileCardsResponse>`

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
  address: string;
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
```
