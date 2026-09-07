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

Construct the client with `new CubeBackendClient({ apiEndpoint })`. Its optional
`apiKey` initializes Bearer authorization, not a global `X-Cube-Api-Key` header.
Public discovery reads have no such global key requirement in the checked source.
Wallet JWT, internal admin keys and Layer3 integration keys serve separate roles.

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
