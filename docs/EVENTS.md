# Events — v6.1 wire (T11) and the backend mapping

Target: `contracts` v6.1 at `409067d` (T11 events overhaul); source of truth
`programs/*/src/events.rs`, pinned by `idl/abi-pins.json` and mirrored here in
`src/parsers/eventPins.ts`. The contracts' own reference is
`docs/EVENTS-V61.md` (full field semantics per event); this page is the SDK
side: what the decoders return and how `backend-v2` maps it.

## 1. Rules

- **One primary event per instruction**, emitted after the last state write; a
  failed instruction emits nothing. Hooked instructions add one `HookInvoked`
  per callback *before* the primary event; protocol-admin wrappers add their
  own wrapper event *after* the inner coffer-pool event (log order = CPI
  order, inner first).
- Every primary event carries the **actor** (`user` / `authority` / `admin`,
  plus `actorKind` where more than one signer class may call), the **action
  params**, the **before / after** of every field the instruction mutated,
  the pool / treasury key and `timestamp` (Clock seconds).
- **Discriminator** `sha256("event:<Name>")[..8]`. A payload change since the
  v6 wire is a **re-cut** (new name `…V2` / new struct, new discriminator).
  Nothing is appended under an old discriminator any more, so the decoders
  are strict: a truncated payload is `Unknown`, never a half value.
- **Retired** (pinned, never reused): `PoolStateLog`, `MaxSelloffWindowAdvanced`,
  STLD `SingleTokenDeposit`. The **legacy** discriminator of every re-cut event
  is pinned too; none of them decode on the v6.1 IDL — v6 history needs the v6
  SDK. They surface as `Unknown { name: <legacy name>, data: { legacy, retired, replacedBy } }`.
- Vectors are `token_count` long in pool order; amounts raw `u64` (`BN`);
  `swapFeeRate` / `effectiveFeeRate` hundredths of bps (`1e6` = 100 %);
  `protocolFeeRate` bps of the fee; `*Bps` bps; `timestamp` `number` (no slot
  — the transaction has it). `decimals` is `bytes` on the wire → `number[]`.
- Token identity is **by index** (`SwapV2.tokenInIndex` → `PoolInitializedV2.mints[i]`
  or the pool account); no event repeats a mint it does not need.
- `actorKind`: `ACTOR_KIND.USER 0`, `POOL_ADMIN 1`, `PROTOCOL_ADMIN 2` (the
  Treasury PDA, i.e. any protocol-admin wrapper), `SUPERVISOR 3`,
  `RANGE_MANAGER 4` (`actorKindName()`).

## 2. Decoders

| API | Returns | Use |
| --- | --- | --- |
| `parseCofferPoolEvents(logs)` | `CofferPoolEvent[]` — camelCase, typed decoders for the 17 trading / liquidity / admin events a backend indexes (`TYPED_EVENT_NAMES`), the IDL coder for the rest (`AdditionalContractEvent`) | flat decoding of one transaction's `logMessages` |
| `parseTransactionEvents(logs, programIds?)` | `AttributedEvent[]` — the same events plus `programId` (top of the invoke stack), `depth`, `lineIndex`; with `programIds` a line is decoded with THAT program's table only | CPI-aware indexing (a planned zap logs coffer-pool events at depth 2) |
| `parseContractEvents(logs, program?)` / `decodeContractEvent` | `{ program, kind, data }` with exact IDL names and `BN` | exact wire view, admin indexer |
| `decodeEventLine(base64, only?)` | one line, `{ event, program }` | custom pipelines |
| `EVENT_TABLES`, `eventProgramOf(hex)` | discriminator → name per program (41 / 36 / 2, no collisions) | table generation |
| `RECUT_EVENTS`, `RETIRED_EVENTS`, `LEGACY_EVENT_DISCRIMINATORS` | the pins | version switch for v6 history |
| `logTruncated(logs)` | `true` on `Log truncated` | flag `needs_rpc_replay` |

Strictness: the typed decoders read every field and refuse a short payload
(`Unknown` with `data.error`); `decodeContractEvent` re-encodes what Anchor's
layout reader decoded and refuses anything that does not reproduce the bytes
(the reader alone zero-fills a cut tail). Trailing bytes after a complete
payload are ignored by both. Timestamps outside the safe-integer range make
the camelCase API return `Unknown` (the IDL API keeps the `BN`).

Nested types: `SlotState { virtualBalance, actualBalance, protocolFeesOwed, creatorFeesOwed, surgeFeesOwed }`
(`vault_i = actual + protocol + creator + surge`), `SelloffWindowState`
(`effectiveSelloffBefore` = pre-swap fill, `effectiveSelloff`, `maxSelloffCap`,
`vbSnapshot`, `previousSelloff`, `currentSelloff`, `windowStartTimestamp`),
`SelloffParams` (the SDK's camelCase shape, all seven fields).

`SwapV2` helpers: `swapSurgeLpAmount(e)` (= `surge − surgeProtocol − surgeCreator`,
booked into `surge_fees_owed[out]`), `swapSlotDeltas(e)` (`after − before` per
field of both touched slots), `applySwapToVectors(e, vectors)` (patch a pool's
known vectors at the two indices with `*After`).

## 3. Typed events (coffer-pool unless noted)

| instruction | event | key fields |
| --- | --- | --- |
| `swap` | `SwapV2` | `tokenInIndex/OutIndex`, `amountIn`, `transferFeeIn`, `amountInNet`, `swapFeeRate`, `effectiveFeeRate`, `protocolFeeRate`, `creatorFeeBps`, `feeAmount`, `protocolFeeAmount`, `creatorFeeAmount`, `amountOutGross`, `surgeFeeAmount`, `surgeProtocolFeeAmount`, `surgeCreatorFeeAmount`, `amountOut` (vault debit), `transferFeeOut`, `inBefore/inAfter/outBefore/outAfter: SlotState`, `timestamp`, `selloffWindow: SelloffWindowState \| null` (343-byte payload without, 399 with; tag byte @342) |
| `seed_liquidity`, `add_liquidity` | `LiquidityAddedV2` | `isSeed`, `tokenAmounts` (charged), `creditedAmounts` (= `Δactual + Δsurge`), `surgeBuyIn`, `lpAmount` (net of the deposit fee), `depositFeeLp`, `depositFeeBps`, `lpSupplyBefore/After`, `virtualBalances/actualBalances/surgeFeesOwed` before / after |
| `remove_liquidity`, `remove_liquidity_bypass_hooks` | `LiquidityRemovedV2` | `requestedLp`, `lpAmount` (effective burn), `tokenAmounts` (reserve part), `surgeAmounts` (bucket part), `withdrawFeeAmounts`, `withdrawFeeBps`, `transferFeesOut`, `hooksBypassed`, `lpSupplyBefore/After`, the six vectors |
| `initialize_pool` | `PoolInitializedV2` | `poolId`, `poolAdmin`, `lpMint`, `lpTokenProgram`, `mints`, `tokenPrograms`, `decimals`, `normalizedWeights`, `initialVirtualBalances`, the five rates, `lpName/Symbol/Uri`, the hook block |
| `get_pool_info` (simulate) | `PoolInfoV2` | the full account view, `timestamp` last — never indexed |
| `fund_sidelined_token` | `SidelinedTokenFunded` | `tokenIndex`, `amountCharged`, `amountCredited`, `actualAfter`, `virtualBalance`, `lpSupply` |
| `collect_protocol_fees` / `claim_creator_fees` | `ProtocolFeesCollectedV2` / `CreatorFeesClaimedV2` | `tokenAmounts` (= owed before; after = 0), `recipients` (`PublicKey.default` where nothing was owed) |
| `rescale_virtual_balances` (T22) | `VirtualBalancesRescaled` | `multiplier`, `oldVirtualBalances`, `newVirtualBalances` |
| any hooked ix / `set_hook_disabled` (T9) | `HookInvoked` / `HookDisabledSet` | `callback`, `verdict`, `hasFeeOverride`, `feeOverride` (raw, unclamped), `cuUsed` / `oldDisabled`, `newDisabled`, `pauseWhenDisabled` |
| `set_pool_enabled` / `set_swaps_enabled` / `set_token_active` | `PoolEnabledUpdated` / `SwapsEnabledUpdatedV2` / `TokenActiveSetV2` | old / new (+ `actorKind`, `tokenIndex`) |
| `range_manager_update` / `set_max_selloff` | `RangeManagerUpdatedV2` / `MaxSelloffSetV2` | sparse `vbIndices` / `weightIndices` with old (CAS) / new values; `oldParams` / `newParams: SelloffParams[]` |
| STLD `deposit_single_token_planned` | `SingleTokenDepositDirectV2` | `amountIn`, `minimumLpAmount`, `allocations`, `planExpectedState` (32 B), `planQuotedAt`, `planValidUntilSlot`, `innerSwapCount`, `depositedAmounts`, `lpReceived`, `dustRemaining`, `lpSupplyBefore/After` — the last event of the tx, self-contained |

Everything else (`PoolAdminTransferInitiatedV2`, `PoolActionProposed`,
`ConfigInitializedV2`, every protocol-admin wrapper, …) decodes through the
IDL coder with camelCase keys; the cooldown events' `kind` data field is
exposed as `actionKind`. The full per-event field tables are in the contracts'
`docs/EVENTS-V61.md` §3–5.

## 4. Backend-v2 column mapping (contracts `docs/EVENTS-V61.md` §6)

1. **Decoder table** (`parsers/events.ts`): replace the v6 discriminators with
   `EVENT_TABLES` (= `events ∪ addedEvents ∪ recutEvents[*].discriminator`
   of `abi-pins.json`, 79 events: 41 / 36 / 2). Keep the v6 table behind a
   version switch for history — `LEGACY_EVENT_DISCRIMINATORS` tells a v6 log
   from garbage. Decode **by program id with the invoke stack**
   (`parseTransactionEvents(logs, { cofferPool, protocolAdmin, singleTokenLiquidity })`),
   not with a flat table.
2. **Normaliser** (`event-normalize.util.ts`):
   - `SwapV2` → swap row: `tokenIn/tokenOut` = `mints[tokenInIndex/OutIndex]`
     from the pool row (or `PoolInitializedV2`); `amountIn`, `amountOut`,
     `feeAmount`, `protocolFeeAmount`, `surgeFeeAmount`, `transferFeeIn/Out`
     keep their meaning; new columns `amountInNet`, `amountOutGross`,
     `creatorFeeAmount`, `surgeProtocolFeeAmount`, `surgeCreatorFeeAmount`,
     `swapFeeRate` (configured), `effectiveFeeRate` (applied — hook override),
     `protocolFeeRate`, `creatorFeeBps` **from the event, not the DB snapshot**,
     `inBefore/inAfter/outBefore/outAfter`, `selloffWindow` (inline; was
     `MaxSelloffWindowAdvanced` attached to the next swap) + `effectiveSelloffBefore`.
   - `LiquidityAddedV2` / `LiquidityRemovedV2` → LP rows: `bptAmount` → `lpAmount`,
     **`bptTotalSupply` ← `lpSupplyAfter`** (was `NULL`), `lpSupplyBefore`,
     `creditedAmounts` (no transfer-fee gross-up needed), `isSeed` replaces the
     "first deposit" heuristic, `surgeAmounts` / `withdrawFeeAmounts` /
     `transferFeesOut` / `hooksBypassed`, and the six vectors.
   - `SingleTokenDepositDirectV2` → zap row: `lpReceived`, `depositedAmounts`,
     `dustRemaining` (was `dust_refunded`), `innerSwapCount`, `lpSupplyBefore/After`,
     `planExpectedState` / `planQuotedAt` / `planValidUntilSlot`.
   - Drop the `PoolStateLog` and `MaxSelloffWindowAdvanced` kinds.
3. **Reducer** (`tx-events.reducer.ts`): no "last `PoolStateLog` of the tx"
   attach — swap rows patch the pool's vectors at the two indices with
   `*After` (`applySwapToVectors`), LP rows take the full `*After` vectors;
   `bptTotalSupply` ← `lpSupplyAfter`; `swapFeeRate` / `protocolFeeRate` from
   the event (fixes the same-slot stale-rate risk); zap collapse sums the legs'
   `swapSurgeLpAmount` for the LP surge share. Apply events in log order: with
   several instructions on one pool in one transaction the before of leg
   *k+1* equals the after of leg *k*.
4. **Admin indexer** (`admin-action-indexer.service.ts`): hand-written
   `ADMIN_EVENT_LAYOUTS` → generate from the IDL `types` (or
   `abi-pins.json eventSchemas`: field `name:type` in Borsh order; `bytes` =
   `Vec<u8>`, `option` = tag byte, nested `SlotState` / `SelloffWindow` /
   `SelloffParams`). Register every `*V2` and the T3 / T6 / T7 / T9 / T14 /
   T22 events for the pool-row refresh; the queued-execute path emits the
   setter's own event right before `PoolActionExecuted`.
5. **Integrity replay**: `SwapV2` is exactly replayable from `inBefore/outBefore`
   + params (`swapSlotDeltas` must equal the cascade: `in.actual += amountInNet −
   protocolFeeAmount − creatorFeeAmount`, `in.protocol += protocolFeeAmount`,
   `in.creator += creatorFeeAmount`, `out.actual −= amountOutGross`,
   `out.protocol += surgeProtocolFeeAmount`, `out.creator += surgeCreatorFeeAmount`,
   `out.surge += swapSurgeLpAmount`); LP events from the before vectors +
   `lpSupplyBefore`. Keep the `needs_rpc_replay` flag on `logTruncated`.
6. **Pool discovery**: build the pool row from `PoolInitializedV2` alone (no
   instruction parse, no RPC).
7. **Protocol-admin feed**: listen to `PoolsFrozenV2` / `PoolsUnfrozenV2` /
   `ActionProposed` / `ActionExecuted` / `ActionCancelledV2` / `ProgramUpgradedV2`
   for the incident timeline; `actorKind` tells admin from supervisor.

## 5. Log budget

Default validator cap 10 000 bytes per transaction. Measured (contracts
`tests/v61_events.ts`): hooked `swap` with a window 2 359 B total, N10
`add` / `remove` with hooks ≈ 5.3 KB, an N10 planned zap 16.9 KB (≈ 10.1 KB of
which is runtime plumbing for nine CPI legs) — an N10 zap truncates on a
default-cap node whatever the events weigh; index zaps from a node with a
raised `--log-messages-bytes-limit` or replay through RPC on `Log truncated`
(the receipt is the last event and the first to be cut). N ≤ 5 zaps fit.

## 6. Fixtures and tests

`scripts/generate-event-fixtures.cjs` samples every event of the three IDLs
deterministically, encodes it with an independent Borsh encoder and writes
`tests/fixtures/events/*.json` (80 fixtures: `Option` fields get a `some` and
a `none` variant). `tests/v61-events.test.ts` decodes each through both APIs,
compares field by field, re-encodes the decoded value to the fixture bytes and
checks the pins, the legacy / retired handling, truncation, bad tags and CPI
attribution; `tests/contract-abi.test.ts` covers the raw IDL round trip of all
79 events.
