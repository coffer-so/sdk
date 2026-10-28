/**
 * lpMetadata — client-side mirror of `coffer_pool::util::lp_metadata`
 * (v6.1, T1): the `LpMetadataArgs` argument of `initialize_pool`, its
 * validation rules, its Borsh encoding, the on-chain limits and the shared
 * accept/reject fixture table. Port of `contracts/scripts/cli/lp-metadata.ts`
 * + `lp-metadata-fixtures.ts`; the rules must match the program
 * byte-for-byte (the fixture table is what both sides are checked against).
 *
 * Every pool created since v6.1 gets a Token-2022 LP mint carrying the three
 * fields as immutable in-mint `TokenMetadata` plus the pair
 * `("pool", <pool pubkey>)`. Decimals are always 9 and are not an input.
 *
 * LP reads/writes must resolve the token program from the MINT OWNER
 * (`PoolInfo.lpTokenProgram`, `fetchLpMetadata`), never assume one: pools
 * created before v6.1 keep a classic SPL Token LP mint without metadata.
 */

import { Connection, PublicKey, type AccountInfo, type Commitment } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  LP_METADATA_POOL_KEY,
  LP_NAME_MAX_LEN,
  LP_SYMBOL_MAX_LEN,
  LP_URI_MAX_LEN,
} from "../config";
import { decodeMintAccount } from "../parsers/mintAccount";
import type { LpMetadata } from "../types/pool";
import type { LpMetadataArgs, LpMetadataField } from "../types/tx-v61";


/** Accepted URI schemes (exact, case-sensitive). */
export const LP_URI_SCHEMES = ["https://", "ipfs://", "ar://"] as const;
/** LP token decimals — pinned on-chain, never an argument. */
export { LP_DECIMALS } from "../config";
/** Every LP mint created since v6.1 is owned by Token-2022. */
export const LP_TOKEN_PROGRAM_ID = TOKEN_2022_PROGRAM_ID;

/** Program error names (and codes) raised by `validate_lp_metadata`. */
export const LP_METADATA_ERRORS: Record<LpMetadataField, { name: string; code: number }> = {
  name: { name: "LpNameInvalid", code: 6076 },
  symbol: { name: "LpSymbolInvalid", code: 6077 },
  uri: { name: "LpUriInvalid", code: 6078 },
};

const utf8 = new TextEncoder();
export function byteLength(s: string): number {
  return utf8.encode(s).length;
}

function hasControlByte(s: string): boolean {
  for (const b of utf8.encode(s)) if (b < 0x20 || b === 0x7f) return true;
  return false;
}

/**
 * Unicode `White_Space` exactly as Rust's `str::trim` / `char::is_whitespace`
 * see it (the on-chain validator uses those). Built from code points so the
 * source stays ASCII.
 */
const WS_CODEPOINTS = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
];
const WS_CLASS = "[" + WS_CODEPOINTS.map((c) => "\\u{" + c.toString(16) + "}").join("") + "]";
const UNICODE_WS = new RegExp(WS_CLASS, "u");
const UNICODE_TRIM = new RegExp("^" + WS_CLASS + "+|" + WS_CLASS + "+$", "gu");
function trimUnicode(s: string): string {
  return s.replace(UNICODE_TRIM, "");
}

export function isValidLpName(name: string): boolean {
  if (typeof name !== "string") return false;
  const len = byteLength(name);
  return len >= 1 && len <= LP_NAME_MAX_LEN && !hasControlByte(name) && trimUnicode(name) === name;
}

export function isValidLpSymbol(symbol: string): boolean {
  if (typeof symbol !== "string") return false;
  return symbol.length >= 1 && symbol.length <= LP_SYMBOL_MAX_LEN && /^[A-Za-z0-9._-]+$/.test(symbol);
}

export function isValidLpUri(uri: string): boolean {
  if (typeof uri !== "string") return false;
  const len = byteLength(uri);
  if (len < 1 || len > LP_URI_MAX_LEN || hasControlByte(uri) || UNICODE_WS.test(uri)) return false;
  return LP_URI_SCHEMES.some((scheme) => uri.length > scheme.length && uri.startsWith(scheme));
}

/**
 * Returns the first invalid field (same order as the program: name, symbol,
 * uri) or `null` when the program would accept the arguments.
 */
export function firstInvalidLpMetadataField(args: LpMetadataArgs): LpMetadataField | null {
  if (!args || typeof args !== "object") return "name";
  if (!isValidLpName(args.name)) return "name";
  if (!isValidLpSymbol(args.symbol)) return "symbol";
  if (!isValidLpUri(args.uri)) return "uri";
  return null;
}

/** Throws a descriptive error mirroring the on-chain rejection; returns the args otherwise. */
export function validateLpMetadata(args: LpMetadataArgs): LpMetadataArgs {
  const field = firstInvalidLpMetadataField(args);
  if (field === null) return args;
  const rules: Record<LpMetadataField, string> = {
    name: `1..=${LP_NAME_MAX_LEN} bytes of printable UTF-8, no leading/trailing whitespace`,
    symbol: `1..=${LP_SYMBOL_MAX_LEN} bytes of [A-Za-z0-9._-]`,
    uri: `1..=${LP_URI_MAX_LEN} bytes, ${LP_URI_SCHEMES.join(" | ")}, no whitespace`,
  };
  throw new Error(
    `LP metadata ${field} invalid (${LP_METADATA_ERRORS[field].name} ${LP_METADATA_ERRORS[field].code}): ${rules[field]}`,
  );
}

/** Borsh `LpMetadataArgs`: three `String`s (u32 LE length + UTF-8 bytes). */
export function encodeLpMetadataArgs(args: LpMetadataArgs): Buffer {
  const parts = [args.name, args.symbol, args.uri].map((s) => Buffer.from(s, "utf8"));
  const buf = Buffer.alloc(parts.reduce((a, p) => a + 4 + p.length, 0));
  let o = 0;
  for (const p of parts) {
    buf.writeUInt32LE(p.length, o);
    o += 4;
    p.copy(buf, o);
    o += p.length;
  }
  return buf;
}

/** Wire size of the Borsh encoding (15 B minimum, 254 B at the limits). */
export function lpMetadataArgsSize(args: LpMetadataArgs): number {
  return 12 + byteLength(args.name) + byteLength(args.symbol) + byteLength(args.uri);
}
export const LP_METADATA_ARGS_MAX_SIZE = 12 + LP_NAME_MAX_LEN + LP_SYMBOL_MAX_LEN + LP_URI_MAX_LEN;

/**
 * Final LP mint account size: base Token-2022 mint + account type (166) +
 * `MetadataPointer` TLV (4 + 64) + `TokenMetadata` TLV (4 + Borsh body with
 * the `("pool", <pool base58>)` pair). Rent is `(size + 128) × 6960`
 * lamports at the default rate.
 */
export function lpMintAccountSize(args: LpMetadataArgs, pool: PublicKey): number {
  const body =
    32 + 32 +
    (4 + byteLength(args.name)) + (4 + byteLength(args.symbol)) + (4 + byteLength(args.uri)) +
    4 + (4 + LP_METADATA_POOL_KEY.length) + (4 + pool.toBase58().length);
  return 166 + (4 + 64) + (4 + body);
}
/** Anchor's allocation before the handler grows the mint. */
export const LP_MINT_BASE_SIZE = 234;
export function rentExemptLamports(size: number, lamportsPerByteYear = 3480, years = 2): number {
  return (size + 128) * lamportsPerByteYear * years;
}

/**
 * Test / tooling default. Production deployers (frontend, CLI) MUST pass an
 * explicit creator-chosen value — these strings are immutable once the pool
 * exists.
 */
export function defaultLpMetadata(label: string | number | bigint = "pool"): LpMetadataArgs {
  const tag = String(label).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 20) || "pool";
  return {
    name: `Coffer LP ${tag}`.slice(0, LP_NAME_MAX_LEN).trimEnd(),
    symbol: "cLP",
    uri: `https://coffer.so/lp/${tag}.json`.slice(0, LP_URI_MAX_LEN),
  };
}

// ─── Shared fixture table (contracts/scripts/cli/lp-metadata-fixtures.ts) ────

export const LP_METADATA_GOOD: LpMetadataArgs = { name: "USDC-USDT Coffer LP", symbol: "cLP-USDX", uri: "https://arweave.net/abc123" };
export const LP_METADATA_MAX: LpMetadataArgs = {
  name: "N".repeat(LP_NAME_MAX_LEN), symbol: "S".repeat(LP_SYMBOL_MAX_LEN),
  uri: "https://" + "u".repeat(LP_URI_MAX_LEN - 8),
};
const GOOD = LP_METADATA_GOOD;
const MAX = LP_METADATA_MAX;
const cp = (c: number) => String.fromCodePoint(c);

/** `[name, symbol, uri, expected first invalid field | null]` — mirrors the Rust cases. */
export const LP_METADATA_FIXTURES: Array<[string, string, string, LpMetadataField | null]> = [
  // positive
  [MAX.name, MAX.symbol, MAX.uri, null],
  ["A", "a", "https://x", null],
  ["1", "1", "ipfs://Q", null],
  ["-", "-", "ar://a", null],
  ["Caf" + cp(0xe9) + " LP", "cLP", GOOD.uri, null],
  [cp(0x41f) + cp(0x443) + cp(0x43b) + " LP", "cLP", GOOD.uri, null],
  [cp(0xe9).repeat(8) + "x".repeat(16), "cLP", GOOD.uri, null],
  [GOOD.name, "aZ09._-", GOOD.uri, null],
  [GOOD.name, "cLP-A.B_C", GOOD.uri, null],
  ["USDC / USDT  Coffer LP", "cLP", GOOD.uri, null],
  ["LP #1 (v6.1) [stable]", "cLP", GOOD.uri, null],
  [GOOD.name, GOOD.symbol, "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", null],
  [GOOD.name, GOOD.symbol, "ar://tx-id_with.dots", null],
  [GOOD.name, GOOD.symbol, "https://gateway.irys.xyz/abc?ext=json&v=1#frag", null],
  [GOOD.name, "cLP-USDCX1", GOOD.uri, null],
  ["USDC" + cp(0x200d) + "LP", GOOD.symbol, GOOD.uri, null], // ZWJ is not a control byte (documented)
  // negative: name
  ["N".repeat(33), GOOD.symbol, GOOD.uri, "name"],
  [cp(0xe9).repeat(11) + "x".repeat(11), GOOD.symbol, GOOD.uri, "name"],
  ["", GOOD.symbol, GOOD.uri, "name"],
  [" ", GOOD.symbol, GOOD.uri, "name"],
  ["USDC\0LP", GOOD.symbol, GOOD.uri, "name"],
  ["USDC\nLP", GOOD.symbol, GOOD.uri, "name"],
  ["USDC\tLP", GOOD.symbol, GOOD.uri, "name"],
  ["USDC\x7fLP", GOOD.symbol, GOOD.uri, "name"],
  [" USDC LP", GOOD.symbol, GOOD.uri, "name"],
  ["USDC LP ", GOOD.symbol, GOOD.uri, "name"],
  ["USDC LP" + cp(0xa0), GOOD.symbol, GOOD.uri, "name"],
  [cp(0x3000) + "USDC LP", GOOD.symbol, GOOD.uri, "name"],
  ["N".repeat(32) + " ", GOOD.symbol, GOOD.uri, "name"],
  // negative: symbol
  [GOOD.name, "S".repeat(11), GOOD.uri, "symbol"],
  [GOOD.name, "", GOOD.uri, "symbol"],
  [GOOD.name, "c LP", GOOD.uri, "symbol"],
  [GOOD.name, " cLP", GOOD.uri, "symbol"],
  [GOOD.name, "cLP\0", GOOD.uri, "symbol"],
  [GOOD.name, "$LP", GOOD.uri, "symbol"],
  [GOOD.name, "LP/USD", GOOD.uri, "symbol"],
  [GOOD.name, cp(0x1fa99), GOOD.uri, "symbol"],
  [GOOD.name, cp(0x441) + "LP", GOOD.uri, "symbol"],
  [GOOD.name, cp(0xff2c) + cp(0xff30), GOOD.uri, "symbol"],
  // negative: uri
  [GOOD.name, GOOD.symbol, "https://" + "u".repeat(193), "uri"],
  [GOOD.name, GOOD.symbol, "", "uri"],
  [GOOD.name, GOOD.symbol, "http://example.com/x.json", "uri"],
  [GOOD.name, GOOD.symbol, "javascript:alert(1)", "uri"],
  [GOOD.name, GOOD.symbol, "data:application/json;base64,e30=", "uri"],
  [GOOD.name, GOOD.symbol, "ftp://example.com/x", "uri"],
  [GOOD.name, GOOD.symbol, "HTTPS://example.com/x", "uri"],
  [GOOD.name, GOOD.symbol, "ipfs:/Qm", "uri"],
  [GOOD.name, GOOD.symbol, " https://example.com/x", "uri"],
  [GOOD.name, GOOD.symbol, "https://", "uri"],
  [GOOD.name, GOOD.symbol, "ipfs://", "uri"],
  [GOOD.name, GOOD.symbol, "ar://", "uri"],
  [GOOD.name, GOOD.symbol, "https://example.com/a b.json", "uri"],
  [GOOD.name, GOOD.symbol, "https://example.com/x.json ", "uri"],
  [GOOD.name, GOOD.symbol, "https://example.com/x\t.json", "uri"],
  [GOOD.name, GOOD.symbol, "https://example.com/x" + cp(0xa0) + "y", "uri"],
  [GOOD.name, GOOD.symbol, "https://example.com/x" + cp(0x2028) + "y", "uri"],
  [GOOD.name, GOOD.symbol, "https://example.com/x\0.json", "uri"],
  // first failing field wins
  ["", "", "", "name"],
  [GOOD.name, "bad sym", "http://x", "symbol"],
  [GOOD.name, GOOD.symbol, "http://x", "uri"],
];

// ─── On-chain read ───────────────────────────────────────────────────────────

/** The subset of `Connection` `fetchLpMetadata` uses (lets tests stub it). */
export interface MintAccountReader {
  getAccountInfo(address: PublicKey, commitment?: Commitment): Promise<AccountInfo<Buffer> | null>;
}

/** What `fetchLpMetadata` returns: the metadata plus the program that owns the mint. */
export interface FetchedLpMetadata {
  /** `null` for a legacy SPL Token LP mint (pre-v6.1 pools) — show a synthetic label. */
  metadata: LpMetadata | null;
  /** Owner of the mint account (SPL Token or Token-2022); use it for every LP ATA / transfer. */
  tokenProgram: PublicKey;
  decimals: number;
  supply: bigint;
}

/**
 * Read an LP mint's in-mint metadata. Resolves the token program from the
 * account OWNER (never assumed): a Token-2022 mint yields its `TokenMetadata`
 * (or `null` when the extension is absent), a classic SPL Token mint yields
 * `null`. Throws when the account is missing or is not a token mint.
 */
export async function fetchLpMetadata(connection: MintAccountReader | Connection, lpMint: PublicKey, commitment: Commitment = "confirmed"): Promise<FetchedLpMetadata> {
  const info = await connection.getAccountInfo(lpMint, commitment);
  if (!info) throw new Error(`LP mint ${lpMint.toBase58()} does not exist`);
  return decodeLpMintAccount(info);
}

/** Pure half of `fetchLpMetadata`: decode a fetched mint account. */
export function decodeLpMintAccount(info: Pick<AccountInfo<Buffer>, "owner" | "data">): FetchedLpMetadata {
  const owner = info.owner;
  if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(`account is owned by ${owner.toBase58()}, not a token program`);
  }
  const mint = decodeMintAccount(info.data);
  return {
    metadata: owner.equals(TOKEN_2022_PROGRAM_ID) ? mint.tokenMetadata : null,
    tokenProgram: owner,
    decimals: mint.decimals,
    supply: BigInt(mint.supply.toString()),
  };
}
