import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import {
  CubicPoolClient,
  getConfig,
  MintExtension,
  parseMintExtensions,
  unsupportedMintExtensions,
  bannedMintExtensions,
  MAX_KNOWN_MINT_EXTENSION,
  decodeMintAccount,
  buildSwapIx,
  buildAddLiquidityIx,
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
  test("fee, hook, non-transferable and pausable mints cannot use plain Transfer", () => {
    expect(unsupportedMintExtensions([1, 14, 9, 16, 26, 18], new BN(0))).toEqual([1, 14, 9, 16, 26]);
  });
  test("benign extensions pass when not banned by the pool", () => {
    expect(unsupportedMintExtensions([18, 19, 4, 6], new BN(0))).toEqual([]);
  });
  test("creation-policy diagnostics do not block a transferable PermanentDelegate mint", () => {
    expect(unsupportedMintExtensions([12, 18], new BN(1 << 12))).toEqual([]);
    expect(unsupportedMintExtensions([12, 18], new BN(0))).toEqual([]);
    expect(bannedMintExtensions([12, 18], new BN(1 << 12))).toEqual([12]);
    expect(bannedMintExtensions([12, 18], new BN(0))).toEqual([]);
  });
  test("unknown extension types are unsupported", () => {
    expect(MAX_KNOWN_MINT_EXTENSION).toBe(27);
    expect(unsupportedMintExtensions([28, 40], new BN(0))).toEqual([28, 40]);
  });
  test("policy bitmaps preserve high u64 bits and reject invalid bounds", () => {
    expect(bannedMintExtensions([12, 63, 64], 1n << 63n)).toEqual([63]);
    expect(() => bannedMintExtensions([12], -1n)).toThrow(/u64/);
    expect(() => bannedMintExtensions([12], 1n << 64n)).toThrow(/u64/);
  });
});

function poolWithFeeToken(): PoolInfo {
  const mk = (index: number, program: PublicKey, unsupported: number[]) => ({
    index,
    mint: pk(),
    tokenProgram: program,
    decimals: 6,
    weightBps: 3334,
    virtualBalance: new BN(1_000_000_000),
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
    mk(2, TOKEN_2022_PROGRAM_ID, [MintExtension.TransferFeeConfig]),
  ];
  return {
    address: pk(),
    config: pk(),
    bump: 255,
    poolId: new BN(1),
    tokenCount: 3,
    tokens,
    unsupportedTokenIndices: [2],
    bptMint: pk(),
    bptTotalSupply: new BN(1_000_000_000),
    swapFeeRate: 0,
    protocolFeeRate: 0,
    poolEnabled: true,
    swapsEnabled: true,
    createdAt: 0,
    lookupTable: PublicKey.default,
    bannedExtensions: new BN(0),
    syncedAt: Date.now(),
  };
}

describe("unsupported-extension guard", () => {
  const cfg = getConfig("devnet");
  const pool = poolWithFeeToken();
  const client = new CubicPoolClient({ config: cfg, poolAddress: pool.address });
  (client as unknown as { cache: PoolInfo }).cache = pool;
  const user = pk();

  test("swap between the two clean tokens still works", () => {
    expect(client.quoteSwap(0, 1, new BN(1000)).ok).toBe(true);
    expect(client.buildSwapTx({ user, tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(1000) }).ok).toBe(true);
  });

  test("swap touching the fee token is refused with unsupported_token_extension", () => {
    for (const [i, j] of [[0, 2], [2, 0]]) {
      const q = client.quoteSwap(i, j, new BN(1000));
      expect(q.ok).toBe(false);
      if (!q.ok) expect(q.error.code).toBe("unsupported_token_extension");
      const b = client.buildSwapTx({ user, tokenInIndex: i, tokenOutIndex: j, amountIn: new BN(1000), minAmountOut: new BN(1) });
      expect(b.ok).toBe(false);
      if (!b.ok) {
        expect(b.error.code).toBe("unsupported_token_extension");
        expect(b.error.humanMessage).toMatch(/TransferFeeConfig/);
      }
    }
  });

  test("liquidity ops and zap are refused (they touch every token)", () => {
    const amounts = [new BN(1000), new BN(1000), new BN(1000)];
    const codes = [
      client.quoteAddLiquidity(amounts),
      client.buildAddLiquidityTx({ user, tokenAmounts: amounts, minimumBptAmount: new BN(1) }),
      client.quoteRemove(new BN(1000)),
      client.buildRemoveLiquidityTx({ user, bptAmount: new BN(1000), minimumTokenAmounts: amounts }),
      client.quoteSingleTokenDeposit(0, new BN(1000)),
      client.buildSingleTokenDepositTx({ user, tokenInIndex: 0, amountIn: new BN(1000), minimumBptAmount: new BN(1) }),
      client.buildSingleTokenDepositTxs({ user, tokenInIndex: 0, amountIn: new BN(1000), minimumBptAmount: new BN(1) }),
      client.singleTokenDeposit.buildTx({ user, tokenInIndex: 0, amountIn: new BN(1000), minimumBptAmount: new BN(1) }),
      client.singleTokenDeposit.buildTxs({ user, tokenInIndex: 0, amountIn: new BN(1000), minimumBptAmount: new BN(1) }),
    ].map((r) => (r.ok ? "ok" : r.error.code));
    expect(codes).toEqual(codes.map(() => "unsupported_token_extension"));
  });

  test("low-level ix builders throw for direct callers", () => {
    expect(() => buildSwapIx(cfg, pool, { user, tokenInIndex: 0, tokenOutIndex: 2, amountIn: new BN(1), minAmountOut: new BN(1) })).toThrow(
      /unsupported Token-2022 extension/
    );
    expect(() => buildAddLiquidityIx(cfg, pool, { user, tokenAmounts: [new BN(1), new BN(1), new BN(1)], minimumBptAmount: new BN(1) })).toThrow(
      /TransferFeeConfig/
    );
    expect(() => buildSwapIx(cfg, pool, { user, tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(1), minAmountOut: new BN(1) })).not.toThrow();
  });

  test("zero-transfer sidelined tokens do not block proportional deposit or withdrawal", () => {
    const sidelined = poolWithFeeToken();
    sidelined.tokens[2].actualBalance = new BN(0);
    const c = new CubicPoolClient({ config: cfg, poolAddress: sidelined.address });
    (c as unknown as { cache: PoolInfo }).cache = sidelined;
    const amounts = [new BN(1000), new BN(1000), new BN(0)];
    expect(c.quoteAddLiquidity(amounts).ok).toBe(true);
    expect(c.buildAddLiquidityTx({ user, tokenAmounts: amounts, minimumBptAmount: new BN(1) }).ok).toBe(true);
    const exit = c.quoteRemove(new BN(1000));
    expect(exit.ok).toBe(true);
    if (exit.ok) expect(exit.data.tokenOuts.map(String)).toEqual(["1000", "1000", "0"]);
    expect(c.buildRemoveLiquidityTx({
      user, bptAmount: new BN(1000), minimumTokenAmounts: amounts,
    }).ok).toBe(true);
  });

  test("PausableConfig is rejected even when the creation policy allowed it", () => {
    const pausable = poolWithFeeToken();
    pausable.tokens[2].extensions = [MintExtension.PausableConfig];
    pausable.tokens[2].unsupportedExtensions = unsupportedMintExtensions([MintExtension.PausableConfig], 0n);
    const c = new CubicPoolClient({ config: cfg, poolAddress: pausable.address });
    (c as unknown as { cache: PoolInfo }).cache = pausable;
    const quote = c.quoteSwap(0, 2, new BN(1000));
    expect(quote.ok).toBe(false);
    if (!quote.ok) expect(quote.error.humanMessage).toMatch(/PausableConfig/);
  });
});
