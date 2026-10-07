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

## Flow

```ts
const pool = new CubicPoolClient({ config, poolAddress });
const zap = pool.plannedZap;                       // or new PlannedZapClient({ config, poolAddress })

// 1. One bank snapshot (pool + BPT mint + every mint + Clock), plan, price.
const q = await zap.quote(tokenInIndex, amountIn, { slippageHundredthsBps: 5_000, validForSlots: 120 });
if (!q.ok) throw q.error;

// 2. Every user_token_i and the user's BPT account must exist (writable, even
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

`PlannedZapQuote` carries the plan (`plan.allocations`, `plan.expectedState`,
`plan.quotedAt`, `plan.validUntilSlot`), the exact replay (`economics`: swap
legs with both transfer fees, `available`, `depositedGross`, `creditedNet`,
`dust`, `bpt`, `ratio`, `stateAfter`), BN conveniences (`estimatedBpt`,
`minimumBpt`, `allocations`, `expectedOuts`, `depositedAmounts`,
`dustAmounts`), the snapshot bytes, `chainSlot`/`chainEpoch`/`chainTimestamp`
and the account layout.

## Validity

- `quotedAt` is the snapshot's Clock `unix_timestamp`; the program accepts
  `0 ≤ clock − quoted_at ≤ 90 s`. `nowSeconds` only re-prices the sell-off
  window in the simulator and never changes `quotedAt`.
- `validUntilSlot = snapshot slot + validForSlots` (1..150, default 120).
- `expectedState` is `sha256` chained over `"coffer-stld-v6-plan-v1"`, the
  epoch, then `(key, owner, data)` of the pool, the BPT mint and every pool
  mint. Any trade, join, exit, admin or range-manager update, a BPT supply
  change, a mint change or an **epoch rollover** makes the plan
  `AllocationPlanStale`: quote again.
- `minimumBpt` is the only slippage guard on the route; internal swaps run
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
core accounts (user, pool, BPT mint, user BPT account) are outside the v6
profile and are refused (`unsupported_token_extension`). Hook state is
external mutable state: always simulate the compiled transaction.

The BPT mint must be a plain 82-byte mint (`ZapTokenExtensionsUnsupported`
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
candidate by BPT, then by ratio, wins. Program-equivalent failures are
`MathError`/`SimError` and are the search's control flow.

Parity: ports of the Rust unit tests (`tests/math/planner.test.ts`), the
state-commitment known-answer vector, and six `zap_plan` snapshots
(`tests/fixtures/zap-plan/`, `tests/zap-plan-fixtures.test.ts`) that match
allocations, BPT, dust, every swap leg and the post-state bit for bit.

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
