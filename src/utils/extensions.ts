import BN from "bn.js";
import { PoolInfo, PoolTokenInfo } from "../types/pool";

/**
 * Token-2022 mint-extension policy.
 *
 * The cubic-pool program moves tokens with the plain SPL `Transfer`
 * instruction (no `transfer_checked`, no fee accounting). Token-2022 refuses
 * a plain `Transfer` for mints that carry a transfer fee, transfer hook or
 * pausable extension,
 * and a `NonTransferable` mint cannot move at all — so any pool operation
 * that touches such a token reverts inside the token program
 * (`MintRequiredForTransfer`, error 0x1f), after the user has already paid
 * for the transaction.
 *
 * The SDK therefore inspects every pool token's mint on `sync()` and refuses
 * to quote or build a transaction that would move a token with an
 * unsupported extension. The refusal is a normal `SdkResult` error with code
 * `unsupported_token_extension` (or a thrown `Error` from the low-level
 * `build*Ix` helpers).
 */

/** Token-2022 `ExtensionType` discriminants (u16, little-endian on the wire). */
export enum MintExtension {
  Uninitialized = 0,
  TransferFeeConfig = 1,
  TransferFeeAmount = 2,
  MintCloseAuthority = 3,
  ConfidentialTransferMint = 4,
  ConfidentialTransferAccount = 5,
  DefaultAccountState = 6,
  ImmutableOwner = 7,
  MemoTransfer = 8,
  NonTransferable = 9,
  InterestBearingConfig = 10,
  CpiGuard = 11,
  PermanentDelegate = 12,
  NonTransferableAccount = 13,
  TransferHook = 14,
  TransferHookAccount = 15,
  ConfidentialTransferFeeConfig = 16,
  ConfidentialTransferFeeAmount = 17,
  MetadataPointer = 18,
  TokenMetadata = 19,
  GroupPointer = 20,
  TokenGroup = 21,
  GroupMemberPointer = 22,
  TokenGroupMember = 23,
  ConfidentialMintBurn = 24,
  ScaledUiAmountConfig = 25,
  PausableConfig = 26,
  PausableAccount = 27,
  PermissionedBurn = 28,
}

/** Highest extension discriminant accepted by the deployed cubic-pool program. */
export const MAX_KNOWN_MINT_EXTENSION = MintExtension.PausableAccount;

/**
 * Extensions the AMM can never move, whatever the pool's `banned_extensions`
 * policy says. This is a transfer-capability check, not the mint-creation
 * policy: even an inert TransferHook needs a mint account for plain Transfer.
 */
export const HARD_UNSUPPORTED_MINT_EXTENSIONS: ReadonlyArray<MintExtension> = [
  MintExtension.TransferFeeConfig, // Token-2022 rejects plain Transfer (needs transfer_checked_with_fee)
  MintExtension.TransferHook, // Token-2022 rejects plain Transfer (needs transfer_checked + hook accounts)
  MintExtension.NonTransferable, // cannot move at all
  MintExtension.ConfidentialTransferFeeConfig, // implies a transfer fee
  MintExtension.PausableConfig, // Token-2022 needs the mint to check the pause state
];

/**
 * `DEFAULT_BANNED_EXTENSIONS` from `cubic-pool/constants.rs`: the bitmap a
 * fresh `CubicPoolConfig` starts with. Exposed so consumers can render the
 * policy; the per-pool effective bitmap is `PoolInfo.bannedExtensions`.
 */
export const DEFAULT_BANNED_EXTENSIONS: bigint =
  (1n << BigInt(MintExtension.TransferFeeConfig)) |
  (1n << BigInt(MintExtension.MintCloseAuthority)) |
  (1n << BigInt(MintExtension.InterestBearingConfig)) |
  (1n << BigInt(MintExtension.PermanentDelegate)) |
  (1n << BigInt(MintExtension.TransferHook)) |
  (1n << BigInt(MintExtension.ScaledUiAmountConfig)) |
  (1n << BigInt(MintExtension.PausableConfig));

/** Human-readable name for an extension discriminant. */
export function mintExtensionName(type: number): string {
  return MintExtension[type] ?? `Unknown(${type})`;
}

const MINT_BASE_LEN = 82;
const ACCOUNT_TYPE_OFFSET = 165; // base(82) + padding to token-account size(165)
const ACCOUNT_TYPE_MINT = 1;

/**
 * Parse the TLV extension list of a Token-2022 mint. Returns `[]` for a
 * classic SPL Token mint (82 bytes) or a Token-2022 mint with no
 * extensions. Rejects uninitialized mints, invalid mint layouts and malformed
 * TLV data. Pool policy and transfer capability are classified separately.
 */
export function parseMintExtensions(data: Buffer | Uint8Array): number[] {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length !== MINT_BASE_LEN && buf.length <= ACCOUNT_TYPE_OFFSET) {
    throw new Error(`parseMintExtensions: invalid mint length ${buf.length}`);
  }
  if (buf[45] !== 1) {
    throw new Error("parseMintExtensions: mint is not initialized");
  }
  if (buf.length === MINT_BASE_LEN) return [];
  if (buf[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_MINT) {
    throw new Error(
      `parseMintExtensions: account type byte is ${buf[ACCOUNT_TYPE_OFFSET]}, expected ${ACCOUNT_TYPE_MINT} (Mint)`
    );
  }
  const out: number[] = [];
  let off = ACCOUNT_TYPE_OFFSET + 1;
  while (off + 4 <= buf.length) {
    const type = buf.readUInt16LE(off);
    const len = buf.readUInt16LE(off + 2);
    if (type === MintExtension.Uninitialized) {
      if (buf.subarray(off).some((byte) => byte !== 0)) {
        throw new Error("parseMintExtensions: nonzero data in uninitialized TLV tail");
      }
      return out;
    }
    off += 4;
    if (off + len > buf.length) {
      throw new Error(`parseMintExtensions: extension ${type} claims ${len} bytes past end of account`);
    }
    if (out.includes(type)) {
      throw new Error(`parseMintExtensions: duplicate extension ${type}`);
    }
    out.push(type);
    off += len;
  }
  if (buf.subarray(off).some((byte) => byte !== 0)) {
    throw new Error("parseMintExtensions: incomplete TLV header");
  }
  return out;
}

/**
 * Which of `extensions` the AMM cannot transfer: everything in
 * {@link HARD_UNSUPPORTED_MINT_EXTENSIONS}, anything the program does not
 * know (> {@link MAX_KNOWN_MINT_EXTENSION}; the program rejects unknown
 * types at creation and the SDK cannot assume their transfer semantics).
 *
 * `banned_extensions` is a snapshot of creation policy, not a runtime transfer
 * restriction. The optional second argument is retained for compatibility
 * but does not change this result. Use `bannedMintExtensions` for diagnostics.
 */
export function unsupportedMintExtensions(extensions: number[], _bannedExtensions?: BN | bigint): number[] {
  return extensions.filter(
    (type) => HARD_UNSUPPORTED_MINT_EXTENSIONS.includes(type) || type > MAX_KNOWN_MINT_EXTENSION
  );
}

/** Extensions covered by a creation-policy bitmap; does not imply transfer failure. */
export function bannedMintExtensions(extensions: number[], bannedExtensions?: BN | bigint): number[] {
  const banned =
    bannedExtensions === undefined
      ? 0n
      : typeof bannedExtensions === "bigint"
        ? bannedExtensions
        : BigInt(bannedExtensions.toString());
  if (banned < 0n || banned > 0xffff_ffff_ffff_ffffn) {
    throw new Error("bannedMintExtensions: bitmap must fit u64");
  }
  return extensions.filter((type) => type >= 0 && type < 64 && ((banned >> BigInt(type)) & 1n) === 1n);
}

/** One-line description of why a token is refused, for error messages. */
export function describeUnsupportedToken(t: Pick<PoolTokenInfo, "index" | "mint" | "unsupportedExtensions" | "metadata">): string {
  const sym = t.metadata?.symbol ?? t.mint.toBase58();
  return `token[${t.index}] ${sym} has unsupported Token-2022 extension(s): ${(t.unsupportedExtensions ?? [])
    .map(mintExtensionName)
    .join(", ")}`;
}

/**
 * Throw if any of the given token indices (or every token when `indices` is
 * `"all"`) carries an unsupported extension. Used by the low-level
 * instruction builders so that direct `build*Ix` callers get the same
 * protection as `CubicPoolClient` users.
 */
export function assertTokensSupported(pool: PoolInfo, indices: number[] | "all", op: string): void {
  const idx = indices === "all" ? pool.tokens.map((t) => t.index) : indices;
  const bad = idx
    .map((i) => pool.tokens[i])
    .filter((t): t is PoolTokenInfo => !!t && (t.unsupportedExtensions?.length ?? 0) > 0);
  if (bad.length === 0) return;
  throw new Error(
    `${op}: unsupported Token-2022 extension for this program's transfer instructions. ` +
      bad.map(describeUnsupportedToken).join("; ")
  );
}
