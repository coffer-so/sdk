/** Finite source-derived cases; not a compiled-contract / SBF execution proof. */
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, NATIVE_MINT_2022 } from "@solana/spl-token";
import { pack } from "@solana/spl-token-metadata";
import { validatePlannedZapLpMint, validateTransferMintSnapshot } from "../src/parsers/mintAccount";
import { applyRescale } from "../src/math/concentrationFactor";
import { calculateExitPayout } from "../src/math/surgeBucket";
const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
function base(authority = key(1)) {
  const b = Buffer.alloc(82); b.writeUInt32LE(1); authority.toBuffer().copy(b, 4); b[45] = 1; b[44] = 9; return b;
}
function extended(parts: Array<[number, Buffer]>, authority = key(1)) {
  return Buffer.concat([base(authority), Buffer.alloc(83), Buffer.from([1]), ...parts.map(([type, bytes]) => { const h = Buffer.alloc(4); h.writeUInt16LE(type); h.writeUInt16LE(bytes.length, 2); return Buffer.concat([h, bytes]); })]);
}
function metadataMint(pointerTarget = key(2), extra: Array<[number, Buffer]> = []) {
  const pointer = Buffer.alloc(64); pointerTarget.toBuffer().copy(pointer, 32);
  const metadata = Buffer.from(pack({ mint: key(2), updateAuthority: PublicKey.default, name: "LP", symbol: "LP", uri: "https://x", additionalMetadata: [] }));
  return extended([[18, pointer], [19, metadata], ...extra]);
}
describe("STLD LP policy from token_validation.rs (epoch concentration-factor-20261102)", () => {
  test("accepts legacy plain owners and the exact self-pointing metadata pair, including zero padding", () => {
    for (const owner of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) expect(validatePlannedZapLpMint(key(2), owner, base(), key(1)).extensions).toEqual([]);
    for (const padding of [0, 1, 16]) expect(validatePlannedZapLpMint(key(2), TOKEN_2022_PROGRAM_ID, Buffer.concat([metadataMint(), Buffer.alloc(padding)]), key(1)).extensions).toEqual([18, 19]);
  });
  test("rejects foreign/missing authorities, foreign owners, foreign pointer and arbitrary LP extensions", () => {
    const missing = base(); missing.writeUInt32LE(0);
    for (const data of [base(key(3)), missing]) expect(() => validatePlannedZapLpMint(key(2), TOKEN_2022_PROGRAM_ID, data, key(1))).toThrow(/InvalidLpMint/);
    for (const owner of [key(9), TOKEN_PROGRAM_ID]) expect(() => validatePlannedZapLpMint(key(2), owner, metadataMint(), key(1))).toThrow(/InvalidMint/);
    for (const data of [metadataMint(key(4)), metadataMint(key(2), [[1, Buffer.alloc(108)]]), extended([[18, Buffer.alloc(64)]]), metadataMint(key(2), [[3, Buffer.alloc(32)]])]) expect(() => validatePlannedZapLpMint(key(2), TOKEN_2022_PROGRAM_ID, data, key(1))).toThrow(/ZapTokenExtensionsUnsupported/);
  });
  test("rejects duplicate/truncated TLVs, uninitialized base, invalid metadata UTF8 and trailing body bytes", () => {
    const pointer = Buffer.alloc(64); key(2).toBuffer().copy(pointer, 32);
    const valid = metadataMint(); const uninitialized = Buffer.from(valid); uninitialized[45] = 0;
    const utf8 = Buffer.from(pack({ mint: key(2), name: "X", symbol: "X", uri: "X", additionalMetadata: [] })); utf8[68] = 255;
    for (const data of [Buffer.concat([valid, Buffer.from([18,0,1])]), extended([[18,pointer],[18,pointer]]), uninitialized, extended([[18,pointer],[19,utf8]]), extended([[18,pointer],[19,Buffer.concat([utf8,Buffer.from([1])])]])]) expect(() => validatePlannedZapLpMint(key(2), TOKEN_2022_PROGRAM_ID, data, key(1))).toThrow();
  });
});

test("strict source extension combinations and body lengths", () => {
  for (const entries of [[[4, Buffer.alloc(65)], [24, Buffer.alloc(196)]], [[4, Buffer.alloc(65)], [1, Buffer.alloc(108)], [16, Buffer.alloc(129)]]] as Array<Array<[number, Buffer]>>) expect(() => validateTransferMintSnapshot(key(2), TOKEN_2022_PROGRAM_ID, extended(entries))).not.toThrow();
  for (const entries of [[[24, Buffer.alloc(196)]], [[16, Buffer.alloc(129)]], [[4, Buffer.alloc(65)], [1, Buffer.alloc(108)]], [[10, Buffer.alloc(52)], [25, Buffer.alloc(56)]], [[6, Buffer.from([0])]], [[8, Buffer.from([0])]], [[18, Buffer.alloc(63)]]] as Array<Array<[number, Buffer]>>) expect(() => validateTransferMintSnapshot(key(2), TOKEN_2022_PROGRAM_ID, extended(entries))).toThrow();
});

test("rescale returns an explicit projection without windows; complete rescale conservatively scales window pressure", () => {
  expect(applyRescale([1000n], [9n], 2n).scope).toBe("virtual_balance_projection");
  const windows = [{ previousSelloff: 11n, currentSelloff: 13n, windowStartTimestamp: 17n, selloffVbSnapshot: 1000n }];
  const result = applyRescale([1000n], [9n], 2n, [0], windows);
  expect(result.scope).toBe("complete_rescale");
  expect(result.windowsAfter).toEqual([{ previousSelloff: 22n, currentSelloff: 26n, windowStartTimestamp: 17n, selloffVbSnapshot: 2000n }]);
  expect(windows[0].selloffVbSnapshot).toBe(1000n);
  expect(() => applyRescale([1000n], [9n], 2n, [0], [{ ...windows[0], previousSelloff: (1n << 64n) - 1n }])).toThrow(/MathOverflow/);
  expect(() => applyRescale([1000n], [9n], 2n, [0], [])).toThrow(/InvalidArrayLength/);
});

test("source exit fee ceilings apply per bucket; below-floor supply remains redeemable; all-net-zero fails", () => {
  expect(() => calculateExitPayout([101n], [101n], 1n, 100n, 1)).toThrow(/WithdrawFeeConsumesAll/);
  const payout = calculateExitPayout([200n], [300n], 50n, 100n, 1);
  expect(payout.effective).toBe(50n);
  expect(payout.legs[0].transferAmount).toBe(248n);
  expect(calculateExitPayout([0n], [0n], 100n, 100n, 10000).legs[0].transferAmount).toBe(0n);
});


test("current source rejects Token-2022 native mint; rescale pressure overflow precedes post-invariant failure", () => {
  expect(() => validateTransferMintSnapshot(NATIVE_MINT_2022, TOKEN_2022_PROGRAM_ID, base())).toThrow(/Token-2022 native mint/);
  expect(() => applyRescale([1000n], [3000n], 2n, [0], [{ previousSelloff: (1n << 64n) - 1n, currentSelloff: 0n, windowStartTimestamp: 1n, selloffVbSnapshot: 1000n }])).toThrow(/MathOverflow/);
});
