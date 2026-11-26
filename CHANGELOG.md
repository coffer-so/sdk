# Changelog

Entries below 0.2.0 keep the names in use at the time (`BPT`, `Cubic*`,
`cubic_pool`); they were not rewritten.

## 2.0.0 — the v6.1 contracts SDK, rewards on the rc8+ ABI, pool admins' boosts

`@coffer_so/sdk` 2.0.0 merges the v6.1 contracts SDK (`@coffer_so/sdk-v6` 0.4.0, branch
`feature/sdk-v6.1` at `d08f967`, contracts v6.1-rc9) into the 1.x line (backend client 1.4.9,
rewards 1.5.0). Breaking for 1.x consumers; 1.x stays on `release/1.x` for v5.1 pools.

- Migration from 1.x: `CubicPoolClient` → `CofferPoolClient`, BPT → LP in every name
  (`deriveLpMint`, `calcTokensOutGivenLpIn`, …), `parseCubicPoolEvents` → `parseCofferPoolEvents`
  (V2 events), `IDLS.cubicPool` / program key `cubicPool` → `cofferPool`, two-step pool creation
  (`initialize_pool` + `seed_liquidity`, `buildAtomicDeploy`), planned / routed single-token deposits
  (`PlannedZapClient`), `getConfig("mainnet")` = the v6 standalone factory (v5.1 as
  `MAINNET_V51_FACTORY_PROGRAMS`), `POOL_LEN` 2304, fee ceilings 100 %. `CofferBackendClient` is unchanged.
- Rewards (coffer_rewards rc9, IDL `1ec8bfa8…`): voucher V2 (`domain`, `expiresAt`; 169-byte message,
  281-byte Ed25519 instruction), claims pass `expires_at`; Campaign 518 bytes (payout window, domain,
  version), Receipt 32 bytes, `ClosedCampaign` marker; `set_payout_limit`, `close_native` /
  `close_token`, `close_receipt` builders; deposits from any funder; `slot_hashes` in initialize;
  errors 6009–6011; `CampaignClosed` event; payout-window preview in `rewardClaimPayout` /
  `loadRewardClaimState`; `boostsCampaignId(cluster, mint, generation)` (id v2).
  `DEVNET_V61_PROGRAMS.cofferRewards` = the rc9 devnet program.
- Pool admins' boosts: `getPoolAdminBoosts`, `getPoolAdminCampaignParams`, `registerPoolAdminCampaign`,
  `getPoolAdminCampaigns`, `refreshPoolAdminCampaign`, `previewPoolAdminBoost`, `createPoolAdminBoost`,
  `updatePoolAdminBoost`, `stopPoolAdminBoost`, `cancelPoolAdminBoost`; `buildPoolAdminCampaignSetup`,
  `suggestedPayoutLimit`. `PoolBoostItem.uncapped` / `paused` / `sponsor`, `PublicCampaign.ownerKind` /
  payout limit / `closedAt`, voucher answer `domain` / `expiresAt` / `windowResetsAt`.

## Unreleased

### 2026-11-23: dead-code removal, helper-account recovery, priced LP supply, plan commitment v2 (contracts `v6.1` working tree on `e545874`)

- IDLs re-synced from `contracts-v6.1/idl` (== `target/idl`; coffer_pool `ee6863f9…`, protocol_admin `fbb98b89…`,
  single_token_liquidity `dac31462…`): 118 instructions / 87 events (56+58+4 / 44+40+3), epoch `abi-sync-20261123`.
  Generated types and event fixtures regenerated; the Rust math reference (`fixtures:rust`) builds again against the
  current sources (`udiv` kernel, decimals-free `calc_out_given_in`) and its 1085 vectors are unchanged.
- REMOVED: `AdminClient.migratePoolToV5Ix` (`pool_migrate_to_v5` / `migrate_to_v5` no longer exist); the
  `PoolMigrationV5Applied` / `PoolMigratedToV5ViaTreasury` events (their discriminators and the v6
  `PoolMigratedToV5` one are pinned in `RETIRED_EVENTS`; removed instruction discriminators in the new
  `REMOVED_INSTRUCTIONS`). STLD `deposit_single_token` / `deposit_single_token_direct` are gone from the IDL (the
  SDK never built them). `setSupervisorIx` no longer passes `system_program`.
- NEW: `AdminClient.stldCloseHelperTokenAccountIx(admin, config, pool, helperTokenAccount, mint, tokenProgram?, tail?)`
  — `stld_close_helper_token_account` (sweep to the Treasury vault PDA of the mint, rent to the Treasury; helper PDA
  derived). Errors 6120 `RecipientIsVault`, 6121 `MaxSelloffCapZero`, PA 6020 `SelfCloseForbidden`, STLD 6041
  `InvalidRecoveryDestination` mapped with user-facing messages.
- Priced LP supply: `pricedLpSupply(mintSupply, stream, now)` / `pricedLpSupplyOf(pool, nowSeconds?)` mirror
  `CofferPool::priced_lp_supply` (mint supply net of the vested LP burn stream). `quoteAddLiquidity(amounts, slip?,
  nowSeconds?)`, `quoteRemove(lpIn, nowSeconds?)`, `quoteFundSidelinedToken`, `quoteRedeemLpTransferFees` and the
  planned / routed zap quote price on it (default clock: the synced `chainTimestamp`; a pending stream without any
  clock is `unsupported_pool_state`). `quoteRemove` mirrors `exit_withdraw_fee_bps` (new export): a burn of the whole
  priced supply pays no withdraw fee.
- Plan commitment v2: `PLAN_DOMAIN = "coffer-stld-v6-plan-v2"`, new `mintFingerprint` / `MAX_FINGERPRINT_EXTENSIONS`;
  the LP mint and every token mint are committed by fingerprint (decimals, extension ids, fee schedules, hook program,
  paused flag; LP supply), so an underlying mint's supply / withheld fees / authorities no longer stale a plan and a
  sidelined slot's closed mint does not block the zap. `V6_PLAN_HASH_VECTOR` updated, `V6_PLAN_HASH_VECTOR_RICH`
  added (both `plan.rs` cross-language vectors, byte-exact tests).
- Zap: `sidelinedTokenIndices` is NAV-based (`actual + surge_fees_owed == 0`); `ensureUserTokenAccountIxs` skips
  sidelined slots (the program no longer validates their mint / user account / vault); the quote no longer validates
  a sidelined slot's mint. `buildRoutedIx` accepts a join-only plan (the program runs the planned path); `"routed"`
  honours the request, `"auto"` still resolves a join-only plan to planned without probing.

### 2026-11-22 rc7: pool `vault_bump_cache` (contracts `v6.1` `e22707d`)

- IDLs re-synced from `contracts-v6.1/target/idl` (coffer_pool `167baeb9…`, single_token_liquidity
  `471c9500…`, protocol_admin unchanged `7de8e983…`): `CofferPool.vault_bump_cache: [u8; 10]` @2168 carved
  from the front of `reserved_v61` (136 → 126 B, now @2178); account size 2304 unchanged, no instruction,
  event or error change (plus two doc-only hook strings: `hook_max_cu` recorded, not enforced; `cu_used`
  always 0).
- `POOL_LAYOUT.VAULT_BUMP_CACHE` / `RESERVED_V61 { offset: 2178, size: 126 }`; `RawPoolAccount.vaultBumpCache`
  (ten raw bytes, `bump + 1`, 0 = not cached; zeros on an unmigrated account); a non-zero byte past
  `tokenCount` is `layoutDrift`. Not surfaced on `PoolInfo`. Generated types / event fixtures regenerated
  (epoch `rc7-vault-bump-20261122`); `npm run abi:check` now points at `../contracts-v6.1`.

### 2026-11-22 rc5 fixes: compute-budget dedupe in `compileTransaction`, routed heap-frame error

- FIX: `compileTransaction` / `compilePlannedZapTransaction` no longer prepend a second
  `setComputeUnitLimit` (or `requestHeapFrame`) when `instructions` already carry one — the documented
  flow `compileTransaction({ instructions: buildTx().instructions })` / `depositRouted().instructions`
  was refused by the runtime ("Transaction contains a duplicate instruction"). The caller's own
  compute-budget instruction is kept; byte-identical repeats of `setComputeUnitLimit` /
  `setComputeUnitPrice` / `requestHeapFrame` are dropped; contradicting values (two different
  instructions of one kind, or `computeUnits` / `heapFrameBytes` vs. an instruction already present) are
  refused with `tx_build_failed`.
- New `SdkErrorCode` `routed_heap_frame_required`: `toSdkError(cause, program, { routedDeposit: true })`
  (or `{ instructions }` containing `deposit_single_token_routed` / `swap_route_join_v1`) maps
  `ProgramFailedToComplete` / "Program failed to complete" (the pool's heap access violation without
  `requestHeapFrame(64 KiB)`) to an actionable message. Without routed context it stays `unknown`.
  `containsRoutedDepositInstruction`, `SdkErrorContext` exported.

### 2026-11-22 rc5: routed single-token deposit, `swap_route_join_v1`, `ExitPaysNothing` (contracts `v6.1-n10` `b9fc7e9`)

- IDLs re-synced from `contracts-v6.1-n10/target/idl` (coffer_pool `9e3df59d…`, single_token_liquidity
  `87c764fa…`, protocol_admin unchanged): 120 ix / 87 events. New `swap_route_join_v1` (pool, returns
  `RouteReturnV1`), `deposit_single_token_routed` (STLD), errors 6116 `ExitPaysNothing`, 6117
  `RouteAllocationsLength`, 6118 `RouteNoLegs`, 6119 `RouteComputeBudgetInsufficient`, STLD 6040
  `RoutedReturnDataInvalid`. Generated types / event fixtures regenerated (epoch `rc5-route-20261122`);
  `abi:check` now targets `../contracts-v6.1-n10 --idl-dir target/idl`.
- `buildRoutedZapIx` (alias `buildRoutedZapInstruction`), `buildDirectZapIx(…, "planned" | "routed")`,
  `ROUTED_ZAP_DISCRIMINATOR_HEX`, `ROUTED_ZAP_HEAP_FRAME_BYTES` (64 KiB), `routedZapComputeBudgetIxs`.
  Byte-for-byte the planned instruction with the routed discriminator (checked against the contracts'
  raw routed builder, the IDL encoder and Anchor's coder).
- `PlannedZapClient`: `route: "auto" | "planned" | "routed"` constructor option (default `"planned"`),
  `buildRoutedIx` / `buildRoutedTx` / `depositRouted` (CU limit + 64 KiB heap frame + routed ix, same
  quote / plan / `minimumLp`), `buildDepositTx` (resolves the route; `"auto"` probes both programs with a
  discriminator-only simulation — 102 present / 101 absent — and falls back to planned), `resolveRoute`,
  `probeRoutedSupport`. A plan without a swap leg never routes. `compileTransaction` /
  `compilePlannedZapTransaction` accept `heapFrameBytes`.
- `buildSwapRouteJoinV1Ix` / `buildSwapRouteJoinV1Tx` (pool-level route, `add_liquidity` account layout;
  Tx adds the heap frame).
- `calculateExitPayout` / `quoteRemove` mirror `ExitPaysNothing` (BEHAVIOUR: a dust burn on a funded pool
  is now `amount_too_small` instead of a zero-payout quote). Error tables map 6116–6119 / STLD 6040 with
  user-facing messages.

### 2026-11-19 LP transfer fee burn stream is true linear vesting (contracts `c9f8f1c`: X1)

- IDLs re-synced (coffer_pool / single_token_liquidity changed: the embedded `CofferPool`
  type and `LpTransferFeesCollected`; counts unchanged at 118 ix / 87 events); generated
  types and event fixtures regenerated; `abi:check` green against `contracts-v6.1@c9f8f1c`.
- New pool field `lp_transfer_fee_burn_end_ts` (i64 @2160, carved AFTER cooldown slot 11;
  `reserved_v61` 144 → 136 B @2168, LEN 2304) decoded as `RawPoolAccount` /
  `PoolInfo.lpTransferFeeBurnEndTs` (`layoutDrift` flags a negative value). The stream is
  the triple `(pending @2134, last_ts @2142, end_ts @2160)`; `lpBurnStreamOf(pool)` reads
  it from a `PoolInfo` / `RawPoolAccount` (zero-filled on a migrated pool).
- Stream math re-cut as an exact mirror of `math/lp_transfer_fee.rs`:
  `lpTransferFeeDrip(pending, lastTs, endTs, now)` (BREAKING: 4-arg; `0` at
  `now ≤ lastTs` or nothing pending, everything at `now ≥ endTs`, else
  `floor(pending · (now − lastTs) / (endTs − lastTs))`), new `lpTransferFeeSettle`
  (`lastTs` moves to `now` only when something burned; an emptied stream collapses to
  `now`; `MathUnderflow` past `pending`) and `lpTransferFeeSchedule` (amount-weighted end
  `floor((P · rem + A · W) / (P + A))`, carried accrual `δ = min(ceil(g · D / (d · T − g)),
  floor((D − 1) / (T − 1)))`, `MathOverflow` where the program errs), plus
  `collectLpTransferFeeStep` — the handler's bookkeeping (sweep → drip → settle → split →
  schedule) that `previewLpTransferFeeCollection` and `quoteLpTransferFeeBurnStream` are
  built on. Both take `burnEndTs` now (BREAKING); the preview returns `burnEndTsAfter`
  (the event's `burn_end_ts`), the quote returns `streamAfter` and `fullyReleasedAt =
  endTs`. `quoteRedeemLpTransferFees(...).streamBurnNow` drips over the pool's segment.
- `LpTransferFeesCollected` (unreleased event, discriminator unchanged) appends
  `burnEndTs: BN` (i64).
- Tests: `tests/v61-lp-transfer-fee-stream.test.ts` ports the native vectors
  (`v61_lp_transfer_fee.rs` 28 / 29 / 30 / 34–38 / neg 25, python-verified constants
  included) and the proptests 31 / 32 / 33 / 39 over a fixed-seed generator.

### 2026-11-19 LP transfer fee review fixes (contracts `a622faa`: L-1 / I-1 / I-2)

- IDLs re-synced (coffer_pool now 56 ix / 45 events — 118 / 87 overall); generated types
  and event fixtures regenerated; `abi:check` green against `contracts-v6.1@a622faa`.
- L-1 burn stream: `collect_lp_transfer_fees` no longer burns at collection. New pool
  fields `lp_transfer_fees_pending_burn` (u64 @2134) and `lp_transfer_fee_burn_last_ts`
  (i64 @2142) are decoded (`RawPoolAccount` / `PoolInfo.lpTransferFeesPendingBurn` /
  `lpTransferFeeBurnLastTs`). New `LP_TRANSFER_FEE_BURN_WINDOW_SECS` (86_400),
  `lpTransferFeeDrip(pending, lastTs, now)` (exact mirror of `lp_transfer_fee_drip`:
  `min(pending, floor(pending · max(0, now − lastTs) / 86_400)`, i64-saturating),
  `quoteLpTransferFeeBurnStream` (effective burn / LP supply at a chain time) and a
  re-cut `previewLpTransferFeeCollection` (program order: sweep → drip burn → re-base →
  `collected = amount − (owed + pending)` → split, the burn part queued). The fee-account
  invariant is now `amount == owed + pending_burn`; `quoteRedeemLpTransferFees` is
  pending-aware (`feeAccountReserved = owed + pending`, `LpFeeAccountUnderfunded` below
  it, `FullExitRequiredBelowFloor` at `supply ≤ 1000` with a pending stream; the redeem
  builders refuse the latter client-side).
- `LpTransferFeesCollected` re-shaped (unreleased event, discriminator unchanged):
  `collected`, `protocolPart`, `scheduledBurn`, `burnedNow`, `protocolOwedAfter`,
  `pendingBurnAfter`, `lpSupplyAfter`, `timestamp` (`burned` is gone).
- I-1: `set_lp_transfer_fee` is D-class — `pool` is writable, the direct builder refuses
  a snapshot with `pool_admin_delay_secs > 0` (`CooldownRequired` 6089). Pool-admin
  cooldown kind 11 `SetLpTransferFee` (`POOL_ACTION_KINDS` is 12 long, Borsh tag 10,
  slot `{ eta: i64, bps: u16 }` @2150, `pendingActions[11]`, mask bit 11, reserve now
  144 B @2160): `PoolActions.setLpTransferFee`, `buildExecutePoolActionIx(.., 11)` →
  `execute_set_lp_transfer_fee` (`e35b25e5e4e08a9b`, `[pool w, lp_mint w, authority s,
  Token-2022]`), plus `buildProposeSetLpTransferFeeIx` / `buildCancelSetLpTransferFeeIx` /
  `buildExecuteSetLpTransferFeeIx` and `SET_LP_TRANSFER_FEE_KIND`.
- I-2: `initialize_pool` emits `PoolInitializedV2` before `LpTransferFeeUpdated`; the
  parser keeps log order (test pinned), nothing in the SDK assumed the old order.

### 2026-11-19 LP transfer fee (contracts `0815207`)

- Vendored IDLs re-synced from `contracts-v6.1/idl` (coffer_pool 55 ix / 45 events,
  protocol_admin 58 / 40, STLD 4 / 2 — 117 / 87); generated types and event fixtures
  regenerated (epoch `lp-transfer-fee-20261119`). Wire pins unchanged; `initialize_pool`
  gained a trailing `lp_transfer_fee_bps: u16` (re-cut args, same discriminator).
- `initialize_pool` / `buildDeployPoolTx` / `buildAtomicDeploy`: new `lpTransferFeeBps`
  (default 0, `0..=1_000`, `LpTransferFeeMaxExceeded` 6111) written into the LP mint's
  Token-2022 `TransferFeeConfig` (both authorities = the pool PDA, `maximum_fee = u64::MAX`).
- New `clients/lpTransferFee.ts`: `deriveLpFeeAccount` (`ATA(pool, lp_mint, Token-2022)`),
  `treasuryPoolTag` (`sha256(pool)[..16]`), `buildSetLpTransferFeeIx`,
  `buildSetLpTransferFeeProtocolShareIx` (raw) + `buildPoolSetLpTransferFeeProtocolShareIx` /
  `buildExecutePoolSetLpTransferFeeProtocolShareIx` (protocol-admin wrapper, kind-15 queue),
  `buildCollectLpTransferFeesIx` / `buildCollectLpTransferFeesTx` (idempotent fee-account
  create + source sweep), `buildRedeemLpTransferFeesIx` (raw) +
  `buildPoolRedeemLpTransferFeesIx` (recipients pinned to the Treasury vault PDAs),
  `quoteRedeemLpTransferFees`, `readLpTransferFeeConfig` / `fetchLpTransferFeeConfig`.
  `AdminClient` gained `poolSetLpTransferFeeProtocolShareIx`,
  `executePoolSetLpTransferFeeProtocolShareIx`, `poolRedeemLpTransferFeesIx`;
  `ProtocolActions.poolSetLpTransferFeeProtocolShare` (kind 15, tag 14).
- New `math/lpTransferFee.ts`: Token-2022 fee math (`ceil(amount · bps / 10_000)` capped at
  `maximumFee`, epoch-aware `older` / `newer`), inverse (`lpGrossForNet`),
  `splitLpTransferFee` (floor on the protocol part) and `previewLpTransferFeeCollection`.
- Decoders: `CofferPool.lp_transfer_fee_protocol_share_bps` @2124 and
  `lp_transfer_fees_owed_protocol` @2126 (reserve now 170 B @2134); Treasury kind-15 slot
  `pending_pool_set_lp_transfer_fee_protocol_share` @1587 (`{ bps, poolTag }`, reserve 11 B
  @1613); `PoolInfo.lpTransferFeeConfig` / `lpTransferFee` / `lpTransferFeeProtocolShareBps` /
  `lpTransferFeesOwedProtocol`.
- Events: typed `LpTransferFeeUpdated`, `LpTransferFeeProtocolShareUpdated`,
  `LpTransferFeesCollected`, `LpTransferFeesRedeemed`; protocol-admin
  `PoolLpTransferFeeProtocolShareSet` / `PoolLpTransferFeesRedeemed` through the generic path.
- Errors 6111–6115 (`LpTransferFeeMaxExceeded`, `LpTransferFeeUnsupported`,
  `LpTransferFeeProtocolShareMaxExceeded`, `NoLpTransferFeesOwed`, `LpFeeAccountUnderfunded`)
  with user-facing messages.
- LP account sizing: `lpTokenAccountSize` (`getAccountLenForMint` semantics: a fee-bearing
  LP ATA is 182 B), `LP_MINT_BASE_SIZE` is now 346 (`LP_MINT_BASE_SIZE_PRE_FEE` = 234),
  `lpMintAccountSize(args, pool, withTransferFee = true)`. `validatePlannedZapLpMint` admits
  `TransferFeeConfig` next to the metadata pair (mirrors STLD `token_validation.rs`).

### 2026-11-13 candidate

- Mirror the proposed per-leg deposit rounding bound before transfer-fee gross-up; retain caller policy. D6 owner ratification remains pending.
- Regenerate all three IDLs; append pool 6110 (`deposit_rounding_loss`) and protocol-admin 6019 (`invalid_input`). Existing wire layouts/discriminators are preserved.
- Export `checkDepositRounding` and `sizeDepositForLp`; raw encoders still require callers to validate state.

- Add and planned-zap clients refuse excessive per-leg token-credit / LP-mint
  rounding loss using the caller's slippage tolerance (`deposit_rounding_loss`).
  Add builders now price against NAV, including surge buckets, and reject
  deposits consumed by the deposit fee. LP quote minima stay positive.
  See [scope, formula, costs and low-level boundaries](docs/LIQUIDITY_ROUNDING.md).
- Match rc2 surge quadrature's saturating segment output and running maximum
  when cumulative output dips through integer rounding.

## 0.4.0 — v6.1-rc2

Targets `contracts-v6.1` at the `v6.1-rc2` ABI. The vendored IDLs are the
exact `anchor build` output (sha256 `f031d8b1…` / `c797bba6…` / `413ea7da…`,
see `docs/CONTRACT_COMPATIBILITY.md`): 51 + 55 + 4 instructions, 41 + 38 + 2
events (110 / 81).

### Breaking

- The never-deployed "N10 batch" route is gone from the contracts and the SDK:
  `batch_single_token_planned_v1` / `deposit_single_token_batch_planned_v1`,
  `BatchFinancialReceiptV1` / `BatchSingleTokenDepositV1`, the 25 STLD error
  codes that had been mirrored into coffer_pool, `BatchPlannedZapV1Client`,
  `buildBatchPlannedZapV1Ix`, `parseBatchPlannedZapV1Receipt`, the compact
  receipt codec and the batch docs / fixtures / support-matrix tooling.
- `leverage` / `Leverage` / `LEVERAGE` names are `concentrationFactor` /
  `ConcentrationFactor` / `CONCENTRATION_FACTOR` everywhere (IDL wire
  fields `concentration_factor`; `PoolTokenInfo.concentrationFactor`). No
  old-name aliases. Wire discriminators, offsets, integer types, error numbers
  and economic formulas are unchanged.

### Added

- `close_upgrade_buffer` (`AdminClient.closeUpgradeBufferIx(admin, buffer,
  recipient)`) and the `UpgradeBufferClosed` event (`treasury`, `admin`,
  `buffer`, `recipient`, `lamports`, `timestamp`): instant admin-only rent
  recovery of a Treasury-owned loader buffer after a cancelled or superseded
  upgrade proposal.
- Errors 6107 `WithdrawFeeNotLockable`, 6108 `RangeManagerKeyRequired`,
  6109 `FullExitRequiredBelowFloor` in `describeProgramError`.
- Pool `safety_flags` bit 13 `SAFETY_FLAG_RANGE_MANAGER_WAS_ENABLED`
  (`PoolInfo.protocolRangeManagerWasEnabled`); `SAFETY_FLAG_*` /
  `SAFETY_FLAGS_KNOWN_MASK` constants; the decoder accepts bits 0–13.

### Changed

- `migrate_pool_layout_v61` semantics: the migration writes no protocol
  restriction bits; `SAFETY_FLAG_SEEDED` is set only when some slot has
  `actual_balance > 0` or `protocol_fees_owed > 0`.
- Planned zap accepts the exact contract LP metadata extension pair, and
  separates native `hookAccounts` from `token2022Accounts`; ambiguous
  arrays are rejected. Exit tails and quotes share the reserve / surge /
  withdraw-fee payout calculation. Atomic deploy validates epoch-selected net
  seed credits and mint snapshots and includes Token-2022 extras in the
  packet / ALT cost; external hooks need a caller-supplied trace budget.
  `applyRescale` reports its projection scope.

## Historical 0.3.0 record (pre-rename)

The following entry records the names, pins and counts used at that time;
its “final” wording and counts do not describe the current source epoch.

## 0.3.0 — v6.1 final ABI: T11 re-cut events, T22 leverage invariant, T9 sync

Targets `contracts` `v6.1-t11` at `409067d` (T9 hooks, T22 leverage
invariant / rescale, T11 events overhaul). The ABI is final; the pending merge
into `v6.1` and the T21-B2 cleanup change no ABI (update the pin in
`docs/CONTRACT_COMPATIBILITY.md` to the merge sha at release). IDLs: 51 / 52 /
4 instructions, 41 / 36 / 2 events (107 / 79).

### Breaking

- **Events re-cut (T11)**: every payload that changed since the v6 wire has a
  new name and discriminator. `parseCofferPoolEvents` returns `SwapV2`
  (`tokenInIndex/OutIndex`, the whole cascade, `inBefore/inAfter/outBefore/outAfter: SlotState`,
  `selloffWindow: SelloffWindowState | null`), `LiquidityAddedV2` /
  `LiquidityRemovedV2` (`lpSupplyBefore/After`, six before / after vectors,
  `requestedLp`, `transferFeesOut`, `hooksBypassed`), `PoolInitializedV2`,
  `PoolInfoV2`, `SingleTokenDepositDirectV2` (plan hash / validity,
  `innerSwapCount`, `lpSupplyBefore/After`), `ProtocolFeesCollectedV2`,
  `CreatorFeesClaimedV2`, `…V2` admin events with `actorKind`, and 24
  protocol-admin `…V2` wrappers. The v6 types (`SwapEvent`,
  `LiquidityAddedEvent`, `PoolInitializedEvent`, `PoolInfoEvent`,
  `PoolStateLogEvent`, `MaxSelloffWindowAdvancedEvent`,
  `SingleTokenDepositEvent`, …) are gone; the tolerant `v61Tail` decoders are
  gone (nothing is appended under an old discriminator any more).
- Legacy (pre-T11) and retired (`PoolStateLog`, `MaxSelloffWindowAdvanced`,
  STLD `SingleTokenDeposit`) discriminators decode as
  `Unknown { name: <legacy>, data: { legacy, retired, replacedBy } }` — v6
  history needs the v6 SDK.
- `decodeContractEvent` / `parseContractEvents` are strict: a payload that
  does not re-encode to its bytes (a truncated log) is refused instead of
  zero-filled.
- Quotes refuse a pool whose slot sits at `virtual ≤ actual`
  (`leverage_invariant`; the program reverts with 6104) — swap, add, planned
  zap; `quoteSeedDeposit` / `buildSeedLiquidityIx` / `buildFundSidelinedTokenIx`
  require `net < virtual`; `buildInitializePoolIx` / `buildAtomicDeploy`
  require `virtual ≥ max(10^decimals, 1000)` when the decimals are known and
  `seedAmounts[i] < virtualBalances[i]`.
- `virtualBalanceAfterWithdrawal` applies the T22 live-leg normalisation
  `max(floor(V·(A−p)/A), (A−p)+1)`; the planner (`validateQuotePool`,
  `swapInPool`, `replay`) carries the program's leverage post-guards.
- `PROTOCOL_ACTION_KINDS` has 14 entries (kind 13 `PoolRescaleVirtualBalances`);
  `TREASURY_LAYOUT.PENDING_POOL_RESCALE_VIRTUAL_BALANCES` @1499 (48 B),
  `RESERVED_V61` @1547 (77 B); `decodeTreasuryAccount` returns 14 slots.

### Added

- `parseTransactionEvents(logs, programIds?)` (invoke-stack attribution:
  program id, depth, line), `decodeEventLine`, `logTruncated`, `EVENT_TABLES`,
  `eventProgramOf`, `TYPED_EVENT_NAMES`; pins `RECUT_EVENTS`,
  `RETIRED_EVENTS`, `LEGACY_EVENT_DISCRIMINATORS`; `ACTOR_KIND(S)`,
  `actorKindName`; reducer helpers `swapSurgeLpAmount`, `swapSlotDeltas`,
  `applySwapToVectors`; `BorshReader.option / vecBool / vec / u8Array`.
- `scripts/generate-event-fixtures.cjs` → `tests/fixtures/events/*.json` (80
  IDL-generated Borsh fixtures, `some` / `none` variants); `docs/EVENTS.md`
  (decoders, typed shapes, backend column mapping per the contracts'
  `docs/EVENTS-V61.md` §6, log budget).
- `math/leverage.ts`: `checkLeverage`, `leverageHolds`, `leverageViolations`,
  `assertLeverageInvariant`, `minVirtualBalance`, `virtualFloorViolations`,
  `assertVirtualFloor`, `checkSeedLeverage`, `checkFundLeverage`,
  `applyRescale`, `minRescaleMultiplier`; constants `MIN_VIRTUAL_BALANCE_ABS`,
  `MIN_VIRTUAL_RESCALE_MULTIPLIER`, `MAX_TOKEN_DECIMALS`; fixtures
  `tests/fixtures/leverage/t22-vectors.json` (cite `v61_leverage_invariant.rs`).
- `PoolInfo.leverageViolations`; `CofferPoolClient.quoteFundSidelinedToken`,
  `quoteRescaleVirtualBalances`; `buildRescaleVirtualBalancesIx`,
  `buildSetHookDisabledIx` (raw coffer_pool); `AdminClient.poolRescaleVirtualBalancesIx`
  / `executePoolRescaleVirtualBalancesIx`, `rescaleMultiplierArg`;
  `ProtocolActions.poolRescaleVirtualBalances`; `DeployPoolParamsV61.tokenDecimals`
  / `AtomicDeployParams.tokenDecimals` (`buildAtomicDeploy` reads them from
  the mint accounts).
- Error map 6104–6106 (`VirtualBalanceNotAboveActual` / `VirtualBalanceBelowFloor`
  → `leverage_invariant`, `InvalidVirtualRescale` → `invalid_input`) with
  user-facing messages; `SdkErrorCode` `leverage_invariant`.

### Changed

- Test fixtures are levered 2× (`virtual = 2 · actual`); the zap-plan
  fixtures were regenerated with the `409067d` `zap_plan` binary; the v6
  rust-parity exit vectors are lifted to the T22 rule.
- `npm run fixtures:events` / `fixtures:events:check`.

## 0.2.0 — v6.1: layout, builders, quotes, events

Targets `contracts` branch `v6.1` at `9094945` (T3) with the T9 hooks merge.
Additive on top of the rename below; the v6 wire formats keep working on
1683-byte pools until they are migrated.

### Added

- **Layout (L0)**: `decodePoolAccount` reads 1683 (`layoutVersion 0`) and 2304
  (`layoutVersion 1`) bytes; `RawPoolAccount` / `PoolInfo` carry every v6.1
  field (`tokenDecimals`, `creatorFeeBps`, `creatorFeesOwed`, `surgeFeesOwed`,
  `depositFeeBps`, `withdrawFeeBps`, `liquidityFeesLocked`,
  `rangeManagerLocked`, `poolAdminDelaySecs`, `poolAdminEpoch`,
  `pendingActions`, `hook`, `lpMetadata`, `needsLayoutMigration`).
  `parsers/layout.ts` pins every offset; `decodeTreasuryAccount` reads the
  786 / 818 / 1624-byte Treasury. `buildMigratePoolLayoutV61Ix`; every
  `build*Tx` prepends the migration (`autoMigrate`, default `true`) or throws
  `PoolLayoutOutdatedError`.
- **Builders**: `buildSeedLiquidityIx/Tx` (+ raw form), `buildFundSidelinedTokenIx/Tx`,
  `buildInitializePoolIx` with `DeployPoolParamsV61` (LP metadata, creator /
  deposit / withdraw fee bps, `Option<HookConfig>`, hook slice),
  `buildSetCreatorFeeBpsIx`, `buildSetLiquidityFeesIx`, `buildLockLiquidityFeesIx`,
  `buildLockRangeManagerIx`, `buildSetPoolAdminDelayIx`, `buildSetSwapsEnabledIx`,
  `buildRemoveLiquidityBypassHooksIx` (`bypassHooks` on `buildRemoveLiquidityTx`),
  `hookAccounts` on swap / add / seed / remove.
- **Cooldown (T3)**: `clients/cooldown.ts` — `PoolActions` / `ProtocolActions`
  payload constructors, kind tables, `buildProposePoolActionIx`,
  `buildCancelPoolActionIx`, `buildExecutePoolActionIx`;
  `AdminClient` wrappers for every protocol-admin propose / execute / cancel
  route; `CofferPoolClient.pendingActionsStatus()`.
- **Fee claims (T5 / T14)**: `clients/feeClaim.ts` — recipients forced to the
  Treasury vault PDAs, v5 (3n) and v6.1 (4n + tail) ABIs, placeholders for
  zero-owed slots, `buildClaimCreatorFeesIx`, `buildRegisterTokenIx`,
  `buildTreasuryWithdrawIx`, `chooseTxForm` (legacy / v0 / aux ALT).
- **Atomic deploy (T8)**: `buildAtomicDeploy` (single / alt-1 / alt-2 layouts
  under the 1232-byte packet and 62-slot trace budgets, paused launch, Jito
  `jitodontfront` marker, hooked deploy), `sendAtomicDeploy`,
  `verifyCreatedPool` / `validatePoolIdentity` (I-08),
  `PoolFactoryClient.buildAtomicDeploy`.
- **Hooks (T9)**: `utils/hooks.ts` — `validateHookConfig`, `encodeHookConfig`,
  `hookCallerPda`, `hookAccountSlice`, `requireHookSlice`, the fixture
  resolver, `hookCuBudget`. Quotes accept `hookFeeOverride` (clamped to
  `[feeMin, feeMax]`) and report `feeSource`.
- **LP metadata (T1)**: `validateLpMetadata`, `encodeLpMetadataArgs`,
  `fetchLpMetadata` / `decodeLpMintAccount` (token program from the mint
  owner; legacy SPL LP mints → `null` metadata), `defaultLpMetadata`.
- **Math / quotes**: `splitFee` (protocol ceil → creator floor → LP),
  `applyLiquidityFee` family, `nav` / `splitDepositCredit` / `splitExitPayout`
  (T12 buckets), `lpPriceUsd`; `quoteSwap` runs the full cascade incl. the
  surge split; `quoteAddLiquidity` prices on NAV with the bucket buy-in and
  the deposit-fee haircut; `quoteRemove` pays the bucket share net of the
  withdraw fee; `quoteSeedDeposit`, `quoteLpPriceUsd`, `quoteLpPositionValue`;
  the planner (`quoteZap` / `replay`) carries the same cascade. Sidelined
  outputs are typed `no_liquidity` errors.
- **Events**: every v6.1 tail decoded tolerantly (`v61Tail` flags); new
  `PoolInfo`, cooldown, hook, creator-fee and liquidity-fee events.
- **Errors**: coffer_pool 6070–6103, protocol_admin 6010–6018; SDK codes
  `pool_layout_outdated`, `no_liquidity`, `cooldown`, `hook_rejected`.
- `MAINNET_V51_FACTORY_PROGRAMS`; `npm run abi:check -- --idl-dir … --ignore-address`.

### Changed

- `calculateInvariant` removed (unused since v6).
- `PoolFactoryClient.buildDeployPoolTx` takes `DeployPoolParamsV61` (LP
  metadata is required; the LP mint must be Token-2022).
- `legacyTxSize` is computed analytically (no 1232-byte serialize guard).

### Known limits

- A `DYNAMIC_FEE` hook decides the fee on chain; quotes without
  `hookFeeOverride` run at the base rate and say `feeSource: "hook_dynamic_unknown"`.
- Hook extras are resolved per hook program (no on-chain resolver in v6.1);
  the fixture rule ships as `fixtureHookExtras`.

## 0.2.0 — rename BPT → LP, Cubic → Coffer; drop the extension policy

Targets `contracts` v6.1 after T18 (rename) and T19 (banned-extension policy
removed). **Breaking**: the whole TypeScript surface is renamed and there are
no deprecated aliases. Wire-level facts are unchanged except where noted.

### Changed (rename, no behaviour change)

| 0.1.x | 0.2.0 |
| --- | --- |
| `CubicPoolClient`, `CubicPoolClientParams` | `CofferPoolClient`, `CofferPoolClientParams` |
| `CubicPoolEvent`, `parseCubicPoolEvents` | `CofferPoolEvent`, `parseCofferPoolEvents` |
| `NetworkPrograms.cubicPool`, `ProgramIdKind "cubicPool"`, `ContractProgram "cubicPool"`, `IDLS.cubicPool`, `CUBIC_POOL_IDL`, `src/idl/cubic_pool.json` | `cofferPool`, `COFFER_POOL_IDL`, `src/idl/coffer_pool.json` |
| `CUBIC_POOL_SEED`, `BPT_MINT_SEED` | `POOL_SEED`, `LP_MINT_SEED` (bytes `"cubic_pool"` / `"bpt_mint"` unchanged) |
| `deriveBptMint` | `deriveLpMint` |
| `BPT_DECIMALS`, `MINIMUM_INITIAL_BPT` | `LP_DECIMALS`, `MIN_LP_SUPPLY` |
| `calcBptOutGivenExactTokensIn`, `calcTokensOutGivenBptIn`, `calcJoinRatioAndBpt`, `calcEffectiveBptBurn` (`math/cubicMath`) | `calcLpOutGivenExactTokensIn`, `calcTokensOutGivenLpIn`, `calcJoinRatioAndLp`, `calcEffectiveLpBurn` (`math/poolMath`) |
| `PoolInfo.bptMint`, `.bptTokenProgram`, `.bptTotalSupply` | `lpMint`, `lpTokenProgram`, `lpTotalSupply` |
| `AddLiquidityParams.minimumBptAmount`, `AddLiquidityQuote.bptOut` / `.minimumBptAmount`, `RemoveLiquidityParams.bptAmount`, `RemoveLiquidityQuote.effectiveBptIn` | `minimumLpAmount`, `lpOut` / `minimumLpAmount`, `lpAmount`, `effectiveLpIn` |
| `DeployPoolParams.bptTokenProgram`; `PoolFactoryClient.buildDeployPoolTx()` result `.bptMint`; `initializeCubicPoolIx`, `buildInitializeCubicPoolIx` | `lpTokenProgram`; `.lpMint`; `initializePoolIx`, `buildInitializePoolIx` |
| `PlannedZapQuote.estimatedBpt` / `.minimumBpt`, `PlannedZapArgs.minimumBptAmount`, `PlannedZapAccounts.bptMint` / `.userBptAccount` | `estimatedLp` / `minimumLp`, `minimumLpAmount`, `lpMint` / `userLpAccount` |
| Event fields `bptMint`, `bptAmount`, `bptReceived` (camelCase API) and IDL names `bpt_mint`, `bpt_amount`, `bpt_received`, `minimum_bpt_amount`, `user_bpt_account`, `bpt_token_program`, `helper_bpt_account`, `cubic_pool_program` | `lpMint`, `lpAmount`, `lpReceived`; `lp_mint`, `lp_amount`, `lp_received`, `minimum_lp_amount`, `user_lp_account`, `lp_token_program`, `helper_lp_account`, `coffer_pool_program` |
| IDL types `CubicPool`, `CubicPoolConfig`; errors `InsufficientBptOut`, `InvalidBptAmount`, STLD `InsufficientBpt`, `InvalidBptMint`, `InvalidCubicPoolProgram`, `InvalidUserBptAccount`, `InvalidHelperBptAccount` | `CofferPool`, `CofferPoolConfig`; `InsufficientLpOut`, `InvalidLpAmount`, `InsufficientLp`, `InvalidLpMint`, `InvalidCofferPoolProgram`, `InvalidUserLpAccount`, `InvalidHelperLpAccount` (numeric codes unchanged) |
| Contract instruction `initialize_cubic_pool` | `initialize_pool` — **new discriminator** `5fb40aac54aee828` (was `d79474cf79686f83`). A 0.1.x SDK sending the old bytes to a v6.1 program gets `InstructionFallbackNotFound`. |

Account discriminators (`CofferPool` `89d22a16d19c2b4e`, `CofferPoolConfig`
`041df30a8e40e876`, `Treasury` `eeef7bee5901a8fd`), event discriminators,
Borsh field order and error codes are unchanged, so 0.1.x-era accounts and
logs decode with 0.2.0.

### Removed (T19 — Token-2022 extension policy)

- `DeployPoolParams.bannedExtensions` and the `Option<u64>` the deploy
  builder appended after `pool_id`; `initialize_pool` takes four args.
- `AdminClient.setBannedExtensionsIx`; IDL instructions
  `set_banned_extensions` / `pool_set_banned_extensions`; events
  `BannedExtensionsUpdated` / `PoolBannedExtensionsSet` and the
  `BannedExtensionsUpdatedEvent` type (59 instructions / 59 events now).
- `PoolInfo.bannedExtensions`; `DEFAULT_BANNED_EXTENSIONS`,
  `HARD_BANNED_EXTENSIONS`, `bannedMintExtensions`; the second argument of
  `unsupportedMintExtensions`.
- `RawPoolAccount.bannedExtensions` → `deprecatedBannedExtensions` (the 8
  bytes at offset 1651 are still read so later offsets hold; never interpret
  them). `CofferPoolConfig` IDL: `banned_extensions` + `hard_banned_extensions`
  → `_deprecated_extension_policy: [u8; 16]`. `PoolInitializedEvent.bannedExtensions`
  → `deprecatedBannedExtensions` (a v6.1 program emits `0`).
- `ContractTypes`/`ContractInstructionMap`/`ContractEventMap` regenerated.

The mint TLV parser (`parseMintExtensions`, `MintExtension`,
`mintExtensionName`, `PoolTokenInfo.extensions`) is unchanged and is the data
source for the frontend's per-token extension disclosure.

## 0.1.1 — program addresses of the real v6 deployments

### Changed

- `NETWORK_PROGRAMS.mainnet` now points at the separate v6 programs:
  cubic_pool `6DhW1Ek5WLJSnFSpBBGYeVRbRiWtCXHbqyGJ6LcVZgH9`, protocol_admin
  `6VbU3f7VDmvWAtzw1ujz4FmNBtNzgS4mVQVVAP7bc6ck`; single_token_liquidity
  is the reserved (not yet deployed) `Dh56yWNdJgmPxYosUu24cUumsEckEw56kXdPTHghLEBy`.
- `NETWORK_PROGRAMS.devnet` now points at the v6 devnet deployment of
  2026-10-10 (`Anqy91qJ…`, `FPwMrsxY…`, `4Rk88MtV…`); the v5 devnet copy
  (`E6YAKuLA…`) belongs to `@coffer_so/sdk` 1.x.
- Bundled IDL `address` fields updated to the mainnet v6 ids.

0.1.0 users on mainnet/devnet were silently targeting the v5 programs
unless they passed `programs` overrides to `getConfig`; those overrides
remain supported and take precedence.

## 0.1.0 — first `@coffer_so/sdk-v6` release (pre-deployment)

Forked from `@coffer_so/sdk` 1.3.2. Targets `contracts/v6` at `7d753b3`.
Everything below applies to the v6 programs; keep using `@coffer_so/sdk` 1.x
for the v5 deployment on mainnet.

### Added

- `PlannedZapClient` (`CubicPoolClient.plannedZap`, `quotePlannedZap`):
  snapshot → local plan → `deposit_single_token_planned`, with
  `ensureUserTokenAccountIxs`, `resolveExtraAccounts`, `buildIx`/`buildTx`,
  wallet-ALT preparation and packet-budgeted compilation.
- `math/planner.ts`: TypeScript port of the Rust zap planner (`quoteZap`,
  `replay`, `swapInPool`, `validatePlanBudget`), bit-for-bit with `zap_plan`.
- `math/swapSim.ts`: pure v6 swap simulator shared by quotes and the planner.
- `math/transferFee.ts`: Token-2022 fee schedule selection, `netOfTransferFee`,
  `grossOfTransferFee` (SPL inverse with the 100 % and round-trip rules).
- `math/surgeFee.ts`: v6 `calcSurgeFeeRate` (1e18) / `calcSurgeFeeAmount` (four
  segments, one ceil). `maxSelloff.ts`: `rebaseSnapshot`,
  `rescaleWindowOnVbChange`. `cubicMath.ts`: `calcJoinRatioAndBpt`,
  `calcDepositCredit`, `virtualBalanceAfterDeposit`,
  `virtualBalanceAfterWithdrawal`, `calcEffectiveBptBurn`.
- `utils/transferProfile.ts`: strict hook registry decoding and the hook/memo
  tail resolver; `resolveSwapExtraAccounts`,
  `resolveAddLiquidityExtraAccounts`, `resolveRemoveLiquidityExtraAccounts`;
  `extraAccounts` on `SwapParams`, `AddLiquidityParams`,
  `RemoveLiquidityParams`.
- `PoolTokenInfo.transferFee`, `transferHookProgram`, `paused`;
  `PoolInfo.chainSlot`, `chainEpoch`, `v5Migrated`;
  `RawMintAccount.transferFeeConfig`, `transferHook`, `pausableConfig`;
  `V5_MIGRATION_MARKER`, `tokenTransferBlockers`, `isTokenTransferable`.
- `SwapQuote.transferFeeIn/Out`, `amountInNet`, `amountOutReceived`;
  `AddLiquidityQuote.chargedAmounts`, `creditedAmounts`, `unspentAmounts`,
  `transferFees`, `virtualBalancesAfter`; `RemoveLiquidityQuote` with
  `transferFees`, `receivedAmounts`, `virtualBalancesAfter`.
- Events: `SingleTokenDepositDirect`; `Swap.transferFeeIn/Out`;
  `PoolInitialized.poolId`.
- Error codes `amount_too_small`, `plan_invalid`, `plan_expired`, `plan_stale`.
- `CofferConfigOverrides.programs` for alternative program ids.
- `MathError` for every checked-arithmetic guard in `src/math`.

### Changed

- Token-2022 policy: fee, hook, memo and unpaused `Pausable` mints are
  supported; only `NonTransferable`, the native mint and unknown extension
  types are refused. A paused mint is refused at quote/build time.
- Quotes rewritten for v6 rounding, window rebasing, surge and transfer fees;
  numbers differ from 1.x at rounding boundaries and whenever a leg carries a
  transfer fee. `minAmountOut` now derives from `amountOutReceived`.
- `AdminClient.collectProtocolFeesIx`/`debugWithdrawLiquidityIx` take
  `PoolTokenTransferAccounts` (`[vault, recipient, mint, token_program]` per
  token + tail); `withdrawIx` takes the mint and allows Token-2022.
- Fee ceilings `MAX_SWAP_FEE_RATE`/`MAX_PROTOCOL_FEE_RATE` are 100 %.
- `calcOutGivenIn` uses the exact `base` for equal weights (no ln/exp).
- `computeAllocations` errors are `MathError`s named after the program's codes.
- Package renamed to `@coffer_so/sdk-v6`; `@solana/web3.js` is a peer
  dependency; `@noble/hashes` and `@solana/spl-token ^0.4.14` are dependencies.

### Removed

- `SingleTokenDepositClient`, `CubicPoolClient.quoteSingleTokenDeposit`,
  `buildSingleTokenDepositTx/Txs`, `singleTokenDeposit` getter, `helperPda`.
- `buildSingleTokenDepositIx/Tx/Txs/AtaIxs`, `STLD_MAX_TOKENS`,
  `STLD_DEPOSIT_CU_LIMIT` (use `PLANNED_ZAP_*`).
- `capDepositAmountsToLpRatio`, `computeTwoTokenOptimalAllocations`,
  `rescaleSelloffWindow`, `calcSegmentedSurgeFeeAmount` and the old
  `calcSurgeFeePct/calcSurgeFeeAmount` signatures.
- `SingleTokenDepositParams`, `SingleTokenDepositQuote`.
- `Cube*` compatibility aliases.
