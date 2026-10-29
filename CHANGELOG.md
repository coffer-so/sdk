# Changelog

Entries below 0.2.0 keep the names in use at the time (`BPT`, `Cubic*`,
`cubic_pool`); they were not rewritten.

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
