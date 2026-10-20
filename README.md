# @coffer_so/sdk-v6

Client library for the **v6** Coffer Pool AMM contracts on Solana. Targeted
at both frontend and backend consumers; no bundler-specific code.

Glossary: **LP token** (formerly "BPT") is the pool's liquidity-provider
mint; **Coffer Pool** / `coffer_pool` (formerly "Cubic Pool" / `cubic_pool`)
is the AMM program. 0.2.0 renamed the whole TypeScript surface accordingly,
with no deprecated aliases — see the [changelog](CHANGELOG.md#020--rename-bpt--lp-cubic--coffer-drop-the-extension-policy)
for the migration table. The on-chain PDA seed bytes (`"cubic_pool"`,
`"bpt_mint"`) are unchanged; only the constants' names are (`POOL_SEED`,
`LP_MINT_SEED`).

This is a separate package from [`@coffer_so/sdk`](https://www.npmjs.com/package/@coffer_so/sdk)
(the 1.x line), which keeps tracking the v5 contracts deployed on mainnet.
Pick by the program version you talk to:

| Package | Contracts | Status |
| --- | --- | --- |
| `@coffer_so/sdk` 1.x | v5 (`main`, mainnet since 2026-09-07) | stable |
| `@coffer_so/sdk-v6` 0.x | v6 (`contracts/v6`: Token-2022 transfer fees, hooks and memos; planned single-token deposits; 100 % fee ceilings; v6 rounding) | pre-release until v6 is deployed |

## Contract compatibility

This release targets `contracts` **v6.1** — `contracts/v6` at `7d753b3`
(`feat: allow swap and protocol fee rates anywhere in 0..=100%`) plus T19
(extension policy removed) and T18 (rename). All three IDLs match the v6.1
rename sweep; `address` fields carry the v6 deployment ids. Typed
`buildContractInstruction` covers all 59 instructions, `parseContractEvents`
covers all 59 events, and `decodeContractAccount` decodes their declared
accounts. See [the compatibility notes](docs/CONTRACT_COMPATIBILITY.md) for
usage and limits, and [the exact state-field mapping](docs/STATE_FIELDS.md)
for decoded account data.

## Install

```bash
npm install @coffer_so/sdk-v6
# or
yarn add @coffer_so/sdk-v6
```

Workspace-local development (linking against the in-repo source):

```bash
cd sdk
npm install
npm run build
```

From sibling packages:

```json
{
  "dependencies": {
    "@coffer_so/sdk-v6": "file:../sdk"
  }
}
```

## Quick start

```ts
import { getConfig, CofferPoolClient, CofferBackendClient } from "@coffer_so/sdk-v6";
import { PublicKey } from "@solana/web3.js";

const config = getConfig("mainnet", {
  backendEndpoint: "https://api.coffer.so",
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
- Current Anchor IDLs for `coffer_pool`, `single_token_liquidity`, and
  `protocol_admin`
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
import { compileBuiltTx } from "@coffer_so/sdk-v6";

const built = client.buildRemoveLiquidityTx({ user, lpAmount, minimumTokenAmounts });
if (!built.ok) throw new Error(built.error.humanMessage);
const compiled = await compileBuiltTx(connection, user, built.data, info);
if (!compiled.ok) throw new Error(compiled.error.humanMessage);
// Sign compiled.data.tx with the wallet, then send and confirm it.
```

### Provisioning an ALT for a new pool

```ts
import { buildInitializePoolAltTx } from "@coffer_so/sdk-v6";

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

The SDK's `safeCall` helper retries transient errors (RPC timeouts, rate
limits, connection refused) up to 3 times with configurable backoff
(default schedule: 200ms / 500ms / 1500ms). Permanent errors (parse failure, invalid input,
insufficient funds) short-circuit.

## Public operation surface

| Client / helpers | Public operations |
| --- | --- |
| `CofferPoolClient` | `sync`, `getCached`, `quoteSwap`, `quoteSeedDeposit`, `quoteAddLiquidity`, `quoteRemove`, `resolve*ExtraAccounts`, swap/add/remove transaction builders, `plannedZap` getter, `quotePlannedZap`, `parseEventsFromLogs` |
| `PlannedZapClient` | `quote`, `replayAt`, `ensureUserTokenAccountIxs`, `resolveExtraAccounts`, `buildIx`, `buildTx`, `walletLookupAddresses`, `prepareWalletLookupTable`, `waitForWalletLookupTable`, `poolLookupTable`, `compileTransaction`; see [PLANNED_ZAP.md](docs/PLANNED_ZAP.md) |
| `PoolFactoryClient` | `buildDeployPoolTx`, `buildInitializeConfigTx`, `initializePoolIx` |
| `AdminClient` | Treasury initialization/rotation, supervisor, fee collection/withdrawals, pool configuration/activation/migration/ALT, program upgrades/authority transfer/freeze/close; all 29 protocol-admin instructions |
| Generic ABI | `buildContractInstruction` for all 59 instructions; `decodeContractAccount` for all declared accounts; `decodeContractEvent`/`parseContractEvents` for all 59 events |
| Raw builders | `build*Ix`/`build*Tx` for swaps, liquidity, pool/config/ALT initialization, fee/sell-off/range management and pool-admin rotation; `buildPlannedZapIx`, `stateCommitment`, `compilePlannedZapTransaction`; `resolveTransferExtraAccounts` |
| RPC/HTTP | `RpcClient`, `CofferBackendClient`; see [backend version scope](docs/BACKEND_COMPATIBILITY.md) |
| XP snapshots | Frozen results of finished epochs and campaigns — `getLeaderboardEpochSnapshot`, `getCampaignSnapshotTop`, …; see [XP snapshots guide](docs/XP_SNAPSHOTS.md) |

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
- Exit `effectiveLpIn` may be smaller than requested to preserve 1,000 raw LP;
  `receivedAmounts` is what lands in the wallet. Derive `minimumTokenAmounts`
  from it.
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
The camelCase `parseCofferPoolEvents` compatibility API also recognizes all 58
current events, but uses numeric timestamps and some legacy default fields.
Malformed/truncated events become `Unknown`; it is not proof of program
provenance or transaction success.
