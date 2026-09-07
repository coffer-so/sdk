# Exact decoded state mapping

Target: SDK 0.11.1 with the current local decoder corrections; contract source
`audit-fixes-excluded-SF@96a2ee20244ff95fb9f14357bb55b17e1eb0e2c0`.

Three read interfaces serve different purposes:

- `CubicPoolClient.sync()` returns operational camelCase `PoolInfo`, enriched with mint data and Solana Clock. `getCached()` returns that last snapshot without RPC. There is no `getState()` method.
- `decodePoolAccount(data)` preserves the complete 1683-byte current pool layout as `RawPoolAccount`, including all ten slots as parallel arrays and `reserved: Buffer`.
- `decodeContractAccount(program, accountName, data)` returns the complete exact IDL structure with snake_case names, nested structs, padding arrays and full-width `BN` integers. It also covers config and Treasury.

The decoders validate size and discriminator. The manual pool decoder also validates canonical Borsh booleans and `token_count <= 10`. It reads `i64` as signed two’s complement. A correctly sized account is not proof of migration: v4 and v5 are both 1683 bytes. Interpret this table only for the target program/layout.

Check the RPC account owner before decoding. For both `CubicPool` and `CubicPoolConfig`, the owner must be the configured cubic-pool program, even though their schemas are repeated in the STLD IDL. Treasury belongs to protocol-admin.

## CubicPool

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
| `banned_extensions` | `u64` | 1651 | `bannedExtensions` | `bannedExtensions` |
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

## CubicPoolConfig

Use `decodeContractAccount("cubicPool", "CubicPoolConfig", data)`. `sync()` does not fetch this account.

| Exact returned field | Type | Byte offset |
| --- | --- | ---: |
| `protocol_admin` | `pubkey` | 8 |
| `pending_protocol_admin` | `pubkey` | 40 |
| `default_protocol_fee_rate` | `u16` | 72 |
| `banned_extensions` | `u64` | 74 |
| `hard_banned_extensions` | `u64` | 82 |
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

Config’s `banned_extensions` is a default policy, `hard_banned_extensions` is the protocol floor, and pool `bannedExtensions` is that pool’s stored policy snapshot. Do not collapse them into one field. Generic decoding returns the stored hard floor, including zero; it does not substitute the contract’s effective fallback policy.

Treasury’s registered `token_mints` and `token_vaults` are distinct from pool reserve ATAs. Its `supervisor`, `pending_admin` and active `token_count` are available without truncating the arrays. The generic decoder expects the current 818-byte layout and rejects an older 786-byte Treasury; supervisor migration is a separate program operation.

## Mint and derived fields

`decodeMintAccount(data)` returns `mintAuthority`, `supply: BN`, `decimals`, `isInitialized`, `freezeAuthority`, and extension type IDs in `extensions`. It checks the base mint shape, authority-option tags, initialized flag and Token-2022 mint/TLV structure. It lists extensions; it does not decode every extension-specific configuration payload or prove transfer compatibility.

`sync()` adds token `index`, `vault`, optional display `metadata`, `concentration`, mint `decimals`, `extensions`, and `unsupportedExtensions`. Pool-level derived fields are `address`, `bptMint`, `bptTokenProgram`, `bptTotalSupply`, `unsupportedTokenIndices`, `chainTimestamp` (seconds) and `syncedAt` (local milliseconds). Metadata/concentration are display conveniences, not on-chain state.

`PoolInfo.createdAt` and `chainTimestamp` are numbers for compatibility. Values outside the exact safe-number range cause a `parse_failure` result rather than truncation. Raw account decoders retain full i64 precision. All token balances, fees, windows and supply remain BN. Separate account reads are not an atomic multi-account snapshot.

```ts
const account = await pool.rpc.getAccountInfo(configAddress);
if (!account.ok) throw new Error(account.error.humanMessage);
if (!account.data || !account.data.owner.equals(config.programs.cubicPool)) {
  throw new Error("Config account missing or wrong owner");
}
const state = decodeContractAccount("cubicPool", "CubicPoolConfig", account.data.data);
// state.protocol_admin, state.pending_protocol_admin,
// state.default_protocol_fee_rate, state.banned_extensions,
// state.hard_banned_extensions, state.reserved
```

The example assumes an existing pool client/config and `configAddress: PublicKey`. For Treasury, derive its PDA with `deriveTreasuryPda`, read its account, verify the protocol-admin owner, and decode `"protocolAdmin", "Treasury"`.

## Validation

`tests/account-state.test.ts` compares the manual decoder and every operational `sync()` field against an independent IDL-driven Borsh fixture. It covers all ten token slots, nonzero padding, mixed token programs, negative i64, u64 values above `Number.MAX_SAFE_INTEGER`, malformed discriminators/booleans and precise numeric-conversion failures.

`tests/contract-abi.test.ts` covers all complete config/Treasury/pool layouts, all 59 instructions and all 60 events. `scripts/check-contract-abi.cjs --contracts-dir ...` compares the bundled IDLs with a chosen checkout’s target IDLs.
