import BN from "bn.js";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { CofferPoolClient } from "../src/clients/CofferPoolClient";
import { RpcClient } from "../src/clients/RpcClient";
import { buildRemoveLiquidityTx, buildRemoveLiquidityIx, buildRemoveLiquidityBypassHooksIx, buildSeedLiquidityIx } from "../src/clients/tx-builders";
import { calcEffectiveLpBurn, virtualBalanceAfterWithdrawal } from "../src/math/poolMath";
import { decodePoolAccount } from "../src/parsers/poolAccount";
import { parseContractEvents } from "../src/parsers/contracts";
import { parseCofferPoolEvents } from "../src/parsers/events";
import { SAFETY_FLAG_RANGE_MANAGER_RESTRICTED, SAFETY_FLAG_RANGE_MANAGER_WAS_ENABLED, SAFETY_FLAGS_KNOWN_MASK } from "../src/config";
import adminFixtures from "./fixtures/events/protocol_admin.json";
import { mockPool, cfg, pk } from "./helpers/poolFixture";
import type { PoolInfo } from "../src/types/pool";

function clientFor(pool: PoolInfo) {
  const client = new CofferPoolClient({ config: cfg, poolAddress: pool.address });
  (client as unknown as { cache: PoolInfo }).cache = pool;
  return client;
}

describe("rc2 external LP burns", () => {
  test.each([[1n, 1n, 1n], [999n, 999n, 999n], [500n, 1_000n, 500n], [1_000n, 1_000n, 1_000n], [1_001n, 1_001n, 1n], [5_000n, 5_000n, 4_000n]])(
    "burn %s at supply %s leaves the normal floor unless external burns already consumed it", (requested, supply, expected) => {
      expect(calcEffectiveLpBurn(requested, supply)).toBe(expected);
    });
  test("a full redemption empties reserves and keeps the strict virtual floor", () => {
    expect(virtualBalanceAfterWithdrawal(2_000n, 1_000n, 1_000n, 999n, 999n)).toBe(1n);
    expect(virtualBalanceAfterWithdrawal(2_000n, 0n, 0n, 999n, 999n)).toBe(1n);
    expect(() => virtualBalanceAfterWithdrawal(2_000n, 1_000n, 1_000n, 998n, 999n)).toThrow(/InvalidAmounts/);
    expect(() => calcEffectiveLpBurn(1n, 0n)).toThrow(/InvalidLpAmount/);
    expect(() => calcEffectiveLpBurn(2n, 1n)).toThrow(/InvalidLpAmount/);
  });
  test("quoteRemove redeems a below-floor holder's full reserve and surge share", () => {
    const pool = mockPool({ lpSupply: 999n, balances: [[100n, 1_000n], [0n, 1_000n]], surge: [20n, 50n] });
    const result = clientFor(pool).quoteRemove(new BN(999));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.humanMessage);
    expect(result.data.effectiveLpIn.toString()).toBe("999");
    expect(result.data.virtualBalancesAfter.map(String)).toEqual(["1", "1"]);
    expect(result.data.transferAmounts.map(String)).toEqual(["120", "50"]);
  });
  test("a permanently seeded zero-supply pool cannot be re-seeded by the builder or quote", () => {
    const user = pk();
    const pool = mockPool({ poolAdmin: user, lpSupply: 0n, balances: [[0n, 1_000n], [0n, 1_000n]] });
    pool.seeded = true;
    const params = { user, tokenAmounts: [new BN(100), new BN(0)], lpAmount: new BN(1_000_000_000) };
    expect(() => buildSeedLiquidityIx(cfg, pool, params)).toThrow(/PoolAlreadySeeded/);
    const q = clientFor(pool).quoteSeedDeposit(user, params.tokenAmounts, params.lpAmount);
    expect(q.ok).toBe(false);
    if (!q.ok) expect(q.error.humanMessage).toMatch(/PoolAlreadySeeded/);
  });
});

describe("rc2 zero-payout mint validation", () => {
  const user = pk();
  const params = { user, lpAmount: new BN(500), minimumTokenAmounts: [new BN(0), new BN(0)] };
  test("closed zero legs need no ATA, including when the whole remaining supply burns", () => {
    const pool = mockPool({ lpSupply: 500n, balances: [[1_000n, 2_000n], [0n, 1_000n]] });
    pool.tokens[1].missingMint = true;
    for (const builder of [buildRemoveLiquidityIx, buildRemoveLiquidityBypassHooksIx]) expect(() => builder(cfg, pool, params)).not.toThrow();
    const tx = buildRemoveLiquidityTx(cfg, pool, params);
    expect(tx.instructions.filter(ix => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID))).toHaveLength(1);
    expect(clientFor(pool).quoteRemove(params.lpAmount).ok).toBe(true);
  });
  test("a surge-only payout is validated and receives its ATA even with zero curve reserves", () => {
    const pool = mockPool({ lpSupply: 500n, balances: [[1_000n, 2_000n], [0n, 1_000n]], surge: [0n, 100n] });
    const tx = buildRemoveLiquidityTx(cfg, pool, params);
    expect(tx.instructions.filter(ix => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID))).toHaveLength(2);
    pool.tokens[1].missingMint = true;
    for (const builder of [buildRemoveLiquidityIx, buildRemoveLiquidityBypassHooksIx]) expect(() => builder(cfg, pool, params)).toThrow(/mint account is absent or closed/);
    expect(clientFor(pool).quoteRemove(params.lpAmount).ok).toBe(false);
  });
  test("a dust/fee-rounded zero payout never creates an ATA for its unusable mint", () => {
    const pool = mockPool({ lpSupply: 2_000n, balances: [[1_000n, 2_000n], [1n, 1_000n]], withdrawFeeBps: 100 });
    pool.tokens[1].missingMint = true;
    const tx = buildRemoveLiquidityTx(cfg, pool, params);
    expect(tx.instructions.filter(ix => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID))).toHaveLength(1);
  });
});

describe("rc2 wire flags and closed-mint reads", () => {
  function bytes(mints: PublicKey[]) {
    const b = Buffer.alloc(2304);
    Buffer.from("89d22a16d19c2b4e", "hex").copy(b);
    pk().toBuffer().copy(b, 8); b[41] = 2; b[64] = 1; b[65] = 1;
    b[1683] = 1; b[1684] = 6; b[1685] = 6;
    for (let i = 0; i < 2; i++) {
      const s = 179 + 144 * i;
      mints[i].toBuffer().copy(b, s); TOKEN_PROGRAM_ID.toBuffer().copy(b, s + 32);
      b.writeBigUInt64LE(5_000n, s + 64); b[s + 84] = 1;
      b.writeBigUInt64LE(2_000n, s + 88); b.writeBigUInt64LE(i ? 0n : 1_000n, s + 96);
    }
    b.writeUInt16LE(1 | (1 << 2) | (1 << 11) | (1 << 12) | (1 << 13), 2102);
    b.writeUInt16LE(5_000, 2104); b.writeUInt16LE(5_000, 2106);
    return b;
  }
  test("flags and immutable weight anchors are decoded without reserve drift", () => {
    const b = bytes([pk(), pk()]);
    const raw = decodePoolAccount(b);
    expect(raw.safetyFlags).toBe(14_341);
    expect(raw.rangeManagerWeightAnchors.slice(0, 2)).toEqual([5_000, 5_000]);
    expect(raw.reservedV61).toHaveLength(180);
    expect(raw.layoutDrift).toEqual([]);
  });
  test.each(["absent", "closed"])("sync preserves exits when an empty leg's mint is %s", async kind => {
    const pool = pk(), mints = [pk(), pk()], data = bytes(mints);
    const rpc = new RpcClient({ endpoint: "http://127.0.0.1:1" });
    const mint = Buffer.alloc(82); mint[44] = 6; mint[45] = 1; mint.writeBigUInt64LE(500n, 36);
    const clock = Buffer.alloc(40); clock.writeBigInt64LE(1_700_000_000n, 32);
    const account = (owner: PublicKey, value: Buffer) => ({ owner, data: value, executable: false, lamports: 1, rentEpoch: 0 });
    jest.spyOn(rpc, "getAccountInfo").mockResolvedValue({ ok: true, data: account(cfg.programs.cofferPool, data) });
    jest.spyOn(rpc, "getMultipleAccountsWithInfo").mockResolvedValue({ ok: true, data: [account(TOKEN_PROGRAM_ID, mint), account(TOKEN_PROGRAM_ID, mint), kind === "absent" ? null : account(SystemProgram.programId, Buffer.alloc(0)), account(SystemProgram.programId, clock)] });
    const client = new CofferPoolClient({ config: cfg, poolAddress: pool, rpc });
    const result = await client.sync();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.humanMessage);
    expect(result.data.tokens[1].missingMint).toBe(true);
    expect(result.data.seeded).toBe(true);
    expect(result.data.protocolRestrictedTokenMask).toBe(2);
    expect(result.data.protocolSwapsRestricted).toBe(true);
    expect(result.data.protocolRangeManagerRestricted).toBe(true);
    expect(result.data.protocolRangeManagerWasEnabled).toBe(true);
    expect(client.quoteRemove(new BN(500)).ok).toBe(true);
    data.writeBigUInt64LE(1n, 179 + 144 + 96);
    expect((await client.sync()).ok).toBe(false);
  });
  test("safety bit 13 (RANGE_MANAGER_WAS_ENABLED) is known, mirrors the program constants and is not drift", () => {
    expect(SAFETY_FLAG_RANGE_MANAGER_RESTRICTED).toBe(1 << 12);
    expect(SAFETY_FLAG_RANGE_MANAGER_WAS_ENABLED).toBe(1 << 13);
    expect(SAFETY_FLAGS_KNOWN_MASK).toBe(0x3fff);
    const b = bytes([pk(), pk()]);
    b.writeUInt16LE(1 << 13, 2102);
    expect(decodePoolAccount(b).layoutDrift).toEqual([]);
    b.writeUInt16LE(1 << 14, 2102);
    expect(decodePoolAccount(b).layoutDrift).toEqual(["unknown safety_flags bits"]);
  });
});

describe("rc2 close_upgrade_buffer", () => {
  test("AdminClient.closeUpgradeBufferIx: [treasury, admin(signer), buffer(mut), recipient(mut), loader], no args", async () => {
    const { AnchorProvider, Wallet } = await import("@coral-xyz/anchor");
    const { Connection, Keypair } = await import("@solana/web3.js");
    const { AdminClient, BPF_LOADER_UPGRADEABLE_PROGRAM_ID } = await import("../src/clients/AdminClient");
    const admin = Keypair.generate();
    const client = new AdminClient({ config: cfg, provider: new AnchorProvider(new Connection("http://127.0.0.1:8899"), new Wallet(admin), {}) });
    const buffer = pk(), recipient = pk();
    const ix = client.closeUpgradeBufferIx(admin.publicKey, buffer, recipient);
    expect(ix.programId.equals(cfg.programs.protocolAdmin)).toBe(true);
    expect(ix.data).toEqual(Buffer.from([236, 125, 119, 188, 84, 47, 236, 62]));
    expect(ix.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [client.treasuryPda.toBase58(), false, false], [admin.publicKey.toBase58(), true, false], [buffer.toBase58(), false, true],
      [recipient.toBase58(), false, true], [BPF_LOADER_UPGRADEABLE_PROGRAM_ID.toBase58(), false, false],
    ]);
  });
  test("UpgradeBufferClosed decodes through both event APIs", () => {
    const fixture = adminFixtures.events.find(e => e.name === "UpgradeBufferClosed")!;
    const line = `Program data: ${fixture.base64}`;
    const [exact] = parseContractEvents([line], "protocolAdmin");
    expect(exact.program).toBe("protocolAdmin"); expect(exact.kind).toBe("UpgradeBufferClosed");
    const data = exact.data as { treasury: PublicKey; admin: PublicKey; buffer: PublicKey; recipient: PublicKey; lamports: BN; timestamp: BN };
    expect(data.buffer.toBase58()).toBe(fixture.value.buffer); expect(data.recipient.toBase58()).toBe(fixture.value.recipient);
    expect(data.lamports.toString()).toBe(fixture.value.lamports); expect(data.timestamp.toString()).toBe(fixture.value.timestamp);
    const [camel] = parseCofferPoolEvents([line]);
    expect(camel.kind).toBe("UpgradeBufferClosed");
    expect((camel as any).lamports.toString()).toBe(fixture.value.lamports); expect((camel as any).timestamp).toBe(Number(fixture.value.timestamp));
  });
});
