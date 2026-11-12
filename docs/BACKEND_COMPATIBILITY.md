# Backend API version scope

The SDK's HTTP interface and a server deployment can have different release schedules.
This table checks **local backend-v2 branch `v5.1` at `a886497`**, not the live server.
A TypeScript return type does not prove that a route exists or validate its JSON.

| SDK methods | Checked backend coverage |
| --- | --- |
| Pool discovery, `listPoolsRaw`, `getPoolRaw`, `getPoolsByTokenPair`, token lists, transactions, platform stats | Implemented under `/api/pools` |
| `getSwapRoute` | Route exists, but this revision does not accept the SDK's `slippageBps`/`pool` options or emit `minReceived`/per-leg `minAmountOut` |
| `getStats` | `/api/stats/:metric`; flat points, timestamps in milliseconds; `all` means 365 days and `unit` is ignored |
| `getNonce`, `verifySignature`, refresh through `setTokens` | SIWS routes implemented; signature is **base64**, not base58 |
| `getAdminPools`, `isPoolAdmin`, `renamePool` | JWT-protected pool metadata routes implemented |
| `getPortfolioSummary/Exposure/History/Pools/PoolHistory` | JWT-protected portfolio routes implemented |
| Leaderboard methods and referral methods | Implemented; XP is processed in three-hour jobs |
| `getTxChallenge`, `verifyTransaction` | No matching `/api/auth/tx-challenge` or `/api/auth/verify-tx` controller in this revision |
| `getTokenPrices` | No matching `/api/prices` controller |
| `getTokenPairChart` | No matching `/api/tokens/pair-chart` controller |
| `updatePoolSettings` | No matching pool `/settings` controller |
| `getPortfolioChart/Activity/Holdings/Positions` | No matching portfolio v2 controllers |
| Campaign methods | No matching campaign controllers |
| Snapshot methods (`getLeaderboardEpochSnapshot`, `getLeaderboardEpochUser`, `getCampaignHistory`, `getCampaignSnapshotTop`, `getCampaignSnapshotUser`) | No matching controllers in this revision — they need the backend that ships `XpEpochSnapshot`/`CampaignSnapshot` (September 2026); see [XP_SNAPSHOTS.md](XP_SNAPSHOTS.md) |
| `recordAttributionLanding`, `claimAttribution` | No matching `/api/attribution/*` controllers in this revision — they need the backend that ships the attribution module (November 2026); browser-side anonId, cookie and beacon logic is described in the backend's `docs/ATTRIBUTION.md`, not in the SDK |
| Profile methods (`getPublicProfile`, `getProfileCards`, `getMyProfile`, `updateMyProfile`, `setUsername`, `uploadAvatar`, `removeAvatar`) and the optional `profile` card on leaderboard, epoch/campaign snapshot, campaign top, referral and pool-transaction rows | No matching `/api/profiles/*` and `/api/profile/me*` controllers in this revision, and its rows carry no `profile` — they need the backend that ships the profile module (November 2026); these routes answer flat JSON; see [PROFILE.md](PROFILE.md) |
| `uploadPoolImage`, `removePoolImage`; `additionalUrl` in `updatePoolSettings` / `createPool`; `imageUrl` / `additionalUrl` on pool objects, `AdminPoolEntry` and `pool` of portfolio v2 positions / activity | No matching `/api/pools/admin/:address/image` routes or fields in this revision — they need the backend that ships pool images (November 2026; the same release makes `renamePool` accept only 1–12 English letters and digits); the image routes answer `{ success, data }`, unwrapped by the SDK; see [POOL_ADMIN.md](POOL_ADMIN.md) |

Construct the client with `new CofferBackendClient({ apiEndpoint })`. Its optional
`apiKey` initializes Bearer authorization, not a global `X-Coffer-Api-Key` header.
Public discovery reads have no such global key requirement in the checked source.
Wallet JWT, internal admin keys and Layer3 integration keys serve separate roles.

HTTP failures are classified by status, not by message text (since 1.4.6): a
rejected `fetch` with no answer (including a CORS-blocked response) or a
response body that broke off, and HTTP 5xx are `backend_unavailable`, 429 is
`rpc_rate_limited`, every other status is `unknown` with `cause.status` set
and `humanMessage` = `"METHOD path → HTTP nnn statusText"`. A `fetch` the
runtime refused to send (invalid URL or header value) is `unknown` with the
original message and a non-JSON 2xx body is `backend_invalid_response`; both
are final. Transport errors, timeouts, 429 and 5xx are retried (3 attempts)
except where a method says otherwise: `claimAttribution` retries only
transport errors and timeouts, `verifySignature`/`verifyTransaction` only 429
(single-use nonce, consumed before the signature check, so a 5xx may come
after it is gone). A 401 triggers one refresh via `/api/auth/refresh`,
detected by `cause.status === 401`; only a 400/401 from the refresh clears
the tokens and calls `onAuthExpired`, a refresh with no answer keeps them. For browser calls the
page origin must be in the backend's `CORS_ORIGINS`; otherwise every response
reads as `backend_unavailable`.

Most pool routes return a `{ success, data }` envelope; paginated pool lists also
include `hasMore` and `totalCount`. `listPoolsRaw` and `getPoolRaw` unwrap these.
The older `listPools/getPool` declarations describe simpler shapes than those
methods actually normalize; prefer the raw-named methods with this backend.
Statistics and leaderboard list routes can return flat JSON. Do not assume one
response envelope for all generic HTTP calls.

The checked router uses its own surrounding reserve/fee logic around
`calcOutGivenIn`, not `CubicPoolClient.quoteSwap`. It still subtracts protocol
fees from v5 actual output balances, uses indexed fee metadata and omits the
current sell-off/surge path. Re-sync and quote proposed legs with the current
SDK before deriving signed output floors; server estimates are not executable
v5 guarantees. Source findings here do not establish the behavior of another
backend deployment.

Other backend guides describe SDK-declared interface shapes. For methods absent
from this source revision, treat those shapes as the integration contract for a
server that implements them, rather than evidence of current runtime support.
