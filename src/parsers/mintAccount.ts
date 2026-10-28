import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  ExtensionType,
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

  return { mintAuthority, supply, decimals, isInitialized, freezeAuthority, extensions, transferFeeConfig, transferHook, pausableConfig, metadataPointer, tokenMetadata };
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
