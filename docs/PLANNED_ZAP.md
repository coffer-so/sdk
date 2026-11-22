# Planned single-token deposit (v6 zap)

In v6 the single-token-liquidity program no longer decides how to split the
input. The client sends an **allocation plan** — the gross input to spend on
each swap leg, a hash of the pool/mint state it was computed on and an expiry —
and `deposit_single_token_planned` only verifies the plan and executes it with
the user's own token accounts (no helper PDA, no refunds: leftovers simply stay
in the user's accounts). The legacy `deposit_single_token*` instructions reject
every call with `AllocationPlanRequired`.

The SDK ships the planner in TypeScript (`src/math/planner.ts`, a port of
`programs/single-token-liquidity/src/planner.rs`) on top of the ported pool
math, so quotes run in the browser with no Rust and no planner service.

The pure planner mirrors the proposed contract's per-leg rounding bound;
D6 ratification is pending. Bisection stops on non-monotone 6110, exposing
`deposit_rounding_search_incomplete` or a feasible quote's `searchLimitation`.
It does not exhaustively search aligned plans. These SDK diagnostics differ
from the frozen Rust search; replay pricing and guard ordering remain shared.
`PlannedZapClient` additionally applies the [caller rounding policy](LIQUIDITY_ROUNDING.md)
to the final join, using the quote's slippage tolerance. Its builder replays
the plan before checking again; a positive manual LP floor cannot bypass it.
The pure planner and the raw instruction encoder remain contract-exact
lower-level tools and do not apply that client policy automatically.

The zap is unavailable while any slot is bucket-only
(`actual == 0 < surge_fees_owed`): the join needs that NAV leg, but a swap
cannot buy its empty reserves. Use multi-token `add_liquidity`, or revive
the slot by swapping that token into the pool or calling
`fund_sidelined_token` as the pool admin. Existing exits remain available.

## Flow

```ts
const pool = new CofferPoolClient({ config, poolAddress });
const zap = pool.plannedZap;                       // or new PlannedZapClient({ config, poolAddress })

// 1. One bank snapshot (pool + LP mint + every mint + Clock), plan, price.
const q = await zap.quote(tokenInIndex, amountIn, { slippageHundredthsBps: 5_000, validForSlots: 120 });
if (!q.ok) throw q.error;

// 2. Every user_token_i and the user's LP account must exist (writable, even
//    sidelined slots). Send these first when any is missing; with the zap they
//    do not fit the packet on larger pools.
const setup = zap.ensureUserTokenAccountIxs(q.data, user);

// 3. Hook / memo tail for the route's transfers. [] for classic pools.
const tail = await zap.resolveExtraAccounts(q.data, user);
if (!tail.ok) throw tail.error;

// 4. The instruction (+ compute budget).
const built = zap.buildTx(q.data, user, tail.data);
if (!built.ok) throw built.error;

// 5. Pools of ~7+ tokens: the pool ALT covers vaults/mints/programs, a
//    wallet-owned ALT covers the user's accounts and the tail.
const poolAlt = await zap.poolLookupTable(poolInfo.lookupTable);
const prep = await zap.prepareWalletLookupTable(user, zap.walletLookupAddresses(q.data, user, tail.data), existingAltOrUndefined);
//    ... send prep.instructionBatches (wallet is payer/authority), then:
const walletAlt = await zap.waitForWalletLookupTable(prep, user);

// 6. Compile within the packet budget, simulate, sign, send.
const tx = zap.compileTransaction({ payer: user, blockhash, instructions: built.data.instructions, lookupTables: [poolAlt.data!, walletAlt] });
```

`compileTransaction` adds a compute limit (and, with `heapFrameBytes`, a heap
frame) only when `instructions` do not already carry one: the runtime refuses a
transaction with two compute-budget instructions of the same kind. Contradicting
values (`computeUnits` / `heapFrameBytes` vs. an instruction already present)
return `tx_build_failed`.

## Routed entry point (contracts v6.1 rc5 / `v6.1-n10`)

`deposit_single_token_routed` takes exactly the accounts and arguments of
`deposit_single_token_planned` — the same quote, plan and `minimumLp` — and
executes them as ONE coffer-pool CPI, `swap_route_join_v1(token_in_index,
allocations, minimum_lp_amount) -> RouteReturnV1`, instead of k `swap` CPIs
plus `add_liquidity`. The pool runs every leg (`minimum_amount_out = 0`) and
the join in-process; STLD then checks every slot's floor once and ties the
returned `received` / `charged` vectors to the real wallet deltas
(`RoutedReturnDataInvalid`, STLD 6040, otherwise). The inner `SwapV2` ×
k and `LiquidityAddedV2` events and the `SingleTokenDepositDirectV2` receipt
are the same as on the planned route; only the CPI frame differs (all inner
events sit under `swap_route_join_v1`). It saves one CPI frame per leg.

The routed transaction MUST request a heap frame:
`ComputeBudgetProgram.requestHeapFrame({ bytes: 64 * 1024 })`
(`ROUTED_ZAP_HEAP_FRAME_BYTES`) — at N10 the single pool invocation exceeds
the default 32 KiB heap — plus a compute unit limit. Without it the pool dies
with `ProgramFailedToComplete` (heap access violation; ~1.4M CU burned);
`toSdkError(e, "singleTokenLiquidity", { routedDeposit: true })` maps that to
`routed_heap_frame_required`. The pool also refuses
to start a leg with too few compute units left
(`RouteComputeBudgetInsufficient`, 6119), and a plan with no swap leg
(`RouteNoLegs`, 6118): the SDK never routes such a plan.

```ts
// Same quote / tail as above.
const routed = zap.depositRouted(q.data, user, tail.data);      // = buildRoutedTx: [CU limit, 64 KiB heap frame, routed ix]
// or, compiling yourself:
const ix = zap.buildRoutedIx(q.data, user, tail.data);
const tx = zap.compileTransaction({ payer: user, blockhash, instructions: [ix], lookupTables, heapFrameBytes: ROUTED_ZAP_HEAP_FRAME_BYTES });
```

Raw: `buildRoutedZapIx(cfg, accounts, args)` (alias `buildRoutedZapInstruction`)
is byte-for-byte `buildPlannedZapIx` with discriminator `f782dde3cee774af`
(`ROUTED_ZAP_DISCRIMINATOR_HEX`); `routedZapComputeBudgetIxs(units)` returns
the `[setComputeUnitLimit, requestHeapFrame]` prefix. The pool-level
instruction is `buildSwapRouteJoinV1Ix` / `buildSwapRouteJoinV1Tx`
(`add_liquidity`'s account layout; the Tx variant adds the heap frame).

### Capability and fallback

The SDK had no capability mechanism before rc5. `PlannedZapClient` takes
`route: "auto" | "planned" | "routed"`, default **`"planned"`** (works on
every deployment, including programs that predate rc5):

- `"planned"` — `buildDepositTx` is `buildTx`; no probe.
- `"routed"` — always the routed entry point (fails with
  `InstructionFallbackNotFound` on an older deployment); no probe.
- `"auto"` — `probeRoutedSupport(payer)` simulates a discriminator-only
  instruction (no accounts, `sigVerify: false`, `replaceRecentBlockhash`)
  against the configured STLD (`deposit_single_token_routed`) and coffer-pool
  (`swap_route_join_v1`) program IDs. Anchor 0.32 deserializes arguments
  before accounts, so a deployed instruction answers
  `InstructionDidNotDeserialize` (102) and a missing one
  `InstructionFallbackNotFound` (101). Routed is used only when BOTH answer
  102; absent, unknown errors or RPC failures fall back to planned
  (`BuiltDirectZapTx.fallbackReason`). A conclusive answer is cached per
  client (`probeRoutedSupport(payer, true)` re-probes); an inconclusive one
  is not. `payer` must exist on chain for the simulation to run.

A plan with no swap leg always resolves to planned.

`PlannedZapQuote` carries the plan (`plan.allocations`, `plan.expectedState`,
`plan.quotedAt`, `plan.validUntilSlot`), the exact replay (`economics`: swap
legs with both transfer fees, `available`, `depositedGross`, `creditedNet`,
`dust`, `lp`, `ratio`, `stateAfter`), BN conveniences (`estimatedLp`,
`minimumLp`, `allocations`, `expectedOuts`, `depositedAmounts`,
`dustAmounts`), the snapshot bytes, `chainSlot`/`chainEpoch`/`chainTimestamp`
and the account layout.

## Validity

- `quotedAt` is the snapshot's Clock `unix_timestamp`; the program accepts
  `0 ≤ clock − quoted_at ≤ 90 s`. `nowSeconds` only re-prices the sell-off
  window in the simulator and never changes `quotedAt`.
- `validUntilSlot = snapshot slot + validForSlots` (1..150, default 120).
- `expectedState` is `sha256` chained over `"coffer-stld-v6-plan-v1"`, the
  epoch, then `(key, owner, data)` of the pool, the LP mint and every pool
  mint. Any trade, join, exit, admin or range-manager update, a LP supply
  change, a mint change or an **epoch rollover** makes the plan
  `AllocationPlanStale`: quote again.
- `minimumLp` is the only slippage guard on the route; internal swaps run
  with `min_out = 0`.
- The plan's budget must sum to `amountIn`, with zero allocations exactly on
  sidelined slots (`InvalidAllocationPlan` otherwise).

## Transfer profile

The tail resolver (`utils/transferProfile.ts`) decodes each armed hook's
`ExtraAccountMetaList` strictly (TLV tag, length, PodSlice count), resolves
the extras with the SPL resolver against the quote's own mint snapshots and a
pinned `confirmed` commitment, de-escalates duplicates like SPL, unions the
metas with writable-OR and adds the memo program for destinations that
require memos. Hooks that need an extra signer or one of the instruction's
core accounts (user, pool, LP mint, user LP account) are outside the v6
profile and are refused (`unsupported_token_extension`). Hook state is
external mutable state: always simulate the compiled transaction.

The LP mint must be a plain 82-byte mint (`ZapTokenExtensionsUnsupported`
otherwise); pool mints may carry fees, hooks and memo requirements.

## Planner

`quoteZap(pool, input, amount)` replays the legacy linear split
(`computeAllocations`) as a baseline, then bisects the common post-swap join
ratio: for a candidate ratio, `basketForRatio` finds, leg by leg in slot
order, the smallest gross input whose net output joins at that ratio
(`legForRatio`, an inner bisection on a private copy of the pool), reserves
the remainder for the input slot, and `replay` executes the whole basket with
the exact program math (swaps → join with `calc_deposit_credit`, inverse
transfer fees, `virtual_balance_after_deposit`, window rebases). The best
candidate by LP, then by ratio, wins. Program-equivalent failures are
`MathError`/`SimError` and are the search's control flow.

Parity: ports of the Rust unit tests (`tests/math/planner.test.ts`), the
state-commitment known-answer vector, and six `zap_plan` snapshots
(`tests/fixtures/zap-plan/`, `tests/zap-plan-fixtures.test.ts`) that match
allocations, LP, dust, every swap leg and the post-state bit for bit.

Benchmark (`tests/math/planner.test.ts`, "benchmark"): N = 10, unequal
weights, three active windows with surge curves, fee mints on half the
slots, 0.3 % swap fee — about **160 ms** per quote on an Apple M-series
laptop (`ln`/`exp` results are memoised within one quote). The function is
pure and synchronous, so it can run in a Web Worker if a UI wants to keep
the main thread free.

## Wire size

A 10-token zap references 36 static keys (37 with two token programs) plus
the tail. With the pool ALT and a wallet ALT the compiled v0 transaction
stays within `1232 − 653` bytes (`DEFAULT_FINANCIAL_WALLET_RESERVE`, the
measured headroom wallets add for guards and priority fees). Setup packets
(ALT create + extend) keep a 520-byte reserve. `compilePlannedZapTransaction`
refuses anything larger instead of letting the wallet fail.
