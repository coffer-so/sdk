import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { parseMintExtensions } from "../utils/extensions";

/**
 * SPL Token (or Token-2022) Mint parser. Reads the 82-byte base layout and,
 * for Token-2022 mints, the TLV extension list (discriminants only).
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
  return { mintAuthority, supply, decimals, isInitialized, freezeAuthority, extensions };
}
