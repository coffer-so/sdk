import BN from "bn.js";
import { NATIVE_MINT_2022, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PoolInfo, PoolTokenInfo } from "../types/pool";

/**
 * Token-2022 mint-extension policy (contracts `v6`).
 *
 * The v6 program moves every token with `transfer_checked`, nets Token-2022
 * transfer fees on both legs and forwards an explicit extra-account tail to
 * an armed transfer hook (plus the memo program for destinations that
 * require memos). The only mints it cannot pool are the ones that cannot
 * move at all — `NonTransferable` — the Token-2022 native mint, and mints
 * carrying an extension type newer than the program knows
 * (`util::token::validate_mint`, fail-closed). A `Pausable` mint is
 * accepted while it is NOT paused and refused by every transfer while it is
 * (`UnsupportedExtension`), so the SDK rejects an operation on a paused
 * token at quote/build time.
 *
 * There is no extension policy (v6.1, T19 removed the `banned_extensions`
 * bitmaps): PermanentDelegate, MintCloseAuthority, InterestBearing,
 * TransferFee, TransferHook, … may all be present on a pool's tokens. The
 * pool creator decides; this module's TLV parser is the data source for the
 * frontend's "token extensions in this pool" disclosure.
 *
 * The SDK inspects every pool token's mint on `sync()` and refuses to quote
 * or build a transaction that would move a token the program cannot
 * transfer. The refusal is a normal `SdkResult` error with code
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

/** Highest extension discriminant accepted by the v6 program (`MAX_KNOWN_EXTENSION`). */
export const MAX_KNOWN_MINT_EXTENSION = MintExtension.PausableAccount;

/**
 * Extensions the AMM can never move (`validate_tlv` rejects them
 * unconditionally). Transfer fees,
 * hooks, memo requirements and an unpaused `Pausable` mint are handled by
 * the v6 transfer path and are NOT in this list.
 */
export const HARD_UNSUPPORTED_MINT_EXTENSIONS: ReadonlyArray<MintExtension> = [
  MintExtension.NonTransferable, // cannot move at all
  MintExtension.NonTransferableAccount, // account-side marker of the same
];

/** Human-readable name for an extension discriminant. */
export function mintExtensionName(type: number): string {
  return MintExtension[type] ?? `Unknown(${type})`;
}

const MINT_BASE_LEN = 82;
const ACCOUNT_TYPE_OFFSET = 165; // base(82) + padding to token-account size(165)
const ACCOUNT_TYPE_MINT = 1;

/** Byte offset of the TLV extension area inside a Token-2022 mint account. */
export const MINT_TLV_OFFSET = ACCOUNT_TYPE_OFFSET + 1;

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
  let off = MINT_TLV_OFFSET;
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
 * Which of `extensions` the v6 program cannot transfer: everything in
 * {@link HARD_UNSUPPORTED_MINT_EXTENSIONS} and anything the program does not
 * know (> {@link MAX_KNOWN_MINT_EXTENSION}; it rejects unknown types
 * fail-closed because their transfer semantics are unknown).
 *
 * There is no extension *policy* any more (v6.1, T19): the pool creator alone
 * decides which mints go into a pool, and the frontend discloses the
 * extensions they carry (`parseMintExtensions` / `PoolTokenInfo.extensions`).
 * A paused `Pausable` mint is a RUNTIME condition reported through
 * `PoolTokenInfo.paused`, not through this list.
 */
export function unsupportedMintExtensions(extensions: number[]): number[] {
  return extensions.filter(
    (type) => HARD_UNSUPPORTED_MINT_EXTENSIONS.includes(type) || type > MAX_KNOWN_MINT_EXTENSION
  );
}

type TransferPolicyToken = Pick<PoolTokenInfo, "index" | "mint" | "unsupportedExtensions" | "metadata"> &
  Partial<Pick<PoolTokenInfo, "paused" | "tokenProgram" | "pinnedDecimalsMismatch">>;

/**
 * Why the v6 program would refuse to transfer this token right now, one
 * reason per entry; empty when the token is transferable. Covers the
 * hard-unsupported extensions, the Token-2022 native mint and a paused
 * mint. Issuer powers (fees, hooks, delegates) are not blockers.
 */
export function tokenTransferBlockers(t: TransferPolicyToken): string[] {
  const reasons: string[] = [];
  const unsupported = t.unsupportedExtensions ?? [];
  if (unsupported.length > 0) {
    reasons.push(`unsupported Token-2022 extension(s): ${unsupported.map(mintExtensionName).join(", ")}`);
  }
  if (t.paused) reasons.push("mint is paused (Pausable)");
  if (t.pinnedDecimalsMismatch) reasons.push("live mint decimals differ from the pool's pinned value (PinnedDecimalsMismatch)");
  if (t.mint.equals(NATIVE_MINT_2022) && (t.tokenProgram === undefined || t.tokenProgram.equals(TOKEN_2022_PROGRAM_ID))) {
    reasons.push("Token-2022 native mint cannot be pooled");
  }
  return reasons;
}

/** `true` when the program can move this token right now. */
export function isTokenTransferable(t: TransferPolicyToken): boolean {
  return tokenTransferBlockers(t).length === 0;
}

/** One-line description of why a token is refused, for error messages. */
export function describeUnsupportedToken(t: TransferPolicyToken): string {
  const sym = t.metadata?.symbol ?? t.mint.toBase58();
  return `token[${t.index}] ${sym}: ${tokenTransferBlockers(t).join("; ") || "transferable"}`;
}

/**
 * Throw if any of the given token indices (or every token when `indices` is
 * `"all"`) cannot be transferred by the program. Used by the low-level
 * instruction builders so that direct `build*Ix` callers get the same
 * protection as `CofferPoolClient` users.
 */
export function assertTokensSupported(pool: PoolInfo, indices: number[] | "all", op: string): void {
  const idx = indices === "all" ? pool.tokens.map((t) => t.index) : indices;
  const bad = idx
    .map((i) => pool.tokens[i])
    .filter((t): t is PoolTokenInfo => !!t && !isTokenTransferable(t));
  if (bad.length === 0) return;
  throw new Error(
    `${op}: the program cannot transfer this token with its current mint state. ` +
      bad.map(describeUnsupportedToken).join("; ")
  );
}
