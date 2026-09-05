import { ComputeBudgetProgram, Keypair, PublicKey } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import { getConfig } from "../src/config";
import {
  buildAddLiquidityTx,
  buildDeployPoolTx,
  buildInitializeConfigIx,
  buildInitializePoolAltIx,
  buildInitializePoolAltTx,
  buildRemoveLiquidityTx,
  buildSwapTx,
  deriveAltAddress,
} from "../src/clients/tx-builders";
import { AddressLookupTableProgram } from "@solana/web3.js";
import cubicPoolIdl from "../src/idl/cubic_pool.json";
import { PoolInfo } from "../src/types/pool";

const pk = (): PublicKey => Keypair.generate().publicKey;

function mockPool(tokenCount = 2): PoolInfo {
  const address = pk();
  const tokens = Array.from({ length: tokenCount }, (_, index) => {
    const mint = pk();
    return {
      index,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      decimals: 9,
      weightBps: 10_000 / tokenCount,
      virtualBalance: new BN(1_000_000_000),
      actualBalance: new BN(1_000_000_000),
      protocolFeesOwed: new BN(0),
      vault: pk(),
      concentration: 1,
      isActive: true,
      maxSelloffPct: 0,
    };
  });

  return {
    address,
    config: pk(),
    bump: 255,
    poolId: new BN(1),
    tokenCount,
    tokens,
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

function idlDiscriminator(name: string): string {
  const ix = (cubicPoolIdl.instructions as Array<{ name: string; discriminator: number[] }>)
    .find((instruction) => instruction.name === name);
  if (!ix) throw new Error(`Missing IDL instruction: ${name}`);
  return Buffer.from(ix.discriminator).toString("hex");
}

describe("tx-builders.removeLiquidity", () => {
  test("creates receive ATAs before proportional burn", () => {
    const cfg = getConfig("devnet");
    const pool = mockPool(3);
    const user = pk();

    const tx = buildRemoveLiquidityTx(cfg, pool, {
      user,
      bptAmount: new BN(1000),
      // explicit per-token floors now required; zeros = intentional opt-out
      minimumTokenAmounts: pool.tokens.map(() => new BN(0)),
    });

    expect(tx.instructions).toHaveLength(1 + pool.tokenCount + 1);
    expect(tx.instructions[0].programId.toBase58()).toBe(ComputeBudgetProgram.programId.toBase58());

    for (let i = 0; i < pool.tokenCount; i++) {
      const createAtaIx = tx.instructions[i + 1];
      expect(createAtaIx.programId.toBase58()).toBe(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
      expect(createAtaIx.keys[0].pubkey.toBase58()).toBe(user.toBase58());
      expect(createAtaIx.keys[2].pubkey.toBase58()).toBe(user.toBase58());
      expect(createAtaIx.keys[3].pubkey.toBase58()).toBe(pool.tokens[i].mint.toBase58());
    }

    const removeIx = tx.instructions[tx.instructions.length - 1];
    expect(removeIx.programId.toBase58()).toBe(cfg.programs.cubicPool.toBase58());
  });
});

describe("tx-builders discriminators", () => {
  test("matches current cubic-pool IDL for user-facing builders", () => {
    const cfg = getConfig("devnet");
    const pool = mockPool(2);
    const user = pk();

    const swap = buildSwapTx(cfg, pool, {
      user,
      tokenInIndex: 0,
      tokenOutIndex: 1,
      amountIn: new BN(1000),
      minAmountOut: new BN(1),
    }).instructions[1];

    const addTx = buildAddLiquidityTx(cfg, pool, {
      user,
      tokenAmounts: [new BN(1000), new BN(1000)],
      minimumBptAmount: new BN(1),
    });
    const add = addTx.instructions[addTx.instructions.length - 1];
    const removeTx = buildRemoveLiquidityTx(cfg, pool, {
      user,
      bptAmount: new BN(1000),
      minimumTokenAmounts: pool.tokens.map(() => new BN(0)),
    });
    const remove = removeTx.instructions[removeTx.instructions.length - 1];

    const deployTx = buildDeployPoolTx(cfg, {
      payer: user,
      configKey: pk(),
      poolId: new BN(1),
      tokens: [pool.tokens[0].mint, pool.tokens[1].mint],
      weightsBps: [5000, 5000],
      virtualBalances: [new BN(1000), new BN(1000)],
      swapFeeRate: 3000,
    });
    const deploy = deployTx.instructions[deployTx.instructions.length - 1];
    const initConfig = buildInitializeConfigIx(cfg, {
      config: pk(),
      payer: user,
      defaultProtocolFeeRate: 1000,
    });

    expect(swap.data.subarray(0, 8).toString("hex")).toBe(idlDiscriminator("swap"));
    expect(add.data.subarray(0, 8).toString("hex")).toBe(idlDiscriminator("add_liquidity"));
    expect(remove.data.subarray(0, 8).toString("hex")).toBe(idlDiscriminator("remove_liquidity"));
    expect(deploy.data.subarray(0, 8).toString("hex")).toBe(idlDiscriminator("initialize_cubic_pool"));
    expect(initConfig.data.subarray(0, 8).toString("hex")).toBe(idlDiscriminator("initialize_config"));
  });
});

describe("tx-builders.initializePoolAlt", () => {
  test("derives the ALT address from (authority, slot) matching the upstream PDA scheme", () => {
    const auth = pk();
    const slot = new BN(123_456_789);

    const slotBuf = Buffer.alloc(8);
    slotBuf.writeBigUInt64LE(BigInt(slot.toString()));
    const [expected] = PublicKey.findProgramAddressSync(
      [auth.toBuffer(), slotBuf],
      AddressLookupTableProgram.programId,
    );

    expect(deriveAltAddress(auth, slot).toBase58()).toBe(expected.toBase58());
  });

  test("emits canonical discriminator + recent_slot little-endian as ix data", () => {
    const cfg = getConfig("devnet");
    const auth = pk();
    const slot = new BN("999000111222");

    const ix = buildInitializePoolAltIx(cfg, {
      pool: pk(),
      config: pk(),
      authority: auth,
      payer: auth,
      recentSlot: slot,
    });

    expect(ix.programId.toBase58()).toBe(cfg.programs.cubicPool.toBase58());
    expect(ix.data.length).toBe(8 + 8);
    expect(ix.data.subarray(0, 8).toString("hex")).toBe(
      idlDiscriminator("initialize_pool_alt"),
    );
    // Last 8 bytes = u64 LE of recent_slot
    const decoded = new BN(ix.data.subarray(8, 16), "le").toString();
    expect(decoded).toBe(slot.toString());
  });

  test("buildTx prepends a ComputeBudget ix and exposes the lookup_table address", () => {
    const cfg = getConfig("devnet");
    const auth = pk();
    const slot = new BN(42);

    const built = buildInitializePoolAltTx(cfg, {
      pool: pk(),
      config: pk(),
      authority: auth,
      payer: auth,
      recentSlot: slot,
    });

    expect(built.instructions).toHaveLength(2);
    expect(built.instructions[0].programId.toBase58()).toBe(
      ComputeBudgetProgram.programId.toBase58(),
    );
    expect(built.lookupTable.toBase58()).toBe(deriveAltAddress(auth, slot).toBase58());
  });
});
