import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import { CubicPoolClient, getConfig } from "../src";
import { PoolInfo } from "../src/types/pool";

const pk = (): PublicKey => Keypair.generate().publicKey;

function mockPool(): PoolInfo {
  const address = pk();
  const tokens = [0, 1].map((index) => ({
    index,
    mint: pk(),
    tokenProgram: TOKEN_PROGRAM_ID,
    decimals: 9,
    weightBps: 5000,
    virtualBalance: new BN(1_000_000_000),
    actualBalance: new BN(1_000_000_000),
    protocolFeesOwed: new BN(0),
    vault: pk(),
    concentration: 1,
    isActive: true,
    maxSelloffPct: 0,
    extensions: [] as number[],
    unsupportedExtensions: [] as number[],
  }));

  return {
    address,
    config: pk(),
    bump: 255,
    poolId: new BN(1),
    tokenCount: 2,
    tokens,
    unsupportedTokenIndices: [],
    bptMint: pk(),
    bptTotalSupply: new BN(1_000_000_000),
    swapFeeRate: 0,
    protocolFeeRate: 0,
    poolEnabled: true,
    swapsEnabled: true,
    createdAt: 0,
    lookupTable: pk(),
    bannedExtensions: new BN(0),
    syncedAt: Date.now(),
  };
}

describe("CubicPoolClient.buildSwapTx", () => {
  test("fails when quote fails instead of using zero minAmountOut", () => {
    const cfg = getConfig("devnet");
    const client = new CubicPoolClient({ config: cfg, poolAddress: pk() });
    (client as unknown as { cache: PoolInfo }).cache = mockPool();

    const res = client.buildSwapTx({
      user: pk(),
      tokenInIndex: 0,
      tokenOutIndex: 99,
      amountIn: new BN(1000),
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("invalid_input");
    expect(res.error.humanMessage).toMatch(/minAmountOut/i);
  });

  test("derives minAmountOut from quote when omitted", () => {
    const cfg = getConfig("devnet");
    const pool = mockPool();
    const client = new CubicPoolClient({ config: cfg, poolAddress: pool.address });
    (client as unknown as { cache: PoolInfo }).cache = pool;

    const res = client.buildSwapTx({
      user: pk(),
      tokenInIndex: 0,
      tokenOutIndex: 1,
      amountIn: new BN(1000),
    });

    expect(res.ok).toBe(true);
  });
});

describe("CubicPoolClient.quoteAddLiquidity", () => {
  function clientWith(pool: PoolInfo): CubicPoolClient {
    const client = new CubicPoolClient({ config: getConfig("devnet"), poolAddress: pool.address });
    (client as unknown as { cache: PoolInfo }).cache = pool;
    return client;
  }

  test("proportional basket: bptOut = supply * min(amount_i / actual_i), crops the non-limiting leg", () => {
    const pool = mockPool(); // 2 tokens, actual 1e9 each, supply 1e9
    const client = clientWith(pool);
    // token 1 offers 0.8% of its balance, token 0 offers 1% → token 1 limits.
    const res = client.quoteAddLiquidity([new BN(10_000_000), new BN(8_000_000)], 10_000 /* 1 % */);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.limitingTokenIndex).toBe(1);
    expect(res.data.bptOut.toString()).toBe("8000000");
    expect(res.data.minimumBptAmount.toString()).toBe("7920000");
    expect(res.data.depositAmounts.map(String)).toEqual(["8000000", "8000000"]);
    expect(res.data.refundAmounts.map(String)).toEqual(["2000000", "0"]);
    // deposit + refund == what was offered, per leg
    res.data.tokenAmounts.forEach((a, i) => {
      expect(res.data.depositAmounts[i].add(res.data.refundAmounts[i]).toString()).toBe(a.toString());
    });
  });

  test("minimumBptAmount feeds buildAddLiquidityTx (which rejects a missing floor)", () => {
    const pool = mockPool();
    const client = clientWith(pool);
    const q = client.quoteAddLiquidity([new BN(1_000_000), new BN(1_000_000)]);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    const without = client.buildAddLiquidityTx({ user: pk(), tokenAmounts: q.data.tokenAmounts });
    expect(without.ok).toBe(false);
    const withFloor = client.buildAddLiquidityTx({
      user: pk(),
      tokenAmounts: q.data.tokenAmounts,
      minimumBptAmount: q.data.minimumBptAmount,
    });
    expect(withFloor.ok).toBe(true);
  });

  test("ignores zero-balance legs when picking the limiting ratio", () => {
    const pool = mockPool();
    pool.tokens[0].actualBalance = new BN(0);
    const client = clientWith(pool);
    const res = client.quoteAddLiquidity([new BN(0), new BN(5_000_000)], 0);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.limitingTokenIndex).toBe(1);
    expect(res.data.bptOut.toString()).toBe("5000000");
    expect(res.data.depositAmounts.map(String)).toEqual(["0", "5000000"]);
  });

  test("rejects wrong vector length and unseeded pools", () => {
    const pool = mockPool();
    const client = clientWith(pool);
    const bad = client.quoteAddLiquidity([new BN(1)]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("invalid_input");
    pool.bptTotalSupply = new BN(0);
    const seed = client.quoteAddLiquidity([new BN(1), new BN(1)]);
    expect(seed.ok).toBe(false);
    if (!seed.ok) expect(seed.error.humanMessage).toMatch(/seed/i);
  });
});
