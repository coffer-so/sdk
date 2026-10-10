# Contract compatibility: v6

Target: `contracts/v6`, commit `7d753b3` (`feat: allow swap and protocol fee
rates anywhere in 0..=100%`). v6 is deployed as SEPARATE programs next to v5
(mainnet since 2026-10; v5 `main` 0.5.1 keeps running and is tracked by
`@coffer_so/sdk` 1.x). A pool belongs to the generation whose cubic_pool owns
its account — drive it with that generation's SDK.

| Program | Instructions | Events | mainnet | devnet (2026-10-10) | localnet (`anchor build` declare_id) |
| --- | ---: | ---: | --- | --- | --- |
| cubic_pool | 28 | 30 | `6DhW1Ek5WLJSnFSpBBGYeVRbRiWtCXHbqyGJ6LcVZgH9` | `Anqy91qJz4Z9faHD6b5bDGYoe1cqYLytPLh4w2Z4UkD1` | `8iQtGj9mcUfFUGaiCpPy89swC3s8YTC8FhVZWfgeZhwu` |
| protocol_admin | 29 | 28 | `6VbU3f7VDmvWAtzw1ujz4FmNBtNzgS4mVQVVAP7bc6ck` | `FPwMrsxYpgJsZRCTKJadP97AsNX1WwFBZwBbzTDcYmjU` | `3jiojHZbjJQ7QLMGSTjFwxVEmx4NtuRy34nLAmsJME81` |
| single_token_liquidity | 4 | 3 | not deployed (reserved `Dh56yWNdJgmPxYosUu24cUumsEckEw56kXdPTHghLEBy`) | `4Rk88MtVT6CjB5e2EPbzQ4Qs6zKtSFgVZYE79SVenVko` | `7BpdUH1tzTSXLuQNo6YpjJ8Eagw8AkrS6cnkxiJdCFS2` |

Protocol accounts: mainnet treasury `BaUyw2zVZx8TGCMDZtQKQxq2S9LCCzNubg8tNKWqh9yv`,
config `HkYKaa4ARjeqPZsVb7bHKuNLJHhM7Dntzh9oLWg8xvhb`; devnet treasury
`HLpyYUeWmz7VfNgJG5ZMj4vnpqiJXYUSY9SNwy3u1NVW`, config
`5GTgLMeodBEovfDnwYjpt8ndw8hUcifQJVMVnGRwWEYp`. The mainnet binaries were
built from a state with re-declared ids that `origin/v6` does not carry yet.

The v6 IDLs still declare `metadata.version = "0.5.1"`; the SDK pins the
revision by commit, not by that field. (Contracts: please bump it to 0.6.0.)
`CofferConfigOverrides.programs` overrides any program id, e.g. for a stand
deployed by `contracts/scripts/run-v6-local.sh`.

## What changed on-chain and how the SDK follows

| v6 | SDK |
| --- | --- |
| Account layouts unchanged (`CubicPool` 1683 bytes); `migrate_to_v5` stamps `"V5M1"` into `reserved[0..4]` and is guarded (`UnsafeLegacyMigration`) | same decoders; `RawPoolAccount.v5Migrated`, `PoolInfo.v5Migrated` |
| Events appended: `Swap.transfer_fee_in/out`, `PoolInitialized.pool_id`, `RangeManagerConfigSet.old/new_min_leverage_bps`; new `SingleTokenDepositDirect` | typed fields, new decoder; legacy `SingleTokenDeposit` kept for history |
| Token-2022: every transfer is `transfer_checked`; transfer fees netted on both legs; armed hooks and memo-requiring destinations served from a remaining-account tail | quotes net fees; `transferProfile.ts` resolves the tail; `extraAccounts` on swap/add/remove builders |
| Fee ceilings 100 % | `MAX_SWAP_FEE_RATE = SWAP_FEE_PRECISION`, `MAX_PROTOCOL_FEE_RATE = PROTOCOL_FEE_PRECISION` |
| Join/exit rounding: `calc_deposit_credit` (ceil), `virtual_balance_after_deposit` (ceil), `virtual_balance_after_withdrawal` (floor, ≥ 1), `calc_effective_bpt_burn`; equal weights skip ln/exp | `cubicMath.ts` ports; quotes rewritten |
| Sell-off window: `rescale_window_on_vb_change` + `rebase_snapshot` on the output leg of swaps, every leg of join/exit and manager updates; rotation carry rounds up | `maxSelloff.ts` ports; `swapSim.ts` applies them |
| Surge: `calc_surge_fee_rate` (1e18 trapezoids, fill ratio rounded up) + `calc_surge_fee_amount` (4 segments, one ceil) | `surgeFee.ts` port |
| Admin: `collect_protocol_fees`/`debug_withdraw` take `[vault, recipient, mint, token_program]` per token + tail; protocol-admin `withdraw` takes `mint` | `AdminClient` |
| STLD: legacy `deposit_single_token*` always fail (`AllocationPlanRequired`); the only route is `deposit_single_token_planned` with a client-computed `AllocationPlan` | `PlannedZapClient` + TypeScript planner; see [PLANNED_ZAP.md](PLANNED_ZAP.md) |

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

`decodeContractAccount` decodes CubicPool, CubicPoolConfig and Treasury with exact
IDL field names. Verify the RPC account owner before decoding.
`parseContractEvents` returns `{ program, kind, data }` for every declared event,
preserving BN values and exact field names. Verify transaction success and the
emitting program before indexing logs. The existing camelCase event API remains.

## Quotes and token support

- `sync()` loads the pool state, every mint's decimals, extensions, transfer-fee
  schedule (selected for the Clock epoch), armed hook program and pause flag,
  the BPT token-program owner, and the Solana Clock slot/epoch/timestamp.
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
  `virtualBalancesAfter`, `bptOut` and `minimumBptAmount`. A credit above the
  net ceiling or a gross-up above the ceiling is an error, not a quote.
  `quoteSeedDeposit` credits the net amounts and prices BPT on them.
- `quoteRemove` applies `calc_effective_bpt_burn`, floors the proportional
  payouts, withholds each leg's transfer fee (`receivedAmounts`) and reports the
  post-exit virtual balances. Derive `minimumTokenAmounts` from `receivedAmounts`.
- Hook/memo tails: `resolveSwapExtraAccounts`, `resolveAddLiquidityExtraAccounts`,
  `resolveRemoveLiquidityExtraAccounts` (or the `CubicPoolClient.resolve*`
  wrappers) return the `AccountMeta[]` to pass as `extraAccounts`. Classic
  pools resolve to `[]` without an RPC read. A hook that needs an extra signer
  or one of the instruction's core accounts is outside the supported profile.
- `actualBalance` already excludes protocol fees; do not subtract
  `protocolFeesOwed` again. The creation-policy bitmap is a separate diagnostic.

Quotes use the synced state and Clock timestamp; swap and planned-zap quotes
accept an explicit `nowSeconds` for an anticipated execution time. Other trades,
window rotation or admin updates before execution can change the result. Always
use the final minimum output/BPT amount and refresh the snapshot when needed.

Compatibility checks are not a security audit of the contracts.

## Reproducible checks

```sh
npm run lint
npm run build
SKIP_MAINNET_TESTS=1 npm test -- --runInBand
npm run types:check
npm run abi:check                       # against ../contracts checked out at v6
npm run fixtures:rust                   # regenerates tests/math/fixtures/deployed-v6-math.json (needs rustc)
ZAP_PLAN_BINARY=../contracts/target/debug/examples/zap_plan SKIP_MAINNET_TESTS=1 npx jest tests/zap-plan-fixtures
```

`tests/contract-abi.test.ts` independently encodes every instruction/event and
checks all declared account layouts against the shipped IDLs.
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
