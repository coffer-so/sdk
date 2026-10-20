/**
 * v6 remaining-account tail resolver (hook extras + memo), modelled on
 * `contracts/tests/offline/v6-hook-resolver.test.ts`. The registry decoder
 * must be as strict as Rust's TLV walk; the union must never contain a
 * signer or a core account; classic-token legs never read the RPC.
 */
import { AccountInfo, AccountMeta, PublicKey } from "@solana/web3.js";
import {
  addExtraAccountMetasForExecute,
  createTransferCheckedInstruction,
  ExtensionType,
  getExtraAccountMetaAddress,
  getExtraAccountMetas,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import type { Connection } from "@solana/web3.js";
import BN from "bn.js";
import {
  MEMO_PROGRAM_ID,
  resolveTransferExtraAccounts,
  UnsupportedTransferProfileError,
  resolveSwapExtraAccounts,
  resolveAddLiquidityExtraAccounts,
  resolveRemoveLiquidityExtraAccounts,
  buildSwapIx,
  getConfig,
  deriveAta,
} from "../src";
import type { AccountReader, MintSnapshot, TransferLeg } from "../src";
import { PoolInfo } from "../src/types/pool";

const key = (n: number) => { const b = Buffer.alloc(32); b.writeUInt32LE(n); b[31] = 1; return new PublicKey(b); };
const EXECUTE = Buffer.from([105, 37, 101, 197, 75, 251, 102, 26]);
const OTHER = Buffer.from("OTHER_TL");
const hook = key(100), state = key(101);
const meta = (pubkey: PublicKey, isSigner = false, isWritable = true) => {
  const data = Buffer.alloc(35); pubkey.toBuffer().copy(data, 1); data[33] = +isSigner; data[34] = +isWritable; return data;
};
function tlv(tag: Buffer, value: Buffer) {
  const header = Buffer.alloc(12); tag.copy(header); header.writeUInt32LE(value.length, 8);
  return Buffer.concat([header, value]);
}
function registry(metas: Buffer[] = [meta(state)], capacity = metas.length) {
  const value = Buffer.alloc(4 + capacity * 35); value.writeUInt32LE(metas.length);
  metas.forEach((item, i) => item.copy(value, 4 + 35 * i));
  return tlv(EXECUTE, value);
}
function account(owner: PublicKey, data: Buffer = Buffer.alloc(0), executable = false): AccountInfo<Buffer> {
  return { owner, data, executable, lamports: 1 };
}
function mint(withHook: boolean, hookProgram = hook) {
  const data = Buffer.alloc(withHook ? 234 : 82); data[44] = 6; data[45] = 1;
  if (withHook) {
    data[165] = 1;
    data.writeUInt16LE(ExtensionType.TransferHook, 166); data.writeUInt16LE(64, 168);
    key(999).toBuffer().copy(data, 170); hookProgram.toBuffer().copy(data, 202);
  }
  return data;
}
function tokenAccount(mintKey: PublicKey, authority: PublicKey, memo = false) {
  const data = Buffer.alloc(memo ? 171 : 165);
  mintKey.toBuffer().copy(data); authority.toBuffer().copy(data, 32); data.writeBigUInt64LE(1000n, 64); data[108] = 1;
  if (memo) {
    data[165] = 2;
    data.writeUInt16LE(ExtensionType.MemoTransfer, 166); data.writeUInt16LE(1, 168); data[170] = 1;
  }
  return account(TOKEN_2022_PROGRAM_ID, data);
}
const rows = (metas: AccountMeta[]) => metas.map((item) => ({ key: item.pubkey.toBase58(), signer: item.isSigner, writable: item.isWritable }));

interface Fixture {
  user: PublicKey; pool: PublicKey; lpMint: PublicKey; mints: PublicKey[]; userTokenAccounts: PublicKey[]; vaults: PublicKey[];
  tokenPrograms: PublicKey[]; snapshots: MintSnapshot[]; registryKey: PublicKey; infos: Map<string, AccountInfo<Buffer>>;
  reads: Map<string, number>; reader: AccountReader; transfers: TransferLeg[]; resolve: () => Promise<AccountMeta[]>;
}
function fixture(data: Buffer = registry(), memo = false): Fixture {
  const user = key(4), pool = key(1), lpMint = key(2);
  const mints = [key(6), key(7)], userTokenAccounts = [key(8), key(9)], vaults = [key(10), key(11)];
  const tokenPrograms = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
  const snapshots: MintSnapshot[] = mints.map((address, i) => ({ address, owner: tokenPrograms[i], data: mint(i === 1) }));
  const registryKey = getExtraAccountMetaAddress(mints[1], hook);
  const infos = new Map<string, AccountInfo<Buffer>>([
    [hook.toBase58(), account(key(200), Buffer.alloc(0), true)],
    [registryKey.toBase58(), account(hook, data)],
    [userTokenAccounts[1].toBase58(), tokenAccount(mints[1], user, memo)],
    [vaults[1].toBase58(), tokenAccount(mints[1], pool)],
  ]);
  const reads = new Map<string, number>();
  const reader: AccountReader = {
    getAccountInfo: async (pubkey) => {
      const address = pubkey.toBase58(); reads.set(address, (reads.get(address) ?? 0) + 1);
      return infos.get(address) ?? null;
    },
    getMultipleAccountsInfo: async (keys) => keys.map((pubkey) => infos.get(pubkey.toBase58()) ?? null),
  };
  // A swap 0 → 1 (output leg on the hooked mint) followed by a join of leg 1.
  const transfers: TransferLeg[] = [
    { mint: mints[0], tokenProgram: tokenPrograms[0], source: userTokenAccounts[0], destination: vaults[0], authority: user, amount: 100n },
    { mint: mints[1], tokenProgram: tokenPrograms[1], source: vaults[1], destination: userTokenAccounts[1], authority: pool, amount: 80n },
    { mint: mints[1], tokenProgram: tokenPrograms[1], source: userTokenAccounts[1], destination: vaults[1], authority: user, amount: 80n },
  ];
  return { user, pool, lpMint, mints, userTokenAccounts, vaults, tokenPrograms, snapshots, registryKey, infos, reads, reader, transfers,
    resolve: () => resolveTransferExtraAccounts(reader, transfers, snapshots, [user, pool, lpMint, key(3)]) };
}
const simpleExpected = (registryKey: PublicKey, extra = state, writable = true) => rows([
  { pubkey: extra, isSigner: false, isWritable: writable },
  { pubkey: hook, isSigner: false, isWritable: false },
  { pubkey: registryKey, isSigner: false, isWritable: false },
]);

describe("resolveTransferExtraAccounts", () => {
  test("valid output hook keeps SPL resolver metas, merges swap/join and preserves memo requirements", async () => {
    const f = fixture(undefined, true);
    const ix = createTransferCheckedInstruction(f.vaults[1], f.mints[1], f.userTokenAccounts[1], f.pool, 80n, 6, [], TOKEN_2022_PROGRAM_ID);
    await addExtraAccountMetasForExecute(f.reader as unknown as Connection, ix, hook, f.vaults[1], f.mints[1], f.userTokenAccounts[1], f.pool, 80n);
    const officialMetas = ix.keys.slice(4);
    f.reads.clear();
    expect(rows(await f.resolve())).toEqual(rows([...officialMetas, { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false }]));
    expect(f.reads.get(f.registryKey.toBase58())).toBe(1); // swap and join share the registry snapshot
    expect(f.reads.get(hook.toBase58())).toBe(1);
  });

  test.each(["missing program", "nonexecutable program", "missing registry", "wrong registry owner", "executable registry"] as const)(
    "rejects %s before returning any metas", async (mode) => {
      const f = fixture();
      const errors = { "missing program": /Missing transfer-hook program/, "nonexecutable program": /is not executable/,
        "missing registry": /Missing transfer-hook registry/, "wrong registry owner": /registry owner or executable state/,
        "executable registry": /registry owner or executable state/ };
      if (mode === "missing program") f.infos.delete(hook.toBase58());
      if (mode === "nonexecutable program") f.infos.get(hook.toBase58())!.executable = false;
      if (mode === "missing registry") f.infos.delete(f.registryKey.toBase58());
      if (mode === "wrong registry owner") f.infos.get(f.registryKey.toBase58())!.owner = key(201);
      if (mode === "executable registry") f.infos.get(f.registryKey.toBase58())!.executable = true;
      await expect(f.resolve()).rejects.toThrow(errors[mode]);
    });

  const excessiveCount = registry(); excessiveCount.writeUInt32LE(2, 12);
  const tooLong = registry(); tooLong.writeUInt32LE(999, 8);
  const invalidRecords: [string, Buffer][] = [
    ["wrong discriminator", tlv(OTHER, registry().subarray(12))],
    ["empty account", Buffer.alloc(0)],
    ["truncated discriminator", EXECUTE.subarray(0, 7)],
    ["truncated length", EXECUTE],
    ["length beyond account", tooLong],
    ["missing PodSlice count", tlv(EXECUTE, Buffer.alloc(3))],
    ["misaligned PodSlice capacity", tlv(EXECUTE, Buffer.alloc(5))],
    ["count beyond capacity", excessiveCount],
    ["malformed trailing TLV", Buffer.concat([registry(), OTHER])],
    ["nonzero short trailing space", Buffer.concat([registry(), Buffer.from([1])])],
  ];
  test.each(invalidRecords)("rejects malformed Execute registry: %s", async (_name, data) => {
    await expect(fixture(data).resolve()).rejects.toThrow(/Malformed transfer-hook Execute registry/);
  });

  test("negative control: SPL JS alone silently accepts wrong tag, length and excessive count", () => {
    for (const data of [invalidRecords[0][1], tooLong, excessiveCount]) {
      expect(getExtraAccountMetas(account(hook, data))).toHaveLength(1);
    }
  });

  const spareCapacity = registry([meta(state)], 2); spareCapacity.fill(255, 51);
  const legalRecords: [string, Buffer][] = [
    ["multiple TLV entries", Buffer.concat([tlv(OTHER, Buffer.from([1, 2, 3])), registry(), tlv(OTHER, Buffer.from([4]))])],
    ["short zero padding", Buffer.concat([registry(), Buffer.alloc(7)])],
    ["uninitialized trailing allocation", Buffer.concat([registry(), Buffer.alloc(8), Buffer.from([255])])],
    ["unused nonzero PodSlice capacity", spareCapacity],
    ["first of repeated Execute entries", Buffer.concat([registry(), registry([meta(key(300))])])],
  ];
  test.each(legalRecords)("preserves Rust-valid registry layout: %s", async (_name, data) => {
    const f = fixture(data);
    expect(rows(await f.resolve())).toEqual(simpleExpected(f.registryKey));
  });

  test("zero extra accounts is a valid Execute registry", async () => {
    const f = fixture(registry([]));
    expect(rows(await f.resolve())).toEqual(simpleExpected(f.registryKey).slice(1));
  });

  test("account-data resolution reads the checked registry snapshot without refetching it", async () => {
    const chosen = key(301), extra = Buffer.alloc(35);
    extra[0] = 2; extra[1] = 2; extra[2] = 4; extra[3] = 12; extra[34] = 1;
    const f = fixture(Buffer.concat([tlv(OTHER, chosen.toBuffer()), registry([extra])]));
    const original = f.reader.getAccountInfo;
    f.reader.getAccountInfo = async (pubkey, c) => {
      if (pubkey.equals(f.registryKey) && f.reads.has(f.registryKey.toBase58())) throw new Error("A second RPC read would race the checked registry snapshot");
      return original(pubkey, c);
    };
    expect(rows(await f.resolve())).toEqual(simpleExpected(f.registryKey, chosen));
    expect(f.reads.get(f.registryKey.toBase58())).toBe(1);
  });

  test.each(["public key", "PDA seed"] as const)("external account-data %s reads use confirmed commitment", async (mode) => {
    const chosen = key(302), extra = Buffer.alloc(35);
    if (mode === "public key") { extra[0] = 2; extra[1] = 2; extra[2] = 5; extra[3] = 0; }
    else { extra[0] = 1; extra[1] = 4; extra[2] = 5; extra[3] = 0; extra[4] = 4; }
    const f = fixture(registry([meta(state), extra]));
    f.infos.set(state.toBase58(), account(hook, chosen.toBuffer()));
    const original = f.reader.getAccountInfo;
    const commitments: unknown[] = [];
    f.reader.getAccountInfo = async (pubkey, c) => { if (pubkey.equals(state)) commitments.push(c); return original(pubkey, c); };
    const expected = mode === "public key" ? chosen : PublicKey.findProgramAddressSync([chosen.toBuffer().subarray(0, 4)], hook)[0];
    const resolved = await f.resolve();
    expect(resolved.some((item) => item.pubkey.equals(expected))).toBe(true);
    expect(commitments).toEqual(["confirmed", "confirmed"]);
  });

  test("an additional signer is outside the supported profile", async () => {
    await expect(fixture(registry([meta(state, true)])).resolve()).rejects.toThrow(UnsupportedTransferProfileError);
  });

  test("a duplicate core account stays forbidden even when nonsigning and readonly", async () => {
    const f = fixture();
    for (const core of [f.user, f.pool, f.lpMint, key(3)]) {
      f.infos.get(f.registryKey.toBase58())!.data = registry([meta(core, false, false)]);
      await expect(f.resolve()).rejects.toThrow(/core account/);
    }
  });

  test("source/destination duplicates keep SPL's privilege reduction", async () => {
    const f = fixture();
    const duplicate = f.userTokenAccounts[1];
    f.infos.get(f.registryKey.toBase58())!.data = registry([meta(duplicate, true, true)]);
    expect(rows(await f.resolve())).toEqual(simpleExpected(f.registryKey, duplicate, false));
  });

  test("writable wins when the same extra is requested readonly by one leg and writable by another", async () => {
    const f = fixture();
    const extraA = meta(state, false, false), extraB = meta(state, false, true);
    // Both legs on mint 1 read the same registry; the union ORs writability.
    f.infos.get(f.registryKey.toBase58())!.data = registry([extraA]);
    const readonly = await f.resolve();
    expect(readonly[0].isWritable).toBe(false);
    f.infos.get(f.registryKey.toBase58())!.data = registry([extraB]);
    expect((await f.resolve())[0].isWritable).toBe(true);
  });

  test("a disarmed hook (default program) and classic-token legs need no tail and no reads", async () => {
    const f = fixture();
    f.snapshots[1] = { ...f.snapshots[1], data: mint(true, PublicKey.default) };
    expect(await f.resolve()).toEqual([]);
    expect(f.reads.size).toBe(0);
  });

  test("a destination token account that does not exist yet (ATA created in the same tx) resolves without memo", async () => {
    // First swap INTO a Token-2022 mint the user has never held: the frontend
    // prepends createAssociatedTokenAccountIdempotent, so at resolution time
    // the output ATA is absent. That is not an error and never needs a memo.
    const f = fixture();
    f.infos.delete(f.userTokenAccounts[1].toBase58());
    // Without the flag the resolver still refuses to guess.
    await expect(f.resolve()).rejects.toThrow(/Missing transfer destination/);
    f.transfers[1].destinationCreatedInTx = true;
    expect(rows(await f.resolve())).toEqual(simpleExpected(f.registryKey));
    expect(rows(await f.resolve())).not.toContainEqual(expect.objectContaining({ key: MEMO_PROGRAM_ID.toBase58() }));
  });

  test("a missing pool vault is still an error even when another leg marks the account as created in-tx", async () => {
    const f = fixture();
    f.infos.delete(f.vaults[1].toBase58());
    f.transfers[1].destinationCreatedInTx = true; // user ATA leg; the vault leg (transfers[2]) stays strict
    await expect(f.resolve()).rejects.toThrow(new RegExp(`Missing transfer destination ${f.vaults[1].toBase58()}`));
  });

  test("an existing destination with MemoTransfer still adds the memo program", async () => {
    const f = fixture(registry(), true);
    expect(rows(await f.resolve())).toContainEqual({ key: MEMO_PROGRAM_ID.toBase58(), signer: false, writable: false });
  });

  test("a missing mint snapshot is an error", async () => {
    const f = fixture();
    await expect(resolveTransferExtraAccounts(f.reader, f.transfers, [f.snapshots[0]], [])).rejects.toThrow(/Mint snapshot missing/);
  });
});

describe("per-instruction resolvers", () => {
  function poolOf(f: Fixture): PoolInfo {
    return {
      address: f.pool, config: key(50), bump: 255, poolId: new BN(1), tokenCount: 2,
      tokens: f.mints.map((mint, index) => ({
        index, mint, tokenProgram: f.tokenPrograms[index], decimals: 6, weightBps: 5000,
        virtualBalance: new BN(1_000_000), actualBalance: new BN(1_000_000), protocolFeesOwed: new BN(0),
        vault: f.vaults[index], concentration: 1, isActive: true, maxSelloffPct: 0, extensions: index === 1 ? [ExtensionType.TransferHook] : [], unsupportedExtensions: [],
        transferHookProgram: index === 1 ? hook : null, transferFee: null, paused: false,
      })),
      lpMint: f.lpMint, lpTokenProgram: TOKEN_PROGRAM_ID, lpTotalSupply: new BN(1_000_000), swapFeeRate: 0, protocolFeeRate: 0,
      poolEnabled: true, swapsEnabled: true, createdAt: 0, lookupTable: PublicKey.default, syncedAt: 0, unsupportedTokenIndices: [],
    };
  }
  /** The fixture's fixed token accounts are the user's ATAs in the resolver; rebind them. */
  function withAtas(f: Fixture): { pool: PoolInfo; f: Fixture } {
    const pool = poolOf(f);
    const ata = deriveAta(f.user, f.mints[1], TOKEN_2022_PROGRAM_ID);
    f.infos.set(ata.toBase58(), f.infos.get(f.userTokenAccounts[1].toBase58())!);
    return { pool, f };
  }

  test("swap: user→vault_in and vault_out→user legs; classic pools return [] without reads", async () => {
    const { pool, f } = withAtas(fixture(undefined, true));
    const tail = await resolveSwapExtraAccounts(f.reader, pool, { user: f.user, tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(100), amountOut: new BN(80) }, { mintSnapshots: f.snapshots });
    expect(rows(tail)).toEqual([...simpleExpected(f.registryKey), { key: MEMO_PROGRAM_ID.toBase58(), signer: false, writable: false }]);
    const classic = poolOf(f); classic.tokens.forEach((t) => { t.tokenProgram = TOKEN_PROGRAM_ID; });
    f.reads.clear();
    expect(await resolveSwapExtraAccounts(f.reader, classic, { user: f.user, tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(1), amountOut: new BN(1) })).toEqual([]);
    expect(f.reads.size).toBe(0);
  });

  test("swap: mint snapshots are fetched when not supplied", async () => {
    const { pool, f } = withAtas(fixture());
    f.infos.set(f.mints[1].toBase58(), account(TOKEN_2022_PROGRAM_ID, mint(true)));
    const tail = await resolveSwapExtraAccounts(f.reader, pool, { user: f.user, tokenInIndex: 1, tokenOutIndex: 0, amountIn: new BN(100), amountOut: new BN(80) });
    expect(rows(tail)).toEqual(simpleExpected(f.registryKey));
  });

  test("add_liquidity: only legs with a positive ceiling; remove_liquidity: only legs with a payout", async () => {
    const { pool, f } = withAtas(fixture());
    const join = await resolveAddLiquidityExtraAccounts(f.reader, pool, { user: f.user, tokenAmounts: [new BN(10), new BN(10)] }, { mintSnapshots: f.snapshots });
    expect(rows(join)).toEqual(simpleExpected(f.registryKey));
    expect(await resolveAddLiquidityExtraAccounts(f.reader, pool, { user: f.user, tokenAmounts: [new BN(10), new BN(0)] }, { mintSnapshots: f.snapshots })).toEqual([]);
    const exit = await resolveRemoveLiquidityExtraAccounts(f.reader, pool, { user: f.user, lpAmount: new BN(10_000) }, { mintSnapshots: f.snapshots });
    expect(rows(exit)).toEqual(simpleExpected(f.registryKey));
    const sidelined = poolOf(f); sidelined.tokens[1].actualBalance = new BN(0);
    expect(await resolveRemoveLiquidityExtraAccounts(f.reader, sidelined, { user: f.user, lpAmount: new BN(10_000) }, { mintSnapshots: f.snapshots })).toEqual([]);
  });

  test("builders append the tail after the fixed layout and refuse signers/duplicates", async () => {
    const { pool, f } = withAtas(fixture());
    const tail = await resolveSwapExtraAccounts(f.reader, pool, { user: f.user, tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(100), amountOut: new BN(80) }, { mintSnapshots: f.snapshots });
    const cfg = getConfig("devnet");
    const ix = buildSwapIx(cfg, pool, { user: f.user, tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(100), minAmountOut: new BN(1), extraAccounts: tail });
    expect(ix.keys).toHaveLength(10 + tail.length);
    expect(rows(ix.keys.slice(10))).toEqual(rows(tail));
    expect(() => buildSwapIx(cfg, pool, { user: f.user, tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(100), minAmountOut: new BN(1), extraAccounts: [{ pubkey: state, isSigner: true, isWritable: false }] })).toThrow(/signers/);
    expect(() => buildSwapIx(cfg, pool, { user: f.user, tokenInIndex: 0, tokenOutIndex: 1, amountIn: new BN(100), minAmountOut: new BN(1), extraAccounts: [...tail, tail[0]] })).toThrow(/duplicate/);
  });
});
