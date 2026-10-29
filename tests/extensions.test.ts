import { Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT_2022, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import {
  CofferPoolClient,
  getConfig,
  MintExtension,
  parseMintExtensions,
  unsupportedMintExtensions,
  MAX_KNOWN_MINT_EXTENSION,
  decodeMintAccount,
  buildSwapIx,
  buildAddLiquidityIx,
  HARD_UNSUPPORTED_MINT_EXTENSIONS,
  tokenTransferBlockers,
  isTokenTransferable,
} from "../src";
import { PoolInfo } from "../src/types/pool";

const pk = (): PublicKey => Keypair.generate().publicKey;

/** Build a Token-2022 mint account image with the given TLV extensions. */
function mintWith(exts: Array<[number, number]>): Buffer {
  const base = Buffer.alloc(82);
  base.writeUInt8(6, 44); // decimals
  base.writeUInt8(1, 45); // initialized
  if (exts.length === 0) return base;
  const tlv = Buffer.concat(
    exts.map(([type, len]) => {
      const b = Buffer.alloc(4 + len);
      b.writeUInt16LE(type, 0);
      b.writeUInt16LE(len, 2);
      return b;
    })
  );
  return Buffer.concat([base, Buffer.alloc(83), Buffer.from([1]), tlv, Buffer.alloc(8)]);
}

describe("parseMintExtensions", () => {
  test("classic 82-byte mint has no extensions", () => {
    expect(parseMintExtensions(mintWith([]))).toEqual([]);
    expect(decodeMintAccount(mintWith([])).extensions).toEqual([]);
  });

  test("reads every TLV entry and stops at zero padding", () => {
    const data = mintWith([
      [MintExtension.MetadataPointer, 64],
      [MintExtension.TransferFeeConfig, 108],
      [MintExtension.TokenMetadata, 20],
    ]);
    expect(parseMintExtensions(data)).toEqual([18, 1, 19]);
    expect(decodeMintAccount(data).decimals).toBe(6);
  });

  test("rejects a non-mint account type byte", () => {
    const data = mintWith([[MintExtension.MetadataPointer, 64]]);
    data[165] = 2; // Account
    expect(() => parseMintExtensions(data)).toThrow(/account type/);
  });

  test.each([0, 81, 83, 100, 164, 165])("rejects invalid mint length %i", (length) => {
    const data = Buffer.alloc(length);
    if (length > 45) data[45] = 1;
    expect(() => parseMintExtensions(data)).toThrow(/mint length/);
    expect(() => decodeMintAccount(data)).toThrow(/mint length/);
  });

  test.each([0, 2, 255])("rejects initialized flag %i", (initialized) => {
    const data = mintWith([]);
    data[45] = initialized;
    expect(() => decodeMintAccount(data)).toThrow(/not initialized/);
  });

  test("accepts an extended mint with an empty TLV area", () => {
    const data = Buffer.concat([mintWith([]), Buffer.alloc(83), Buffer.from([1])]);
    expect(decodeMintAccount(data).extensions).toEqual([]);
  });

  test("rejects an extension body extending past the account", () => {
    const data = mintWith([[MintExtension.MetadataPointer, 64]]);
    data.writeUInt16LE(1000, 168);
    expect(() => parseMintExtensions(data)).toThrow(/past end/);
  });

  test("rejects duplicate extensions and incomplete nonzero headers", () => {
    expect(() => parseMintExtensions(mintWith([[18, 64], [18, 64]]))).toThrow(/duplicate/);
    const noTail = mintWith([[18, 64]]).subarray(0, -8);
    expect(() => parseMintExtensions(Buffer.concat([noTail, Buffer.from([1])]))).toThrow(/incomplete/);
    expect(() => parseMintExtensions(Buffer.concat([noTail, Buffer.from([0, 0, 0])]))).not.toThrow();
  });

  test("rejects nonzero bytes after an uninitialized TLV entry", () => {
    const data = mintWith([[18, 64]]);
    data[data.length - 1] = 1;
    expect(() => parseMintExtensions(data)).toThrow(/uninitialized TLV tail/);
  });

  test.each([0, 46])("rejects an invalid authority COption at offset %i", (offset) => {
    const data = mintWith([]);
    data.writeUInt32LE(2, offset);
    expect(() => decodeMintAccount(data)).toThrow(/authority option/);
  });
});

describe("unsupportedMintExtensions", () => {
  test("v6: only non-transferable mints are unsupported; fee, hook, pausable, confidential-fee move via transfer_checked", () => {
    expect(unsupportedMintExtensions([1, 14, 9, 16, 26, 18, 13])).toEqual([9, 13]);
    expect(HARD_UNSUPPORTED_MINT_EXTENSIONS).toEqual([MintExtension.NonTransferable, MintExtension.NonTransferableAccount]);
  });
  test("benign extensions are never unsupported", () => {
    expect(unsupportedMintExtensions([18, 19, 4, 6, 8, 11])).toEqual([]);
  });
  test("v6.1 (T19): no extension policy — PermanentDelegate, MintCloseAuthority, InterestBearing, hooks and fees are admissible", () => {
    expect(unsupportedMintExtensions([12, 18])).toEqual([]);
    expect(unsupportedMintExtensions([1, 3, 10, 12, 14, 25, 26, 4])).toEqual([]);
  });
  test("unknown extension types are unsupported", () => {
    expect(MAX_KNOWN_MINT_EXTENSION).toBe(27);
    expect(unsupportedMintExtensions([28, 40])).toEqual([28, 40]);
  });
});

function poolWithFeeToken(): PoolInfo {
  const mk = (index: number, program: PublicKey, unsupported: number[]) => ({
    index,
    mint: pk(),
    tokenProgram: program,
    decimals: 6,
    weightBps: 3334,
    virtualBalance: new BN(2_000_000_000), // v6.1 (T22): strictly levered
    actualBalance: new BN(1_000_000_000),
    protocolFeesOwed: new BN(0),
    vault: pk(),
    concentration: 1,
    isActive: true,
    maxSelloffPct: 0,
    extensions: unsupported,
    unsupportedExtensions: unsupported,
  });
  const tokens = [
    mk(0, TOKEN_PROGRAM_ID, []),
    mk(1, TOKEN_2022_PROGRAM_ID, []),
    mk(2, TOKEN_2022_PROGRAM_ID, [MintExtension.NonTransferable]),
  ];
  return {
    address: pk(),
    config: pk(),
    bump: 255,
    poolId: new BN(1),
    tokenCount: 3,
    tokens,
    unsupportedTokenIndices: [2],
    lpMint: pk(),
    lpTotalSupply: new BN(1_000_000_000),
    swapFeeRate: 0,
    protocolFeeRate: 0,
    poolEnabled: true,
    swapsEnabled: true,
    createdAt: 0,
    lookupTable: PublicKey.default,
   
    syncedAt: Date.now(),
  };
}

describe("unsupported-extension guard", () => {
  const cfg = getConfig("devnet");
  const pool = poolWithFeeToken();
  const client = new CofferPoolClient({ config: cfg, poolAddress: pool.address });
  (client as unknown as { cache: PoolInfo }).cache = pool;
  const user = pk();

  test("swap between the two clean tokens still works", () => {
    expect(client.quoteSwap(0, 1, new BN(1000)).ok).toBe(true);
    expect(client.buildSwapTx({ user, tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(1000) }).ok).toBe(true);
  });

  test("swap touching the non-transferable token is refused with unsupported_token_extension", () => {
    for (const [i, j] of [[0, 2], [2, 0]]) {
      const q = client.quoteSwap(i, j, new BN(1000));
      expect(q.ok).toBe(false);
      if (!q.ok) expect(q.error.code).toBe("unsupported_token_extension");
      const b = client.buildSwapTx({ user, tokenInIndex: i, tokenOutIndex: j, amountIn: new BN(1000), minAmountOut: new BN(1) });
      expect(b.ok).toBe(false);
      if (!b.ok) {
        expect(b.error.code).toBe("unsupported_token_extension");
        expect(b.error.humanMessage).toMatch(/NonTransferable/);
      }
    }
  });

  test("liquidity ops are refused (they touch every token)", () => {
    const amounts = [new BN(1000), new BN(1000), new BN(1000)];
    const codes = [
      client.quoteAddLiquidity(amounts),
      client.buildAddLiquidityTx({ user, tokenAmounts: amounts, minimumLpAmount: new BN(1) }),
      client.quoteRemove(new BN(1000)),
      client.buildRemoveLiquidityTx({ user, lpAmount: new BN(1000), minimumTokenAmounts: amounts }),
    ].map((r) => (r.ok ? "ok" : r.error.code));
    expect(codes).toEqual(codes.map(() => "unsupported_token_extension"));
  });

  test("low-level ix builders throw for direct callers", () => {
    expect(() => buildSwapIx(cfg, pool, { user, tokenInIndex: 0, tokenOutIndex: 2, amountIn: new BN(1), minAmountOut: new BN(1) })).toThrow(
      /cannot transfer this token/
    );
    expect(() => buildAddLiquidityIx(cfg, pool, { user, tokenAmounts: [new BN(1), new BN(1), new BN(1)], minimumLpAmount: new BN(1) })).toThrow(
      /NonTransferable/
    );
    expect(() => buildSwapIx(cfg, pool, { user, tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(1), minAmountOut: new BN(1) })).not.toThrow();
  });

  test("zero-transfer sidelined tokens do not block proportional deposit or withdrawal", () => {
    const sidelined = poolWithFeeToken();
    sidelined.tokens[2].actualBalance = new BN(0);
    const c = new CofferPoolClient({ config: cfg, poolAddress: sidelined.address });
    (c as unknown as { cache: PoolInfo }).cache = sidelined;
    const amounts = [new BN(1000), new BN(1000), new BN(0)];
    expect(c.quoteAddLiquidity(amounts).ok).toBe(true);
    expect(c.buildAddLiquidityTx({ user, tokenAmounts: amounts, minimumLpAmount: new BN(1) }).ok).toBe(true);
    const exit = c.quoteRemove(new BN(1000));
    expect(exit.ok).toBe(true);
    if (exit.ok) expect(exit.data.tokenOuts.map(String)).toEqual(["1000", "1000", "0"]);
    expect(c.buildRemoveLiquidityTx({
      user, lpAmount: new BN(1000), minimumTokenAmounts: amounts,
    }).ok).toBe(true);
  });

  test("v6 policy flip: a transfer-fee or hooked token is quoted and built", () => {
    const feePool = poolWithFeeToken();
    feePool.tokens[2].extensions = [MintExtension.TransferFeeConfig, MintExtension.TransferHook];
    feePool.tokens[2].unsupportedExtensions = unsupportedMintExtensions(feePool.tokens[2].extensions);
    feePool.tokens[2].transferFee = { epoch: 0n, maximumFee: 1_000n, transferFeeBasisPoints: 100 };
    feePool.tokens[2].transferHookProgram = pk();
    feePool.unsupportedTokenIndices = feePool.tokens.filter((t) => !isTokenTransferable(t)).map((t) => t.index);
    expect(feePool.unsupportedTokenIndices).toEqual([]);
    const c = new CofferPoolClient({ config: cfg, poolAddress: feePool.address });
    (c as unknown as { cache: PoolInfo }).cache = feePool;
    expect(c.quoteSwap(0, 2, new BN(1000)).ok).toBe(true);
    expect(c.buildSwapTx({ user, tokenInIndex: 2, tokenOutIndex: 0, amountIn: new BN(1000), minAmountOut: new BN(1) }).ok).toBe(true);
    expect(c.quoteAddLiquidity([new BN(1000), new BN(1000), new BN(1000)]).ok).toBe(true);
  });

  test("an unpaused Pausable mint is accepted; a paused one is refused on every leg that moves it", () => {
    const pausable = poolWithFeeToken();
    pausable.tokens[2].extensions = [MintExtension.PausableConfig];
    pausable.tokens[2].unsupportedExtensions = unsupportedMintExtensions([MintExtension.PausableConfig]);
    pausable.tokens[2].paused = false;
    pausable.unsupportedTokenIndices = [];
    const c = new CofferPoolClient({ config: cfg, poolAddress: pausable.address });
    (c as unknown as { cache: PoolInfo }).cache = pausable;
    expect(c.quoteSwap(0, 2, new BN(1000)).ok).toBe(true);
    pausable.tokens[2].paused = true;
    expect(tokenTransferBlockers(pausable.tokens[2])).toEqual(["mint is paused (Pausable)"]);
    const quote = c.quoteSwap(0, 2, new BN(1000));
    expect(quote.ok).toBe(false);
    if (!quote.ok) {
      expect(quote.error.code).toBe("unsupported_token_extension");
      expect(quote.error.humanMessage).toMatch(/paused/);
    }
    expect(c.quoteSwap(0, 1, new BN(1000)).ok).toBe(true);
    expect(() => buildSwapIx(cfg, pausable, { user, tokenInIndex: 2, tokenOutIndex: 0, amountIn: new BN(1), minAmountOut: new BN(1) })).toThrow(/paused/);
  });

  test("the Token-2022 native mint cannot be pooled", () => {
    const native = poolWithFeeToken();
    native.tokens[2].mint = NATIVE_MINT_2022;
    native.tokens[2].extensions = [];
    native.tokens[2].unsupportedExtensions = [];
    expect(tokenTransferBlockers(native.tokens[2])).toEqual(["Token-2022 native mint cannot be pooled"]);
    expect(isTokenTransferable({ ...native.tokens[2], tokenProgram: TOKEN_PROGRAM_ID })).toBe(true);
  });
});

describe("decodeMintAccount extension bodies", () => {
  const feeBody = (older: [number, bigint, bigint], newer: [number, bigint, bigint]) => {
    const b = Buffer.alloc(108);
    const schedule = ([bps, maxFee, epoch]: [number, bigint, bigint], off: number) => {
      b.writeBigUInt64LE(epoch, off); b.writeBigUInt64LE(maxFee, off + 8); b.writeUInt16LE(bps, off + 16);
    };
    schedule(older, 72); schedule(newer, 90);
    return b;
  };
  const withBodies = (entries: Array<[number, Buffer]>): Buffer => {
    const base = mintWith([]);
    const tlv = Buffer.concat(entries.map(([type, body]) => {
      const h = Buffer.alloc(4); h.writeUInt16LE(type, 0); h.writeUInt16LE(body.length, 2);
      return Buffer.concat([h, body]);
    }));
    return Buffer.concat([base, Buffer.alloc(83), Buffer.from([1]), tlv, Buffer.alloc(8)]);
  };

  test("transfer-fee schedules, hook program and pause flag are decoded", () => {
    const hookProgram = pk();
    const hook = Buffer.concat([pk().toBuffer(), hookProgram.toBuffer()]);
    const pause = Buffer.concat([pk().toBuffer(), Buffer.from([1])]);
    const m = decodeMintAccount(withBodies([
      [MintExtension.TransferFeeConfig, feeBody([100, 1_000n, 0n], [250, 5_000n, 7n])],
      [MintExtension.TransferHook, hook],
      [MintExtension.PausableConfig, pause],
    ]));
    expect(m.extensions).toEqual([1, 14, 26]);
    expect(m.transferFeeConfig?.olderTransferFee).toMatchObject({ transferFeeBasisPoints: 100, maximumFee: 1_000n, epoch: 0n });
    expect(m.transferFeeConfig?.newerTransferFee).toMatchObject({ transferFeeBasisPoints: 250, maximumFee: 5_000n, epoch: 7n });
    expect(m.transferHook?.programId.equals(hookProgram)).toBe(true);
    expect(m.pausableConfig?.paused).toBe(true);
  });

  test("a mint without those extensions reports null bodies", () => {
    const m = decodeMintAccount(mintWith([[MintExtension.MetadataPointer, 64]]));
    expect([m.transferFeeConfig, m.transferHook, m.pausableConfig]).toEqual([null, null, null]);
  });

  test("a schedule above 100 % is an invalid mint, as on-chain", () => {
    expect(() => decodeMintAccount(withBodies([[MintExtension.TransferFeeConfig, feeBody([100, 1n, 0n], [10_001, 1n, 1n])]]))).toThrow(/exceeds 100/);
  });

  test("a disarmed hook (default program) is reported as no hook by sync", () => {
    const hook = Buffer.concat([pk().toBuffer(), PublicKey.default.toBuffer()]);
    const m = decodeMintAccount(withBodies([[MintExtension.TransferHook, hook]]));
    expect(m.transferHook?.programId.equals(PublicKey.default)).toBe(true);
  });
});
