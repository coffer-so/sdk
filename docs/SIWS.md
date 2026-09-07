# Sign In With Solana (SIWS) — Frontend Integration Guide

## Overview

Cubee uses **Sign In With Solana (SIWS)** for wallet-based authentication. The flow:

1. Request a nonce from the backend
2. Sign the returned message with the wallet
3. Submit the signature to receive an access token + refresh token
4. Use the access token for authenticated API calls
5. SDK auto-refreshes when the access token expires

Sign the exact backend message and encode the signature bytes as base64.
`getTxChallenge`/`verifyTransaction` are SDK-declared alternatives without
matching routes in checked backend `v5.1@a886497`; do not assume they are
available for Ledger sign-in. See [backend scope](BACKEND_COMPATIBILITY.md).

## Prerequisites

- `@cubee_ee/sdk` (already used for API calls)
- `@solana/wallet-adapter-react` (already used for wallet connection)

No additional dependencies needed.

## Token Storage

The SDK does **not** persist tokens. The frontend must:

1. After sign-in: save both `accessToken` and `refreshToken` to `localStorage`
2. On page load: read tokens from `localStorage` and call `client.setTokens()`
3. On auto-refresh: update `localStorage` via `onTokenRefreshed` callback
4. On logout / auth expiry: clear `localStorage`

## Integration

### Setup with Callbacks

```tsx
import { CubeBackendClient, AuthTokens } from "@cubee_ee/sdk";

const STORAGE_KEY_ACCESS = "cubee_access_token";
const STORAGE_KEY_REFRESH = "cubee_refresh_token";

const client = new CubeBackendClient({
  apiEndpoint: "https://api.cubee.ee",

  // Called when SDK auto-refreshes tokens after a 401
  onTokenRefreshed: (tokens: AuthTokens) => {
    localStorage.setItem(STORAGE_KEY_ACCESS, tokens.accessToken);
    localStorage.setItem(STORAGE_KEY_REFRESH, tokens.refreshToken);
  },

  // Called when both tokens are expired — user must re-sign
  onAuthExpired: () => {
    localStorage.removeItem(STORAGE_KEY_ACCESS);
    localStorage.removeItem(STORAGE_KEY_REFRESH);
    // Trigger re-authentication UI (e.g. show "Sign in" button)
  },
});

// Restore tokens on page load
const savedAccess = localStorage.getItem(STORAGE_KEY_ACCESS);
const savedRefresh = localStorage.getItem(STORAGE_KEY_REFRESH);
if (savedAccess && savedRefresh) {
  client.setTokens(savedAccess, savedRefresh);
}
```

### Sign-In Hook

```tsx
import { useWallet } from "@solana/wallet-adapter-react";
import { useCallback } from "react";

export function useAuth() {
  const { publicKey, signMessage } = useWallet();

  const signIn = useCallback(async () => {
    if (!publicKey || !signMessage) {
      throw new Error("Wallet not connected");
    }

    // 1. Request nonce
    const nonceRes = await client.getNonce(publicKey.toBase58());
    if (!nonceRes.ok) throw new Error(nonceRes.error.humanMessage);

    // 2. Sign the message
    const messageBytes = new TextEncoder().encode(nonceRes.data.message);
    const signatureBytes = await signMessage(messageBytes);
    const signatureBase64 = btoa(String.fromCharCode(...signatureBytes));

    // 3. Verify and get tokens
    const authRes = await client.verifySignature(
      nonceRes.data.message,
      signatureBase64,
    );
    if (!authRes.ok) throw new Error(authRes.error.humanMessage);

    // 4. Persist tokens and set on client
    localStorage.setItem(STORAGE_KEY_ACCESS, authRes.data.accessToken);
    localStorage.setItem(STORAGE_KEY_REFRESH, authRes.data.refreshToken);
    client.setTokens(authRes.data.accessToken, authRes.data.refreshToken);

    return authRes.data;
  }, [publicKey, signMessage]);

  const signOut = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY_ACCESS);
    localStorage.removeItem(STORAGE_KEY_REFRESH);
    client.clearTokens();
  }, []);

  return { signIn, signOut };
}
```

## Auto-Refresh Flow

The SDK handles token refresh automatically:

1. A request to a protected endpoint returns **401**
2. SDK sends `POST /api/auth/refresh` with the stored refresh token
3. If refresh succeeds:
   - New tokens are set internally
   - `onTokenRefreshed` callback fires (frontend updates localStorage)
   - Original request is retried with the new access token
4. If refresh fails (refresh token also expired):
   - `onAuthExpired` callback fires (frontend clears storage, shows sign-in)
   - Original request returns the error

Concurrent 401s are deduplicated — only one refresh request is made.

**No wallet popup is needed for refresh.** The user only sees a popup when both tokens expire and a full re-sign is required.

## Token Lifecycle

| Token | Lifetime | Purpose |
|---|---|---|
| Access token | 24 hours | Sent in `Authorization: Bearer` header |
| Refresh token | 30 days | Used to get a new access token when it expires |

When the refresh token expires, the user must re-authenticate via SIWS (one wallet popup).

## API Reference

### `client.getNonce(wallet: string)`
Request a single-use nonce and pre-built SIWS message.
**Returns:** `SdkResult<{ nonce: string; message: string }>`

### `client.verifySignature(message: string, signature: string)`
Submit the signed message to receive tokens.
**Returns:** `SdkResult<AuthTokens>`

### `client.setTokens(accessToken: string, refreshToken: string)`
Set both tokens. Call after sign-in and on page load (restore from storage).

### `client.clearTokens()`
Remove both tokens (logout).

## Error Handling

```ts
const res = await client.verifySignature(message, signature);
if (!res.ok) {
  switch (res.error.code) {
    case "auth_failed":
      // Signature invalid, nonce expired, or message tampered
      break;
    case "backend_unavailable":
      // Server unreachable — retry later
      break;
    default:
      console.error(res.error.humanMessage);
  }
}
```
