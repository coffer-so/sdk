import { AccountMeta, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import { U64_MAX } from "../math/fixedPoint";
import { deriveAta } from "../utils/pda";
import { buildContractInstructionWithProgramId } from "../clients/contract-instructions";
import { COFFER_REWARDS_PROGRAM_ID, REWARD_CAMPAIGN_METADATA_MAX, SPL_MEMO_PROGRAM_ID } from "./constants";
import { deriveRewardReceiptPda, deriveRewardSolVaultPda, deriveRewardTokenVault } from "./pda";

/**
 * Instruction builders of coffer_rewards, encoded through the shipped IDL
 * (`buildContractInstructionWithProgramId`). Amounts are bigint raw units.
 * Every builder takes the program id last (default COFFER_REWARDS_PROGRAM_ID).
 */

/** The asset of a campaign: SOL, or one SPL / Token-2022 mint with its token program. */
export type RewardCampaignAsset =
  | { native: true }
  | { native?: false; mint: PublicKey; tokenProgram: PublicKey };

const isNative = (asset: RewardCampaignAsset): asset is { native: true } => asset.native === true;

function u64(value: bigint, what: string): BN {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) throw new Error(`${what} must be a u64 bigint`);
  return new BN(value.toString());
}

/** `error` is what the program raises for 0: 6003 in deposit/withdraw, 6002 in return_surplus (`check_surplus`). */
function positive(value: bigint, what: string, error: string): BN {
  if (typeof value === "bigint" && value === 0n) throw new Error(`${what} must be above 0 (${error})`);
  return u64(value, what);
}

function tokenProgramOf(asset: { mint: PublicKey; tokenProgram: PublicKey }): PublicKey {
  if (!asset.tokenProgram.equals(TOKEN_PROGRAM_ID) && !asset.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(`token program ${asset.tokenProgram.toBase58()} is neither SPL Token nor Token-2022`);
  }
  return asset.tokenProgram;
}

/** A backend key the program accepts (`validate_signer`): an Ed25519 point, not the default key. */
export function assertRewardSigner(signer: PublicKey): void {
  if (signer.equals(PublicKey.default) || !PublicKey.isOnCurve(signer.toBytes())) {
    throw new Error(`${signer.toBase58()} is not a valid backend signer (6004 InvalidSigner)`);
  }
}

const memoAccounts = (memo: boolean | undefined): AccountMeta[] =>
  memo ? [{ pubkey: SPL_MEMO_PROGRAM_ID, isSigner: false, isWritable: false }] : [];

// ── Claims ──

export interface RewardClaimIxParams {
  campaign: PublicKey;
  /** The beneficiary; signs and pays the receipt rent on the first claim. */
  user: PublicKey;
  /** Voucher total (cumulative, net). */
  total: bigint;
  asset: RewardCampaignAsset;
  /** Token claims: the receiving token account (mint + owner = user); default ATA(user). */
  walletToken?: PublicKey;
  /** Token claims: add SPL Memo to the hook slice (destination requires incoming memos). */
  memo?: boolean;
}

/** `claim_native` or `claim_token` without a callback. Must come right after the voucher's Ed25519 instruction. */
export function buildRewardClaimIx(params: RewardClaimIxParams, programId: PublicKey = COFFER_REWARDS_PROGRAM_ID): TransactionInstruction {
  const [receipt] = deriveRewardReceiptPda(params.campaign, params.user, programId);
  const total = u64(params.total, "total");
  if (isNative(params.asset)) {
    const [vault] = deriveRewardSolVaultPda(params.campaign, programId);
    return buildContractInstructionWithProgramId(programId, "cofferRewards", "claim_native", { total, callback: null }, {
      user: params.user,
      campaign: params.campaign,
      vault,
      receipt,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      system_program: SystemProgram.programId,
    });
  }
  const tokenProgram = tokenProgramOf(params.asset);
  const hooks = memoAccounts(params.memo);
  return buildContractInstructionWithProgramId(
    programId,
    "cofferRewards",
    "claim_token",
    { total, hook_accounts: hooks.length, callback: null },
    {
      user: params.user,
      campaign: params.campaign,
      receipt,
      mint: params.asset.mint,
      token_program: tokenProgram,
      vault: deriveRewardTokenVault(params.campaign, params.asset.mint, tokenProgram),
      wallet_token: params.walletToken ?? deriveAta(params.user, params.asset.mint, tokenProgram),
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      system_program: SystemProgram.programId,
    },
    hooks,
  );
}

// ── Admin ──

export interface RewardInitializeIxParams {
  /** Becomes the campaign's admin for ever; pays the rent. */
  admin: PublicKey;
  /** The campaign PDA `["campaign", admin, id]` (deriveRewardCampaignPda). */
  campaign: PublicKey;
  /** 32 bytes; ours is boostsCampaignId(cluster, mint | "native"). */
  id: Uint8Array;
  backendSigner: PublicKey;
  /** Up to 200 bytes of UTF-8; default "". */
  metadata?: string;
  asset: RewardCampaignAsset;
}

/** `initialize_native` or `initialize_token` (creates the campaign's vault ATA when missing). */
export function buildRewardInitializeIx(params: RewardInitializeIxParams, programId: PublicKey = COFFER_REWARDS_PROGRAM_ID): TransactionInstruction {
  if (params.id.length !== 32) throw new Error("a campaign id is 32 bytes");
  const metadata = params.metadata ?? "";
  if (Buffer.byteLength(metadata, "utf8") > REWARD_CAMPAIGN_METADATA_MAX) throw new Error(`metadata is above ${REWARD_CAMPAIGN_METADATA_MAX} bytes (6005 MetadataTooLong)`);
  assertRewardSigner(params.backendSigner);
  const args = { id: Array.from(params.id), backend_signer: params.backendSigner, metadata };
  if (isNative(params.asset)) {
    const [vault] = deriveRewardSolVaultPda(params.campaign, programId);
    return buildContractInstructionWithProgramId(programId, "cofferRewards", "initialize_native", args, {
      admin: params.admin,
      campaign: params.campaign,
      vault,
      system_program: SystemProgram.programId,
    });
  }
  const tokenProgram = tokenProgramOf(params.asset);
  return buildContractInstructionWithProgramId(programId, "cofferRewards", "initialize_token", args, {
    admin: params.admin,
    campaign: params.campaign,
    mint: params.asset.mint,
    token_program: tokenProgram,
    vault: deriveRewardTokenVault(params.campaign, params.asset.mint, tokenProgram),
    associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
    system_program: SystemProgram.programId,
  });
}

export interface RewardLiquidityIxParams {
  admin: PublicKey;
  campaign: PublicKey;
  /** Gross units moved (a deposit credits liquidity with what arrives after a Token-2022 fee). */
  amount: bigint;
  asset: RewardCampaignAsset;
  /** Token campaigns: the admin's token account; default ATA(admin). */
  walletToken?: PublicKey;
  /** Token withdrawals: the admin's account requires incoming memos. */
  memo?: boolean;
}

function liquidityIx(name: "deposit" | "withdraw", params: RewardLiquidityIxParams, programId: PublicKey): TransactionInstruction {
  const amount = positive(params.amount, "amount", "6003 ZeroPayment");
  if (isNative(params.asset)) {
    const [vault] = deriveRewardSolVaultPda(params.campaign, programId);
    return buildContractInstructionWithProgramId(programId, "cofferRewards", `${name}_native`, { amount }, {
      admin: params.admin,
      campaign: params.campaign,
      vault,
      system_program: SystemProgram.programId,
    });
  }
  const tokenProgram = tokenProgramOf(params.asset);
  return buildContractInstructionWithProgramId(
    programId,
    "cofferRewards",
    `${name}_token`,
    { amount },
    {
      admin: params.admin,
      campaign: params.campaign,
      mint: params.asset.mint,
      token_program: tokenProgram,
      vault: deriveRewardTokenVault(params.campaign, params.asset.mint, tokenProgram),
      wallet_token: params.walletToken ?? deriveAta(params.admin, params.asset.mint, tokenProgram),
      system_program: SystemProgram.programId,
    },
    name === "withdraw" ? memoAccounts(params.memo) : [],
  );
}

/** `deposit_native` / `deposit_token`: admin only; raises liquidity by the net received. */
export function buildRewardDepositIx(params: RewardLiquidityIxParams, programId: PublicKey = COFFER_REWARDS_PROGRAM_ID): TransactionInstruction {
  return liquidityIx("deposit", params, programId);
}

/** `withdraw_native` / `withdraw_token`: admin only, up to liquidity (gross vault debit). */
export function buildRewardWithdrawIx(params: RewardLiquidityIxParams, programId: PublicKey = COFFER_REWARDS_PROGRAM_ID): TransactionInstruction {
  return liquidityIx("withdraw", params, programId);
}

/** `rotate_signer`: admin only; signer epoch +1, every older voucher fails with 6000. */
export function buildRewardRotateSignerIx(
  params: { admin: PublicKey; campaign: PublicKey; backendSigner: PublicKey },
  programId: PublicKey = COFFER_REWARDS_PROGRAM_ID,
): TransactionInstruction {
  assertRewardSigner(params.backendSigner);
  return buildContractInstructionWithProgramId(programId, "cofferRewards", "rotate_signer", { backend_signer: params.backendSigner }, {
    admin: params.admin,
    campaign: params.campaign,
  });
}

export type RewardReturnSurplusIxParams =
  | {
      admin: PublicKey;
      campaign: PublicKey;
      amount: bigint;
      native: true;
      /** Where the stray SOL was sent: the campaign account itself or its SOL vault. */
      source: "campaign" | "vault";
      recipient: PublicKey;
    }
  | {
      admin: PublicKey;
      campaign: PublicKey;
      amount: bigint;
      native?: false;
      /** The mint sent to the campaign's ATA (the campaign's own mint, or another one). */
      mint: PublicKey;
      tokenProgram: PublicKey;
      recipient: PublicKey;
      /** The recipient's token account; default ATA(recipient). */
      walletToken?: PublicKey;
      memo?: boolean;
    };

/** `return_surplus_native` / `return_surplus_token`: admin only; returns what was sent outside deposit (never the liquidity). */
export function buildRewardReturnSurplusIx(params: RewardReturnSurplusIxParams, programId: PublicKey = COFFER_REWARDS_PROGRAM_ID): TransactionInstruction {
  const amount = positive(params.amount, "amount", "6002 InsufficientLiquidity");
  if (params.native === true) {
    const source = params.source === "campaign" ? params.campaign : deriveRewardSolVaultPda(params.campaign, programId)[0];
    return buildContractInstructionWithProgramId(programId, "cofferRewards", "return_surplus_native", { amount }, {
      admin: params.admin,
      campaign: params.campaign,
      recipient: params.recipient,
      source,
      system_program: SystemProgram.programId,
    });
  }
  const tokenProgram = tokenProgramOf(params);
  return buildContractInstructionWithProgramId(
    programId,
    "cofferRewards",
    "return_surplus_token",
    { amount },
    {
      admin: params.admin,
      campaign: params.campaign,
      mint: params.mint,
      token_program: tokenProgram,
      vault: deriveRewardTokenVault(params.campaign, params.mint, tokenProgram),
      recipient: params.recipient,
      wallet_token: params.walletToken ?? deriveAta(params.recipient, params.mint, tokenProgram),
    },
    memoAccounts(params.memo),
  );
}
