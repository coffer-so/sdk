# @cubee_ee/sdk

[![npm](https://img.shields.io/npm/v/@cubee_ee/sdk.svg)](https://www.npmjs.com/package/@cubee_ee/sdk)

📦 **npm**: <https://www.npmjs.com/package/@cubee_ee/sdk>

Client library for the Cubic Pool AMM on Solana. Targeted at both frontend
and backend consumers; no bundler-specific code.

## Contract compatibility

This release targets `contracts/audit-fixes-excluded-SF` at
`96a2ee20244ff95fb9f14357bb55b17e1eb0e2c0`, deployed on mainnet on 2026-09-07.
All three IDLs match that revision. Typed `buildContractInstruction` covers all
59 instructions, `parseContractEvents` covers all 60 events, and
`decodeContractAccount` decodes their declared accounts. See
[the compatibility notes](docs/CONTRACT_COMPATIBILITY.md) for usage and limits.

## Install

```bash
npm install @cubee_ee/sdk
# or
yarn add @cubee_ee/sdk
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
    "@cubee_ee/sdk": "file:../sdk"
  }
}
```

## Quick start

```ts
import { getConfig, CubicPoolClient, CubeBackendClient } from "@cubee_ee/sdk";
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
config/       CubeConfig, program IDs per network, token registry
types/        Result<T> shape, PoolInfo, SwapQuote, SingleTokenDepositQuote,
              CubicPoolEvent
utils/        Error mapping, retry wrapper (safeCall), PDA helpers
math/         Pure math — port of cubic-pool + stld Rust math modules
parsers/      Binary layout decoders for CubicPool / Mint / events
clients/      RpcClient, CubeBackendClient, CubicPoolClient
idl/          Anchor IDL exports generated from the current contracts
examples/     Runnable scripts demonstrating each capability
```

`RpcClient` rotates through `config.defaults.rpcEndpoints` for every RPC call.
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

**In the frontend:** only UI rendering + state management (zustand / redux) + wallet integration. No raw RPC calls, no borsh, no math.

## v0 transactions + per-pool ALT

Multi-token pools (especially 7–10 token ones) exceed Solana's 1232-byte
legacy transaction wire ceiling on `add_liquidity` /
`remove_liquidity`. The contract provisions an **Address Lookup Table
(ALT) per pool** via `initialize_pool_alt`. After init the ALT is
frozen and its address is recorded on `pool.lookup_table`.

Builders return instructions. Call `compileBuiltTx` to fetch the pool's ALT and
compile a v0 transaction. The wallet supplies signatures and the caller sends it.

```ts
import { compileBuiltTx } from "@cubee_ee/sdk";

const built = client.buildRemoveLiquidityTx({ user, bptAmount, minimumTokenAmounts });
if (!built.ok) throw new Error(built.error.humanMessage);
const compiled = await compileBuiltTx(connection, user, built.data, info);
if (!compiled.ok) throw new Error(compiled.error.humanMessage);
// Sign compiled.data.tx with the wallet, then send and confirm it.
```

### Provisioning an ALT for a new pool

```ts
import { buildInitializePoolAltTx } from "@cubee_ee/sdk";

const recentSlot = new BN(await connection.getSlot("finalized"));
const { instructions, lookupTable } = buildInitializePoolAltTx(config, {
  pool: poolPubkey,
  config: poolConfigPubkey,    // from pool.config — required
  authority: poolAdmin,         // pool admin OR config.protocol_admin
  payer: poolAdmin,             // pays ~0.005 SOL ALT rent (locked)
  recentSlot,
});
// Sign + send. After landing, pool.lookup_table === lookupTable.
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

ALT rent for a typical 4-token pool is ~0.0044 SOL; a 10-token pool
~0.0071 SOL. Permanently locked (frozen ALT can't be closed).

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
SDK guards reject these and other incompatible mint extensions for transfers.
`bannedMintExtensions()` separately reports the creation-policy bitmap; a bit in
that bitmap does not by itself make an existing token non-transferable.

## Examples

See `examples/*.ts`:

- `01-init-sdk.ts` — initialisation patterns
- `02-fetch-pool.ts` — parse pool state
- `03-quote-swap.ts` — swap quote with slippage
- `06-single-token-deposit.ts` — single-token deposit quote
- `08-backend-stats.ts` — statistics via CubeBackendClient

Run: `npx ts-node examples/<name>.ts`.

## Error handling pattern

```ts
const res = await pool.sync();
if (!res.ok) {
  toast.error(res.error.humanMessage);
  logger.debug(res.error.cause);
  return;
}
const pool = res.data;
```

The SDK's `safeCall` helper retries transient errors (RPC timeouts, rate
limits, connection refused) up to 3 times with exponential backoff
(200ms / 500ms / 1500ms). Permanent errors (parse failure, invalid input,
insufficient funds) short-circuit.
