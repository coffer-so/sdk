# Exact decoded state mapping

Target: `@coffer_so/sdk-v6` 0.3.0; contract source `contracts` v6.1 (`v6.1-t11` at `409067d`: L0/T1/T2/T3/T5/T6/T7/T8/T9/T10/T11/T12/T14/T15/T22).
v6 added the `"V5M1"` migration marker in `CofferPool.reserved[0..4]` (`v5Migrated`); v6.1 (L0) grows
`CofferPool` 1683 → **2304 bytes** by APPENDING a block after the frozen legacy `reserved[16]` — every
pre-existing offset is unchanged — and `Treasury` 818 → **1624 bytes** (T3). The 1683-byte account is
the v6.1 account's prefix: `decodePoolAccount` reads it READ-ONLY (`layoutVersion = 0`, every appended
field at its default), and the v6.1 program refuses every instruction on it with
`LayoutVersionMismatch` (6070) until the permissionless `migrate_pool_layout_v61` grows it.

Three read interfaces serve different purposes:

- `CofferPoolClient.sync()` returns operational camelCase `PoolInfo`, enriched with mint data and Solana Clock. `getCached()` returns that last snapshot without RPC. There is no `getState()` method.
- `decodePoolAccount(data)` preserves the complete pool layout (2304 bytes, or the 1683-byte unmigrated prefix) as `RawPoolAccount`, including all ten slots as parallel arrays, `reserved: Buffer`, the v6.1 block and `layoutDrift` notes.
- `decodeTreasuryAccount(data)` (v6.1) decodes the 786 / 818 / 1624-byte `Treasury` by raw offsets with the T3 cooldown slots.
- `decodeContractAccount(program, accountName, data)` returns the complete exact IDL structure with snake_case names, nested structs, padding arrays and full-width `BN` integers. It also covers config and Treasury.

The decoders validate size and discriminator. The manual pool decoder also validates canonical Borsh booleans and `token_count <= 10`. It reads `i64` as signed two’s complement. A correctly sized account is not proof of migration: v4 and v5 are both 1683 bytes; a 2304-byte account is a v6.1 account (`layout_version` must read 1 — anything else is reported in `layoutDrift`, never thrown). Interpret this table only for the target program/layout.

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

End of the v4/v5 prefix: **1683 bytes**. Reserved bytes are copied; changing the returned padding buffer does not mutate the input buffer.

### v6.1 appended block (bytes 1683..2304)

Defaults on an unmigrated 1683-byte account: 0 / `[]` / `false` / `PublicKey.default`; `pendingActions = []`, `reservedV61` empty. `PoolInfo` arrays carry `tokenCount` entries, `RawPoolAccount` arrays carry all ten slots.

| Contract field | Type | Byte offset | RawPoolAccount | PoolInfo from sync | Task |
| --- | --- | ---: | --- | --- | --- |
| `layout_version` | `u8` (= 1) | 1683 | `layoutVersion` | `layoutVersion`, `needsLayoutMigration` | L0 |
| `token_decimals` | `[u8; 10]` | 1684 | `tokenDecimals` | `tokenDecimals`, `tokens[i].pinnedDecimals` (+ `pinnedDecimalsMismatch` vs the live mint) | L0 FIX-6 |
| `creator_fee_bps` | `u16` | 1694 | `creatorFeeBps` | `creatorFeeBps` | T14 |
| `creator_fees_owed` | `[u64; 10]` | 1696 | `creatorFeesOwed` | `creatorFeesOwed`, `tokens[i].creatorFeesOwed` | T14 |
| `surge_fees_owed` | `[u64; 10]` | 1776 | `surgeFeesOwed` | `surgeFeesOwed`, `tokens[i].surgeFeesOwed` (LP NAV = actual + surge) | T12 |
| `deposit_fee_bps` | `u16` | 1856 | `depositFeeBps` | `depositFeeBps` | T7 |
| `withdraw_fee_bps` | `u16` | 1858 | `withdrawFeeBps` | `withdrawFeeBps` | T7 |
| `liquidity_fee_lock` | `u8` (bit 0) | 1860 | `liquidityFeeLock` | `liquidityFeeLock`, `liquidityFeesLocked` | T7 |
| `range_manager_locked` | `bool` | 1861 | `rangeManagerLocked` | `rangeManagerLocked` | T6 |
| `pool_admin_delay_secs` | `u32` | 1862 | `poolAdminDelaySecs` | `poolAdminDelaySecs` | T3 |
| `pool_admin_epoch` | `u32` | 1866 | `poolAdminEpoch` | `poolAdminEpoch` | T3 |
| `pending_pool_admin_eta` | `i64` | 1870 | `pendingPoolAdminEta`, `pendingActions[0]` | same | T3 (kind 0, nominee @98) |
| `pending_set_delay` | `{eta: i64, secs: u32}` | 1878 | `pendingActions[1]` | same | T3 kind 1 |
| `pending_set_swap_fee_rate` | `{eta, rate: u32}` | 1890 | `pendingActions[2]` | same | kind 2 |
| `pending_set_creator_fee_bps` | `{eta, bps: u16}` | 1902 | `pendingActions[3]` | same | kind 3 |
| `pending_set_liquidity_fees` | `{eta, deposit_fee_bps: u16, withdraw_fee_bps: u16}` | 1912 | `pendingActions[4]` | same | kind 4 |
| `pending_lock_liquidity_fees` | `{eta}` | 1924 | `pendingActions[5]` | same | kind 5 |
| `pending_lock_range_manager` | `{eta}` | 1932 | `pendingActions[6]` | same | kind 6 |
| `pending_set_range_manager` | `{eta, manager: pubkey, enabled: bool}` | 1940 | `pendingActions[7]` | same | kind 7 |
| `pending_set_range_manager_config` | `{eta, u16, u16, u32, u32, u32}` | 1981 | `pendingActions[8]` | same | kind 8 |
| `pending_set_max_selloff` | `{eta, params_hash: [u8; 32]}` | 2005 | `pendingActions[9]` (`paramsHash` hex) | same | kind 9 |
| `pending_set_token_active` | `{eta, token_index: u8}` | 2045 | `pendingActions[10]` | same | kind 10 |
| `hook_program` | `pubkey` | 2054 | `hookProgram` | `hook.program` (`hook = null` when default) | T9 |
| `hook_flags` | `u16` | 2086 | `hookFlags` | `hook.flags` | T9 |
| `hook_disabled` | `u8` | 2088 | `hookDisabled` | `hook.disabled`, `hook.active` | T9 |
| `hook_fee_min` / `hook_fee_max` | `u32` / `u32` | 2089 / 2093 | `hookFeeMin` / `hookFeeMax` | `hook.feeMin` / `hook.feeMax` | T9 |
| `hook_max_cu` | `u32` | 2097 | `hookMaxCu` | `hook.maxCu` | T9 |
| `hook_accounts_len` | `u8` | 2101 | `hookAccountsLen` | `hook.accountsLen` | T9 |
| `reserved_v61` | `[u8; 202]` | 2102 | `reservedV61: Buffer` | Omitted (`layoutDrift` lists a non-zero reserve) | — |

Total size: **2304 bytes**. `pendingActionsMask` (bit `kind` ⇔ `eta != 0`) is derived; `pendingStatus(eta, chainNow)` classifies a slot as none / waiting / ready / expired against the Clock sysvar (14-day grace).

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

Use `decodeTreasuryAccount(data)` (raw offsets, accepts 786 / 818 / 1624 bytes) or `decodeContractAccount("protocolAdmin", "Treasury", data)` (current 1624-byte layout only). `sync()` does not fetch this account.

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
| `delay_secs` (v6.1 T3) | `u32` | 818 |
| `admin_epoch` | `u32` | 822 |
| `pending_admin_eta` | `i64` | 826 |
| `pending_set_delay` … `pending_program_op` (kinds 1..12) | typed slots, see `TREASURY_LAYOUT` | 834 … 1426 |
| `pending_pool_rescale_virtual_balances` (v6.1 T22, kind 13) | `{ eta: i64, pool: pubkey, multiplier: u64 }` (48 B) | 1499 |
| `reserved_v61` | `[u8; 77]` | 1547 |

Current account length: **1624 bytes** (v3) including discriminator; v2 = 818, v1 = 786 (no supervisor). T22 carved the kind-13 slot from the v3 reserve (125 → 77 B); `LEN` is unchanged. The v6.1 program refuses every typed Treasury instruction until the admin runs `migrate_treasury_layout_v61` (`treasuryNeedsLayoutMigration`).

Bytes 74..90 of the config and 1651..1659 of the pool held the Token-2022 extension-policy bitmaps until v6.1. The policy was removed (T19): no code path reads them, existing accounts still carry their old values, fresh accounts write zero. They are exposed raw (`_deprecated_extension_policy`, `deprecatedBannedExtensions`) only so every later field keeps its byte offset; never interpret them.

Treasury’s registered `token_mints` and `token_vaults` are distinct from pool reserve ATAs and compat-only since v6.1 (T5: the vault PDA `[b"vault", mint]` is self-describing, no mint cap). Its `supervisor`, `pending_admin` and active `token_count` are available without truncating the arrays. The generic decoder expects the current 1624-byte layout; `decodeTreasuryAccount` reads every size.

## Mint and derived fields

`decodeMintAccount(data)` returns `mintAuthority`, `supply: BN`, `decimals`, `isInitialized`, `freezeAuthority`, extension type IDs in `extensions`, the three extension bodies the v6 transfer path depends on: `transferFeeConfig` (both epoch schedules), `transferHook` (`programId === PublicKey.default` means disarmed) and `pausableConfig`, and (v6.1 T1) `metadataPointer` + `tokenMetadata` (in-mint `TokenMetadata`: name / symbol / uri / `("pool", <pool>)`; `null` on a legacy SPL Token LP mint — show a synthetic label). It checks the base mint shape, authority-option tags, initialized flag, Token-2022 mint/TLV structure and rejects a fee schedule above 100 % like the program. Other extension payloads are not decoded.

`sync()` adds token `index`, `vault`, optional display `metadata`, `concentration`, mint `decimals`, `extensions`, `unsupportedExtensions` (only `NonTransferable`/unknown types), `transferFee` (the schedule selected for `chainEpoch`), `transferHookProgram` (armed hooks only), `paused`, and (v6.1) `sidelined` (`actualBalance == 0`), `pinnedDecimals` / `pinnedDecimalsMismatch`, `creatorFeesOwed`, `surgeFeesOwed`. Pool-level derived fields are `address`, `lpMint`, `lpTokenProgram` (read from the LP mint's owner: Token-2022 since v6.1, SPL Token on older pools), `lpMetadata`, `lpTotalSupply`, `unsupportedTokenIndices` (unsupported, paused, native-mint or decimals-mismatched tokens), `chainSlot`, `chainEpoch`, `chainTimestamp` (seconds), `v5Migrated`, `needsLayoutMigration`, `hook`, `layoutDrift` and `syncedAt` (local milliseconds). Metadata/concentration are display conveniences, not on-chain state.

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

`tests/contract-abi.test.ts` covers all complete config/Treasury/pool layouts, all 107 instructions and all 79 events. `tests/v61-decoder.test.ts` pins every v6.1 offset against the contracts' `tests/utils/v61-layout.ts` table (2304-byte and 1683-byte pools, Treasury v1/v2/v3, LP metadata). `scripts/check-contract-abi.cjs --contracts-dir ... --idl-dir idl --ignore-address` compares the bundled IDLs with a chosen checkout’s committed IDLs.
