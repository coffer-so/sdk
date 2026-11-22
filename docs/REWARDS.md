# Rewards (boosts) — SDK guide

Since **1.5.0**. A **boost** pays the LPs of a pool an extra reward in a token
(USDC, SOL, …) on top of the swap fees. The money sits in an on-chain
`coffer_rewards` campaign, one per reward token. The backend counts what each
wallet earns, once a day, and signs a **voucher** for the wallet's all-time
total. The wallet claims with that voucher and signs the claim itself.

The backend's `docs/BOOSTS.md` is the source of truth for the routes, the JSON
and how to show boosts in the app; this file covers the SDK side. Program:
`coffer_rewards` of contracts v6.1, id
`2XGGEHUSRYAqYZ5qdTFJjFnFkiQLWvMW6iMsooaJAZtg` on every cluster
(`COFFER_REWARDS_PROGRAM_ID`). `src/idl/coffer_rewards.json` is a copy of
contracts `idl/coffer_rewards.json` at `55d9b13` (sha256 `9c6182c1…6d42b06`,
pinned in `tests/rewards.test.ts`).

Amounts in the rewards API of the SDK are `bigint` raw units; the backend
sends u64 values as decimal strings (`…Raw`).

## 1. Show boosts

Every raw pool answer (`getPoolRaw`, `listPoolsRaw`, `getPoolsByTokenPair`, …)
carries `boost: PoolBoostSnapshot | null` and `boostAprPct: number | null`.
`PoolSummary` (`listPools`, `getPool`) and `AdminPoolEntry` have both;
`PortfolioPositionItem` has `boostAprPct`. All are
optional in the types: older backends do not send them.

- `boostAprPct` is a **simple** APR paid in the reward token. It is never part
  of `apy` and never added to it: show two chips (`12.3% APY`,
  `+8% USDC Boost APR`).
- `null` means no active boost: show no chip.
- `boost.v !== 1`: treat as no boost.

| Method | Route | Answer |
| --- | --- | --- |
| `getRewardBoosts()` | `GET /api/rewards/boosts` | `PublicBoostsResponse`: pools with an active or scheduled boost |
| `getRewardCampaigns()` | `GET /api/rewards/campaigns` | `PublicCampaignsResponse`: our campaigns and the voucher key |
| `getWalletRewards(ref)` | `GET /api/rewards/wallets/:ref` | `WalletRewardsResponse`: earned, claimable, held per campaign and boost; `ref` is an address, `alice` or `@alice` |
| `requestRewardVoucher({ wallet, campaign })` (or `(wallet, campaign)`) | `POST /api/rewards/vouchers` | `RewardVoucherResponse` |

All four are public (no JWT) and answer flat JSON. While the backend's rewards
module is off, the GET routes answer empty lists and the voucher route 503.

## 2. Claim

```ts
import {
  CofferBackendClient, buildRewardClaimTx, loadRewardClaimState, getRewardsApiError,
} from "@coffer_so/sdk";
import { Transaction } from "@solana/web3.js";

const api = new CofferBackendClient({ apiEndpoint: "https://api.coffer.so" });
const rewards = await api.getWalletRewards(wallet.toBase58());
// For each campaign with claimsOpen && BigInt(claimableRaw) > 0n:
const voucher = await api.requestRewardVoucher({ wallet: wallet.toBase58(), campaign });
if (!voucher.ok) {
  const e = getRewardsApiError(voucher.error); // { status, code, message, body }
  // e?.code: "nothing_accrued" | "already_claimed" | "change_pending" | "issuance_paused" | …
  return;
}
const state = await loadRewardClaimState(connection, voucher.data); // one getMultipleAccountsInfo
if (!state.ok) return; // e.g. the key was rotated: ask for a new voucher
const built = buildRewardClaimTx(voucher.data, { ...state.data, beneficiary: wallet });
if (!built.ok) return; // code "unsupported_token_extension", "insufficient_funds", …
const tx = new Transaction().add(...built.data.instructions); // the wallet signs and sends
// built.data.expectedNetRaw — what the wallet receives; built.data.rentLamports — rent of the first claim (+ ATA)
```

`buildRewardClaimTx(voucher, options)` returns `SdkResult<RewardClaimTx>`:

- **Instructions:** `[ComputeBudget?, createAssociatedTokenAccountIdempotent?, Ed25519 verify, claim_token | claim_native]`.
  - `computeUnitLimit` defaults to `REWARD_CLAIM_CU_LIMIT` (200 000), a
    conservative suggestion, not a measurement. `null` leaves it to the wallet.
    `computeUnitPriceMicroLamports` adds a price.
  - The ATA of the reward mint is created when `destinationData` says it is
    missing, or when the state is unknown (the create is idempotent). A SOL
    campaign pays lamports to the wallet itself.
- **The voucher is checked first.** `parseRewardVoucher` rebuilds the 129-byte
  message from `programId`, `campaign`, `beneficiary`, `signerEpoch` and
  `totalRaw` and refuses a mismatch, a wrong program or malformed fields
  (`backend_invalid_response`). A voucher for another wallet than
  `beneficiary` is `invalid_input`. The Ed25519 signature itself is checked
  on chain by the precompile.
- **The Ed25519 instruction must stay right before the claim.** The program reads
  only the instruction just before the claim. It must be the self-contained
  web3.js layout: `Ed25519Program.createInstructionWithPublicKey`, no
  `instructionIndex`, every index 0xffff. Wallets that add ComputeBudget at the
  start or Lighthouse assertions after the claim are fine.
- **Memo.** When `destinationData` shows that the account requires incoming
  memos, the SPL Memo program goes into the claim's hook slice
  (`hook_accounts = 1`). The program then writes the memo itself. For a
  Token-2022 reward without `destinationData` it is always passed: the program
  invokes it only when the destination requires memos, so it costs one account
  key otherwise. `memo` overrides the detection.
- **Refused before building:**
  - a mint with a TransferHook → `unsupported_token_extension`;
  - total ≤ claimed → `invalid_input` (6001 would fail);
  - nothing payable now → `insufficient_funds` (6002). This uses the given
    `vaultRaw`, or else the voucher's `claimableNowRaw`;
  - a destination of another mint or owner, or a frozen one → `invalid_input`;
  - a `destination` that is not the ATA with `destinationData: null` →
    `account_not_found` (only the ATA can be created).
- **Preview.**
  - `expectedGrossRaw` is the vault debit and `expectedNetRaw` what the wallet
    receives. They come from `rewardClaimPayout` with the given state, or else
    from the voucher's `claimableNowRaw`.
  - `receiptRentLamports` is 1 002 240 on the first claim, paid by the wallet
    and not returned.
  - `destinationRentLamports` is an estimate of the ATA rent when it is created
    (165 bytes; 170 for Token-2022, 182 with a transfer fee).

`loadRewardClaimState(connection, voucher, { destination?, commitment? })`
reads the campaign, receipt, vault, mint and destination in one call, plus the
epoch for a transfer-fee mint. The result carries the `destination` it read,
so `{ ...state.data }` builds the claim to that account. It refuses:
- a voucher whose signer or epoch differs from the campaign's: the key was
  rotated, and the claim would fail with 6000;
- a mint or token program that differs from the campaign's.

**Partial payment.** The program pays `min(total − claimed, liquidity, vault)`.
When the campaign is short, it pays in part, and the same voucher pays the rest
after a deposit, until 6001.

**Token-2022 transfer fee.** The campaign pays the fee: the gross leaves the
vault, the net reaches the wallet, and the receipt counts the net.
`rewardClaimPayout` is a port of `assets.rs` `claim_transfer_amount`:
- the net is clipped to what `min(vault, liquidity)` yields after the fee;
- the gross is the least that pays it.

Without an epoch, the higher of the two fee schedules is used, as the backend
does.

## 3. Program errors

`toSdkError(e, "cofferRewards")` and `describeProgramError(code, "cofferRewards")`
use the coffer_rewards table. Without `"cofferRewards"`, 6000–6008 are read as
cubic-pool errors.

| Code | Name | When | What to show |
| --- | --- | --- | --- |
| 6000 | `InvalidVoucher` | No Ed25519 instruction right before the claim, or signed by a rotated key | Ask for a new voucher and retry once |
| 6001 | `AlreadyClaimed` | The receipt reached the voucher's total | "All claimed" |
| 6002 | `InsufficientLiquidity` | Nothing to pay right now | "The reward pool is being refilled, try later" |
| 6003 | `ZeroPayment` | The payment rounds to 0 | "Too small to claim" |
| 6004 | `InvalidSigner` | `initialize` / `rotate_signer` with a bad key | — |
| 6005 | `MetadataTooLong` | Admin only | — |
| 6006 | `WrongAsset` | Wrong mint, token program or vault | Generic error |
| 6007 | `CallbackAccounts` | Wrong callback accounts (the SDK sends no callback) | Generic error |
| 6008 | `Arithmetic` | Overflow | Generic error |

Voucher-route errors come back as a failed `SdkResult` with `cause.status`.
`getRewardsApiError(error)` reads the backend body
`{ success: false, error, code? }` (`message` is taken from `error`); the codes
are `RewardVoucherErrorCode`, listed in BOOSTS.md §5. `code` is null for
400 and 429, and on a backend older than the rewards release.

`requestRewardVoucher` re-sends only on transport errors and timeouts. A 429
counts against the per-wallet window, and a 503 does not clear in
milliseconds.

## 4. Lower-level helpers

| Helper | What it does |
| --- | --- |
| `rewardVoucherMessage(program, campaign, user, epoch, total)` | The 129 signed bytes; same signature as contracts `scripts/rewards/voucher.ts` |
| `rewardVerificationInstruction(…, backendSigner, signature)` | The Ed25519 instruction |
| `boostsCampaignId(cluster, mint \| "native")` | `sha256("coffer-boosts:v1:<cluster>:<mint\|native>")`, the backend's campaign id; `cluster` is `"mainnet"` or `"devnet"` |
| `deriveRewardCampaignPda(admin, id)`, `deriveRewardReceiptPda(campaign, user)`, `deriveRewardSolVaultPda(campaign)`, `deriveRewardTokenVault(campaign, mint, tokenProgram)` | PDAs `["campaign", admin, id]`, `["receipt", campaign, user]`, `["sol", campaign]`; the token vault is ATA(campaign) |
| `decodeRewardCampaignAccount` (389 bytes), `decodeRewardReceiptAccount` (16 bytes) | Strict decoders; check the account owner separately |
| `parseRewardPaidEvents(logs)` | `RewardPaid` lines printed while coffer_rewards is on top of the invoke stack, nothing after `Log truncated`; read logs of successful transactions only |
| `rewardClaimPayout`, `parseRewardMintTransferFee`, `rewardTransferFeeAt`, `rewardVaultSpendable` | Payout preview |
| `buildRewardClaimIx` | The bare claim instruction |
| `buildRewardInitializeIx`, `buildRewardDepositIx`, `buildRewardWithdrawIx`, `buildRewardRotateSignerIx`, `buildRewardReturnSurplusIx` | Admin instructions (the campaign admin signs). Token or SOL by `asset`; `memo` for a recipient that requires memos |

The generic ABI covers the program too:
- `buildContractInstruction(cfg, "cofferRewards", …)`;
- `buildContractInstructionWithProgramId(id, …)`;
- `decodeContractAccount("cofferRewards", "Campaign" | "Receipt", data)`;
- `parseContractEvents(logs, "cofferRewards")`.

`NetworkPrograms.cofferRewards` is optional, so configs built by hand keep
compiling. `programId(cfg, "cofferRewards")` falls back to
`COFFER_REWARDS_PROGRAM_ID`.
