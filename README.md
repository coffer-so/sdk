# @coffer_so/sdk

[![npm](https://img.shields.io/npm/v/@coffer_so/sdk.svg)](https://www.npmjs.com/package/@coffer_so/sdk)

📦 **npm**: <https://www.npmjs.com/package/@coffer_so/sdk>

Client library for the Cubic Pool AMM on Solana. Targeted at both frontend
and backend consumers; no bundler-specific code.

## Contract compatibility

This release targets `contracts/audit-fixes-excluded-SF` at
`96a2ee20244ff95fb9f14357bb55b17e1eb0e2c0`, deployed on mainnet on 2026-09-07.
All three IDLs match that revision. Typed `buildContractInstruction` covers all
59 instructions, `parseContractEvents` covers all 60 events, and
`decodeContractAccount` decodes their declared accounts. See
[the compatibility notes](docs/CONTRACT_COMPATIBILITY.md) for usage and limits, and
[the exact state-field mapping](docs/STATE_FIELDS.md) for decoded account data.

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
import { getConfig, CubicPoolClient, CofferBackendClient } from "@coffer_so/sdk";
import { PublicKey } from "@solana/web3.js";

const config = getConfig("mainnet", {
  backendEndpoint: "https://api.coffer.so",
  // Optional: put your paid RPC first; SDK falls back to the defaults below.
  rpcEndpoints: [
    process.env.CUBE_RPC_URL!,
    "https://api.mainnet-beta.solana.com",
    "https://solana-rpc.publicnode.com",
    "https://solana.api.pocket.network",
  ],
  rpcTimeoutMs: 2_000,
  slippageHundredthsBps: 30_000, // 3 %
});

const pool = new CubicPoolClient({
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
types/        Result<T> shape, PoolInfo, SwapQuote, SingleTokenDepositQuote,
              CubicPoolEvent
utils/        Error mapping, retry wrapper (safeCall), PDA helpers
math/         Pure math — port of cubic-pool + stld Rust math modules
parsers/      Binary layout decoders for CubicPool / Mint / events
clients/      RpcClient, CofferBackendClient, CubicPoolClient
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
- All transaction building (swap, add/remove liquidity, single-token deposit, pool deploy)
- Current Anchor IDLs for `cubic_pool`, `single_token_liquidity`, and
  `protocol_admin`
- Retry + fallback for RPC and backend calls
- Event log decoding

**In the application:** UI/state, wallet signing, transaction submission and
confirmation, native SOL wrapping, any missing token-account setup, and fresh
helper-balance reads for STLD. Use the SDK quote and ABI helpers for contract
math and encoding; direct `rpc.connection` calls bypass its fallback wrapper.

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

const built = client.buildRemoveLiquidityTx({ user, bptAmount, minimumTokenAmounts });
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
- `pool` — `CubicPool` account
- `config` — the `CubicPoolConfig` the pool is pinned to (read for the
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
`PoolTokenInfo` carries a `tokenProgram` field decoded straight from
the on-chain pool account. The transaction builders
(`buildSwapTx`, `buildAddLiquidityTx`, `buildRemoveLiquidityTx`,
`buildSingleTokenDepositTx`) thread `token.tokenProgram` through ATA
derivation and remaining-accounts assembly, so consumers do not need
to special-case Token-2022 on the call site.

The BPT mint defaults to classic SPL Token; `bptTokenProgram` can select
Token-2022. `sync()` records its actual owner and builders use that program.

The deployed contracts do not support transfer-fee or transfer-hook accounting.
SDK swap/add/remove guards reject incompatible extensions on affected transfer
legs. STLD instruction builders check **every pool mint**, including sidelined
ones, because existing helper balances can be refunded. Its quote checks live
reserve legs and any supplied nonzero helper balances, so a quote can succeed
while the stricter STLD builder rejects a sidelined incompatible mint.
`bannedMintExtensions()` separately reports the creation-policy bitmap; a bit in
that bitmap does not by itself make an existing token non-transferable.

## Examples

See `examples/*.ts`:

- `01-init-sdk.ts` — initialisation patterns
- `02-fetch-pool.ts` — parse pool state
- `03-quote-swap.ts` — swap quote with slippage
- `06-single-token-deposit.ts` — single-token deposit quote
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
| `CubicPoolClient` | `sync`, `getCached`, `helperPda`, `quoteSwap`, `quoteSeedDeposit`, `quoteAddLiquidity`, `quoteRemove`, `quoteSingleTokenDeposit`, swap/add/remove/STLD transaction builders, split STLD builder, `singleTokenDeposit` getter, `parseEventsFromLogs` |
| `SingleTokenDepositClient` | `sync`, `helperPda`, `quote`, `buildTx`, `buildTxs` |
| `PoolFactoryClient` | `buildDeployPoolTx`, `buildInitializeConfigTx`, `initializeCubicPoolIx` |
| `AdminClient` | Treasury initialization/rotation, supervisor, fee collection/withdrawals, pool configuration/activation/migration/ALT, program upgrades/authority transfer/freeze/close; all 29 protocol-admin instructions |
| Generic ABI | `buildContractInstruction` for all 59 instructions; `decodeContractAccount` for all declared accounts; `decodeContractEvent`/`parseContractEvents` for all 60 events |
| Raw builders | `build*Ix`/`build*Tx` for swaps, liquidity, STLD, pool/config/ALT initialization, fee/sell-off/range management and pool-admin rotation |
| RPC/HTTP | `RpcClient`, `CofferBackendClient`; see [backend version scope](docs/BACKEND_COMPATIBILITY.md) |

`getCached()` is the actual cache accessor; there is no `getState()`, `swap()`,
or `getSwapQuote()` method. `pool.singleTokenDeposit` is a client getter, not a
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
const exit = pool.quoteRemove(bptIn);
const zap = pool.quoteSingleTokenDeposit(inIndex, amountIn, slippageHbps, nowSeconds, helperBalances);
```

`nowSeconds` is optional Unix seconds; omitted uses Solana Clock from `sync()`.
STLD `helperBalances` is an optional vector of **existing helper token ATA
balances before the operation**; omitted means zero and does not fetch them.
`sync()` does not read helper ATAs. There is no per-leg minimum-output argument
on the deployed STLD instruction: quote `minOuts` are informational.

- Swap `amountOut` is net of the output-token surge fee; pass `minAmountOut` to
  the builder. `feeAmount` and `protocolFeeAmount` use the input token.
- Join `tokenAmounts` are spend ceilings. Display `depositAmounts` as the quoted
  pool credit and `refundAmounts` as unspent funds. Seed uses exact amounts.
- Exit `effectiveBptIn` may be smaller than requested to preserve 1,000 raw BPT.
- Add/STLD builders require a **positive** `minimumBptAmount` at runtime, even
  though the compatibility interfaces retain it as optional. Remove builders
  require an explicit `minimumTokenAmounts` vector.

`buildDeployPoolTx` initializes the pool and BPT mint without seeding or creating
reserve vault ATAs. `buildAddLiquidityTx` creates the user's BPT ATA, but the
user's input-token accounts and pool reserve vaults must already exist. Supply
the necessary ATA setup in the application before the first deposit.
For STLD on larger pools, use `buildSingleTokenDepositTxs`, confirm its setup
transaction, then compile the deposit with the already initialized pool ALT.
Neither splitting nor compiling creates the ALT.

The complete typed event API keeps snake_case fields and full-width BN values.
The camelCase `parseCubicPoolEvents` compatibility API also recognizes all 60
current events, but uses numeric timestamps and some legacy default fields.
Malformed/truncated events become `Unknown`; it is not proof of program
provenance or transaction success.
