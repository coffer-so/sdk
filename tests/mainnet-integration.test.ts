/**
 * Live mainnet integration tests for the SDK.
 *
 * These tests hit real Solana mainnet RPC and exercise the full sync /
 * derive / build flow against a migrated v5 mainnet pool
 * (`EFfVk5qcKBKEQXeWwWjVsnit3YqLNXNENUDW5Fxdfyjy`). They guard against the
 * regressions discovered during the mainnet rollout:
 *
 *   1. **Stale dist** — `frontend/node_modules/@cube/sdk/dist/` had old
 *      program IDs (Fc3R…) baked in, so `deriveBptMint` returned a PDA
 *      that did not exist on-chain ("BPT mint account missing").
 *   2. **Discriminator drift** — fixture data in our IDL must match what
 *      the deployed `cubic_pool` program will accept. A `b59d…` mismatch
 *      shows up as Solana's "InstructionFallbackNotFound" / "Unknown
 *      instruction" errors.
 *   3. **WSOL handling** — the SDK builder is intentionally RPC-light
 *      and does not pre-wrap native SOL. Tests assert no `SystemProgram`
 *      transfer is in the built instructions so the frontend hook stays
 *      responsible for wrapping (a contract test for the hook layer).
 *
 * Read-only: no signing, transaction sending or balance changes. Set
 * SKIP_MAINNET_TESTS=1 for an explicitly offline run. Otherwise RPC errors,
 * a wrong cluster and unexpected account layouts fail the suite.
 */

import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import BN from "bn.js";
import { getConfig } from "../src/config";
import { CubicPoolClient } from "../src/clients/CubicPoolClient";
import { RpcClient } from "../src/clients/RpcClient";
import { deriveBptMint } from "../src/utils/pda";
import cubicPoolIdl from "../src/idl/cubic_pool.json";
import { POOL_V3_LEN, POOL_LEN, decodePoolAccount } from "../src/parsers/poolAccount";

// v6 mainnet pool #2 (xStocks basket, Token-2022 mints, SPL BPT), created by
// the contracts team 2026-10 on the SEPARATE v6 cubic_pool program.
const POOL_ADDRESS = "HGbQ74sgfvyhyEBgPwtKBge2HFcnZbHXTCSA2QdBTHA3";
const KNOWN_BPT_MINT = "8DqoXsgP3YuJDeq5e2u7VF3zSTX66bVHXYVKUFmecsQS";
const MAINNET_PROGRAM = "6DhW1Ek5WLJSnFSpBBGYeVRbRiWtCXHbqyGJ6LcVZgH9";
const POOL_ADMIN = "4vPXU53SbsgsDjcpS4T2UQvsZShZcEEMTSvjxoTHUKRn"; // handed over from the stand deployer on 2026-10-10
const TOKEN_COUNT = 5;
const RPC = process.env.SDK_MAINNET_RPC_URL ?? process.env.RPC_URL ?? getConfig("mainnet").defaults.rpcEndpoint;

// SystemProgram transfer (used to wrap SOL → wSOL): 4-byte instruction tag = 2.
function isSystemTransfer(programId: PublicKey, data: Buffer): boolean {
  return programId.equals(SystemProgram.programId) && data.length >= 4 && data.readUInt32LE(0) === 2;
}

const skipMainnet = process.env.SKIP_MAINNET_TESTS === "1";
const describeOnline = skipMainnet ? describe.skip : describe;

describeOnline("mainnet integration: sdk-v6 against v6 pool HGbQ…THA3", () => {
  jest.setTimeout(30_000);

  const cfg = getConfig("mainnet", { rpcEndpoint: RPC });
  const rpc = new RpcClient({ endpoint: RPC, commitment: "confirmed" });
  const client = new CubicPoolClient({
    config: cfg,
    poolAddress: new PublicKey(POOL_ADDRESS),
    rpc,
  });
  const conn = new Connection(RPC, "confirmed");

  beforeAll(async () => {
    expect(await conn.getGenesisHash()).toBe("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
    const pool = await conn.getAccountInfo(new PublicKey(POOL_ADDRESS));
    expect(pool).not.toBeNull();
    expect(pool!.owner.toBase58()).toBe(MAINNET_PROGRAM);
    expect(pool!.data.length).toBe(POOL_LEN);
  });

  test("network config exposes the mainnet cubic_pool program ID", () => {
    expect(cfg.programs.cubicPool.toBase58()).toBe(MAINNET_PROGRAM);
  });

  test("deriveBptMint(mainnet program, pool) matches on-chain bptMint", () => {
    const [derived] = deriveBptMint(cfg.programs.cubicPool, new PublicKey(POOL_ADDRESS));
    expect(derived.toBase58()).toBe(KNOWN_BPT_MINT);
  });

  test(`client.sync() loads pool with ${TOKEN_COUNT} tokens and BPT mint matches derivation`, async () => {
    const r = await client.sync();
    if (!r.ok) throw new Error(`sync failed: ${r.error.code} ${r.error.humanMessage}`);

    expect(r.data.tokenCount).toBe(TOKEN_COUNT);
    expect(r.data.bptMint.toBase58()).toBe(KNOWN_BPT_MINT);
    expect(r.data.tokens).toHaveLength(TOKEN_COUNT);
    expect(r.data.bptTokenProgram?.toBase58()).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    expect(r.data.poolAdmin?.toBase58()).toBe(POOL_ADMIN);
    expect(r.data.pendingPoolAdmin).toBeInstanceOf(PublicKey);
    expect(r.data.rangeManager).toBeInstanceOf(PublicKey);
    expect(typeof r.data.rangeManagerEnabled).toBe("boolean");
    expect(Number.isSafeInteger(r.data.chainTimestamp)).toBe(true);
    expect(r.data.chainTimestamp).toBeGreaterThan(0);
    for (const token of r.data.tokens) {
      expect(typeof token.maxSelloffPeriodLength).toBe("number");
      expect(typeof token.variableFeeThresholdPct).toBe("number");
      expect(typeof token.variableFeeSlopeLowPct).toBe("number");
      expect(typeof token.variableFeeSlopeMidPct).toBe("number");
      expect(typeof token.variableFeeSlopeHighPct).toBe("number");
      expect(typeof token.variableFeeKinkPct).toBe("number");
      expect(BN.isBN(token.previousSelloff)).toBe(true);
      expect(BN.isBN(token.currentSelloff)).toBe(true);
      expect(BN.isBN(token.windowStartTimestamp)).toBe(true);
      expect(BN.isBN(token.selloffVbSnapshot)).toBe(true);
    }

    // The published mint set: five xStocks (Token-2022) wrappers.
    const wantedMints = new Set([
      "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
      "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN",
      "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
      "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ",
      "XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1",
    ]);
    const onChain = new Set(r.data.tokens.map((t) => t.mint.toBase58()));
    expect(onChain).toEqual(wantedMints);
  });

  test("BPT mint account exists on-chain at the derived address", async () => {
    const info = await conn.getAccountInfo(new PublicKey(KNOWN_BPT_MINT));
    expect(info).not.toBeNull();
    // SPL Token mint = 82 bytes, owned by the SPL Token program.
    expect(info!.data.length).toBe(82);
    expect(info!.owner.toBase58()).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  });

  test("buildAddLiquidityTx uses the IDL discriminator the program expects", async () => {
    const r = await client.sync();
    if (!r.ok) throw new Error(`sync failed: ${r.error.code} ${r.error.humanMessage}`);

    const built = client.buildAddLiquidityTx({
      user: new PublicKey(MAINNET_PROGRAM), // any pubkey works for shape check
      tokenAmounts: r.data.tokens.map(t => t.actualBalance.divn(100).addn(1)),
      minimumBptAmount: new BN(1),
    });
    if (!built.ok) throw new Error(`build failed: ${built.error.humanMessage}`);

    const ix = built.data.instructions.find((i) => i.programId.equals(cfg.programs.cubicPool));
    expect(ix).toBeDefined();

    const expectedDiscHex = Buffer.from(
      (cubicPoolIdl.instructions as Array<{ name: string; discriminator: number[] }>)
        .find((i) => i.name === "add_liquidity")!.discriminator
    ).toString("hex");
    expect(ix!.data.subarray(0, 8).toString("hex")).toBe(expectedDiscHex);
    expect(expectedDiscHex).toBe("b59d59438fb63448"); // canonical Anchor discriminator
  });

  test("builder leaves wSOL wrap to the caller (no SystemProgram.transfer in output)", async () => {
    const r = await client.sync();
    if (!r.ok) throw new Error(`sync failed: ${r.error.code} ${r.error.humanMessage}`);

    const built = client.buildAddLiquidityTx({
      user: new PublicKey(MAINNET_PROGRAM),
      tokenAmounts: r.data.tokens.map(t => t.actualBalance.divn(100).addn(1)),
      minimumBptAmount: new BN(1),
    });
    if (!built.ok) throw new Error(`build failed: ${built.error.humanMessage}`);

    const transfersInjected = built.data.instructions.some((i) =>
      isSystemTransfer(i.programId, Buffer.from(i.data))
    );
    expect(transfersInjected).toBe(false);
  });

  test("the on-chain cubic_pool program is the deployed mainnet binary", async () => {
    const programInfo = await conn.getAccountInfo(new PublicKey(MAINNET_PROGRAM));
    expect(programInfo).not.toBeNull();
    expect(programInfo!.owner.toBase58()).toBe("BPFLoaderUpgradeab1e11111111111111111111111");
    expect(programInfo!.executable).toBe(true);
  });
});

test("unsupported v3 account layouts fail explicitly instead of skipping sync checks", () => {
  expect(() => decodePoolAccount(Buffer.alloc(POOL_V3_LEN))).toThrow(/v3|legacy|unsupported/i);
});
