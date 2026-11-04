import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  ExtensionType, getTypeLen, isMintExtension,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT_2022,
  getExtensionData,
  MetadataPointerLayout,
  PausableConfigLayout,
  TransferFeeConfigLayout,
  TransferHookLayout,
} from "@solana/spl-token";
import type { MetadataPointer, PausableConfig, TransferFeeConfig, TransferHook } from "@solana/spl-token";
import { unpack as unpackTokenMetadata } from "@solana/spl-token-metadata";
import type { LpMetadata } from "../types/pool";
import { MAX_FEE_BASIS_POINTS } from "../math/transferFee";
import { MINT_TLV_OFFSET, parseMintExtensions } from "../utils/extensions";

/**
 * SPL Token (or Token-2022) Mint parser. Reads the 82-byte base layout and,
 * for Token-2022 mints, the TLV extension list plus the bodies the v6
 * transfer path depends on (transfer-fee schedules, transfer hook, pause
 * state).
 *
 * Layout:
 *   0..36  COption<Pubkey>  mintAuthority  (4 bytes tag + 32 bytes pubkey)
 *   36..44 u64              supply
 *   44..45 u8               decimals
 *   45..46 u8               isInitialized
 *   46..82 COption<Pubkey>  freezeAuthority
 */
/** ScaledUI timestamps are signed i64 on-chain (not JS SPL's u64 layout). */
export interface ScaledUiAmountConfig {
  authority: PublicKey;
  multiplier: number;
  newMultiplierEffectiveTimestamp: bigint;
  newMultiplier: number;
}
/** Preserve exact i64 times; interest is separate from ScaledUI. */
export interface InterestBearingConfig {
  rateAuthority: PublicKey;
  initializationTimestamp: bigint;
  preUpdateAverageRate: number;
  lastUpdateTimestamp: bigint;
  currentRate: number;
}
export interface ConfidentialTransferMintConfig {
  authority: PublicKey;
  autoApproveNewAccounts: boolean;
  auditorElgamalPubkey: Uint8Array;
}

export interface RawMintAccount {
  mintAuthority: PublicKey | null;
  supply: BN;
  decimals: number;
  isInitialized: boolean;
  freezeAuthority: PublicKey | null;
  /** Token-2022 extension discriminants; `[]` for classic SPL mints. */
  extensions: number[];
  /** Both fee schedules (older/newer with activation epoch); `null` without the extension. */
  transferFeeConfig: TransferFeeConfig | null;
  /**
   * `TransferHook` extension body; `null` without the extension. A hook with
   * `programId === PublicKey.default` is DISARMED and adds no extra accounts.
   */
  transferHook: TransferHook | null;
  /** `Pausable` extension body; `null` without the extension. */
  pausableConfig: PausableConfig | null;
  /**
   * v6.1 (T1): `MetadataPointer` extension body; `null` without it. Every
   * LP mint created since v6.1 points at itself (in-mint metadata).
   */
  metadataPointer: MetadataPointer | null;
  /**
   * v6.1 (T1): in-mint `TokenMetadata` (name / symbol / uri / additional
   * pairs); `null` without the extension — a legacy SPL Token LP mint, or a
   * pool token that keeps its metadata elsewhere (Metaplex).
   */
  tokenMetadata: LpMetadata | null;
  scaledUiAmountConfig: ScaledUiAmountConfig | null;
  interestBearingConfig: InterestBearingConfig | null;
  defaultAccountState: { state: 1 | 2 } | null;
  permanentDelegate: { delegate: PublicKey } | null;
  /** Public transfers remain possible; this does not authorize confidential balances. */
  confidentialTransferMint: ConfidentialTransferMintConfig | null;
}

export function decodeMintAccount(data: Buffer): RawMintAccount {
  const extensions = parseMintExtensions(data);
  const mintAuthTag = data.readUInt32LE(0);
  if (mintAuthTag !== 0 && mintAuthTag !== 1) {
    throw new Error(`decodeMintAccount: invalid mint-authority option ${mintAuthTag}`);
  }
  const mintAuthority =
    mintAuthTag === 0 ? null : new PublicKey(data.slice(4, 36));
  const supply = new BN(data.slice(36, 44), "le");
  const decimals = data.readUInt8(44);
  const isInitialized = data.readUInt8(45) === 1;
  const freezeTag = data.readUInt32LE(46);
  if (freezeTag !== 0 && freezeTag !== 1) {
    throw new Error(`decodeMintAccount: invalid freeze-authority option ${freezeTag}`);
  }
  const freezeAuthority =
    freezeTag === 0 ? null : new PublicKey(data.slice(50, 82));

  // Extension bodies: `parseMintExtensions` already validated the TLV walk.
  const tlv = extensions.length > 0 ? data.subarray(MINT_TLV_OFFSET) : Buffer.alloc(0);
  const body = (type: ExtensionType, expectedLen: number): Buffer | null => {
    if (!extensions.includes(type)) return null;
    const bytes = getExtensionData(type, tlv);
    if (!bytes || bytes.length !== expectedLen) {
      throw new Error(`decodeMintAccount: extension ${type} has ${bytes?.length ?? 0} bytes, expected ${expectedLen}`);
    }
    return bytes;
  };
  const feeBytes = body(ExtensionType.TransferFeeConfig, TransferFeeConfigLayout.span);
  const transferFeeConfig = feeBytes ? TransferFeeConfigLayout.decode(feeBytes) : null;
  if (transferFeeConfig) {
    // `validate_mint` rejects schedules above 100 % as `InvalidMint`.
    for (const schedule of [transferFeeConfig.olderTransferFee, transferFeeConfig.newerTransferFee]) {
      if (schedule.transferFeeBasisPoints > MAX_FEE_BASIS_POINTS) {
        throw new Error(`decodeMintAccount: transfer fee ${schedule.transferFeeBasisPoints} bps exceeds 100 %`);
      }
    }
  }
  const hookBytes = body(ExtensionType.TransferHook, TransferHookLayout.span);
  const transferHook = hookBytes ? TransferHookLayout.decode(hookBytes) : null;
  const pausableBytes = body(ExtensionType.PausableConfig, PausableConfigLayout.span);
  if (pausableBytes && pausableBytes[32] > 1) {
    throw new Error("decodeMintAccount: non-canonical Pausable flag");
  }
  const pausableConfig = pausableBytes ? PausableConfigLayout.decode(pausableBytes) : null;
  const pointerBytes = body(ExtensionType.MetadataPointer, MetadataPointerLayout.span);
  const metadataPointer = pointerBytes ? MetadataPointerLayout.decode(pointerBytes) : null;
  const tokenMetadata = parseTokenMetadataExtension(extensions, tlv);

  const scaled = body(ExtensionType.ScaledUiAmountConfig, 56);
  const scaledUiAmountConfig: ScaledUiAmountConfig | null = scaled ? {
    authority: new PublicKey(scaled.subarray(0, 32)), multiplier: scaled.readDoubleLE(32),
    newMultiplierEffectiveTimestamp: scaled.readBigInt64LE(40), newMultiplier: scaled.readDoubleLE(48),
  } : null;
  if (scaledUiAmountConfig && [scaledUiAmountConfig.multiplier, scaledUiAmountConfig.newMultiplier].some(n => !Number.isFinite(n) || n < 2.2250738585072014e-308)) {
    throw new Error("decodeMintAccount: invalid ScaledUI multiplier");
  }
  const interest = body(ExtensionType.InterestBearingConfig, 52);
  const interestBearingConfig: InterestBearingConfig | null = interest ? {
    rateAuthority: new PublicKey(interest.subarray(0, 32)), initializationTimestamp: interest.readBigInt64LE(32),
    preUpdateAverageRate: interest.readInt16LE(40), lastUpdateTimestamp: interest.readBigInt64LE(42), currentRate: interest.readInt16LE(50),
  } : null;
  if (scaled && interest) throw new Error("InvalidExtensionCombination: InterestBearing and ScaledUI");
  const state = body(ExtensionType.DefaultAccountState, 1);
  if (state && state[0] !== 1 && state[0] !== 2) throw new Error("decodeMintAccount: invalid default account state");
  const defaultAccountState = state ? { state: state[0] as 1 | 2 } : null;
  const delegate = body(ExtensionType.PermanentDelegate, 32);
  const permanentDelegate = delegate ? { delegate: new PublicKey(delegate) } : null;
  const confidential = body(ExtensionType.ConfidentialTransferMint, 65);
  if (confidential && confidential[32] > 1) throw new Error("decodeMintAccount: invalid confidential auto-approval flag");
  const confidentialTransferMint = confidential ? {
    authority: new PublicKey(confidential.subarray(0, 32)), autoApproveNewAccounts: confidential[32] === 1,
    auditorElgamalPubkey: Uint8Array.from(confidential.subarray(33, 65)),
  } : null;
  return { mintAuthority, supply, decimals, isInitialized, freezeAuthority, extensions, transferFeeConfig, transferHook, pausableConfig, metadataPointer, tokenMetadata,
    scaledUiAmountConfig, interestBearingConfig, defaultAccountState, permanentDelegate, confidentialTransferMint };
}

/**
 * v6.1 (T1): decode the variable-length `TokenMetadata` TLV body (what
 * `getTokenMetadata` / Phantom / Solscan read). `null` without the extension.
 */
export function parseTokenMetadataExtension(extensions: number[], tlv: Buffer): LpMetadata | null {
  if (!extensions.includes(ExtensionType.TokenMetadata)) return null;
  const bytes = getExtensionData(ExtensionType.TokenMetadata, tlv);
  if (!bytes) return null;
  let meta: ReturnType<typeof unpackTokenMetadata>;
  try {
    meta = unpackTokenMetadata(bytes);
  } catch {
    // A malformed body (the extension is present but not a valid
    // `TokenMetadata` encoding) must not break pool sync: the mint is still
    // transferable; only its label is unreadable.
    return null;
  }
  return {
    name: meta.name,
    symbol: meta.symbol,
    uri: meta.uri,
    additionalMetadata: meta.additionalMetadata.map(([k, v]) => [k, v] as [string, string]),
    updateAuthority: meta.updateAuthority && !meta.updateAuthority.equals(PublicKey.default) ? meta.updateAuthority : null,
  };
}

/**
 * v6.1 (T1): the LP metadata of a decoded LP mint, or `null` for a legacy
 * SPL Token LP mint (pre-v6.1 pools) — show a synthetic label in that case.
 */
export function lpMetadataOf(mint: RawMintAccount): LpMetadata | null {
  return mint.tokenMetadata;
}

/** Mirrors STLD token_validation::validate_plain_zap_mint; underlying mints use a different policy. */
export function validatePlannedZapLpMint(address: PublicKey, owner: PublicKey, data: Buffer, pool: PublicKey): RawMintAccount {
  if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID)) throw new Error("InvalidMint: LP owner");
  if (owner.equals(TOKEN_PROGRAM_ID) && data.length !== 82) throw new Error("InvalidMint: extended SPL LP mint");
  const mint = validateTransferMintSnapshot(address, owner, data);
  if (!mint.mintAuthority?.equals(pool)) throw new Error("InvalidLpMint: mint authority must be pool");
  if (data.length === 82) return mint;
  if (mint.extensions.length !== 2 || !mint.extensions.includes(ExtensionType.MetadataPointer) || !mint.extensions.includes(ExtensionType.TokenMetadata) || !mint.metadataPointer?.metadataAddress?.equals(address)) throw new Error("ZapTokenExtensionsUnsupported: expected MetadataPointer to self + TokenMetadata only");
  if (!mint.tokenMetadata) throw new Error("InvalidMint: malformed TokenMetadata");
  return mint;
}

/** Exact mint TLV/body checks from coffer_pool::util::token, SPL Token-2022 8.0.1. */
export function validateTransferMintSnapshot(address: PublicKey, owner: PublicKey, data: Buffer): RawMintAccount {
  if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID)) throw new Error("InvalidMint: owner");
  if (owner.equals(TOKEN_PROGRAM_ID) && data.length !== 82) throw new Error("InvalidMint: SPL layout");
  if (owner.equals(TOKEN_2022_PROGRAM_ID) && address.equals(NATIVE_MINT_2022)) throw new Error("UnsupportedExtension: Token-2022 native mint");
  const mint = decodeMintAccount(data);
  const types = mint.extensions;
  const has = (t: number) => types.includes(t);
  const tlv = data.subarray(MINT_TLV_OFFSET);
  for (const type of types) {
    // JS SPL omits these Rust 8.0.1 mint extensions: POD sizes are explicit.
    const special = type === 16 ? 129 : type === 24 ? 196 : undefined;
    if (type > 27 || type === 9 || type === 13) throw new Error(`UnsupportedExtension: ${type}`);
    if (special === undefined && !isMintExtension(type)) throw new Error(`InvalidMint: account extension ${type}`);
    const body = getExtensionData(type, tlv);
    if (!body) throw new Error("InvalidMint: missing body");
    if (type === ExtensionType.TokenMetadata) validateMetadataBody(body);
    else if (body.length !== (special ?? getTypeLen(type))) throw new Error(`InvalidMint: extension ${type} length`);
    if (type === 6 && body[0] !== 1 && body[0] !== 2) throw new Error("InvalidMint: default state");
    if ((type === 4 || type === 26) && body[32] > 1) throw new Error("InvalidMint: noncanonical boolean");
  }
  if ((has(16) && !(has(1) && has(4))) || (has(1) && has(4) && !has(16)) || (has(24) && !has(4)) || (has(25) && has(10))) throw new Error("InvalidExtensionCombination");
  return mint;
}

function validateMetadataBody(body: Buffer): void {
  let offset = 64;
  const invalid = () => { throw new Error("InvalidMint: malformed TokenMetadata"); };
  const u32 = () => { if (offset + 4 > body.length) return invalid(); const n = body.readUInt32LE(offset); offset += 4; return n; };
  const string = () => { const n = u32(); if (n > body.length - offset) return invalid(); try { new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(offset, offset + n)); } catch { return invalid(); } offset += n; };
  if (body.length < 64) invalid();
  for (let i = 0; i < 3; i++) string();
  const pairs = u32(); if (pairs > Math.floor((body.length - offset) / 8)) invalid();
  for (let i = 0; i < pairs; i++) { string(); string(); }
  if (offset !== body.length) invalid();
}
