/**
 * T1 LP metadata: validation (shared fixture table), Borsh encoding, size
 * helpers, and reading the metadata back from a Token-2022 mint (vs a
 * legacy SPL Token LP mint).
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ExtensionType } from "@solana/spl-token";
import { pack as packTokenMetadata } from "@solana/spl-token-metadata";
import {
  validateLpMetadata, firstInvalidLpMetadataField, isValidLpName, isValidLpSymbol, isValidLpUri, encodeLpMetadataArgs, lpMetadataArgsSize,
  LP_METADATA_ARGS_MAX_SIZE, lpMintAccountSize, LP_MINT_BASE_SIZE, rentExemptLamports, defaultLpMetadata, fetchLpMetadata, decodeLpMintAccount,
  LP_METADATA_FIXTURES, LP_METADATA_GOOD, LP_METADATA_MAX, LP_METADATA_ERRORS, LP_DECIMALS, LP_TOKEN_PROGRAM_ID, byteLength,
} from "../src/utils/lpMetadata";
import { LP_NAME_MAX_LEN, LP_SYMBOL_MAX_LEN, LP_URI_MAX_LEN, LP_METADATA_POOL_KEY } from "../src/config";
import { lpMetadataOf, decodeMintAccount } from "../src/parsers/mintAccount";

const pk = (): PublicKey => Keypair.generate().publicKey;

/** Token-2022 mint image with MetadataPointer + TokenMetadata TLVs. */
function token2022LpMint(meta: { name: string; symbol: string; uri: string; pool: PublicKey; updateAuthority?: PublicKey }, mint: PublicKey, supply = 1_000_000_000n): Buffer {
  const base = Buffer.alloc(82);
  base.writeBigUInt64LE(supply, 36); base.writeUInt8(LP_DECIMALS, 44); base.writeUInt8(1, 45);
  const pointer = Buffer.concat([PublicKey.default.toBuffer(), mint.toBuffer()]);
  const body = Buffer.from(packTokenMetadata({
    updateAuthority: meta.updateAuthority ?? PublicKey.default, mint, name: meta.name, symbol: meta.symbol, uri: meta.uri,
    additionalMetadata: [[LP_METADATA_POOL_KEY, meta.pool.toBase58()]],
  }));
  const tlv = (type: number, b: Buffer) => { const h = Buffer.alloc(4); h.writeUInt16LE(type, 0); h.writeUInt16LE(b.length, 2); return Buffer.concat([h, b]); };
  return Buffer.concat([base, Buffer.alloc(83), Buffer.from([1]), tlv(ExtensionType.MetadataPointer, pointer), tlv(ExtensionType.TokenMetadata, body)]);
}
const splMint = (supply = 5n): Buffer => { const b = Buffer.alloc(82); b.writeBigUInt64LE(supply, 36); b.writeUInt8(9, 44); b.writeUInt8(1, 45); return b; };

describe("validation", () => {
  test("[P01] the shared fixture table (positive rows) validates", () => {
    const positives = LP_METADATA_FIXTURES.filter((f) => f[3] === null);
    expect(positives.length).toBeGreaterThanOrEqual(16);
    for (const [name, symbol, uri] of positives) expect(validateLpMetadata({ name, symbol, uri })).toEqual({ name, symbol, uri });
  });
  test("[P02] GOOD and MAX pass; MAX is exactly at the byte limits", () => {
    validateLpMetadata(LP_METADATA_GOOD); validateLpMetadata(LP_METADATA_MAX);
    expect(byteLength(LP_METADATA_MAX.name)).toBe(LP_NAME_MAX_LEN); expect(byteLength(LP_METADATA_MAX.symbol)).toBe(LP_SYMBOL_MAX_LEN); expect(byteLength(LP_METADATA_MAX.uri)).toBe(LP_URI_MAX_LEN);
  });
  test("[P03] multi-byte UTF-8 counts bytes, not code points", () => {
    expect(byteLength("é")).toBe(2); expect(isValidLpName("é".repeat(16))).toBe(true); expect(isValidLpName("é".repeat(17))).toBe(false);
  });
  test("[P04] every URI scheme is accepted; symbols allow [A-Za-z0-9._-]", () => {
    for (const u of ["https://a", "ipfs://Qm", "ar://x"]) expect(isValidLpUri(u)).toBe(true);
    expect(isValidLpSymbol("aZ09._-")).toBe(true);
  });
  test("[P05] defaultLpMetadata is always valid and sanitises the label", () => {
    for (const label of ["pool", 42, 123n, "weird label!!", "", "x".repeat(100)]) validateLpMetadata(defaultLpMetadata(label));
    expect(defaultLpMetadata("USDC/USDT").name).toBe("Coffer LP USDCUSDT");
    validateLpMetadata(defaultLpMetadata());
  });
  test("[N01] the shared fixture table (negative rows) reports the first invalid field", () => {
    const negatives = LP_METADATA_FIXTURES.filter((f) => f[3] !== null);
    expect(negatives.length).toBeGreaterThanOrEqual(20);
    for (const [name, symbol, uri, field] of negatives) {
      expect(firstInvalidLpMetadataField({ name, symbol, uri })).toBe(field);
      expect(() => validateLpMetadata({ name, symbol, uri })).toThrow(new RegExp(`${LP_METADATA_ERRORS[field!].name} ${LP_METADATA_ERRORS[field!].code}`));
    }
  });
  test("[N02] empty / oversize / whitespace / control bytes per field", () => {
    expect(isValidLpName("")).toBe(false); expect(isValidLpName("N".repeat(33))).toBe(false); expect(isValidLpName(" x")).toBe(false); expect(isValidLpName("x ")).toBe(false); expect(isValidLpName("a\u0000b")).toBe(false); expect(isValidLpName("a\tb")).toBe(false);
    expect(isValidLpSymbol("")).toBe(false); expect(isValidLpSymbol("S".repeat(11))).toBe(false); expect(isValidLpSymbol("c LP")).toBe(false); expect(isValidLpSymbol("cLP$")).toBe(false); expect(isValidLpSymbol("é")).toBe(false);
    expect(isValidLpUri("")).toBe(false); expect(isValidLpUri("http://x")).toBe(false); expect(isValidLpUri("https://")).toBe(false); expect(isValidLpUri("https://a b")).toBe(false); expect(isValidLpUri("https://" + "u".repeat(193))).toBe(false); expect(isValidLpUri("HTTPS://x")).toBe(false);
  });
  test("[N03] non-objects / missing fields are reported as `name`", () => {
    expect(firstInvalidLpMetadataField(null as any)).toBe("name");
    expect(firstInvalidLpMetadataField({} as any)).toBe("name");
    expect(firstInvalidLpMetadataField({ name: "ok" } as any)).toBe("symbol");
    expect(() => validateLpMetadata({ name: "ok", symbol: "ok", uri: undefined as any })).toThrow(/LpUriInvalid 6078/);
  });
  test("[N04] error codes are the program's", () => {
    expect(LP_METADATA_ERRORS).toEqual({ name: { name: "LpNameInvalid", code: 6076 }, symbol: { name: "LpSymbolInvalid", code: 6077 }, uri: { name: "LpUriInvalid", code: 6078 } });
  });
});

describe("encoding and sizes", () => {
  test("[P06] Borsh: three length-prefixed strings", () => {
    const b = encodeLpMetadataArgs({ name: "ab", symbol: "c", uri: "https://x" });
    expect(b.length).toBe(12 + 2 + 1 + 9);
    expect(b.readUInt32LE(0)).toBe(2); expect(b.subarray(4, 6).toString()).toBe("ab");
    expect(b.readUInt32LE(6)).toBe(1); expect(b[10]).toBe("c".charCodeAt(0));
    expect(b.readUInt32LE(11)).toBe(9); expect(b.subarray(15).toString()).toBe("https://x");
    expect(lpMetadataArgsSize({ name: "ab", symbol: "c", uri: "https://x" })).toBe(b.length);
  });
  test("[P07] UTF-8 bytes are what gets encoded", () => {
    const b = encodeLpMetadataArgs({ name: "é", symbol: "s", uri: "https://x" });
    expect(b.readUInt32LE(0)).toBe(2); expect(b.subarray(4, 6)).toEqual(Buffer.from([0xc3, 0xa9]));
  });
  test("[P08] the max size is 254 and matches LP_METADATA_MAX", () => {
    expect(LP_METADATA_ARGS_MAX_SIZE).toBe(254); expect(encodeLpMetadataArgs(LP_METADATA_MAX).length).toBe(254); expect(lpMetadataArgsSize(LP_METADATA_MAX)).toBe(254);
  });
  test("[P09] mint account size grows with the metadata; rent follows", () => {
    const pool = pk();
    const small = lpMintAccountSize({ name: "a", symbol: "b", uri: "https://x" }, pool), big = lpMintAccountSize(LP_METADATA_MAX, pool);
    expect(small).toBeGreaterThan(LP_MINT_BASE_SIZE); expect(big - small).toBe(254 - lpMetadataArgsSize({ name: "a", symbol: "b", uri: "https://x" }));
    expect(rentExemptLamports(big)).toBeGreaterThan(rentExemptLamports(small));
    expect(rentExemptLamports(0)).toBe((128 * 3480) * 2);
  });
  test("[P10] constants", () => { expect(LP_DECIMALS).toBe(9); expect(LP_TOKEN_PROGRAM_ID.equals(TOKEN_2022_PROGRAM_ID)).toBe(true); });
});

describe("fetchLpMetadata / decodeLpMintAccount", () => {
  const pool = pk(); const mint = pk();
  test("[P11] a Token-2022 LP mint yields its metadata, the ('pool', <pool>) pair, revoked authority, decimals and supply", () => {
    const info = { owner: TOKEN_2022_PROGRAM_ID, data: token2022LpMint({ ...LP_METADATA_GOOD, pool }, mint, 123n) };
    const r = decodeLpMintAccount(info);
    expect(r.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)).toBe(true); expect(r.decimals).toBe(9); expect(r.supply).toBe(123n);
    expect(r.metadata).toEqual({ ...LP_METADATA_GOOD, additionalMetadata: [[LP_METADATA_POOL_KEY, pool.toBase58()]], updateAuthority: null });
  });
  test("[P12] fetchLpMetadata goes through the reader with the commitment", async () => {
    const calls: unknown[] = [];
    const conn = { getAccountInfo: async (a: PublicKey, c?: string) => { calls.push([a.toBase58(), c]); return { owner: TOKEN_2022_PROGRAM_ID, data: token2022LpMint({ ...LP_METADATA_MAX, pool }, mint), executable: false, lamports: 1 }; } };
    const r = await fetchLpMetadata(conn, mint, "finalized");
    expect(calls).toEqual([[mint.toBase58(), "finalized"]]); expect(r.metadata?.name).toBe(LP_METADATA_MAX.name); expect(r.metadata?.uri.length).toBe(LP_URI_MAX_LEN);
  });
  test("[P13] a legacy SPL Token LP mint yields null metadata and its program", () => {
    const r = decodeLpMintAccount({ owner: TOKEN_PROGRAM_ID, data: splMint(5n) });
    expect(r.metadata).toBeNull(); expect(r.tokenProgram.equals(TOKEN_PROGRAM_ID)).toBe(true); expect(r.supply).toBe(5n);
  });
  test("[P14] a Token-2022 mint WITHOUT the extension yields null metadata; an unrevoked authority is surfaced", () => {
    const base = splMint(1n);
    expect(decodeLpMintAccount({ owner: TOKEN_2022_PROGRAM_ID, data: base }).metadata).toBeNull();
    const auth = pk();
    expect(decodeLpMintAccount({ owner: TOKEN_2022_PROGRAM_ID, data: token2022LpMint({ ...LP_METADATA_GOOD, pool, updateAuthority: auth }, mint) }).metadata?.updateAuthority?.equals(auth)).toBe(true);
  });
  test("[P15] lpMetadataOf reads the same thing from a raw buffer", () => {
    const m = lpMetadataOf(decodeMintAccount(token2022LpMint({ ...LP_METADATA_GOOD, pool }, mint)));
    expect(m?.symbol).toBe(LP_METADATA_GOOD.symbol);
    expect(lpMetadataOf(decodeMintAccount(splMint()))).toBeNull();
  });
  test("[N05] missing account / non-token owner / garbage data", async () => {
    await expect(fetchLpMetadata({ getAccountInfo: async () => null }, mint)).rejects.toThrow(/does not exist/);
    expect(() => decodeLpMintAccount({ owner: pk(), data: splMint() })).toThrow(/not a token program/);
    expect(() => decodeLpMintAccount({ owner: TOKEN_2022_PROGRAM_ID, data: Buffer.alloc(10) })).toThrow();
  });
  test("[N06] a malformed TokenMetadata TLV body does not throw — metadata is null", () => {
    const base = splMint(1n);
    const h = Buffer.alloc(4); h.writeUInt16LE(ExtensionType.TokenMetadata, 0); h.writeUInt16LE(5, 2);
    const data = Buffer.concat([base, Buffer.alloc(83), Buffer.from([1]), h, Buffer.from([1, 2, 3, 4, 5])]);
    expect(decodeLpMintAccount({ owner: TOKEN_2022_PROGRAM_ID, data }).metadata).toBeNull();
  });
});
