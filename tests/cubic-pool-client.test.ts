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
  }));

  return {
    address,
    config: pk(),
    bump: 255,
    poolId: new BN(1),
    tokenCount: 2,
    tokens,
    bptMint: pk(),
    bptTotalSupply: new BN(1_000_000_000),
    swapFeeRate: 0,
    protocolFeeRate: 0,
    poolEnabled: true,
    swapsEnabled: true,
    createdAt: 0,
    lookupTable: pk(),
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
