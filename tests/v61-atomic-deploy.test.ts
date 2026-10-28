/**
 * T8 atomic deploy (`buildAtomicDeploy`) against a fake connection: layouts
 * by token count, paused launch, Jito marker, hooked deploy, identity
 * verification, and the refusals.
 */
import { AddressLookupTableProgram, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import {
  buildAtomicDeploy, DeployBuildConnection, SOLANA_TX_LIMIT, TRACE_BUDGET, INIT_POOL_TRACE, ATA_CREATE_TRACE, seedTrace, JITO_DONT_FRONT,
  POOL_CONFIG_LEN, POOL_CONFIG_DISCRIMINATOR, v0WireSize, v0AccountCount, randomPoolId, assertDontFrontReadOnly, bundleTransactions, deployHookAccounts,
} from "../src/clients/atomicDeploy";
import { validatePoolIdentity, verifyCreatedPool, POOL_ACCOUNT_DISCRIMINATOR, randomPoolIdU64 } from "../src/clients/poolIdentity";
import { POOL_LAYOUT, TOKEN_SLOT_LAYOUT, POOL_LEN_V61, POOL_LEN_V5 } from "../src/parsers/layout";
import { LP_METADATA_GOOD } from "../src/utils/lpMetadata";
import { hookCallerPda } from "../src/utils/hooks";
import { HOOK_FLAGS, DEFAULT_INITIAL_LP_SUPPLY, MIN_INITIAL_LP_SUPPLY } from "../src/config";
import { derivePoolPda, deriveLpMint, deriveAta } from "../src/utils/pda";
import { cfg } from "./helpers/poolFixture";
import type { ExpectedPoolIdentity } from "../src/types/tx-v61";

const pk = (): PublicKey => Keypair.generate().publicKey;
const BLOCKHASH = "11111111111111111111111111111111";

interface FakeOpts { mintOwners?: Map<string, PublicKey>; occupied?: Map<string, { owner: PublicKey; data: Buffer }>; config?: { owner: PublicKey; data: Buffer } | null }
function fakeConnection(configKey: PublicKey, o: FakeOpts = {}): DeployBuildConnection & { calls: string[] } {
  const configInfo = o.config === undefined ? { owner: cfg.programs.cofferPool, data: Buffer.concat([POOL_CONFIG_DISCRIMINATOR, Buffer.alloc(POOL_CONFIG_LEN - 8)]) } : o.config;
  const calls: string[] = [];
  return {
    calls,
    async getMultipleAccountsInfo(keys) {
      calls.push("getMultipleAccountsInfo");
      return keys.map((k) => {
        const s = k.toBase58();
        if (k.equals(configKey)) return configInfo ? { ...configInfo, executable: false, lamports: 1 } : null;
        if (o.occupied?.has(s)) return { ...o.occupied.get(s)!, executable: false, lamports: 1 };
        if (o.mintOwners?.has(s)) return { owner: o.mintOwners.get(s)!, data: Buffer.alloc(82), executable: false, lamports: 1 };
        return null;
      });
    },
    async getLatestBlockhash() { calls.push("getLatestBlockhash"); return { blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 }; },
    async getBlockHeight() { calls.push("getBlockHeight"); return 900; },
    async getSlot() { calls.push("getSlot"); return 123_456; },
  };
}
function params(n: number, extra: Record<string, unknown> = {}) {
  const mints = Array.from({ length: n }, pk);
  const w = Math.floor(10_000 / n);
  return {
    payer: pk(), config: pk(), mints, tokenPrograms: Array(n).fill(TOKEN_PROGRAM_ID),
    weights: Array.from({ length: n }, (_, i) => new BN(i === n - 1 ? 10_000 - w * (n - 1) : w)),
    virtualBalances: Array(n).fill(new BN(1_000_000)), swapFeeRate: 3000, seedAmounts: Array(n).fill(new BN(1_000)), lpMetadata: LP_METADATA_GOOD, poolId: new BN(7), ...extra,
  } as any;
}
const progs = (tx: VersionedTransaction) => tx.message.compiledInstructions.map((ci) => tx.message.staticAccountKeys[ci.programIdIndex].toBase58());
const INIT_DISC = "5fb40aac54aee828", SEED_DISC = "b4395e2349300d0b", SET_SWAPS_DISC = "909acd3af1a94028";
const discs = (ixs: { data: Buffer }[]) => ixs.map((ix) => ix.data.subarray(0, 8).toString("hex"));

describe("layouts", () => {
  test("[P01] n=2: single transaction, init + 3 ATAs + seed, CU ix first, no ALT", async () => {
    const p = params(2); const conn = fakeConnection(p.config);
    const r = await buildAtomicDeploy(cfg, conn, p);
    expect(r.layout).toBe("single"); expect(r.transactions.length).toBe(1); expect(r.seedTxIndex).toBe(1); expect(r.poolTxCount).toBe(1); expect(r.altAddress).toBeNull();
    const ixs = r.instructions[0];
    expect(ixs[0].programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(discs(ixs.slice(1, 2))).toEqual([INIT_DISC]);
    expect(ixs.slice(2, 5).every((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID))).toBe(true);
    expect(discs(ixs.slice(5))).toEqual([SEED_DISC]);
    expect(r.txSizes[0]).toBe(v0WireSize(r.transactions[0].message as any)); expect(r.txSizes[0]).toBeLessThanOrEqual(SOLANA_TX_LIMIT);
    expect(r.traces[0]).toBe(INIT_POOL_TRACE + ATA_CREATE_TRACE * 3 + seedTrace(2) + 1); expect(r.traces[0]).toBeLessThanOrEqual(TRACE_BUDGET);
    expect(r.blockhash).toBe(BLOCKHASH); expect(r.lastValidBlockHeight).toBe(1_000);
    expect(r.poolPda.equals(derivePoolPda(cfg.programs.cofferPool, p.config, p.poolId)[0])).toBe(true);
    expect(r.lpMint.equals(deriveLpMint(cfg.programs.cofferPool, r.poolPda)[0])).toBe(true);
    expect(r.vaults.map(String)).toEqual(p.mints.map((m: PublicKey) => deriveAta(r.poolPda, m, TOKEN_PROGRAM_ID).toBase58()));
    expect(r.userLpAccount.equals(deriveAta(p.payer, r.lpMint, TOKEN_2022_PROGRAM_ID))).toBe(true);
    expect(r.swapsEnabledAtLaunch).toBe(true); expect(r.computeBudgetInTx2).toBe(true);
    expect(conn.calls).not.toContain("getSlot");
  });
  test("[P02] n=5: ALT in tx1, init + ATAs + seed in tx2 (alt-1)", async () => {
    const p = params(5); const r = await buildAtomicDeploy(cfg, fakeConnection(p.config), p);
    expect(r.layout).toBe("alt-1"); expect(r.transactions.length).toBe(2); expect(r.seedTxIndex).toBe(2); expect(r.poolTxCount).toBe(1);
    expect(r.altAddress).not.toBeNull(); expect(r.altAddresses.length).toBeGreaterThan(0);
    expect(r.instructions[0][0].programId.equals(AddressLookupTableProgram.programId)).toBe(true);
    expect(discs(r.instructions[1]).filter((d) => d === INIT_DISC || d === SEED_DISC)).toEqual([INIT_DISC, SEED_DISC]);
    expect(r.txSizes.every((s) => s <= SOLANA_TX_LIMIT)).toBe(true); expect(r.traces.every((t) => t <= TRACE_BUDGET)).toBe(true);
    expect(r.transactions[1].message.addressTableLookups.length).toBe(1);
    expect(r.transactions[1].message.addressTableLookups[0].accountKey.equals(r.altAddress!)).toBe(true);
    expect(bundleTransactions(r).length).toBe(1);
  });
  test("[P03] n=10: the ALT packet is full (1232 B), so init gets its own packet (alt-2) and the seed is last", async () => {
    const p = params(10); const r = await buildAtomicDeploy(cfg, fakeConnection(p.config), p);
    expect(r.layout).toBe("alt-2"); expect(r.transactions.length).toBe(3); expect(r.seedTxIndex).toBe(3); expect(r.poolTxCount).toBe(2);
    expect(r.txSizes[0]).toBe(SOLANA_TX_LIMIT); expect(r.altAddresses.length).toBe(30);
    expect(discs(r.instructions[1])).toContain(INIT_DISC); expect(discs(r.instructions[1])).not.toContain(SEED_DISC);
    expect(discs(r.instructions[2])).toContain(SEED_DISC); expect(discs(r.instructions[2])).not.toContain(INIT_DISC);
    expect(r.txSizes.every((s) => s <= SOLANA_TX_LIMIT)).toBe(true); expect(r.traces.every((t) => t <= TRACE_BUDGET)).toBe(true);
    // tx3 = 10 ATAs + seed is exactly at the trace budget with spill 1 and NO explicit CU ix (the default
    // 200k × top-level budget covers it); tx2 = init + 1 vault ATA.
    expect(r.vaultAtasInTx1).toBe(1); expect(r.computeBudgetInTx2).toBe(false);
    expect(r.traces).toEqual([2, INIT_POOL_TRACE + ATA_CREATE_TRACE, ATA_CREATE_TRACE * 10 + seedTrace(10)]);
    expect(r.traces[2]).toBe(TRACE_BUDGET);
    expect(r.instructions[2].some((ix) => ix.programId.equals(ComputeBudgetProgram.programId))).toBe(false);
    expect(r.instructions[1].filter((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).length).toBe(1);
    expect(r.instructions[2].filter((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).length).toBe(10);
    expect(r.accountCount).toBeGreaterThan(30);
    // the bundle = the pool-state transactions (the ALT packet lands first, on its own)
    expect(bundleTransactions(r).length).toBe(2);
  });
  test("[P04] every layout shares one blockhash and the seed carries the creator-chosen LP supply", async () => {
    for (const n of [2, 5, 10]) {
      const p = params(n, { initialLpSupply: new BN(MIN_INITIAL_LP_SUPPLY.toString()) });
      const r = await buildAtomicDeploy(cfg, fakeConnection(p.config), p);
      expect(r.transactions.every((tx) => tx.message.recentBlockhash === BLOCKHASH)).toBe(true);
      const seed = r.instructions[r.seedTxIndex - 1].find((ix) => ix.data.subarray(0, 8).toString("hex") === SEED_DISC)!;
      expect(seed.data.readBigUInt64LE(8 + 4 + 8 * n)).toBe(MIN_INITIAL_LP_SUPPLY);
    }
    const p2 = params(2);
    const d = await buildAtomicDeploy(cfg, fakeConnection(p2.config), p2);
    const seed = d.instructions[0].find((ix) => ix.data.subarray(0, 8).toString("hex") === SEED_DISC)!;
    expect(seed.data.readBigUInt64LE(8 + 4 + 16)).toBe(DEFAULT_INITIAL_LP_SUPPLY);
  });
  test("[P05] layout: \"alt\" forces a table even for n=2; \"single\" refuses n=10; allowSplit false refuses n=10", async () => {
    const p2 = params(2, { layout: "alt" });
    expect((await buildAtomicDeploy(cfg, fakeConnection(p2.config), p2)).layout).toBe("alt-1");
    const p10 = params(10, { layout: "single" });
    await expect(buildAtomicDeploy(cfg, fakeConnection(p10.config), p10)).rejects.toThrow(/no deploy layout fits/);
    const p10b = params(10, { allowSplit: false });
    await expect(buildAtomicDeploy(cfg, fakeConnection(p10b.config), p10b)).rejects.toThrow(/no deploy layout fits/);
  });
  test("[P06] an explicit blockhash / recentSlot skips the RPC; a priority fee adds the price ix", async () => {
    const p = params(5, { blockhash: BLOCKHASH, recentSlot: 5, computeUnitPrice: 1_000 }); const conn = fakeConnection(p.config);
    const r = await buildAtomicDeploy(cfg, conn, p);
    expect(conn.calls).not.toContain("getLatestBlockhash"); expect(conn.calls).not.toContain("getSlot"); expect(conn.calls).toContain("getBlockHeight");
    expect(r.lastValidBlockHeight).toBe(900 + 150);
    expect(r.instructions[1].filter((ix) => ix.programId.equals(ComputeBudgetProgram.programId)).length).toBe(2);
  });
  test("[P07] token programs are read from the mint owners when omitted", async () => {
    const p = params(2); delete p.tokenPrograms;
    const owners = new Map<string, PublicKey>([[p.mints[0].toBase58(), TOKEN_PROGRAM_ID], [p.mints[1].toBase58(), TOKEN_2022_PROGRAM_ID]]);
    const r = await buildAtomicDeploy(cfg, fakeConnection(p.config, { mintOwners: owners }), p);
    expect(r.tokenPrograms.map(String)).toEqual([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]);
    expect(r.expectedIdentity.tokenPrograms[1].equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });
});

describe("paused launch, Jito marker, hooks", () => {
  test("[P08] swapsEnabledAtLaunch false: set_swaps_enabled(false) rides in the seed transaction, identity records it", async () => {
    for (const n of [2, 5, 10]) {
      const p = params(n, { swapsEnabledAtLaunch: false }); const r = await buildAtomicDeploy(cfg, fakeConnection(p.config), p);
      const seedIxs = r.instructions[r.seedTxIndex - 1];
      const d = discs(seedIxs);
      expect(d[d.length - 1]).toBe(SET_SWAPS_DISC); expect(d[d.length - 2]).toBe(SEED_DISC);
      expect(seedIxs[seedIxs.length - 1].data[8]).toBe(0);
      expect(r.expectedIdentity.swapsEnabled).toBe(false); expect(r.swapsEnabledAtLaunch).toBe(false);
    }
  });
  test("[P09] jitoDontFront: the marker is a read-only key of the seed tx's ComputeBudget ix and the assertion passes", async () => {
    for (const n of [2, 5, 10]) {
      const p = params(n, { jitoDontFront: true }); const r = await buildAtomicDeploy(cfg, fakeConnection(p.config), p);
      const seedTx = r.transactions[r.seedTxIndex - 1];
      const idx = seedTx.message.staticAccountKeys.findIndex((k) => k.equals(JITO_DONT_FRONT));
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(seedTx.message.isAccountWritable(idx)).toBe(false); expect(seedTx.message.isAccountSigner(idx)).toBe(false);
      expect(() => assertDontFrontReadOnly(seedTx)).not.toThrow();
      expect(r.computeBudgetInTx2).toBe(true);
      // The marker never leaks into the earlier (ALT) transactions.
      for (const tx of r.transactions.slice(0, -1)) expect(tx.message.staticAccountKeys.some((k) => k.equals(JITO_DONT_FRONT))).toBe(false);
    }
  });
  test("[P10] a hooked deploy: Option<HookConfig>=Some in init, the slice after the mints and after the seed's ×4 block", async () => {
    const hookProgram = pk();
    const hookConfig = { program: hookProgram, flags: HOOK_FLAGS.BEFORE_SWAP | HOOK_FLAGS.BEFORE_ADD_LIQUIDITY, feeMin: 0, feeMax: 0, maxCu: 20_000, accountsLen: 2 };
    const hookAccounts = deployHookAccounts({ hookConfig, hookAccounts: [{ pubkey: hookProgram, isSigner: false, isWritable: false }, { pubkey: hookCallerPda(cfg.programs.cofferPool)[0], isSigner: false, isWritable: false }] });
    expect(hookAccounts.length).toBe(2);
    const p = params(2, { hookConfig, hookAccounts }); const r = await buildAtomicDeploy(cfg, fakeConnection(p.config), p);
    const init = r.instructions[0].find((ix) => ix.data.subarray(0, 8).toString("hex") === INIT_DISC)!;
    expect(init.data[init.data.length - 48]).toBe(1);
    expect(init.keys.slice(-2).map((k) => k.pubkey.toBase58())).toEqual(hookAccounts.map((a) => a.pubkey.toBase58()));
    const seed = r.instructions[0].find((ix) => ix.data.subarray(0, 8).toString("hex") === SEED_DISC)!;
    expect(seed.keys.slice(-2).map((k) => k.pubkey.toBase58())).toEqual(hookAccounts.map((a) => a.pubkey.toBase58()));
    expect(r.altAddresses.length).toBe(0);
    expect(deployHookAccounts({})).toEqual([]);
  });
  test("[P11] fee parameters reach initialize_pool", async () => {
    const p = params(2, { creatorFeeBps: 2500, depositFeeBps: 5, withdrawFeeBps: 7 }); const r = await buildAtomicDeploy(cfg, fakeConnection(p.config), p);
    const init = r.instructions[0].find((ix) => ix.data.subarray(0, 8).toString("hex") === INIT_DISC)!;
    const o = init.data.length - 7;
    expect([init.data.readUInt16LE(o), init.data.readUInt16LE(o + 2), init.data.readUInt16LE(o + 4), init.data[o + 6]]).toEqual([2500, 5, 7, 0]);
  });
});

describe("refusals", () => {
  test("[N01] token count, array lengths, weights sum, zero vb, all-zero seed", async () => {
    const conn = (p: any) => fakeConnection(p.config);
    const one = params(1); await expect(buildAtomicDeploy(cfg, conn(one), one)).rejects.toThrow(/outside \[2, 10\]/);
    const eleven = params(11); await expect(buildAtomicDeploy(cfg, conn(eleven), eleven)).rejects.toThrow(/outside \[2, 10\]/);
    const badLen = params(2, { weights: [new BN(10_000)] }); await expect(buildAtomicDeploy(cfg, conn(badLen), badLen)).rejects.toThrow(/match mints length/);
    const badSum = params(2, { weights: [new BN(5000), new BN(4000)] }); await expect(buildAtomicDeploy(cfg, conn(badSum), badSum)).rejects.toThrow(/sum to 10000/);
    const zeroVb = params(2, { virtualBalances: [new BN(0), new BN(1)] }); await expect(buildAtomicDeploy(cfg, conn(zeroVb), zeroVb)).rejects.toThrow(/> 0/);
    const zeroSeed = params(2, { seedAmounts: [new BN(0), new BN(0)] }); await expect(buildAtomicDeploy(cfg, conn(zeroSeed), zeroSeed)).rejects.toThrow(/non-zero/);
  });
  test("[N02] LP program, LP metadata, hook config / slice, supply bounds", async () => {
    const conn = (p: any) => fakeConnection(p.config);
    const spl = params(2, { lpTokenProgram: TOKEN_PROGRAM_ID }); await expect(buildAtomicDeploy(cfg, conn(spl), spl)).rejects.toThrow(/Token-2022/);
    const meta = params(2, { lpMetadata: { name: "", symbol: "x", uri: "https://x" } }); await expect(buildAtomicDeploy(cfg, conn(meta), meta)).rejects.toThrow(/LpNameInvalid/);
    const hook = params(2, { hookConfig: { program: pk(), flags: 0, feeMin: 0, feeMax: 0, maxCu: 20_000, accountsLen: 2 } }); await expect(buildAtomicDeploy(cfg, conn(hook), hook)).rejects.toThrow(/callback/);
    const slice = params(2, { hookConfig: { program: pk(), flags: HOOK_FLAGS.BEFORE_SWAP, feeMin: 0, feeMax: 0, maxCu: 20_000, accountsLen: 3 }, hookAccounts: [] }); await expect(buildAtomicDeploy(cfg, conn(slice), slice)).rejects.toThrow(/hookAccounts length/);
    const supply = params(2, { initialLpSupply: new BN(1) }); await expect(buildAtomicDeploy(cfg, conn(supply), supply)).rejects.toThrow(/InitialLiquidityTooSmall/);
  });
  test("[N03] occupied pool / LP mint address, missing or foreign config, bad config layout, missing mint", async () => {
    const p = params(2);
    const [poolPda] = derivePoolPda(cfg.programs.cofferPool, p.config, p.poolId); const [lpMint] = deriveLpMint(cfg.programs.cofferPool, poolPda);
    await expect(buildAtomicDeploy(cfg, fakeConnection(p.config, { occupied: new Map([[poolPda.toBase58(), { owner: cfg.programs.cofferPool, data: Buffer.alloc(2304) }]]) }), p)).rejects.toThrow(/already exists/);
    await expect(buildAtomicDeploy(cfg, fakeConnection(p.config, { occupied: new Map([[poolPda.toBase58(), { owner: pk(), data: Buffer.alloc(1) }]]) }), p)).rejects.toThrow(/foreign account/);
    await expect(buildAtomicDeploy(cfg, fakeConnection(p.config, { occupied: new Map([[lpMint.toBase58(), { owner: TOKEN_2022_PROGRAM_ID, data: Buffer.alloc(82) }]]) }), p)).rejects.toThrow(/already exists/);
    // a pre-funded system account with no data is fine
    await expect(buildAtomicDeploy(cfg, fakeConnection(p.config, { occupied: new Map([[poolPda.toBase58(), { owner: SystemProgram.programId, data: Buffer.alloc(0) }]]) }), p)).resolves.toBeDefined();
    await expect(buildAtomicDeploy(cfg, fakeConnection(p.config, { config: null }), p)).rejects.toThrow(/missing config/);
    await expect(buildAtomicDeploy(cfg, fakeConnection(p.config, { config: { owner: pk(), data: Buffer.alloc(POOL_CONFIG_LEN) } }), p)).rejects.toThrow(/config owner/);
    await expect(buildAtomicDeploy(cfg, fakeConnection(p.config, { config: { owner: cfg.programs.cofferPool, data: Buffer.alloc(POOL_CONFIG_LEN) } }), p)).rejects.toThrow(/config layout/);
    await expect(buildAtomicDeploy(cfg, fakeConnection(p.config, { config: { owner: cfg.programs.cofferPool, data: Buffer.alloc(100) } }), p)).rejects.toThrow(/config layout/);
    const noPrograms = params(2); delete noPrograms.tokenPrograms;
    await expect(buildAtomicDeploy(cfg, fakeConnection(noPrograms.config), noPrograms)).rejects.toThrow(/does not exist/);
  });
  test("[N04] the dont-front assertion rejects a writable marker", async () => {
    const p = params(2, { jitoDontFront: true }); const r = await buildAtomicDeploy(cfg, fakeConnection(p.config), p);
    const tx = r.transactions[0];
    const idx = tx.message.staticAccountKeys.findIndex((k) => k.equals(JITO_DONT_FRONT));
    const header = tx.message.header;
    // move the marker into the writable non-signer range by rewriting the header counts
    const forged = new VersionedTransaction(Object.assign(Object.create(Object.getPrototypeOf(tx.message)), tx.message, { header: { ...header, numReadonlyUnsignedAccounts: 0 } }));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(() => assertDontFrontReadOnly(forged)).toThrow();
  });
});

describe("pool identity (I-08)", () => {
  function image(expected: ExpectedPoolIdentity, len = POOL_LEN_V61, o: { swapsEnabled?: boolean; admin?: PublicKey } = {}): Buffer {
    const b = Buffer.alloc(len);
    POOL_ACCOUNT_DISCRIMINATOR.copy(b, 0);
    expected.config.toBuffer().copy(b, POOL_LAYOUT.CONFIG.offset);
    b[POOL_LAYOUT.TOKEN_COUNT.offset] = expected.mints.length;
    b.writeBigUInt64LE(expected.poolId, POOL_LAYOUT.POOL_ID.offset);
    b.writeUInt32LE(expected.swapFeeRate, POOL_LAYOUT.SWAP_FEE_RATE.offset);
    b[POOL_LAYOUT.POOL_ENABLED.offset] = 1; b[POOL_LAYOUT.SWAPS_ENABLED.offset] = (o.swapsEnabled ?? true) ? 1 : 0;
    (o.admin ?? expected.poolAdmin).toBuffer().copy(b, POOL_LAYOUT.POOL_ADMIN.offset);
    expected.mints.forEach((m, i) => {
      const s = POOL_LAYOUT.TOKENS.offset + i * TOKEN_SLOT_LAYOUT.TOTAL;
      m.toBuffer().copy(b, s + TOKEN_SLOT_LAYOUT.MINT.offset); expected.tokenPrograms[i].toBuffer().copy(b, s + TOKEN_SLOT_LAYOUT.TOKEN_PROGRAM.offset);
      b.writeBigUInt64LE(expected.weights[i], s + TOKEN_SLOT_LAYOUT.NORMALIZED_WEIGHT.offset);
    });
    return b;
  }
  const expectedOf = (): ExpectedPoolIdentity => ({
    programId: cfg.programs.cofferPool, config: pk(), poolId: 7n, poolAdmin: pk(), mints: [pk(), pk()], tokenPrograms: [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID],
    weights: [6000n, 4000n], swapFeeRate: 3000, swapsEnabled: true,
  });
  const addrOf = (e: ExpectedPoolIdentity) => { const s = Buffer.alloc(8); s.writeBigUInt64LE(e.poolId); return PublicKey.findProgramAddressSync([Buffer.from("cubic_pool"), e.config.toBuffer(), s], e.programId)[0]; };
  test("[P12] a matching 2304-byte image verifies (and the 1683-byte prefix too)", async () => {
    const e = expectedOf(); const addr = addrOf(e);
    const v = validatePoolIdentity(addr, { owner: e.programId, data: image(e) }, e);
    expect(v.poolId).toBe("7"); expect(v.tokenCount).toBe(2); expect(v.swapsEnabled).toBe(true); expect(v.tokens[1].tokenProgram).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    validatePoolIdentity(addr, { owner: e.programId, data: image(e, POOL_LEN_V5) }, e);
    const viaConn = await verifyCreatedPool({ getAccountInfo: async () => ({ owner: e.programId, data: image(e), executable: false, lamports: 1 }) }, addr, e);
    expect(viaConn.config).toBe(e.config.toBase58());
    expect(() => validatePoolIdentity(addr, { owner: e.programId, data: image(e, POOL_LEN_V61, { swapsEnabled: false }) }, { ...e, swapsEnabled: undefined })).not.toThrow();
  });
  test("[P13] random pool ids are 8-byte u64 and differ", () => {
    const a = randomPoolId(), b = randomPoolId();
    expect(a.bitLength()).toBeLessThanOrEqual(64); expect(a.eq(b)).toBe(false);
    expect(randomPoolIdU64() <= 0xffff_ffff_ffff_ffffn).toBe(true);
  });
  test("[N05] every divergence is named: PDA, owner, layout, discriminator, config, pool_id, admin, fee, launch state, mint, program, weight", async () => {
    const e = expectedOf(); const addr = addrOf(e); const ok = image(e);
    const mut = (f: (b: Buffer) => void) => { const b = Buffer.from(ok); f(b); return b; };
    expect(() => validatePoolIdentity(pk(), { owner: e.programId, data: ok }, e)).toThrow(/mismatch: PDA/);
    expect(() => validatePoolIdentity(addr, { owner: pk(), data: ok }, e)).toThrow(/program owner/);
    expect(() => validatePoolIdentity(addr, { owner: e.programId, data: Buffer.alloc(1154) }, e)).toThrow(/account layout/);
    expect(() => validatePoolIdentity(addr, { owner: e.programId, data: mut((b) => { b[0] ^= 1; }) }, e)).toThrow(/discriminator/);
    expect(() => validatePoolIdentity(addr, { owner: e.programId, data: mut((b) => pk().toBuffer().copy(b, POOL_LAYOUT.CONFIG.offset)) }, e)).toThrow(/config/);
    expect(() => validatePoolIdentity(addr, { owner: e.programId, data: mut((b) => b.writeBigUInt64LE(8n, POOL_LAYOUT.POOL_ID.offset)) }, e)).toThrow(/pool_id/);
    expect(() => validatePoolIdentity(addr, { owner: e.programId, data: image(e, POOL_LEN_V61, { admin: pk() }) }, e)).toThrow(/pool_admin/);
    expect(() => validatePoolIdentity(addr, { owner: e.programId, data: mut((b) => b.writeUInt32LE(1, POOL_LAYOUT.SWAP_FEE_RATE.offset)) }, e)).toThrow(/swap fee/);
    expect(() => validatePoolIdentity(addr, { owner: e.programId, data: image(e, POOL_LEN_V61, { swapsEnabled: false }) }, e)).toThrow(/launch state/);
    expect(() => validatePoolIdentity(addr, { owner: e.programId, data: mut((b) => pk().toBuffer().copy(b, POOL_LAYOUT.TOKENS.offset + TOKEN_SLOT_LAYOUT.TOTAL)) }, e)).toThrow(/mint\[1\]/);
    expect(() => validatePoolIdentity(addr, { owner: e.programId, data: mut((b) => TOKEN_PROGRAM_ID.toBuffer().copy(b, POOL_LAYOUT.TOKENS.offset + TOKEN_SLOT_LAYOUT.TOTAL + 32)) }, e)).toThrow(/token program\[1\]/);
    expect(() => validatePoolIdentity(addr, { owner: e.programId, data: mut((b) => b.writeBigUInt64LE(1n, POOL_LAYOUT.TOKENS.offset + 64)) }, e)).toThrow(/weight\[0\]/);
    expect(() => validatePoolIdentity(addr, { owner: e.programId, data: mut((b) => { b[POOL_LAYOUT.TOKEN_COUNT.offset] = 3; }) }, e)).toThrow(/token count/);
    await expect(verifyCreatedPool({ getAccountInfo: async () => null }, addr, e)).rejects.toThrow(/missing after confirmation/);
    expect(() => validatePoolIdentity(addr, { owner: e.programId, data: ok }, { ...e, weights: [1n] })).toThrow(/identity lengths/);
    expect(() => validatePoolIdentity(addr, { owner: e.programId, data: ok }, { ...e, poolId: -1n })).toThrow(/u64/);
  });
  test("[N06] v0 size accounting helpers agree with serialize() where it does not throw", async () => {
    const p = params(2); const r = await buildAtomicDeploy(cfg, fakeConnection(p.config), p);
    const tx = r.transactions[0];
    expect(v0WireSize(tx.message as any)).toBe(tx.serialize().length);
    expect(v0AccountCount(tx.message as any)).toBe(tx.message.staticAccountKeys.length);
  });
});
