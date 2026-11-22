import { PublicKey } from "@solana/web3.js";

/**
 * coffer_rewards (contracts v6.1, programs/coffer-rewards): permissionless
 * reward campaigns paid out against Ed25519 vouchers signed by a backend key.
 * The same program id on every cluster (`declare_id!`).
 */
export const COFFER_REWARDS_PROGRAM_ID = new PublicKey("2XGGEHUSRYAqYZ5qdTFJjFnFkiQLWvMW6iMsooaJAZtg");

export const REWARD_CAMPAIGN_SEED = Buffer.from("campaign");
export const REWARD_RECEIPT_SEED = Buffer.from("receipt");
export const REWARD_SOL_VAULT_SEED = Buffer.from("sol");

/** Campaign: 8 discriminator + InitSpace (metadata `max_len(200)`). */
export const REWARD_CAMPAIGN_LEN = 389;
/** Receipt: 8 discriminator + `claimed` u64. */
export const REWARD_RECEIPT_LEN = 16;
/** RewardPaid event: 8 discriminator + campaign + user + 4 × u64. */
export const REWARD_PAID_LEN = 104;
export const REWARD_CAMPAIGN_METADATA_MAX = 200;

export const REWARD_CAMPAIGN_DISCRIMINATOR = Buffer.from("3228310b9ddce5c0", "hex");
export const REWARD_RECEIPT_DISCRIMINATOR = Buffer.from("279a496a50669199", "hex");
export const REWARD_PAID_DISCRIMINATOR = Buffer.from("84a0be75d7b1135f", "hex");

/** Voucher message: "COFFER_REWARDS_V1" ‖ program ‖ campaign ‖ beneficiary ‖ epoch u64le ‖ total u64le. */
export const REWARD_VOUCHER_DOMAIN = Buffer.from("COFFER_REWARDS_V1", "ascii");
export const REWARD_VOUCHER_MESSAGE_LEN = REWARD_VOUCHER_DOMAIN.length + 32 * 3 + 8 * 2; // 129
/** Data of the Ed25519 instruction the program accepts: 16-byte header + key + signature + message. */
export const REWARD_VERIFY_IX_LEN = 16 + 32 + 64 + REWARD_VOUCHER_MESSAGE_LEN; // 241

/** SPL Memo v3: passed to the claim when the destination account requires incoming memos. */
export const SPL_MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/** Rent-exempt minimum of a 0-byte account: what the SOL vault keeps back (`native_available`). */
export const REWARD_SOL_VAULT_RENT_LAMPORTS = 890_880n;
/** Rent of a Receipt (16 bytes), paid by the wallet on its first claim and not returned. */
export const REWARD_RECEIPT_RENT_LAMPORTS = 1_002_240;

/** Suggested compute limit of a claim transaction (ATA creation, receipt init, token CPI). */
export const REWARD_CLAIM_CU_LIMIT = 200_000;
