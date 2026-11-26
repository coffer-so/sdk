# @coffer_so/sdk

Client library for the **v6** Coffer Pool AMM contracts on Solana. Targeted
at both frontend and backend consumers; no bundler-specific code.

Glossary: **LP token** (formerly "BPT") is the pool's liquidity-provider
mint; **Coffer Pool** / `coffer_pool` (formerly "Cubic Pool" / `cubic_pool`)
is the AMM program. 0.2.0 renamed the whole TypeScript surface accordingly,
with no deprecated aliases — see the [changelog](CHANGELOG.md#020--rename-bpt--lp-cubic--coffer-drop-the-extension-policy)
for the migration table. The on-chain PDA seed bytes (`"cubic_pool"`,
`"bpt_mint"`) are unchanged; only the constants' names are (`POOL_SEED`,
`LP_MINT_SEED`).

## Contract compatibility

`@coffer_so/sdk` 2.1 targets the production v6.1 upgrade of the existing v5.1
factory. `getConfig("mainnet")` uses the four program addresses compiled into
`contracts-v6.1` at `2a922f9`. Pool, LP mint and treasury addresses are stable
across the upgrade. The SDK reads both the 1683-byte v5 layout and the 2304-byte
v6.1 layout. After the program upgrade, the first supported write to an old pool
can prepend its permissionless layout migration. Use the 1.x SDK for v5 writes
until the on-chain programs are upgraded.

For the independent v6 factory use
`getConfig("mainnet", { programs: MAINNET_V6_STANDALONE_PROGRAMS })`.
For the v6.1 Devnet stand use
`getConfig("devnet", { programs: DEVNET_V61_PROGRAMS })`.

The package also ships the `coffer_rewards` IDL and builders (boosts, [REWARDS.md](docs/REWARDS.md)) and the Coffer backend API client (`CofferBackendClient`).

## Install

```bash
npm install @coffer_so/sdk
# or
yarn add @coffer_so/sdk
```

Workspace-local development (linking against the in-repo source):

```bash
cd sdk
npm install
npm run build
```

The runnable examples use Node.js 20.12 or newer. Examples 01 and 08 load the
workspace `.env`; set `COFFER_API_URL=http://localhost:3001` to use the local backend.

From sibling packages:

```json
{
  "dependencies": {
    "@coffer_so/sdk": "file:../sdk"
  }
}
```

## Quick start

```ts
import { getConfig, CofferPoolClient, CofferBackendClient } from "@coffer_so/sdk";
import { PublicKey } from "@solana/web3.js";

const config = getConfig("mainnet", {
  backendEndpoint: process.env.COFFER_API_URL ?? "https://api.coffer.so",
  // Optional: put your paid RPC first; SDK falls back to the defaults below.
  rpcEndpoints: [
    process.env.COFFER_RPC_URL!,
    "https://api.mainnet-beta.solana.com",
    "https://solana-rpc.publicnode.com",
    "https://solana.api.pocket.network",
  ],
  rpcTimeoutMs: 2_000,
  slippageHundredthsBps: 30_000, // 3 %
});

const pool = new CofferPoolClient({
  config,
  poolAddress: new PublicKey("..."),
});

const res = await pool.sync();
if (!res.ok) {
  // res.error.humanMessage is safe to render to users
  console.error(res.error.humanMessage);
  return;
}
const info = res.data;
// info.tokens[i].metadata contains ticker / logo / decimals
// info.tokens[i].actualBalance is a bn.js BN in native units
```

## Architecture

```
config/       CofferConfig, program IDs per network, token registry
types/        Result<T> shape, PoolInfo, SwapQuote, AddLiquidityQuote,
              RemoveLiquidityQuote, CofferPoolEvent
utils/        Error mapping, retry wrapper (safeCall), PDA helpers
math/         Pure math — ports of the v6 coffer-pool + stld Rust math, the
              swap simulator and the zap planner
parsers/      Binary layout decoders for CofferPool / Mint / events
clients/      RpcClient, CofferBackendClient, CofferPoolClient, PlannedZapClient,
              AdminClient, PoolFactoryClient
idl/          Anchor IDL exports generated from the current contracts
examples/     Runnable scripts demonstrating each capability
```

`RpcClient` starts with its last successful endpoint and rotates through
`config.defaults.rpcEndpoints` after a retryable failure.
If one endpoint times out or returns a transient provider error, the SDK tries
the next endpoint instead of waiting on the same RPC. Mainnet defaults are
no-key public endpoints; production frontends should prepend their paid RPC via
`getConfig("mainnet", { rpcEndpoints: [...] })`.

Client sync and quote methods return `SdkResult<T>`: `{ ok: true, data }` or
`{ ok: false, error: { code, humanMessage, cause? } }`. Pure math, parsers and
low-level instruction builders throw on invalid input.

## What lives in the SDK vs the frontend

**In the SDK:**
- All on-chain account parsing (pool, mint, events)
- All math (quote, allocations, slippage, price impact)
- All transaction building (swap, add/remove liquidity, planned single-token deposit, pool deploy)
- The off-chain zap planner and the Token-2022 hook/memo tail resolver
- Current Anchor IDLs for `coffer_pool`, `single_token_liquidity`,
  `protocol_admin` and `coffer_rewards`
- Retry + fallback for RPC and backend calls
- Event log decoding

**In the application:** UI/state, wallet signing, transaction submission and
confirmation, native SOL wrapping, token-account setup (the SDK hands you the
idempotent-create instructions) and wallet-ALT setup for large pools. Use the
SDK quote and ABI helpers for contract math and encoding; direct
`rpc.connection` calls bypass its fallback wrapper.

## v0 transactions + per-pool ALT

Multi-token pools (especially 7–10 token ones) exceed Solana's 1232-byte
legacy transaction wire ceiling on `add_liquidity` /
`remove_liquidity`. The contract provisions an **Address Lookup Table
(ALT) per pool** via `initialize_pool_alt`. After init the ALT is
frozen and its address is recorded on `pool.lookup_table`.

Builders return instructions. Call `compileBuiltTx` to fetch the pool's ALT and
compile a v0 transaction. The wallet supplies signatures and the caller sends it.

```ts
import { compileBuiltTx } from "@coffer_so/sdk";

const built = client.buildRemoveLiquidityTx({ user, lpAmount, minimumTokenAmounts });
if (!built.ok) throw new Error(built.error.humanMessage);
const compiled = await compileBuiltTx(connection, user, built.data, info);
if (!compiled.ok) throw new Error(compiled.error.humanMessage);
// Sign compiled.data.tx with the wallet, then send and confirm it.
```

### Provisioning an ALT for a new pool

```ts
import { buildInitializePoolAltTx } from "@coffer_so/sdk";

const recentSlot = new BN(await connection.getSlot("finalized"));
const { instructions, lookupTable } = buildInitializePoolAltTx(config, {
  pool: poolPubkey,
  config: poolConfigPubkey,    // from pool.config — required
  authority: poolAdmin,         // pool admin OR config.protocol_admin
  payer: poolAdmin,             // funds the table; rent depends on its size
  recentSlot,
});
// Sign, send, confirm, then sync the pool. Wait for a later slot before
// using newly added ALT addresses in a dependent transaction.
```

**Account fields:**
- `pool` — `CofferPool` account
- `config` — the `CofferPoolConfig` the pool is pinned to (read for the
  alternative-authority check). Always required.
- `authority` — signs the create+extend+freeze CPIs. Either
  `pool.pool_admin` or `config.protocol_admin` (Treasury PDA, only
  reachable via `protocol_admin.pool_initialize_alt`). ALT pubkey is
  derived from `[authority, recent_slot]`.
- `payer` — pays ALT rent. Decoupled from `authority` because
  Treasury PDA can't be a `system_program::transfer` source (carries
  data). For the pool-admin path, pass the same key as `authority`.

ALT rent depends on the address count and the current rent calculation.
The contract freezes the table; it cannot then be closed to reclaim that rent.

## Token-2022 support

Pools may mix the classic SPL Token program and Token-2022. Every
`PoolTokenInfo` carries `tokenProgram`, `extensions`, `transferFee` (the
schedule in force at the snapshot epoch), `transferHookProgram` (armed hooks
only) and `paused`, all decoded on `sync()`. Builders thread
`token.tokenProgram` through ATA derivation and remaining-accounts assembly.

The v6 program moves every token with `transfer_checked`, nets transfer fees
on both legs and forwards a remaining-account tail to armed hooks and to the
memo program. The SDK:

- nets fees in every quote (`transferFeeIn/Out`, `amountOutReceived`,
  `chargedAmounts` vs `creditedAmounts`, `receivedAmounts`);
- resolves the tail (`resolveSwapExtraAccounts`, …, `PlannedZapClient.resolveExtraAccounts`)
  and appends it through `extraAccounts`;
- refuses only what the program refuses: `NonTransferable`, the Token-2022
  native mint, unknown extension types, and any **paused** mint
  (`unsupported_token_extension`). Hooks that need an extra signer or a core
  account are outside the supported profile.

The LP mint defaults to classic SPL Token; `lpTokenProgram` can select
Token-2022 for joins/exits, but the planned zap requires a plain LP mint.

There is no Token-2022 extension *policy* any more (v6.1, T19): the pool
creator decides which mints go into a pool, and consumers disclose what the
mints carry — `PoolTokenInfo.extensions` / `parseMintExtensions` /
`mintExtensionName` are the data source for such an alert. The former
`banned_extensions` bytes stay in the account layouts as
`RawPoolAccount.deprecatedBannedExtensions` / `_deprecated_extension_policy`
and must not be interpreted.

## Examples

See `examples/*.ts`:

- `01-init-sdk.ts` — initialisation patterns
- `02-fetch-pool.ts` — parse pool state
- `03-quote-swap.ts` — swap quote with slippage
- `06-single-token-deposit.ts` — planned single-token deposit: snapshot, plan, tail, packet budget
- `08-backend-stats.ts` — statistics via CofferBackendClient

Run: `npx ts-node examples/<name>.ts`.

## Error handling pattern

```ts
const res = await pool.sync();
if (!res.ok) {
  toast.error(res.error.humanMessage);
  logger.debug(res.error.cause);
  return;
}
const poolInfo = res.data;
```

The SDK's `safeCall` helper retries transient errors up to 3 times with
configurable backoff (default schedule: 200ms / 500ms / 1500ms). Permanent
errors (parse failure, invalid input, insufficient funds, HTTP 4xx other than
429) short-circuit.

`toSdkError` classifies by structure first, then by text:

| Failure | `code` | Retried by default |
| --- | --- | --- |
| Backend `fetch` rejected — no HTTP answer (Chrome "Failed to fetch", Safari "Load failed", Firefox "NetworkError when attempting to fetch resource.", Node "fetch failed", CORS), or the response body broke off | `backend_unavailable`, `humanMessage` "Backend unreachable: <original message>" | yes |
| Backend `fetch` refused before sending (invalid URL such as `apiEndpoint` without `https://`, invalid header value) | `unknown`, original message | no |
| Backend HTTP 2xx whose body is not JSON | `backend_invalid_response` | no |
| Backend HTTP 5xx | `backend_unavailable` | yes |
| Backend HTTP 429 | `rpc_rate_limited` | yes |
| Backend HTTP 401/403/404/… | `unknown`; `cause.status` holds the status | no |
| `TimeoutError`, or the per-attempt timeout (`timed out after …`) | `rpc_timeout` | yes |
| RPC network failure (web3.js "fetch failed", "…: TypeError: Failed to fetch") | `rpc_unavailable` | yes, next endpoint |
| RPC HTTP 5xx from web3.js ("502 Bad Gateway: …", "…: Error: 503 Service Unavailable: …") | `rpc_unavailable` | yes, next endpoint |
| RPC "429 Too Many Requests" / "403 Forbidden" from web3.js | `rpc_rate_limited` / `rpc_unavailable` | yes, next endpoint |

For backend HTTP errors `humanMessage` stays `"METHOD path → HTTP nnn
statusText"`, so matching `HTTP 404` keeps working; prefer
`(res.error.cause as { status?: number })?.status`. Digits inside the
request path or in a JSON parse error never change the class of a backend
error. Exceptions to the default policy: `claimAttribution` retries only
transport errors and timeouts (any HTTP status, 429 included, is final), and
`verifySignature` / `verifyTransaction` retry only HTTP 429 — their nonce is
single-use and the backend consumes it before the signature check, so a
resend after a lost response, a timeout or a 5xx (which can arrive after the
nonce is gone) would answer "nonce already used" (401) and hide the real
outcome. A failed token refresh logs the user out (`clearTokens` +
`onAuthExpired`) only when the backend rejects the refresh token (HTTP
400/401); when the refresh gets no answer the tokens are kept and the
original 401 is returned. The per-attempt timeout does not abort the underlying
`fetch` (no `AbortController`); the request may still complete server-side.

## Public operation surface

| Client / helpers | Public operations |
| --- | --- |
| `CofferPoolClient` | `sync`, `getCached`, `quoteSwap`, `quoteSeedDeposit`, `quoteAddLiquidity`, `quoteRemove`, `resolve*ExtraAccounts`, swap/add/remove transaction builders, `plannedZap` getter, `quotePlannedZap`, `parseEventsFromLogs` |
| `PlannedZapClient` | `quote`, `replayAt`, `ensureUserTokenAccountIxs`, `resolveExtraAccounts`, `buildIx`, `buildTx`, `walletLookupAddresses`, `prepareWalletLookupTable`, `waitForWalletLookupTable`, `poolLookupTable`, `compileTransaction`; see [PLANNED_ZAP.md](docs/PLANNED_ZAP.md) |
| `PoolFactoryClient` | `buildDeployPoolTx`, `buildInitializeConfigTx`, `initializePoolIx` |
| `AdminClient` | Treasury initialization/rotation, supervisor, fee collection/withdrawals, pool configuration/activation/ALT, STLD helper SOL / token-account recovery, program upgrades/authority transfer/freeze/close; all 58 protocol-admin instructions |
| Generic ABI | `buildContractInstruction` for all 120 instructions; `decodeContractAccount` for all declared accounts; `decodeContractEvent`/`parseContractEvents` for all 87 events; `parseTransactionEvents` with invoke-stack attribution ([EVENTS.md](docs/EVENTS.md)) |
| Raw builders | `build*Ix`/`build*Tx` for swaps, liquidity, pool/config/ALT initialization, fee/sell-off/range management and pool-admin rotation; `buildPlannedZapIx`, `stateCommitment`, `compilePlannedZapTransaction`; `resolveTransferExtraAccounts` |
| RPC/HTTP | `RpcClient`, `CofferBackendClient`; see [backend version scope](docs/BACKEND_COMPATIBILITY.md) |
| XP snapshots | Frozen results of finished epochs and campaigns — `getLeaderboardEpochSnapshot`, `getCampaignSnapshotTop`, …; see [XP snapshots guide](docs/XP_SNAPSHOTS.md) |
| Attribution | `recordAttributionLanding` (public, idempotent by `touchId`) and `claimAttribution` (JWT) for UTM touches; anonId storage and `sendBeacon` stay in the app, see [backend version scope](docs/BACKEND_COMPATIBILITY.md) |
| Public profiles | `getPublicProfile` (by address, username or `@username`), `getProfileCards` (public); `getMyProfile`, `updateMyProfile`, `setUsername`, `uploadAvatar`, `removeAvatar` (JWT); leaderboard, campaign, referral and pool-transaction rows carry a `profile` card; see [profiles guide](docs/PROFILE.md) |
| Public portfolio | `getPublicPortfolioChart`, `getPublicPortfolioActivity`, `getPublicPortfolioHoldings`, `getPublicPortfolioPositions` (public, any wallet by address or username) — the portfolio v2 views for a profile page, without Net Worth and wallet tokens; see [portfolio v2 guide](docs/PORTFOLIO_V2.md#public-portfolio-of-any-wallet) |
| Pool admin | `getAdminPools`, `isPoolAdmin`, `renamePool`, `updatePoolSettings` (base asset, description, `additionalUrl`), `uploadPoolImage`, `removePoolImage` (JWT + on-chain pool admin); see [pool admin guide](docs/POOL_ADMIN.md) |
| Rewards (boosts) | `getRewardBoosts`, `getRewardCampaigns`, `getWalletRewards`, `requestRewardVoucher` (public); `buildRewardClaimTx` + `loadRewardClaimState` for the claim, voucher/PDA/decoder helpers and coffer_rewards admin builders; `boost` / `boostAprPct` on pools; see [rewards guide](docs/REWARDS.md) |

`getCached()` is the actual cache accessor; there is no `getState()`, `swap()`,
or `getSwapQuote()` method. `pool.plannedZap` is a client getter, not a
callable deposit function. Raw builders and AdminClient instruction methods
construct instructions; the caller signs and sends them.
`AdminClient.initializeTreasuryIfMissing` is the explicit exception that can
submit an initialization through the supplied Anchor provider.

### Quotes and input floors

```ts
// All amounts are BN in raw mint units; vector order is the pool token order.
const swap = pool.quoteSwap(inIndex, outIndex, amountIn, slippageHbps, nowSeconds);
const seed = pool.quoteSeedDeposit(user, tokenAmounts, slippageHbps);
const join = pool.quoteAddLiquidity(tokenAmounts, slippageHbps);
const exit = pool.quoteRemove(lpIn);
const zap = await pool.plannedZap.quote(inIndex, amountIn, { slippageHundredthsBps, validForSlots, nowSeconds });
```

`nowSeconds` is optional Unix seconds; omitted uses the Solana Clock from
`sync()` (or, for the zap, from its own snapshot).

- Swap `amountOut` is the vault debit net of the surge fee; `amountOutReceived`
  subtracts the output mint's transfer fee and is what `minAmountOut` protects.
  `feeAmount` and `protocolFeeAmount` use the input token (net of its fee).
- Join `tokenAmounts` are spend ceilings. Display `creditedAmounts` as the pool
  credit, `chargedAmounts` as the wallet debit (credit + transfer fee) and
  `unspentAmounts` as what stays. Seed uses exact amounts.
- Exit `effectiveLpIn` may be smaller than requested to preserve 1,000 raw LP. If direct external burns already reduced supply to
  that floor or below, rc2 permits redemption of the remaining full supply, and a burn of the
  whole supply pays no withdraw fee; `receivedAmounts` is what lands in the wallet. Derive
  `minimumTokenAmounts` from it.
- Join, exit, zap and redemption quotes are priced on the LP supply net of the vested LP burn
  stream (`pricedLpSupplyOf(pool, nowSeconds)`), exactly as the program prices them; pass
  `nowSeconds` to `quoteAddLiquidity` / `quoteRemove` to price at the transaction's clock.
- Add/zap builders require a **positive** LP floor at runtime, even though the
  compatibility interfaces retain it as optional. Remove builders require an
  explicit `minimumTokenAmounts` vector.
- Token-2022 hooks/memos: pass the resolved tail as `extraAccounts`.

`buildDeployPoolTx` initializes the pool and LP mint without seeding or creating
reserve vault ATAs. `buildAddLiquidityTx` creates the user's LP ATA, but the
user's input-token accounts and pool reserve vaults must already exist. The
planned zap needs every user token account and the LP account to exist:
`ensureUserTokenAccountIxs` returns the idempotent creates to send first.
For 7+-token pools compile the zap with the pool ALT plus a wallet-owned ALT
(`prepareWalletLookupTable`); neither quoting nor compiling creates an ALT.

The complete typed event API keeps snake_case fields and full-width BN values.
The camelCase `parseCofferPoolEvents` API recognizes all 81 current events
(typed `…V2` shapes for the trading / liquidity / admin events, the IDL coder
for the rest) with numeric timestamps; pre-T11 (v6) discriminators and the
retired `PoolStateLog` / `MaxSelloffWindowAdvanced` / `SingleTokenDeposit`
are reported as `Unknown { legacy }`. Malformed/truncated events become
`Unknown`; it is not proof of program provenance or transaction success —
`parseTransactionEvents` attributes lines to the invoke stack.
