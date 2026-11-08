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

- `@coffer_so/sdk` (already used for API calls)
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
import { CofferBackendClient, AuthTokens } from "@coffer_so/sdk";

const STORAGE_KEY_ACCESS = "coffer_access_token";
const STORAGE_KEY_REFRESH = "coffer_refresh_token";

const client = new CofferBackendClient({
  apiEndpoint: "https://api.coffer.so",

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

1. A request to a protected endpoint returns **401** (detected by the HTTP
   status on `error.cause.status`, not by message text)
2. SDK sends `POST /api/auth/refresh` with the stored refresh token
3. If refresh succeeds:
   - New tokens are set internally
   - `onTokenRefreshed` callback fires (frontend updates localStorage)
   - Original request is retried with the new access token
4. If the backend rejects the refresh token (HTTP 401 expired/invalid, or
   400 malformed):
   - Both tokens are cleared and `onAuthExpired` fires (frontend clears
     storage, shows sign-in)
   - Original request returns the error
5. If the refresh gets no answer (offline, timeout, HTTP 5xx after retries):
   - Tokens are kept and `onAuthExpired` does **not** fire
   - Original request returns its 401; the next protected request tries the
     refresh again

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

The nonce is single-use, so this call (and `verifyTransaction`) retries only
an HTTP 429 (the rate limiter answers it before the nonce is touched). A
transport error, a timeout or an HTTP 5xx is returned at once: the backend
consumes the nonce before it checks the signature, so the server may already
have consumed it (and even issued tokens) before a 500 from the handler or a
502/504 from the proxy, and a resend would only answer "nonce already used"
(401). On `backend_unavailable` or `rpc_timeout`, request a fresh nonce and
sign again.

### `client.setTokens(accessToken: string, refreshToken: string)`
Set both tokens. Call after sign-in and on page load (restore from storage).

### `client.clearTokens()`
Remove both tokens (logout).

## Error Handling

```ts
const res = await client.verifySignature(message, signature);
if (!res.ok) {
  const status = (res.error.cause as { status?: number } | undefined)?.status;
  if (status === 401 || status === 400) {
    // Signature invalid, nonce expired/used, or message tampered
    // (code "unknown", humanMessage "POST /api/auth/verify → HTTP 401 …")
  } else if (res.error.code === "backend_unavailable" || res.error.code === "rpc_timeout") {
    // No answer (offline, "Failed to fetch"), timeout or HTTP 5xx: get a new
    // nonce and sign again later — the old nonce may already be consumed
  } else {
    console.error(res.error.humanMessage);
  }
}
```

`backend_unavailable` is returned when the backend `fetch` itself rejects
with no answer (Chrome "Failed to fetch", Safari "Load failed", Firefox
"NetworkError when attempting to fetch resource.", Node "fetch failed"), when
the response body breaks off, and on HTTP 5xx (then `cause.status` is set).
HTTP 4xx other than 429 comes back as `unknown` with `cause.status`; 429 is
`rpc_rate_limited`. A request the runtime refused to send (invalid URL or
header value) is `unknown` with the original message, and a 2xx body that is
not JSON is `backend_invalid_response`; neither is retried.
