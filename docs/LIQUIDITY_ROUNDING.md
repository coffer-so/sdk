# Deposit rounding protection

`quoteAddLiquidity`, `buildAddLiquidityIx` / `buildAddLiquidityTx` (including
the `CofferPoolClient` wrappers), and `PlannedZapClient.quote`, `replayAt`,
`buildIx` / `buildTx` refuse excessive rounding loss with
`deposit_rounding_loss` (`DepositRoundingLossError` for throwing methods).

The current candidate mirrors the proposed F-02 on-chain bound, whose D6
owner ratification is pending. For every leg, with gross LP `L`, supply `S`,
NAV `N` and net credit `C`, it requires:

```text
fair = ceil(N * L / S)
C <= fair + floor(fair / 1000) + 1
```

`checkDepositRounding` uses exact BigInt products, including full-u64 inputs.
Against exact pre-join value `v = N*L/S`, the integer implication is
`1000*C*S <= 1001*(N*L+S)+1000*S`. The prose consequence is
`C-v < v/1000+2.001`, not `v/1000+2`.
It runs after net-credit validation and before transfer-fee gross-up in add
quotes/builders, and before gross-up in planner replay, matching Rust's order.
Failure maps to `deposit_rounding_loss` (program error 6110). Increasing
slippage cannot relax this bound.

The additional caller policy uses `slippageHundredthsBps`, or
`config.defaults.slippageHundredthsBps` when omitted. The same tolerance
also derives the quoted LP minimum. Pass a custom tolerance to the add
builder as well as the quote; a manually supplied positive `minimumLpAmount`
does not bypass the rounding check. Planned-zap quotes retain their tolerance
and the builder replays the signed allocations before checking it again.

For each leg, `N` is its pre-join NAV (`actual + surge_fees_owed`), `C` is
its exact credited amount after transfer fees, `S` is the old LP supply,
`L` is the gross LP mint before the deposit fee, and `t` is the tolerance
in hundredths of a basis point. The SDK accepts only if:

```text
L * N * 1_000_000 >= C * S * (1_000_000 - t)
```

This exact bigint comparison bounds the shortfall between the LP's value
at the old NAV price and the credited amount. It includes both the LP mint
floor and the token-credit ceiling. Every leg must pass; no price oracle or
minimum supply assumption is used. An exactly proportional join can pass
even at supply 1. A large-supply pool can fail when a thin leg rounds its
credit up substantially. Zero tolerance accepts only zero rounding loss;
100% tolerance disables only this additional caller policy. Quoted LP minima
remain at least one raw LP unit.

For example, supply 1, NAV `[1000, 2000]`, and credits `[1900, 3800]` mint
one gross LP. Its old-price NAV is `[1000, 2000]`: a `9/19` (47.37%)
shortfall. A hypothetical immediate gross redemption from the post-join
pool returns `[1450, 2900]`: a `9/38` (23.68%) loss before fees. These are
different measures. The SDK bounds the more conservative old-price
shortfall. It refuses that quote at the default 5% tolerance.

Configured deposit fees, their integer rounding, Token-2022 transfer fees,
swap costs, and withdrawal fees are separate explicit costs. The rounding
check uses gross LP and net credits, so it does not constrain those costs
or promise a profitable join/exit round trip. In a zap, it checks only the
final proportional join at the **post-swap** NAV, not the route's swap
price impact. `minimumLpAmount` / `minimumLp` remain the on-chain output
floors, net of the deposit fee; slippage against later state changes is a
separate check.

External LP burns and
split-account exits can leave any positive supply; there is no reliable
on-chain supply floor on which a client can base deposit safety. Fresh
snapshots and transaction simulation are still needed. State changes,
dynamic fee hooks, or a direct program call can bypass the snapshot policy;
the proposed program still enforces its own per-leg bound on live state.
`calcJoinRatioAndLp`, `calcDepositCredit`, `quoteZap`, and `replay` remain
contract-exact math. `buildPlannedZapIx`, generic contract encoders, and
Anchor instruction methods only encode their inputs and cannot establish
this policy without pool economics. Low-level callers can explicitly use
`assertDepositRoundingLoss` or `assertZapDepositRoundingLoss` before encoding.
Seed deposits retain their explicit creator-chosen supply and are unaffected.

Deposit-fee ceilings can be material at tiny supply even when this guard
passes: supply 1, gross LP 2, declared fee 1bp charges 1 LP and mints 1 LP.
The effective LP fee is 50%; immediate fee-free redemption loses 25% of the
deposit through dilution. Quotes expose the exact fraction as
`depositFeeLp / lpGross` (`estimatedLpGross` for zaps) and the ceiled display
field `depositFeeEffectiveHundredthsBpsCeil`. This characterizes existing
fee policy; D6 remains pending.

`sizeDepositForLp(navs, targetLp, supply)` returns net ceilings
`ceil(nav_i * targetLp / supply) + ceil(nav_i / 1e18)` for live legs and zero for sidelined
legs. Gross these up for transfer fees and obtain a fresh quote before use;
the helper validates actual LP/credit floors and u64 limits, including a
conservative gross-LP supply check. It does not validate hooks, funds, fees or
a future transaction. The old `+1` recipe is sufficient only while NAV <= 1e18.
Planner bisection stops on non-monotone 6110; this is not a "ratio too high"
signal. With no feasible baseline it reports `deposit_rounding_search_incomplete`;
with a feasible result it exposes `searchLimitation: "deposit_rounding_grid"`.
Neither outcome proves optimality or absence of an aligned plan. Raw replay
reports the specific rounding refusal. Raw encoders without pool state cannot
promise quote validation.
