import { PublicKey } from "@solana/web3.js";
import { deriveAta } from "../utils/pda";
import {
  COFFER_REWARDS_PROGRAM_ID,
  REWARD_CAMPAIGN_SEED,
  REWARD_RECEIPT_SEED,
  REWARD_SOL_VAULT_SEED,
} from "./constants";
import { sha256 } from "./sha256";

/** Cluster name inside the backend's campaign id (SOLANA_NETWORK of the backend). */
export type RewardsCluster = "mainnet" | "devnet";

/**
 * Id of a boosts campaign of one admin for one reward asset:
 * `sha256("coffer-boosts:v2:<cluster>:<mint|native>:<generation>")`, the mint in
 * base58. The PDA also carries the admin, so the same id gives every admin its
 * own campaign. A closed campaign leaves a marker at its address for good, so
 * a new campaign for the same asset takes the next `generation` (the backend's
 * `campaign-params` answer names it). Same string as new-backend
 * `boostsCampaignId` (src/rewards/campaign-account.util.ts).
 */
export function boostsCampaignId(cluster: RewardsCluster, mint: PublicKey | string | "native", generation = 0): Buffer {
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("generation must be a non-negative integer");
  const asset = typeof mint === "string" ? (mint === "native" ? mint : new PublicKey(mint).toBase58()) : mint.toBase58();
  return sha256(Buffer.from(`coffer-boosts:v2:${cluster}:${asset}:${generation}`, "utf8"));
}

/** Campaign PDA `["campaign", admin, id32]`. */
export function deriveRewardCampaignPda(
  admin: PublicKey,
  id: Uint8Array,
  programId: PublicKey = COFFER_REWARDS_PROGRAM_ID,
): [PublicKey, number] {
  if (id.length !== 32) throw new Error("deriveRewardCampaignPda: a campaign id is 32 bytes");
  return PublicKey.findProgramAddressSync([REWARD_CAMPAIGN_SEED, admin.toBuffer(), Buffer.from(id)], programId);
}

/** Receipt PDA `["receipt", campaign, user]`: the wallet's lifetime claimed total (net). */
export function deriveRewardReceiptPda(
  campaign: PublicKey,
  user: PublicKey,
  programId: PublicKey = COFFER_REWARDS_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([REWARD_RECEIPT_SEED, campaign.toBuffer(), user.toBuffer()], programId);
}

/** SOL vault PDA `["sol", campaign]` of a native campaign (system-owned, 0 bytes). */
export function deriveRewardSolVaultPda(
  campaign: PublicKey,
  programId: PublicKey = COFFER_REWARDS_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([REWARD_SOL_VAULT_SEED, campaign.toBuffer()], programId);
}

/** Token vault of a token campaign: ATA(campaign, mint, tokenProgram), the only vault the program accepts. */
export function deriveRewardTokenVault(campaign: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return deriveAta(campaign, mint, tokenProgram);
}
