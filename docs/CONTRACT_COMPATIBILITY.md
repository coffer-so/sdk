# Contract compatibility: v6.1

Target: `contracts` **v6.1** — branch `v6.1-t11` at **`409067d`** (T9 hooks,
T22 leverage invariant / rescale, T11 events overhaul; the ABI is final — the
pending merge into `v6.1` and the T21-B2 cleanup change no ABI; update this
pin to the v6.1 merge commit sha at release). SDK 0.3.0 drives every v6.1
feature: the 2304-byte pool layout (L0), LP metadata (T1), seed deposit (T2),
admin cooldowns (T3), vault-PDA fee claims (T5), range manager lock (T6),
deposit / withdraw fees (T7), atomic deploy (T8), hooks (T9), sidelined tokens
(T10), the re-cut events (T11), surge buckets (T12), creator fees (T14), the
per-pool protocol fee rate (T15), the T18 / T19 rename / policy removal and
the strict leverage invariant with `rescale_virtual_balances` (T22).

v6.1 ships as NEW program ids next to v6 and v5 (the v6 mainnet factory keeps
running on the 1683-byte layout until `migrate_pool_layout_v61` runs per
pool). A pool belongs to the generation whose coffer_pool owns its account —
drive it with that generation's SDK; `MAINNET_V51_FACTORY_PROGRAMS` names the
v6.1 factory ids (`8iQt…` / `7Bpd…` / `3jio…`), `NETWORK_PROGRAMS.mainnet`
the v6 ones, and `CofferConfigOverrides.programs` switches between them.

| Program | Instructions | Events | v6 mainnet | v6.1 mainnet factory | devnet (2026-10-10) |
| --- | ---: | ---: | --- | --- | --- |
| coffer_pool | 51 | 41 | `6DhW1Ek5WLJSnFSpBBGYeVRbRiWtCXHbqyGJ6LcVZgH9` | `8iQtGj9mcUfFUGaiCpPy89swC3s8YTC8FhVZWfgeZhwu` | `Anqy91qJz4Z9faHD6b5bDGYoe1cqYLytPLh4w2Z4UkD1` |
| protocol_admin | 52 | 36 | `6VbU3f7VDmvWAtzw1ujz4FmNBtNzgS4mVQVVAP7bc6ck` | `3jiojHZbjJQ7QLMGSTjFwxVEmx4NtuRy34nLAmsJME81` | `FPwMrsxYpgJsZRCTKJadP97AsNX1WwFBZwBbzTDcYmjU` |
| single_token_liquidity | 4 | 2 | reserved `Dh56yWNdJgmPxYosUu24cUumsEckEw56kXdPTHghLEBy` | `7BpdUH1tzTSXLuQNo6YpjJ8Eagw8AkrS6cnkxiJdCFS2` | `4Rk88MtVT6CjB5e2EPbzQ4Qs6zKtSFgVZYE79SVenVko` |

107 instructions / 79 events in total; `npm run abi:check -- --idl-dir
../contracts-v6.1/idl --ignore-address` diffs the vendored IDLs against a
contracts checkout (the `address` fields are the SDK's and differ on purpose).
Vendored IDLs are byte-identical to `idl/*.json` at `409067d` modulo `address`.

Protocol accounts (v6): mainnet treasury `BaUyw2zVZx8TGCMDZtQKQxq2S9LCCzNubg8tNKWqh9yv`,
config `HkYKaa4ARjeqPZsVb7bHKuNLJHhM7Dntzh9oLWg8xvhb`; devnet treasury
`HLpyYUeWmz7VfNgJG5ZMj4vnpqiJXYUSY9SNwy3u1NVW`, config
`5GTgLMeodBEovfDnwYjpt8ndw8hUcifQJVMVnGRwWEYp`. The v6.1 factory needs its
own Treasury / config (hard-coded ids); fill them in when it is initialised.

## What changed on-chain (v6.1) and how the SDK follows

| v6.1 | SDK 0.3.0 |
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
| T10: sidelined slots (`actual_balance == 0`): never a swap output, no payout on exit, `fund_sidelined_token` by the pool admin | `PoolTokenInfo.sidelined`, `no_liquidity` quotes, `buildFundSidelinedTokenIx/Tx` |
| T12: the LP share of surge fees accrues in `surge_fees_owed[out]`; NAV = actual + surge; joins buy into the bucket, exits pay their share | `nav` / `splitDepositCredit` / `splitExitPayout`; quotes on NAV (`navBalances`, `surgeBuyIn`, `surgeOuts`); `quoteLpPriceUsd` |
| T14: `creator_fee_bps` share of the LP remainder → `creator_fees_owed`, `claim_creator_fees` | `splitFee` cascade (protocol ceil → creator floor → LP), `buildClaimCreatorFeesIx`, `creatorFeeAmount` in quotes |
| T15: `pool_set_protocol_fee_rate` per pool (0..=10_000 bps) | `AdminClient.poolSetProtocolFeeRateIx` / cooldown payload |
| T11: one primary event per instruction with actor / params / before-after; every changed payload re-cut (`SwapV2` with `SlotState` pairs + `Option<SelloffWindow>`, `LiquidityAddedV2` / `LiquidityRemovedV2` with `lp_supply_before/after` and the six vectors, `PoolInitializedV2`, `PoolInfoV2`, `SingleTokenDepositDirectV2`, 24 protocol-admin `…V2`); `PoolStateLog`, `MaxSelloffWindowAdvanced`, `SingleTokenDeposit` retired | strict typed decoders + IDL-coder path with re-encode check, `parseTransactionEvents` (invoke-stack attribution), legacy / retired discriminators → `Unknown { legacy }`, IDL-generated fixtures; see [EVENTS.md](EVENTS.md) |
| T22: strict `virtual_balance > actual_balance` on every slot after every balance write; per-slot floor `max(10^decimals, 1000)` where `V` is chosen; `rescale_virtual_balances` (protocol admin, D-class cooldown kind 13) | `math/leverage.ts` (`checkLeverage`, `minVirtualBalance`, seed / fund gates, `applyRescale`, T22 exit normalisation in `virtualBalanceAfterWithdrawal`), create-pool / seed / fund builders and quotes mirror the gates, `PoolInfo.leverageViolations`, `buildRescaleVirtualBalancesIx`, `AdminClient.poolRescaleVirtualBalancesIx` / `executePoolRescaleVirtualBalancesIx`, `ProtocolActions.poolRescaleVirtualBalances` |
| Errors 6070–6106 (coffer_pool) and 6010–6018 (protocol_admin) | `describeProgramError`, `CLAIM_ERROR_NAMES`, SDK codes `pool_layout_outdated`, `no_liquidity`, `cooldown`, `hook_rejected`, `leverage_invariant` (6104–6106 carry user-facing messages) |

Legacy rows (v6) still hold: `transfer_checked` everywhere with transfer-fee
netting and hook / memo tails, 100 % fee ceilings, v6 join / exit rounding,
sell-off windows and the four-segment surge curve, and the planned STLD route.

## Full instruction API

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
npm run abi:check                       # against ../contracts-v6.1 (committed idl/); the 0.3.0 pin: --idl-dir ../contracts-v6.1-t11/idl
npm run fixtures:events:check           # tests/fixtures/events/*.json still match src/idl
npm run fixtures:rust                   # regenerates tests/math/fixtures/deployed-v6-math.json (needs rustc)
ZAP_PLAN_BINARY=../contracts/target/debug/examples/zap_plan SKIP_MAINNET_TESTS=1 npx jest tests/zap-plan-fixtures
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
