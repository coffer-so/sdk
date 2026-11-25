import { PublicKey } from "@solana/web3.js";

/**
 * coffer_rewards (contracts v6.1, programs/coffer-rewards): permissionless
 * reward campaigns paid out against Ed25519 vouchers signed by a backend key.
 * The mainnet id (`declare_id!`); the devnet rc9 stand runs its own build
 * (`DEVNET_V61_REWARDS_PROGRAM_ID`, set in `DEVNET_V61_PROGRAMS.cofferRewards`).
 */
export const COFFER_REWARDS_PROGRAM_ID = new PublicKey("2XGGEHUSRYAqYZ5qdTFJjFnFkiQLWvMW6iMsooaJAZtg");

export const REWARD_CAMPAIGN_SEED = Buffer.from("campaign");
export const REWARD_RECEIPT_SEED = Buffer.from("receipt");
export const REWARD_SOL_VAULT_SEED = Buffer.from("sol");

/** Layout version stored in every account of the program (`state::VERSION`). */
export const REWARD_ACCOUNT_VERSION = 1;
/** Campaign: 8 discriminator + InitSpace (version, bump, keys, window, 64 reserved, metadata `max_len(200)`). */
export const REWARD_CAMPAIGN_LEN = 518;
/** Receipt: 8 discriminator + version u8 + `claimed` u64 + 15 reserved. */
export const REWARD_RECEIPT_LEN = 32;
/** ClosedCampaign: the permanent 9-byte marker a closed campaign leaves at its address. */
export const REWARD_CLOSED_CAMPAIGN_LEN = 9;
/** RewardPaid event: 8 discriminator + campaign + user + 4 × u64. */
export const REWARD_PAID_LEN = 104;
/** CampaignClosed event: 8 discriminator + campaign + admin. */
export const REWARD_CAMPAIGN_CLOSED_LEN = 72;
export const REWARD_CAMPAIGN_METADATA_MAX = 200;

export const REWARD_CAMPAIGN_DISCRIMINATOR = Buffer.from("3228310b9ddce5c0", "hex");
export const REWARD_RECEIPT_DISCRIMINATOR = Buffer.from("279a496a50669199", "hex");
export const REWARD_CLOSED_CAMPAIGN_DISCRIMINATOR = Buffer.from("e58737e8c49fa799", "hex");
export const REWARD_PAID_DISCRIMINATOR = Buffer.from("84a0be75d7b1135f", "hex");
export const REWARD_CAMPAIGN_CLOSED_DISCRIMINATOR = Buffer.from("9e8f80fb5483025a", "hex");

/**
 * Voucher message (V2, 169 bytes): "COFFER_REWARDS_V2" ‖ program ‖ campaign ‖
 * domain ‖ beneficiary ‖ signer_epoch u64le ‖ total u64le ‖ expires_at i64le.
 */
export const REWARD_VOUCHER_TAG = Buffer.from("COFFER_REWARDS_V2", "ascii");
/** @deprecated the old name of `REWARD_VOUCHER_TAG` (it is a tag, not the campaign `domain`). */
export const REWARD_VOUCHER_DOMAIN = REWARD_VOUCHER_TAG;
export const REWARD_VOUCHER_MESSAGE_LEN = REWARD_VOUCHER_TAG.length + 32 * 4 + 8 * 3; // 169
/** Data of the Ed25519 instruction the program accepts: 16-byte header + key + signature + message. */
export const REWARD_VERIFY_IX_LEN = 16 + 32 + 64 + REWARD_VOUCHER_MESSAGE_LEN; // 281
/** `expires_at` that never expires (`i64::MAX`). */
export const REWARD_VOUCHER_NO_EXPIRY = 9_223_372_036_854_775_807n;

/** SPL Memo v3: passed to the claim when the destination account requires incoming memos. */
export const SPL_MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/** Rent-exempt minimum of a 0-byte account: what the SOL vault keeps back (`native_available`). */
export const REWARD_SOL_VAULT_RENT_LAMPORTS = 890_880n;
/** Rent of a Receipt (32 bytes), paid by the wallet on its first claim; `close_receipt` refunds it once the campaign is closed. */
export const REWARD_RECEIPT_RENT_LAMPORTS = 1_113_600;

/** Suggested compute limit of a claim transaction (ATA creation, receipt init, token CPI). */
export const REWARD_CLAIM_CU_LIMIT = 200_000;
