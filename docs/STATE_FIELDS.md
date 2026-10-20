# Exact decoded state mapping

Target: `@coffer_so/sdk-v6` 0.2.0; contract source `contracts` v6.1 (post T18/T19 rename, derived from `v6@7d753b3`).
The account layouts are unchanged from v5; v6 adds the `"V5M1"` migration
marker in `CofferPool.reserved[0..4]` (`v5Migrated`).

Three read interfaces serve different purposes:

- `CofferPoolClient.sync()` returns operational camelCase `PoolInfo`, enriched with mint data and Solana Clock. `getCached()` returns that last snapshot without RPC. There is no `getState()` method.
- `decodePoolAccount(data)` preserves the complete 1683-byte current pool layout as `RawPoolAccount`, including all ten slots as parallel arrays and `reserved: Buffer`.
- `decodeContractAccount(program, accountName, data)` returns the complete exact IDL structure with snake_case names, nested structs, padding arrays and full-width `BN` integers. It also covers config and Treasury.

The decoders validate size and discriminator. The manual pool decoder also validates canonical Borsh booleans and `token_count <= 10`. It reads `i64` as signed two’s complement. A correctly sized account is not proof of migration: v4 and v5 are both 1683 bytes. Interpret this table only for the target program/layout.

Check the RPC account owner before decoding. For both `CofferPool` and `CofferPoolConfig`, the owner must be the configured coffer-pool program, even though their schemas are repeated in the STLD IDL. Treasury belongs to protocol-admin.

## CofferPool

Offsets include the 8-byte discriminator. `reserved` is ABI padding rather than an operational parameter.

| Contract field | Type | Byte offset | RawPoolAccount | PoolInfo from sync |
| --- | --- | ---: | --- | --- |
| `config` | `pubkey` | 8 | `config` | `config` |
| `bump` | `u8` | 40 | `bump` | `bump` |
| `token_count` | `u8` | 41 | `tokenCount` | `tokenCount` |
| `pool_id` | `u64` | 42 | `poolId` | `poolId` |
| `swap_fee_rate` | `u32` | 50 | `swapFeeRate` | `swapFeeRate` |
| `protocol_fee_rate` | `u16` | 54 | `protocolFeeRate` | `protocolFeeRate` |
| `created_at` | `i64` | 56 | `createdAt` | `createdAt` (`number`, exact safe range only) |
| `pool_enabled` | `bool` | 64 | `poolEnabled` | `poolEnabled` |
| `swaps_enabled` | `bool` | 65 | `swapsEnabled` | `swapsEnabled` |
| `pool_admin` | `pubkey` | 66 | `poolAdmin` | `poolAdmin` |
| `pending_pool_admin` | `pubkey` | 98 | `pendingPoolAdmin` | `pendingPoolAdmin` |
| `range_manager` | `pubkey` | 130 | `rangeManager` | `rangeManager` |
| `range_manager_enabled` | `bool` | 162 | `rangeManagerEnabled` | `rangeManagerEnabled` |
| `range_manager_max_vb_change_pct` | `u16` | 163 | `rangeManagerMaxVbChangePct` | `rangeManagerMaxVbChangePct` |
| `range_manager_max_weight_change_pct` | `u16` | 165 | `rangeManagerMaxWeightChangePct` | `rangeManagerMaxWeightChangePct` |
| `range_manager_min_update_interval_secs` | `u32` | 167 | `rangeManagerMinUpdateIntervalSecs` | `rangeManagerMinUpdateIntervalSecs` |
| `range_manager_last_updated` | `i64` | 171 | `rangeManagerLastUpdated` | `rangeManagerLastUpdated` |
| `tokens` | `[TokenSlot; 10]` | 179 | Parallel arrays below (10 entries each) | `tokens` (first `tokenCount` entries) |
| `lookup_table` | `pubkey` | 1619 | `lookupTable` | `lookupTable` |
| `_deprecated_banned_extensions` | `u64` | 1651 | `deprecatedBannedExtensions` | Omitted (policy removed in v6.1/T19; never interpret) |
| `range_manager_max_leverage_bps` | `u32` | 1659 | `rangeManagerMaxLeverageBps` | `rangeManagerMaxLeverageBps` |
| `range_manager_min_leverage_bps` | `u32` | 1663 | `rangeManagerMinLeverageBps` | `rangeManagerMinLeverageBps` |
| `reserved` | `[u8; 16]` | 1667 | `reserved: Buffer` | Omitted; use raw decoder |

Total size: **1683 bytes**. Reserved bytes are copied; changing the returned padding buffer does not mutate the input buffer.

## TokenSlot

Slot `i` starts at `179 + 144 × i`. AssetConfig is 88 bytes; AssetDynamics is 56 bytes. These tables use offsets relative to the slot start. Every operational per-token field is mapped by `sync()`.

| Contract field | Type | Slot offset | Raw array | PoolInfo.tokens[i] |
| --- | --- | ---: | --- | --- |
| `AssetConfig.mint` | `pubkey` | 0 | `tokenMints[i]` | `mint` |
| `AssetConfig.token_program` | `pubkey` | 32 | `tokenPrograms[i]` | `tokenProgram` |
| `AssetConfig.normalized_weight` | `u64` | 64 | `normalizedWeights[i]` | `weightBps` (`number`) |
| `AssetConfig.max_selloff_pct` | `u16` | 72 | `maxSelloffPct[i]` | `maxSelloffPct` |
| `AssetConfig.max_selloff_period_length` | `u32` | 74 | `maxSelloffPeriodLength[i]` | `maxSelloffPeriodLength` |
| `AssetConfig.variable_fee_threshold_pct` | `u16` | 78 | `variableFeeThresholdPct[i]` | `variableFeeThresholdPct` |
| `AssetConfig.variable_fee_slope_low_pct` | `u16` | 80 | `variableFeeSlopeLowPct[i]` | `variableFeeSlopeLowPct` |
| `AssetConfig.variable_fee_slope_high_pct` | `u16` | 82 | `variableFeeSlopeHighPct[i]` | `variableFeeSlopeHighPct` |
| `AssetConfig.is_active` | `bool` | 84 | `isActive[i]` | `isActive` |
| `AssetConfig.variable_fee_slope_mid_pct` | `u16` | 85 | `variableFeeSlopeMidPct[i]` | `variableFeeSlopeMidPct` |
| `AssetConfig.variable_fee_kink_pct` | `u8` | 87 | `variableFeeKinkPct[i]` | `variableFeeKinkPct` |
| `AssetDynamics.virtual_balance` | `u64` | 88 | `virtualBalances[i]` | `virtualBalance` |
| `AssetDynamics.actual_balance` | `u64` | 96 | `actualBalances[i]` | `actualBalance` |
| `AssetDynamics.protocol_fees_owed` | `u64` | 104 | `protocolFeesOwed[i]` | `protocolFeesOwed` |
| `AssetDynamics.previous_selloff` | `u64` | 112 | `previousSelloff[i]` | `previousSelloff` |
| `AssetDynamics.current_selloff` | `u64` | 120 | `currentSelloff[i]` | `currentSelloff` |
| `AssetDynamics.window_start_timestamp` | `i64` | 128 | `windowStartTimestamp[i]` | `windowStartTimestamp` |
| `AssetDynamics.selloff_vb_snapshot` | `u64` | 136 | `selloffVbSnapshot[i]` | `selloffVbSnapshot` |

## CofferPoolConfig

Use `decodeContractAccount("cofferPool", "CofferPoolConfig", data)`. `sync()` does not fetch this account.

| Exact returned field | Type | Byte offset |
| --- | --- | ---: |
| `protocol_admin` | `pubkey` | 8 |
| `pending_protocol_admin` | `pubkey` | 40 |
| `default_protocol_fee_rate` | `u16` | 72 |
| `_deprecated_extension_policy` | `[u8; 16]` | 74 |
| `reserved` | `[u8; 112]` | 90 |

Current account length: **202 bytes** including discriminator.

## Treasury

Use `decodeContractAccount("protocolAdmin", "Treasury", data)`. `sync()` does not fetch this account.

| Exact returned field | Type | Byte offset |
| --- | --- | ---: |
| `admin` | `pubkey` | 8 |
| `pending_admin` | `pubkey` | 40 |
| `bump` | `u8` | 72 |
| `token_count` | `u8` | 73 |
| `token_mints` | `[pubkey; 10]` | 74 |
| `token_vaults` | `[pubkey; 10]` | 394 |
| `created_at` | `i64` | 714 |
| `reserved` | `[u8; 64]` | 722 |
| `supervisor` | `pubkey` | 786 |

Current account length: **818 bytes** including discriminator.

Bytes 74..90 of the config and 1651..1659 of the pool held the Token-2022 extension-policy bitmaps until v6.1. The policy was removed (T19): no code path reads them, existing accounts still carry their old values, fresh accounts write zero. They are exposed raw (`_deprecated_extension_policy`, `deprecatedBannedExtensions`) only so every later field keeps its byte offset; never interpret them.

Treasury’s registered `token_mints` and `token_vaults` are distinct from pool reserve ATAs. Its `supervisor`, `pending_admin` and active `token_count` are available without truncating the arrays. The generic decoder expects the current 818-byte layout and rejects an older 786-byte Treasury; supervisor migration is a separate program operation.

## Mint and derived fields

`decodeMintAccount(data)` returns `mintAuthority`, `supply: BN`, `decimals`, `isInitialized`, `freezeAuthority`, extension type IDs in `extensions`, and the three extension bodies the v6 transfer path depends on: `transferFeeConfig` (both epoch schedules), `transferHook` (`programId === PublicKey.default` means disarmed) and `pausableConfig`. It checks the base mint shape, authority-option tags, initialized flag, Token-2022 mint/TLV structure and rejects a fee schedule above 100 % like the program. Other extension payloads are not decoded.

`sync()` adds token `index`, `vault`, optional display `metadata`, `concentration`, mint `decimals`, `extensions`, `unsupportedExtensions` (only `NonTransferable`/unknown types), `transferFee` (the schedule selected for `chainEpoch`), `transferHookProgram` (armed hooks only) and `paused`. Pool-level derived fields are `address`, `lpMint`, `lpTokenProgram`, `lpTotalSupply`, `unsupportedTokenIndices` (unsupported, paused or native-mint tokens), `chainSlot`, `chainEpoch`, `chainTimestamp` (seconds), `v5Migrated` and `syncedAt` (local milliseconds). Metadata/concentration are display conveniences, not on-chain state.

`PoolInfo.createdAt`, `chainSlot`, `chainEpoch` and `chainTimestamp` are numbers for compatibility. Values outside the exact safe-number range cause a `parse_failure` result rather than truncation. Raw account decoders retain full i64 precision. All token balances, fees, windows and supply remain BN. `sync()` reads the pool and then the mints + Clock in two calls, so it is not an atomic multi-account snapshot; `PlannedZapClient.quote` takes the atomic snapshot the plan hash needs.

```ts
const account = await pool.rpc.getAccountInfo(configAddress);
if (!account.ok) throw new Error(account.error.humanMessage);
if (!account.data || !account.data.owner.equals(config.programs.cofferPool)) {
  throw new Error("Config account missing or wrong owner");
}
const state = decodeContractAccount("cofferPool", "CofferPoolConfig", account.data.data);
// state.protocol_admin, state.pending_protocol_admin,
// state.default_protocol_fee_rate, state._deprecated_extension_policy,
// state.reserved
```

The example assumes an existing pool client/config and `configAddress: PublicKey`. For Treasury, derive its PDA with `deriveTreasuryPda`, read its account, verify the protocol-admin owner, and decode `"protocolAdmin", "Treasury"`.

## Validation

`tests/account-state.test.ts` compares the manual decoder and every operational `sync()` field against an independent IDL-driven Borsh fixture. It covers all ten token slots, nonzero padding, mixed token programs, negative i64, u64 values above `Number.MAX_SAFE_INTEGER`, malformed discriminators/booleans and precise numeric-conversion failures.

`tests/contract-abi.test.ts` covers all complete config/Treasury/pool layouts, all 59 instructions and all 59 events. `scripts/check-contract-abi.cjs --contracts-dir ...` compares the bundled IDLs with a chosen checkout’s target IDLs.
