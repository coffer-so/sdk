# Contract compatibility: v6.1

Source: `contracts-v6.1` branch `v6.1` at the `v6.1-rc2` ABI (the commit is
tagged `v6.1-rc2` on release). The vendored IDLs are byte-for-byte the
`anchor build` output of that source (`idl/*.json`, addresses included):

| Program | Instructions | Events | IDL sha256 |
| --- | ---: | ---: | --- |
| coffer_pool | 51 | 41 | `f031d8b14636b35c69397549b1eafffe0f554c6924f1aed92ae0e45a095389b2` |
| protocol_admin | 55 | 38 | `c797bba6a1a1fa8388822240e0fe96bafd29c833d3e8842b0fc04180bddf3534` |
| single_token_liquidity | 4 | 2 | `413ea7dabbc0dc0ec16339c37a78834a8d587530b5f8064ec9512794afcff55b` |

110 instructions / 81 events. `npm run abi:check` compares `../contracts-v6.1/idl`
with the vendored IDLs, ignoring addresses. Repeated command-line path options
use the last value. A wire comparison does not establish complete instruction
support. The never-deployed "N10 batch" route (`batch_single_token_planned_v1`,
`deposit_single_token_batch_planned_v1`, `BatchFinancialReceiptV1` /
`BatchSingleTokenDepositV1`) was dropped from the contracts and from this SDK.

Program IDs and Treasury/config addresses in `config/networks.ts` are configured
historical values, not deployment receipts. This work verifies no installed devnet
or mainnet v6.1 program. Select owner-verified program IDs, Treasury and config
through configuration overrides only after checking deployment receipts and source pins.
No requirement to create new program IDs is inferred from an ABI rename.

## What changed on-chain (v6.1) and how the SDK follows

| v6.1 | SDK 0.4.0 |
| --- | --- |
| L0: `CofferPool` grows 1683 → 2304 bytes (`layout_version`, pinned decimals, creator / surge buckets, liquidity fees, locks, cooldown block, hook block, 202 reserved). `migrate_pool_layout_v61` is permissionless; until it runs every instruction fails with `LayoutVersionMismatch` (6070) | `decodePoolAccount` reads both lengths (1683 = `layoutVersion 0`, read-only); `PoolInfo.needsLayoutMigration`; `build*Tx` prepend `migrate_pool_layout_v61` (`autoMigrate`, default on) or throw `PoolLayoutOutdatedError`; `parsers/layout.ts` pins every offset |
| T1: LP mint is Token-2022 with in-mint `TokenMetadata` (`name`, `symbol`, `uri`, `("pool", <pool>)`, authority revoked); `initialize_pool` takes `LpMetadataArgs` | `validateLpMetadata` (program rules + shared fixture table), `encodeLpMetadataArgs`, `fetchLpMetadata` / `decodeLpMintAccount` (token program from the mint OWNER; legacy SPL LP mints → `null`), `PoolInfo.lpMetadata` |
| T2: `seed_liquidity(token_amounts, lp_amount)` — the creator's first deposit, creator-chosen supply `1 LP ≤ x ≤ 1e7 LP`, no `pow`; `add_liquidity` refuses an unseeded pool | `buildSeedLiquidityIx/Tx`, `quoteSeedDeposit(user, amounts, lpAmount = 1_000 LP)`, `MIN/MAX/DEFAULT_INITIAL_LP_SUPPLY` |
| T3: pool-admin and protocol-admin cooldowns — `propose_*` / `execute_*` / `cancel_*`, one typed slot per kind, 14-day grace, epoch-invalidated | `clients/cooldown.ts` (`PoolActions` / `ProtocolActions` constructors, kind tables, builders), `AdminClient.propose/execute/cancelAction*`, `PoolInfo.pendingActions` + `pendingActionsStatus()` (chain clock, never `Date.now()`), Treasury v3 decoder |
| T5: `collect_protocol_fees` recipients MUST be the Treasury vault PDAs `[b"vault", mint]`; `register_token` cap lifted | `buildCollectProtocolFeesIx` (recipients forced, placeholders for zero-owed slots, v5 3n vs v6.1 4n ABIs), `chooseTxForm` (legacy / v0 / aux ALT) |
| T6: `lock_range_manager` (irreversible) | builder + `PoolInfo.rangeManagerLocked` |
| T7: deposit fee (LP haircut, ceil) / withdraw fee (per-leg payout haircut), `lock_liquidity_fees` | `applyDepositFee` / `applyWithdrawFee` / `splitExitPayout`; quotes report `depositFeeLp`, `withdrawFeeAmounts`; `DepositFeeConsumesAll` / `WithdrawFeeConsumesAll` at 100 % |
| T8: one-approval deploy (init + ATAs + seed [+ pause]) in 1–3 transactions, Jito `jitodontfront` marker, identity verification | `buildAtomicDeploy` / `sendAtomicDeploy`, `verifyCreatedPool`, `PoolFactoryClient.buildAtomicDeploy` |
| T9: immutable native hooks (`HookConfig` at init; `set_hook_disabled`; `remove_liquidity_bypass_hooks`); the slice `[hook_program, HOOK_CALLER, extras…]` leads the remaining-accounts tail | `utils/hooks.ts` (config validation / encoding, slice, `requireHookSlice`, CU heuristic), `hookAccounts` on swap / add / seed / remove, `bypassHooks`, quotes take `hookFeeOverride` (clamped to `[feeMin, feeMax]`; `feeSource` reports `hook_dynamic_unknown` when the hook decides on chain) |
| T10: sidelined slots (`actual_balance == 0`): never a swap output, no reserve payout on exit (a surge bucket still pays), `fund_sidelined_token` by the pool admin | `PoolTokenInfo.sidelined`, `no_liquidity` quotes, `buildFundSidelinedTokenIx/Tx` |
| T12: the LP share of surge fees accrues in `surge_fees_owed[out]`; NAV = actual + surge; joins buy into the bucket, exits pay their share | `nav` / `splitDepositCredit` / `splitExitPayout`; quotes on NAV (`navBalances`, `surgeBuyIn`, `surgeOuts`); `quoteLpPriceUsd` |
| T14: `creator_fee_bps` share of the LP remainder → `creator_fees_owed`, `claim_creator_fees` | `splitFee` cascade (protocol ceil → creator floor → LP), `buildClaimCreatorFeesIx`, `creatorFeeAmount` in quotes |
| T15: `pool_set_protocol_fee_rate` per pool (0..=10_000 bps) | `AdminClient.poolSetProtocolFeeRateIx` / cooldown payload |
| T11: one primary event per instruction with actor / params / before-after; every changed payload re-cut (`SwapV2` with `SlotState` pairs + `Option<SelloffWindow>`, `LiquidityAddedV2` / `LiquidityRemovedV2` with `lp_supply_before/after` and the six vectors, `PoolInitializedV2`, `PoolInfoV2`, `SingleTokenDepositDirectV2`, 24 protocol-admin `…V2`); `PoolStateLog`, `MaxSelloffWindowAdvanced`, `SingleTokenDeposit` retired | strict typed decoders + IDL-coder path with re-encode check, `parseTransactionEvents` (invoke-stack attribution), legacy / retired discriminators → `Unknown { legacy }`, IDL-generated fixtures; see [EVENTS.md](EVENTS.md) |
| T22: strict `virtual_balance > actual_balance` on every slot after every balance write; per-slot floor `max(10^decimals, 1000)` where `V` is chosen; `rescale_virtual_balances` (protocol admin, D-class cooldown kind 13) | `math/concentrationFactor.ts` (`checkConcentrationFactor`, `minVirtualBalance`, seed / fund gates, `applyRescale`, T22 exit normalisation in `virtualBalanceAfterWithdrawal`), create-pool / seed / fund builders and quotes mirror the gates, `PoolInfo.concentrationFactorViolations`, `buildRescaleVirtualBalancesIx`, `AdminClient.poolRescaleVirtualBalancesIx` / `executePoolRescaleVirtualBalancesIx`, `ProtocolActions.poolRescaleVirtualBalances` |
| Errors 6070–6109 (coffer_pool) and 6010–6018 (protocol_admin) | `describeProgramError`, `CLAIM_ERROR_NAMES`, SDK codes `pool_layout_outdated`, `no_liquidity`, `cooldown`, `hook_rejected`, `concentration_factor_invariant` (6104–6106 carry user-facing messages; rc2 appends 6107 `WithdrawFeeNotLockable`, 6108 `RangeManagerKeyRequired`, 6109 `FullExitRequiredBelowFloor`) |

Legacy rows (v6) still hold: `transfer_checked` everywhere with transfer-fee
netting and hook / memo tails, 100 % fee ceilings, v6 join / exit rounding,
sell-off windows and the four-segment surge curve, and the planned STLD route.

## Raw instruction API

`buildContractInstruction` exposes every instruction with its exact arguments,
fixed account names, account order and signer/writable flags. It uses snake_case
IDL names; u64/i64/u128 values use `BN`. The generated `ContractInstructionMap`
provides autocomplete and compile-time types. All fields are also validated at
runtime. Pass explicit remaining-account metas where the instruction needs them.

```ts
import { buildContractInstruction } from "@coffer_so/sdk-v6";
import { SystemProgram } from "@solana/web3.js";

const ix = buildContractInstruction(config, "protocolAdmin", "set_supervisor",
  { new_supervisor: supervisor },
  { treasury, admin, system_program: SystemProgram.programId });
```

`AdminClient` provides convenient Treasury-governance methods; the exported
`build*Ix`/`build*Tx` functions also cover normal pool operations. A Treasury PDA
signs through a protocol-admin CPI, so use that wrapper for protocol governance.
The generic API does not supply authority signatures or waive contract checks.

[State mapping](STATE_FIELDS.md) documents every pool/config/Treasury field, including
the distinction between operational `PoolInfo` and the full raw ABI.

`decodeContractAccount` decodes CofferPool, CofferPoolConfig and Treasury with exact
IDL field names. Verify the RPC account owner before decoding.
`parseContractEvents` returns `{ program, kind, data }` for every declared event,
preserving BN values and exact field names (strict: the decoded value must
re-encode to the payload). Verify transaction success and the emitting program
before indexing logs — `parseTransactionEvents` attributes each line to the
program on top of the invoke stack. The camelCase `parseCofferPoolEvents` API
returns the typed `…V2` shapes ([EVENTS.md](EVENTS.md)).

## Quotes and token support

- `sync()` loads the pool state, every mint's decimals, extensions, transfer-fee
  schedule (selected for the Clock epoch), armed hook program and pause flag,
  the LP token-program owner, and the Solana Clock slot/epoch/timestamp.
  Layout v3 (1154 bytes) is rejected explicitly.
- Token policy (`utils/extensions.ts`): only `NonTransferable` mints, the
  Token-2022 native mint and extension types newer than the program knows are
  refused outright. Transfer fees, transfer hooks, memo requirements and an
  unpaused `Pausable` mint are supported. A paused mint refuses every operation
  that would move it (`unsupported_token_extension`), as the program would.
- `quoteSwap` follows the program byte for byte (`math/swapSim.ts`): input
  transfer fee → net; the input token's window advances by the net; swap and
  protocol fees (ceil) on the net; curve output; four-segment surge; output
  transfer fee. `amountOut` is the vault debit (the `Swap` event's
  `amount_out`), `amountOutReceived` is what the user gets, and
  `minAmountOut` is derived from the latter because that is what the program
  compares `minimum_amount_out` to. `feeAmount`/`protocolFeeAmount` are in the
  input token; `surgeFeeAmount` in the output token.
  Unequal weights round the fixed-point power upward by 200 ULP before
  clamping to `ONE`; equal positive weights retain the exact-base path and
  +1 ULP. Compared with the previous +1 power margin, this reduces output
  by at most `ceil(199 * virtualBalanceOut / ONE)` (3671 raw at `u64::MAX`).
- `quoteAddLiquidity` nets each ceiling of its transfer fee, takes the limiting
  ratio over live legs, mints `floor(supply · ratio)`, credits each leg
  `ceil(actual · ratio)` and debits that credit grossed up by the inverse
  transfer fee. It reports `chargedAmounts` (= `depositAmounts`),
  `creditedAmounts`, `transferFees`, `unspentAmounts` (= `refundAmounts`),
  `virtualBalancesAfter`, `lpOut` and `minimumLpAmount`. A credit above the
  net ceiling or a gross-up above the ceiling is an error, not a quote.
  `quoteSeedDeposit` credits the net amounts and prices LP on them.
- `quoteRemove` applies `calc_effective_lp_burn`, floors the proportional
  payouts, withholds each leg's transfer fee (`receivedAmounts`) and reports the
  post-exit virtual balances. Derive `minimumTokenAmounts` from `receivedAmounts`.
- Hook/memo tails: `resolveSwapExtraAccounts`, `resolveAddLiquidityExtraAccounts`,
  `resolveRemoveLiquidityExtraAccounts` (or the `CofferPoolClient.resolve*`
  wrappers) return the `AccountMeta[]` to pass as `extraAccounts`. Classic
  pools resolve to `[]` without an RPC read. A hook that needs an extra signer
  or one of the instruction's core accounts is outside the supported profile.
- `actualBalance` already excludes protocol fees; do not subtract
  `protocolFeesOwed` again. The creation-policy bitmap is a separate diagnostic.

Quotes use the synced state and Clock timestamp; swap and planned-zap quotes
accept an explicit `nowSeconds` for an anticipated execution time. Other trades,
window rotation or admin updates before execution can change the result. Always
use the final minimum output/LP amount and refresh the snapshot when needed.

Compatibility checks are not a security audit of the contracts.

## Reproducible checks

```sh
npm run lint
npm run build
SKIP_MAINNET_TESTS=1 npm test -- --runInBand
npm run types:check
npm run abi:check                       # ../contracts-v6.1/idl, modulo addresses
npm run fixtures:events:check           # tests/fixtures/events/*.json still match src/idl
SKIP_MAINNET_TESTS=1 npm test -- --maxWorkers=2  # finite offline fixtures; no fresh Rust execution
```

`tests/contract-abi.test.ts` independently encodes every instruction/event and
checks all declared account layouts against the shipped IDLs;
`tests/v61-events.test.ts` round-trips the IDL-generated event fixtures
(`node scripts/generate-event-fixtures.cjs --check`).
`tests/math/rust-parity.test.ts` runs 748 vectors produced by compiling the v6
Rust math bodies (`generate-rust-reference.py`); the fixture header records the
contract commit and source hashes. `tests/zap-plan-fixtures.test.ts` compares
the TypeScript planner with six snapshots of the canonical Rust planner
(`cargo build -p single-token-liquidity --example zap_plan`), committed under
`tests/fixtures/zap-plan/`. Mainnet integration tests only read accounts and
build unsigned instructions; set `SDK_MAINNET_RPC_URL` or `RPC_URL` and run them
without `SKIP_MAINNET_TESTS` (they target the v5 deployment's read paths).

The comparison command checks all bundled JSON against the explicitly selected
checkout’s `target/idl` files, including arguments, accounts, privileges, types
and events. It does not establish which binary a live RPC serves. `sync()`
returns a parse failure rather than throwing or rounding when a timestamp,
slot, epoch or weight cannot fit its numeric convenience field; raw account
decoders retain full integer precision.

## rc2 audit fixes

- Pool safety flags retain seed history and protocol restrictions. A pool admin cannot clear protocol token/swap/range-manager restrictions. Bit 13 (`SAFETY_FLAG_RANGE_MANAGER_WAS_ENABLED`, `PoolInfo.protocolRangeManagerWasEnabled`) records that the manager was enabled when the protocol suspended it; the protocol release restores that state and clears bits 12 and 13. `SAFETY_FLAG_*` constants are exported.
- `migrate_pool_layout_v61` writes no restriction bits any more: the migrated `safety_flags` carry only `SAFETY_FLAG_SEEDED`, and only when some slot has `actual_balance > 0` or `protocol_fees_owed > 0` (a never-funded legacy pool stays seedable). Restriction provenance starts at the upgrade; the protocol re-applies its instant disable where it wants a restriction.
- `close_upgrade_buffer` (`AdminClient.closeUpgradeBufferIx(admin, buffer, recipient)`, event `UpgradeBufferClosed`): instant, admin-only recovery of a loader buffer owned by the Treasury PDA after a cancelled or superseded upgrade proposal; the pending proposal's buffer is refused until that proposal is cancelled.
- `lock_liquidity_fees` / renouncing with a withdraw fee above the lockable cap fails with `WithdrawFeeNotLockable` (6107); enabling the range manager with the default key fails with `RangeManagerKeyRequired` (6108); at or below the LP floor only a full exit is accepted (`FullExitRequiredBelowFloor`, 6109).
- `ProtocolActions.poolEnableRangeManager(pool)` is kind 14; `AdminClient.poolEnableRangeManagerIx` and `executePoolEnableRangeManagerIx` restore the protocol restriction with Treasury cooldown enforcement.
- External LP burns below the 1,000-raw floor no longer strand remaining holders. A zero-supply pool with prior seed history cannot be seeded again.
- `sync()` tolerates an absent/closed mint only when every tracked balance/fee bucket of its leg is zero, marks it `missingMint`, and refuses transfers involving it. Exit builders validate and create ATAs only for positive net payouts, including surge-only payouts.
- Pool LEN remains 2304 (reserve 180 B at 2124); Treasury LEN remains 1624 (reserve 37 B at 1587). Existing deployment addresses are preserved; matching ABI does not imply those programs have been upgraded.

## Current integration boundaries (2026-11-02)

`PlannedZapClient.resolveExtraAccounts(quote, user, { hookAccounts })` returns
`{ hookAccounts, token2022Accounts }`. Pass that object to `buildIx` / `buildTx`.
The native slice has exactly `hookAccountsLen` metas: read-only program, read-only
caller PDA, then caller-supplied hook data accounts. It precedes the Token-2022
union after the fixed mint/user/vault and token-program prefix. Inactive native
hooks take no slice. Planned zap has no native-hook bypass mode; exit bypass
removes only native callbacks and still requires Token-2022 transfer extras.
The resolver checks executable native programs and hook ownership of writable
extras. Generic/on-chain per-call native-hook discovery remains deferred to v6.2;
explicit application-provided data accounts are supported in v6.1.

For atomic deploy, optional `seedMintSnapshots` and `seedEpoch` must be supplied
together. Otherwise mints and Clock are fetched in one batch, including when
`tokenPrograms` / `tokenDecimals` hints are supplied. Validation pins mint order,
owner, layout, decimals, extension combinations and epoch-selected transfer fees.
`seedSnapshot` returns those inputs, net credits, resolved Token-2022 metas and
public resolution snapshots (including explicit missing-account observations).
`seedExtraAccounts`, when supplied, must match the resolved union exactly; native
accounts belong in `hookAccounts`. Packet sizing includes both tails. External
hooks require `externalCpiTraceBudget`; any native hook registers during initialization,
even when its add-liquidity flags are unset. The supplied bound covers all external
callbacks within each transaction that invokes hooks; split registration and seed
transactions are budgeted independently. This is an integrator's conservative
bound, not a measured guarantee about arbitrary hook code. Simulate before signing.
All seed slots remain structurally validated. Transfer blockers, including a paused
mint, apply to positive seed legs; a zero seed slot performs no token transfer.
The current captured seed source calls the native add callbacks; funding a
sidelined slot does not. Deposit fees do not charge the seed.

`applyRescale` marks `scope: "virtual_balance_projection"` when windows or decimals
are omitted. Supplying both computes checked window snapshots and both pressure
buckets with the source rounding; `scope: "complete_rescale"` describes this pure
transition, not authority checks, a submitted transaction or all protocol state.

Package version 0.4.0 (breaking: the `concentrationFactor` rename and the
batch-route removal).

## Owner-devnet candidate (2026-11-02)

The fresh source-generated canonical IDLs retain the v5.1 factory program IDs.
They do not select a network. Explicitly configure the owner-devnet candidate:

```ts
import { getConfig, DEVNET_V61_CANDIDATE_PROGRAMS } from "@coffer_so/sdk-v6";
const config = getConfig("devnet", { programs: DEVNET_V61_CANDIDATE_PROGRAMS });
```

These are compiled public IDs, not a deployment or authority attestation.
Check the exact owner-devnet ELF/IDL pins and devnet genesis before signing.
The historical default network table is unchanged; `getConfig("devnet")` alone
does not select this candidate. The owner deploys and validates it separately.
