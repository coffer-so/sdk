# Referral System — Frontend Integration Guide

## Overview

Cubee has a two-level referral system. Users share referral links, invitees bind themselves as referrals, and referrers earn bonus XP from their referrals' activity.

- **L1 (direct referrer):** 12% of referral's XP
- **L2 (referrer's referrer):** 6% of referral's XP

These rates are verified in local backend `v5.1@a886497`. Bonuses are processed
every three hours during XP accrual. Referred users receive a 3% boost to their
own XP. Referral bonuses use that boosted own-XP base, multiply by the level
rate and any recipient 3% boost, then round down. See
[backend version scope](BACKEND_COMPATIBILITY.md).

## Prerequisites

- User must be authenticated via SIWS (see `docs/SIWS.md`)
- `client.setTokens()` must be called before using referral methods

## Full Flow

### 1. Get Your Referral Code

Every authenticated user has a referral code (their wallet address by default, or a custom code if assigned).

```ts
const status = await client.getReferralStatus();
if (status.ok) {
  const code = status.data.customCodes[0] ?? status.data.referralCode;
  const link = `https://coffer.so?ref=${code}`;
  // Share this link
}
```

### 2. Open a Referral Link

When a new user visits `https://coffer.so?ref=<code>`, the frontend should:

1. Extract `ref` from the URL query params
2. Store it (e.g. in `localStorage`) — the user hasn't signed in yet
3. After the user signs in via SIWS, call `bindReferral`

```ts
// On page load — save ref code from URL
const params = new URLSearchParams(window.location.search);
const refCode = params.get("ref");
if (refCode) {
  localStorage.setItem("coffer_ref_code", refCode);
}
```

### 3. Bind as a Referral (after sign-in)

```ts
const refCode = localStorage.getItem("coffer_ref_code");
if (refCode) {
  const res = await client.bindReferral(refCode);
  if (res.ok) {
    // Successfully bound — clear stored code
    localStorage.removeItem("coffer_ref_code");
  } else {
    // Possible errors:
    // - "Cannot refer yourself"
    // - "Already bound to a referrer"
    // - "Invalid referral code"
    console.warn(res.error.humanMessage);
    localStorage.removeItem("coffer_ref_code");
  }
}
```

Binding is permanent — once set, it cannot be changed.

### 4. View Referral Status

```ts
const status = await client.getReferralStatus();
if (status.ok) {
  const { referredBy, referralCode, customCodes, rates, stats } = status.data;

  // Who referred me (null if nobody)
  console.log("Referred by:", referredBy);

  // My referral code for sharing
  console.log("My code:", customCodes[0] ?? referralCode);

  // My bonus rates
  console.log(`L1: ${rates.l1Percent}%, L2: ${rates.l2Percent}%`);

  // My stats
  console.log(`Direct referrals: ${stats.l1Count}`);
  console.log(`L2 referrals: ${stats.l2Count}`);
  console.log(`Total bonus XP: ${stats.totalBonusPoints}`);
}
```

### 5. List My Referrals (paginated)

```ts
const page1 = await client.getMyReferrals(1, 20);
if (page1.ok) {
  console.log(`Total referrals: ${page1.data.total}`);
  for (const ref of page1.data.data) {
    console.log(`${ref.address} — earned you ${ref.earnedBonusXp} XP — bound ${ref.boundAt}`);
  }

  // Load next page
  if (page1.data.total > 20) {
    const page2 = await client.getMyReferrals(2, 20);
    // ...
  }
}
```

## API Reference

### `client.bindReferral(code: string)`
Bind yourself as a referral. Code is a wallet address or custom code. Requires auth.
**Returns:** `SdkResult<{ referrer: string; bound: true }>`

### `client.getReferralStatus()`
Get your referral status, code, rates, and stats. Requires auth.
**Returns:** `SdkResult<ReferralStatusResponse>`

### `client.getMyReferrals(page?, limit?)`
Paginated list of your direct referrals (L1). Requires auth.
**Returns:** `SdkResult<ReferralListResponse>`

## Referral Link Format

```
https://coffer.so?ref=<code>
```

Where `<code>` is either:
- A Solana wallet address (default for all users)
- A custom string (assigned to specific users, e.g. `alice`)

The frontend is responsible for:
- Extracting `ref` from the URL
- Storing it until the user signs in
- Calling `bindReferral()` after authentication
- Building and sharing the referral link with the user's code

## Types

```ts
interface ReferralStatusResponse {
  referredBy: string | null;
  referralCode: string;       // wallet address
  customCodes: string[];      // custom codes (if any)
  rates: {
    l1Percent: number;        // e.g. 10
    l2Percent: number;        // e.g. 5
  };
  stats: {
    totalReferrals: number;
    l1Count: number;
    l2Count: number;
    totalBonusPoints: number;
    l1BonusPoints: number;
    l2BonusPoints: number;
  };
}

interface ReferralListResponse {
  total: number;
  page: number;
  limit: number;
  data: Array<{
    /** Wallet address of the referral */
    address: string;
    /** Total bonus XP this referral has earned for you */
    earnedBonusXp: number;
    /** When this user became your referral */
    boundAt: string;
  }>;
}
```
