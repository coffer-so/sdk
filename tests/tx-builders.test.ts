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
import cofferPoolIdl from "../src/idl/coffer_pool.json";
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
      extensions: [],
      unsupportedExtensions: [],
    };
  });

  return {
    address,
    config: pk(),
    bump: 255,
    poolId: new BN(1),
    tokenCount,
    tokens,
    unsupportedTokenIndices: [],
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

function idlDiscriminator(name: string): string {
  const ix = (cofferPoolIdl.instructions as Array<{ name: string; discriminator: number[] }>)
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
      lpAmount: new BN(1000),
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
    expect(removeIx.programId.toBase58()).toBe(cfg.programs.cofferPool.toBase58());
  });
});

describe("tx-builders v6 remaining-account tail", () => {
  test("swap, add and remove append extraAccounts after the fixed layout as non-signers", () => {
    const cfg = getConfig("devnet");
    const pool = mockPool(2);
    const user = pk();
    const extra = [{ pubkey: pk(), isSigner: false, isWritable: true }, { pubkey: pk(), isSigner: false, isWritable: false }];
    const swap = buildSwapTx(cfg, pool, { user, tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(1000), minAmountOut: new BN(1), extraAccounts: extra }).instructions[1];
    expect(swap.keys).toHaveLength(10 + 2);
    expect(swap.keys.slice(10).map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual(extra.map((k) => [k.pubkey.toBase58(), false, k.isWritable]));
    const add = buildAddLiquidityTx(cfg, pool, { user, tokenAmounts: [new BN(1000), new BN(1000)], minimumLpAmount: new BN(1), extraAccounts: extra }).instructions[2];
    expect(add.keys).toHaveLength(5 + 4 * 2 + 2);
    expect(add.keys.slice(-2).map((k) => k.pubkey.toBase58())).toEqual(extra.map((k) => k.pubkey.toBase58()));
    const remove = buildRemoveLiquidityTx(cfg, pool, { user, lpAmount: new BN(1000), minimumTokenAmounts: [new BN(0), new BN(0)], extraAccounts: extra }).instructions.at(-1)!;
    expect(remove.keys).toHaveLength(5 + 4 * 2 + 2);
    expect(remove.keys.slice(-2).map((k) => k.pubkey.toBase58())).toEqual(extra.map((k) => k.pubkey.toBase58()));
    // Without a tail the layout is unchanged.
    expect(buildSwapTx(cfg, pool, { user, tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(1000), minAmountOut: new BN(1) }).instructions[1].keys).toHaveLength(10);
  });

  test("add_liquidity refuses a ceiling fully consumed by its transfer fee", () => {
    const cfg = getConfig("devnet");
    const pool = mockPool(2);
    pool.tokens[0].transferFee = { epoch: 0n, maximumFee: 1_000_000n, transferFeeBasisPoints: 10_000 };
    expect(() => buildAddLiquidityTx(cfg, pool, { user: pk(), tokenAmounts: [new BN(5), new BN(1000)], minimumLpAmount: new BN(1) })).toThrow(/fully consumed/);
  });
});

describe("tx-builders discriminators", () => {
  test("matches current coffer-pool IDL for user-facing builders", () => {
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
      minimumLpAmount: new BN(1),
    });
    const add = addTx.instructions[addTx.instructions.length - 1];
    const removeTx = buildRemoveLiquidityTx(cfg, pool, {
      user,
      lpAmount: new BN(1000),
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
      lpMetadata: { name: "Coffer LP", symbol: "cLP", uri: "https://coffer.so/lp.json" },
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
    expect(deploy.data.subarray(0, 8).toString("hex")).toBe(idlDiscriminator("initialize_pool"));
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

    expect(ix.programId.toBase58()).toBe(cfg.programs.cofferPool.toBase58());
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
