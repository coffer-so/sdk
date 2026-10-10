# Changelog

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
