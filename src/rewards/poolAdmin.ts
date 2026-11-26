import { ComputeBudgetProgram, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { PoolAdminCampaignParams } from "../clients/CofferBackendClient";
import { boostsCampaignId, deriveRewardCampaignPda } from "./pda";
import { RewardCampaignAsset, buildRewardDepositIx, buildRewardInitializeIx, buildRewardSetPayoutLimitIx } from "./instructions";

/** The backend wants a pool admin's payout limit per day to cover this many days of its boosts' issuance (×10). */
export const POOL_ADMIN_PAYOUT_LIMIT_FACTOR_X10 = 15n;
const DAY = 86_400n;

/**
 * A payout limit per `windowSeconds` that covers `factor` × the daily issuance
 * of `dailyBudgetRaw` (the sum of your boosts' budgets per day) — the least the
 * backend accepts, rounded up. Raise it when you add a boost.
 */
export function suggestedPayoutLimit(dailyBudgetRaw: bigint, windowSeconds: bigint = DAY): bigint {
  if (dailyBudgetRaw <= 0n || windowSeconds <= 0n) return 0n;
  const perDay = (dailyBudgetRaw * POOL_ADMIN_PAYOUT_LIMIT_FACTOR_X10 + 9n) / 10n;
  return (perDay * windowSeconds + DAY - 1n) / DAY;
}

export interface PoolAdminCampaignSetupParams {
  /** The answer of `CofferBackendClient.getPoolAdminCampaignParams` (state must be "free"). */
  params: PoolAdminCampaignParams;
  /** The pool admin's wallet: the campaign admin for ever, pays the rent and the deposit. */
  admin: PublicKey;
  /** SOL, or the reward mint with its token program (Token-2022 for a fee or metadata mint). */
  asset: RewardCampaignAsset;
  /** What to deposit now (raw, gross: a Token-2022 fee is taken from it): what is owed plus every budget you will run. 0n = none. */
  depositRaw: bigint;
  /** The payout limit and its window (≤ params.payoutWindowSec): see `suggestedPayoutLimit`. */
  payoutLimitRaw: bigint;
  payoutWindowSec?: bigint;
  /** Up to 200 bytes of UTF-8. */
  metadata?: string;
  /** The rewards program; default the one in `params.programId`. */
  programId?: PublicKey;
  /** setComputeUnitLimit; default 200 000, null = none. */
  computeUnitLimit?: number | null;
}

/**
 * The pool admin's campaign in one transaction: initialize (backend signer =
 * ours, id of the backend's generation) + set_payout_limit (the backend
 * requires one) + the first deposit. The pool admin signs; afterwards
 * register it with `registerPoolAdminCampaign`. Throws when the params do not
 * describe a free address of this admin, or the token program is not a token
 * program.
 */
export function buildPoolAdminCampaignSetup(p: PoolAdminCampaignSetupParams): { instructions: TransactionInstruction[]; campaign: PublicKey; id: Buffer } {
  const { params } = p;
  if (params.state !== "free") throw new Error(`the campaign address is ${params.state}: ${params.state === "registered" ? "use it" : "register it"} instead of creating one`);
  if (params.admin !== p.admin.toBase58()) throw new Error(`the params are for ${params.admin}, not ${p.admin.toBase58()}`);
  const programId = p.programId ?? new PublicKey(params.programId);
  const asset = p.asset.native === true ? "native" : p.asset.mint.toBase58();
  if (asset !== params.mint) throw new Error(`the params are for ${params.mint}, not ${asset}`);
  if (p.asset.native !== true && !p.asset.tokenProgram.equals(TOKEN_PROGRAM_ID) && !p.asset.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error("the token program is neither SPL Token nor Token-2022");
  }
  const id = boostsCampaignId(params.cluster, asset, params.generation);
  if (id.toString("hex") !== params.campaignIdHex) throw new Error("the campaign id does not match the backend's (cluster or generation)");
  const [campaign] = deriveRewardCampaignPda(p.admin, id, programId);
  if (campaign.toBase58() !== params.address) throw new Error(`the campaign PDA ${campaign.toBase58()} is not the backend's ${params.address} (program id?)`);
  const window = p.payoutWindowSec ?? BigInt(params.payoutWindowSec);
  if (p.payoutLimitRaw <= 0n || window <= 0n || window > BigInt(params.payoutWindowSec)) {
    throw new Error(`a payout limit above 0 per a window of at most ${params.payoutWindowSec} s is required`);
  }
  const instructions: TransactionInstruction[] = [];
  const cu = p.computeUnitLimit === undefined ? 200_000 : p.computeUnitLimit;
  if (cu !== null) instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));
  instructions.push(
    buildRewardInitializeIx(
      { admin: p.admin, campaign, id, backendSigner: new PublicKey(params.backendSigner), metadata: p.metadata ?? `coffer boosts ${params.cluster}`, asset: p.asset },
      programId,
    ),
    buildRewardSetPayoutLimitIx({ admin: p.admin, campaign, limit: p.payoutLimitRaw, windowSeconds: window }, programId),
  );
  if (p.depositRaw > 0n) instructions.push(buildRewardDepositIx({ admin: p.admin, campaign, amount: p.depositRaw, asset: p.asset }, programId));
  return { instructions, campaign, id };
}
