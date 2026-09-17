# XP Snapshots — Frontend Integration Guide

## Overview

Two things in Coffer have a natural "final result": a leaderboard **epoch**
(the four-month halving period) and a swap-XP **campaign**. Both used to
exist only as live, moving tables. This guide covers their frozen
counterparts:

- **Epoch snapshots** — the leaderboard exactly as it stood the instant an
  epoch ended: places, cumulative XP, everyone on the board.
- **Campaign snapshots** — the final standings of a finished campaign with
  prizes resolved per place.

Frozen means frozen: the rows are written once, by the backend, and never
recomputed. The live leaderboard keeps changing as people earn XP at
different speeds; an epoch snapshot does not. A later re-pricing of
historical swaps moves the live campaign report; the snapshot does not —
it is what the prizes were paid on.

No authentication is required for any of these; all reads are public.

## Prerequisites

None beyond a `CofferBackendClient`. Frozen data is safe to cache with
`staleTime: Infinity` — but only once a snapshot is reported `finalized`
(see below); before that the endpoints 404.

## Epoch snapshots

### 1. Find out which epochs are frozen

`getLeaderboardEpoch()` — the endpoint the countdown already uses — now
carries a snapshot flag per epoch:

```ts
const res = await client.getLeaderboardEpoch();
if (res.ok) {
  const past = res.data.epochs.filter((e) => !e.isCurrent);
  // e.finalized === true  ⇒ getLeaderboardEpochSnapshot(e.epoch) will answer
  // e.finalized === false ⇒ ended but not frozen yet (only for minutes after a boundary)
}
```

A finished epoch is frozen on the first XP accrual tick after its boundary,
i.e. within about ten minutes. Nothing needs to be triggered.

### 2. Page the frozen board

```ts
const res = await client.getLeaderboardEpochSnapshot(1, page, 10);
if (res.ok) {
  const { totalUsers, data, method } = res.data;
  // data: [{ place, address, points, epochPoints }]
}
```

The shape mirrors `getLeaderboard`: `total`/`page`/`limit`/`data`, `place`
continuous across pages, so the same table component renders both.

What the numbers mean:

- **`points`** — cumulative XP at the epoch's end: everything earned since
  the start of the leaderboard, across all epochs so far, referral bonuses
  included. This is the number the live board displayed at that moment.
- **`epochPoints`** — what was earned inside this epoch alone (`points`
  minus the wallet's `points` in the previous epoch's snapshot). Use it
  for "epoch winners"; it can be negative only if someone's total was
  corrected out-of-band, which is worth surfacing rather than hiding.
- **`place`** — positional, under the same ordering as the live list
  (points, then account age, then address). Every user has a distinct
  place, including the zero-XP tail, so `totalUsers` equals the live
  `total` at the time.

`method` tells how the snapshot was produced. `capture` means it was copied
live at the boundary and is exact by construction. `rewind` means the
backend reconstructed it later from the accrual logs (only happens when the
feature ships after an epoch already ended, as with epoch 1); it is
accurate to the accrual tick and carries no product-level caveat.

### 3. A wallet's place in that epoch

```ts
const res = await client.getLeaderboardEpochUser(1, wallet);
if (res.ok) {
  const { place, points, epochPoints, totalUsers } = res.data; // "#place of totalUsers"
}
```

This is the place the wallet held **in the snapshot**, which is not its
live rank today. A 404 means the wallet was not on the board when the epoch
ended (it joined later). Same `{ success, data }` envelope as
`getLeaderboardUser`, unwrapped by the SDK.

### Boundaries

An epoch's `end` is exclusive: it is the exact instant the next epoch
began (`2026-09-16T00:00:00Z` for epoch 1). The snapshot includes every
accrual stamped before that instant and none at or after it.

## Campaign snapshots

### 1. List campaigns and their status

```ts
const res = await client.getCampaignHistory();
if (res.ok) {
  for (const c of res.data) {
    // c.ended      — the window has closed
    // c.finalized  — frozen results exist (grace period after the end, see below)
  }
}
```

Every campaign in the registry comes back, newest first, including one
that is still running (`ended: false`). Today the list holds `swap-xp-2`
and `swap-xp-1`, both ended and finalized.

### 2. Final standings

```ts
const res = await client.getCampaignSnapshotTop("swap-xp-2", page, 10);
if (res.ok) {
  const { prizes, total, data } = res.data;
  // data: [{ place, address, swapXp, swapVolumeUsd, prizeUsd, joinedAt }]
}
```

Same shape as `getCampaignTop`, plus two things the live endpoint does not
have: **`prizeUsd` already resolved per row**, and the prize tiers in the
header. A results page no longer needs to fetch `getCampaignInfo` and join
`prizes` to places on the client.

Only participants with swap XP > 0 are ranked (`total`); wallets that
joined but never swapped are counted in `totalParticipants` and answer
`participating: true` on the per-wallet call.

### 3. A wallet's result

```ts
const res = await client.getCampaignSnapshotUser("swap-xp-2", wallet);
if (res.ok) {
  const { participating, place, swapXp, prizeUsd, totalRanked } = res.data;
  // place === null ⇒ did not join, or joined and earned no swap XP
}
```

Public by address — no SIWS needed, unlike the live `getCampaignRank`,
because frozen results are public information.

### The grace period

A campaign is `ended` the instant its window closes, but `finalized` only
**24 hours later**. Standings are computed from indexed swaps by their
on-chain time, and the indexer keeps landing late transactions for a
while; freezing earlier would immortalize a table missing legitimate
swaps. During those 24 hours the live campaign endpoints
(`getCampaignInfo`, `getCampaignTop`, `getCampaignRank`) still serve the
same, already window-bounded, table — so the pattern is:

```ts
const history = await client.getCampaignHistory();
const c = history.ok ? history.data.find((x) => x.campaign === slug) : undefined;
if (c?.finalized) {
  // frozen: getCampaignSnapshotTop / getCampaignSnapshotUser, staleTime Infinity
} else {
  // live: getCampaignTop / getCampaignRank as before
}
```

## Errors

All snapshot reads return a plain 404 (`res.ok === false`, HTTP 404) for:

- an epoch that has not ended (`Epoch 2 has not ended yet`) or not
  started, or `epoch < 1`;
- an ended epoch whose snapshot is not written yet (minutes after a
  boundary);
- a campaign slug that is not in the registry, or one not finalized yet;
- a wallet absent from an epoch snapshot.

Treat "unknown" and "not yet" the same way in the UI: show the empty
state, and for campaigns fall back to the live endpoints.

## Caching guidance

React-query keys should hang off the existing roots, one level deeper:

```ts
leaderboard.epochSnapshot: (epoch, page, limit) => [...queryKeys.leaderboard.all, 'epoch', epoch, { page, limit }]
leaderboard.epochUser:     (epoch, address)     => [...queryKeys.leaderboard.all, 'epoch', epoch, 'user', address]
campaign.history:          ()                   => [...queryKeys.campaign.all, 'history']
campaign.snapshotTop:      (slug, page, limit)  => [...queryKeys.campaign.all, slug, 'top', { page, limit }]
campaign.snapshotUser:     (slug, address)      => [...queryKeys.campaign.all, slug, 'user', address]
```

Use `staleTime: Infinity` and no `refetchInterval` for anything that
returned successfully — it cannot change. Keep `getCampaignHistory` and
`getLeaderboardEpoch` on their usual short `staleTime`, since those are the
signals that flip from "not yet" to "frozen".
