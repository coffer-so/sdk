/**
 * v6 planned zap: state-commitment hash vector, instruction wire layout,
 * client quote on a mocked bank snapshot, tail/ALT budget.
 */
import { AddressLookupTableAccount, AddressLookupTableProgram, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import {
  buildPlannedZapIx,
  encodeAllocationPlan,
  stateCommitment,
  V6_PLAN_HASH_VECTOR,
  PLANNED_ZAP_DISCRIMINATOR_HEX,
  PlannedZapClient,
  RpcClient,
  getConfig,
  deriveAta,
  deriveLpMint,
  IDLS,
  compilePlannedZapTransaction,
  replay,
} from "../src";
import type { PlannedZapAccounts, SnapshotAccount } from "../src";
import { ContractAccountMap } from "../src/types/contracts";

const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const pk = () => Keypair.generate().publicKey;
const bn = (v: number | bigint | string) => new BN(v.toString());

describe("stateCommitment", () => {
  test("matches the plan.rs known-answer vector and is sensitive to every input", () => {
    const account = (k: number, owner: number, data: Buffer): SnapshotAccount => ({ key: key(k), owner: key(owner), data });
    const pool = account(1, 2, Buffer.alloc(64, 3)), lp = account(4, 5, Buffer.alloc(82, 6));
    const mints = [account(7, 8, Buffer.alloc(278, 9))];
    const original = Buffer.from(stateCommitment(pool, lp, mints, 17n)).toString("hex");
    expect(original).toBe(V6_PLAN_HASH_VECTOR);
    for (const target of [pool, lp, mints[0]]) {
      const data = Buffer.from(target.data); data[36] ^= 1;
      expect(Buffer.from(stateCommitment(target === pool ? { ...pool, data } : pool, target === lp ? { ...lp, data } : lp, target === mints[0] ? [{ ...mints[0], data }] : mints, 17n)).toString("hex")).not.toBe(original);
    }
    expect(Buffer.from(stateCommitment(pool, lp, mints, 18n)).toString("hex")).not.toBe(original);
    expect(Buffer.from(stateCommitment({ ...pool, key: key(12) }, lp, mints, 17n)).toString("hex")).not.toBe(original);
    expect(Buffer.from(stateCommitment({ ...pool, owner: key(12) }, lp, mints, 17n)).toString("hex")).not.toBe(original);
  });
});

function accountsFor(n: number, opts: { lpProgram?: PublicKey; programs?: PublicKey[] } = {}): PlannedZapAccounts {
  const lpTokenProgram = opts.lpProgram ?? TOKEN_PROGRAM_ID;
  return {
    pool: key(1), lpMint: key(2), userLpAccount: key(3), user: key(4), cofferPoolProgram: key(5), lpTokenProgram,
    mints: Array.from({ length: n }, (_, i) => key(10 + i)),
    userTokenAccounts: Array.from({ length: n }, (_, i) => key(40 + i)),
    vaults: Array.from({ length: n }, (_, i) => key(70 + i)),
    tokenPrograms: opts.programs ?? Array.from({ length: n }, () => TOKEN_PROGRAM_ID),
  };
}
const plan = (allocations: bigint[]) => ({ allocations, expectedState: new Uint8Array(32).fill(7), quotedAt: 100n, validUntilSlot: 300n });

describe("buildPlannedZapIx", () => {
  const cfg = getConfig("devnet");

  test("Anchor wire layout (plan.rs::anchor_wire_layout_contains_exact_u64_budget_and_freshness)", () => {
    const ix = buildPlannedZapIx(cfg, accountsFor(2), { amountIn: 33n, tokenInIndex: 0, minimumLp: 7n, plan: plan([11n, 22n]) });
    expect(ix.programId.equals(cfg.programs.singleTokenLiquidity)).toBe(true);
    expect(ix.data.length).toBe(77 + 2 * 8);
    expect(ix.data.subarray(0, 8).toString("hex")).toBe(PLANNED_ZAP_DISCRIMINATOR_HEX);
    expect(ix.data.subarray(0, 8)).toEqual(Buffer.from((IDLS.singleTokenLiquidity.instructions as any[]).find((i) => i.name === "deposit_single_token_planned").discriminator));
    expect(ix.data.readBigUInt64LE(8)).toBe(33n);
    expect(ix.data[16]).toBe(0);
    expect(ix.data.readBigUInt64LE(17)).toBe(7n);
    expect(ix.data.readUInt32LE(25)).toBe(2);
    expect(ix.data.readBigUInt64LE(29)).toBe(11n);
    expect(ix.data.readBigUInt64LE(37)).toBe(22n);
    expect(ix.data.subarray(45, 77)).toEqual(Buffer.alloc(32, 7));
    expect(ix.data.readBigInt64LE(77)).toBe(100n);
    expect(ix.data.readBigUInt64LE(85)).toBe(300n);
    expect(encodeAllocationPlan(plan([11n, 22n]))).toEqual(ix.data.subarray(25));
  });

  test("N=10: 157 data bytes, 36 keys with one token program, 37 with two", () => {
    const allocations = Array.from({ length: 10 }, (_, i) => BigInt(i + 1));
    const amountIn = allocations.reduce((a, b) => a + b, 0n);
    const one = buildPlannedZapIx(cfg, accountsFor(10), { amountIn, tokenInIndex: 0, minimumLp: 1n, plan: plan(allocations) });
    expect(one.data.length).toBe(157);
    expect(one.keys).toHaveLength(36);
    const programs = Array.from({ length: 10 }, (_, i) => (i % 2 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID));
    const two = buildPlannedZapIx(cfg, accountsFor(10, { programs }), { amountIn, tokenInIndex: 0, minimumLp: 1n, plan: plan(allocations) });
    expect(two.keys).toHaveLength(37);
    expect(two.keys[36].pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    // The suffix is the program that differs from the LP program, whichever it is.
    const flipped = buildPlannedZapIx(cfg, accountsFor(10, { programs, lpProgram: TOKEN_2022_PROGRAM_ID }), { amountIn, tokenInIndex: 0, minimumLp: 1n, plan: plan(allocations) });
    expect(flipped.keys[36].pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true);
    // Fixed layout: [pool w, lp w, user_lp w, user s, program, lp program] + [mint, user_token w, vault w]×N
    const flags = one.keys.slice(0, 6).map((k) => [k.isWritable, k.isSigner]);
    expect(flags).toEqual([[true, false], [true, false], [true, false], [false, true], [false, false], [false, false]]);
    for (let i = 0; i < 10; i++) {
      expect(one.keys[6 + 3 * i].isWritable).toBe(false);
      expect(one.keys[7 + 3 * i].isWritable).toBe(true);
      expect(one.keys[8 + 3 * i].isWritable).toBe(true);
    }
  });

  test("refuses bad shapes, budgets, programs and tails", () => {
    const base = { amountIn: 3n, tokenInIndex: 0, minimumLp: 1n, plan: plan([1n, 2n]) };
    expect(() => buildPlannedZapIx(cfg, accountsFor(2), { ...base, plan: plan([1n, 1n]) })).toThrow(/sum to amountIn/);
    expect(() => buildPlannedZapIx(cfg, accountsFor(2), { ...base, minimumLp: 0n })).toThrow(/minimumLp/);
    expect(() => buildPlannedZapIx(cfg, accountsFor(2), { ...base, tokenInIndex: 2 })).toThrow(/tokenInIndex/);
    expect(() => buildPlannedZapIx(cfg, accountsFor(1), { ...base, plan: plan([3n]) })).toThrow(/2\.\.10/);
    expect(() => buildPlannedZapIx(cfg, accountsFor(2, { programs: [TOKEN_PROGRAM_ID, pk()] }), base)).toThrow(/token program/);
    const dup = accountsFor(2); dup.mints[1] = dup.mints[0];
    expect(() => buildPlannedZapIx(cfg, dup, base)).toThrow(/duplicate mint/i);
    const lpAsMint = accountsFor(2); lpAsMint.mints[0] = lpAsMint.lpMint;
    expect(() => buildPlannedZapIx(cfg, lpAsMint, base)).toThrow(/LP mint/);
    for (const forbidden of [key(1), key(2), key(3), key(4)]) {
      expect(() => buildPlannedZapIx(cfg, { ...accountsFor(2), extraAccounts: [{ pubkey: forbidden, isSigner: false, isWritable: false }] }, base)).toThrow(/core accounts/);
    }
    expect(() => buildPlannedZapIx(cfg, { ...accountsFor(2), extraAccounts: [{ pubkey: pk(), isSigner: true, isWritable: false }] }, base)).toThrow(/signers/);
    const extra = { pubkey: pk(), isSigner: false, isWritable: true };
    expect(() => buildPlannedZapIx(cfg, { ...accountsFor(2), extraAccounts: [extra, extra] }, base)).toThrow(/duplicate extra/);
    const ok = buildPlannedZapIx(cfg, { ...accountsFor(2), extraAccounts: [extra] }, base);
    expect(ok.keys.at(-1)).toEqual({ pubkey: extra.pubkey, isSigner: false, isWritable: true });
  });
});

// ---- Client quote on a synthetic bank snapshot ---------------------------

type State = ContractAccountMap["cofferPool"]["CofferPool"];
const fields = (name: string) => (IDLS.cofferPool.types.find((t) => t.name === name)!.type as any).fields as { name: string; type: any }[];
function encode(value: any, type: any): Buffer {
  if (type === "pubkey") return value.toBuffer();
  if (type === "bool") return Buffer.from([Number(value)]);
  if (typeof type === "string") {
    const bits = Number(type.slice(1));
    return (BN.isBN(value) ? value : bn(value)).toTwos(bits).toArrayLike(Buffer, "le", bits / 8);
  }
  if (type.array) return Buffer.concat(value.map((v: any) => encode(v, type.array[0])));
  if (type.defined) return Buffer.concat(fields(type.defined.name).map((f) => encode(value[f.name], f.type)));
  throw new Error("Unknown fixture type");
}
// The synthetic state is the v5 (1683-byte) prefix of the v6.1 account: the
// decoder accepts it (every appended v6.1 field reads as 0 / empty), and the
// recorded fixtures were produced from exactly these bytes.
const v5Fields = (name: string) => { const all = fields(name); return all.slice(0, all.findIndex((f) => f.name === "reserved") + 1); };
const poolBytes = (state: State) => Buffer.concat([Buffer.from(IDLS.cofferPool.accounts[0].discriminator), ...v5Fields("CofferPool").map((f) => encode((state as any)[f.name], f.type))]);
function plainMint(decimals: number, supply: bigint): Buffer {
  const b = Buffer.alloc(82); b[44] = decimals; b[45] = 1; b.writeBigUInt64LE(supply, 36); return b;
}
function feeMint(decimals: number, bps: number, maxFee: bigint): Buffer {
  const base = plainMint(decimals, 0n);
  const body = Buffer.alloc(108); body.writeBigUInt64LE(0n, 72); body.writeBigUInt64LE(maxFee, 80); body.writeUInt16LE(bps, 88); body.writeBigUInt64LE(0n, 90); body.writeBigUInt64LE(maxFee, 98); body.writeUInt16LE(bps, 106);
  const h = Buffer.alloc(4); h.writeUInt16LE(1, 0); h.writeUInt16LE(108, 2);
  return Buffer.concat([base, Buffer.alloc(83), Buffer.from([1]), h, body, Buffer.alloc(8)]);
}
function syntheticPool(cfg: ReturnType<typeof getConfig>, address: PublicKey, n: number, programs: PublicKey[]): State {
  const slot = (i: number) => ({
    config: { mint: key(100 + i), token_program: programs[i], normalized_weight: bn(Math.floor(10_000 / n)), max_selloff_pct: 0, max_selloff_period_length: 0,
      variable_fee_threshold_pct: 0, variable_fee_slope_low_pct: 0, variable_fee_slope_high_pct: 0, is_active: true, variable_fee_slope_mid_pct: 0, variable_fee_kink_pct: 0 },
    dynamics: { virtual_balance: bn(2_000_000_000), actual_balance: bn(1_000_000_000), protocol_fees_owed: bn(0), previous_selloff: bn(0), current_selloff: bn(0), window_start_timestamp: bn(0), selloff_vb_snapshot: bn(0) },
  });
  const empty = () => ({ config: { ...slot(0).config, mint: PublicKey.default, token_program: PublicKey.default, normalized_weight: bn(0) }, dynamics: { ...slot(0).dynamics, virtual_balance: bn(0), actual_balance: bn(0) } });
  return {
    config: key(2), bump: 254, token_count: n, pool_id: bn(1), swap_fee_rate: 3000, protocol_fee_rate: 2000, created_at: bn(1),
    pool_enabled: true, swaps_enabled: true, pool_admin: key(3), pending_pool_admin: PublicKey.default, range_manager: PublicKey.default,
    range_manager_enabled: false, range_manager_max_vb_change_pct: 0, range_manager_max_weight_change_pct: 0, range_manager_min_update_interval_secs: 0,
    range_manager_last_updated: bn(0), tokens: Array.from({ length: 10 }, (_, i) => (i < n ? slot(i) : empty())),
    lookup_table: PublicKey.default, _deprecated_banned_extensions: bn(0), range_manager_max_leverage_bps: 0, range_manager_min_leverage_bps: 0,
    reserved: [0x56, 0x35, 0x4d, 0x31, ...Array(12).fill(0)],
  } as unknown as State;
}

function mockClient(n: number, feeIndices: number[] = []) {
  const cfg = getConfig("mainnet");
  const address = key(1);
  const programs = Array.from({ length: n }, (_, i) => (feeIndices.includes(i) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID));
  const state = syntheticPool(cfg, address, n, programs);
  const [lpMint] = deriveLpMint(cfg.programs.cofferPool, address);
  const infos = new Map<string, { data: Buffer; owner: PublicKey; executable: boolean; lamports: number }>();
  infos.set(address.toBase58(), { data: poolBytes(state), owner: cfg.programs.cofferPool, executable: false, lamports: 1 });
  infos.set(lpMint.toBase58(), { data: plainMint(9, 1_000_000_000n), owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1 });
  for (let i = 0; i < n; i++) infos.set(key(100 + i).toBase58(), { data: feeIndices.includes(i) ? feeMint(6, 100, 10_000n) : plainMint(6, 0n), owner: programs[i], executable: false, lamports: 1 });
  const clock = Buffer.alloc(40); clock.writeBigUInt64LE(445_105_299n, 0); clock.writeBigUInt64LE(1030n, 16); clock.writeBigInt64LE(1_788_799_999n, 32);
  infos.set(SYSVAR_CLOCK_PUBKEY.toBase58(), { data: clock, owner: key(55), executable: false, lamports: 1 });
  const calls: string[] = [];
  const rpc = new RpcClient({ endpoint: "http://127.0.0.1:8899", connectionFactory: () => ({
    getAccountInfo: async (k: PublicKey) => { calls.push("getAccountInfo"); return infos.get(k.toBase58()) ?? null; },
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => infos.get(k.toBase58()) ?? null),
    getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => { calls.push("getMultipleAccountsInfoAndContext"); return { context: { slot: 445_105_299 }, value: keys.map((k) => infos.get(k.toBase58()) ?? null) }; },
    getSlot: async () => 445_105_299,
  }) as any });
  const client = new PlannedZapClient({ config: cfg, poolAddress: address, rpc });
  return { cfg, client, address, lpMint, infos, calls, state, programs };
}

describe("PlannedZapClient.quote", () => {
  test("one bank snapshot → plan, hash, timestamps and economics", async () => {
    const m = mockClient(3);
    const res = await m.client.quote(0, bn(50_000_000), { slippageHundredthsBps: 10_000, validForSlots: 100 });
    if (!res.ok) throw new Error(res.error.humanMessage);
    const q = res.data;
    expect(m.calls).toEqual(["getAccountInfo", "getMultipleAccountsInfoAndContext"]);
    expect(q.plan.allocations.reduce((a, b) => a + b, 0n)).toBe(50_000_000n);
    expect(q.plan.quotedAt).toBe(1_788_799_999n);
    expect(q.plan.validUntilSlot).toBe(445_105_399n);
    expect(q.chainEpoch).toBe(1030n);
    expect(q.contextSlot).toBe(445_105_299);
    expect(Buffer.from(q.plan.expectedState)).toEqual(Buffer.from(stateCommitment(q.snapshots.pool, q.snapshots.lpMint, q.snapshots.mints, 1030n)));
    expect(q.estimatedLp.toString()).toBe(q.economics.lp.toString());
    expect(q.minimumLp.toString()).toBe(((q.economics.lp * 9900n) / 10_000n).toString());
    expect(q.expectedOuts[0].isZero()).toBe(true);
    expect(q.expectedOuts.slice(1).every((o) => o.gt(bn(0)))).toBe(true);
    // The quote is an exact replay of its own plan.
    const again = replay(q.quotePool, 0, 50_000_000n, q.plan.allocations);
    expect(again.lp).toBe(q.economics.lp);
    expect(q.layout.vaults[1].equals(deriveAta(m.address, key(101), TOKEN_PROGRAM_ID))).toBe(true);
    expect(q.layout.lpMint.equals(m.lpMint)).toBe(true);
  });

  test("nowSeconds re-prices the window but never the signed quotedAt", async () => {
    const m = mockClient(2);
    const res = await m.client.quote(0, 1_000_000n, { nowSeconds: 1_788_800_050 });
    if (!res.ok) throw new Error(res.error.humanMessage);
    expect(res.data.plan.quotedAt).toBe(1_788_799_999n);
    expect(res.data.quotePool.now).toBe(1_788_800_050n);
  });

  test("Token-2022 fee mints are netted and the tail resolves to [] without hooks", async () => {
    const m = mockClient(3, [1]);
    const res = await m.client.quote(1, 10_000_000n, { slippageHundredthsBps: 0 });
    if (!res.ok) throw new Error(res.error.humanMessage);
    const q = res.data;
    expect(q.quotePool.tokens[1].transferFee).toMatchObject({ transferFeeBasisPoints: 100, maximumFee: 10_000n });
    expect(q.economics.swaps.every((s) => s.grossInput - s.netInput === 10_000n)).toBe(true);
    // The memo check reads the Token-2022 destinations (user ATA + vault); they exist once ATAs are ensured.
    const tokenAccount = (mint: PublicKey, owner: PublicKey) => { const d = Buffer.alloc(165); mint.toBuffer().copy(d); owner.toBuffer().copy(d, 32); d[108] = 1; return { data: d, owner: TOKEN_2022_PROGRAM_ID, executable: false, lamports: 1 }; };
    m.infos.set(deriveAta(key(9), key(101), TOKEN_2022_PROGRAM_ID).toBase58(), tokenAccount(key(101), key(9)));
    m.infos.set(deriveAta(m.address, key(101), TOKEN_2022_PROGRAM_ID).toBase58(), tokenAccount(key(101), m.address));
    const tail = await m.client.resolveExtraAccounts(q, key(9));
    if (!tail.ok) throw new Error(tail.error.humanMessage);
    expect(tail.data).toEqual([]);
    // The user's output ATA may not exist yet (first zap into this mint): ensureUserTokenAccountIxs creates it in the same tx, so the tail still resolves.
    m.infos.delete(deriveAta(key(9), key(101), TOKEN_2022_PROGRAM_ID).toBase58());
    const firstTime = await m.client.resolveExtraAccounts(q, key(9));
    if (!firstTime.ok) throw new Error(firstTime.error.humanMessage);
    expect(firstTime.data).toEqual([]);
    m.infos.set(deriveAta(key(9), key(101), TOKEN_2022_PROGRAM_ID).toBase58(), tokenAccount(key(101), key(9)));
    // Without a Token-2022 destination (here the fee mint's vault) the resolver reports a build failure rather than guessing.
    m.infos.delete(deriveAta(m.address, key(101), TOKEN_2022_PROGRAM_ID).toBase58());
    const missing = await m.client.resolveExtraAccounts(q, key(9));
    expect(!missing.ok && missing.error.code).toBe("tx_build_failed");
    const ix = m.client.buildIx(q, key(9));
    expect(ix.keys).toHaveLength(6 + 9 + 1);
    expect(ix.keys[15].pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    const atas = m.client.ensureUserTokenAccountIxs(q, key(9));
    expect(atas).toHaveLength(4);
  });

  test("validation: index, amount, validity, sidelined input, disabled pool, unseeded supply, LP with extensions", async () => {
    const m = mockClient(2);
    expect((await m.client.quote(2, 1n)).ok).toBe(false);
    expect((await m.client.quote(0, 0n)).ok).toBe(false);
    expect((await m.client.quote(0, 1n, { validForSlots: 151 })).ok).toBe(false);
    const sidelined = mockClient(2); sidelined.state.tokens[0].dynamics.actual_balance = bn(0);
    sidelined.infos.set(sidelined.address.toBase58(), { data: poolBytes(sidelined.state), owner: sidelined.cfg.programs.cofferPool, executable: false, lamports: 1 });
    const r = await sidelined.client.quote(0, 1_000n);
    expect(r.ok).toBe(false);
    const disabled = mockClient(2); disabled.state.pool_enabled = false;
    disabled.infos.set(disabled.address.toBase58(), { data: poolBytes(disabled.state), owner: disabled.cfg.programs.cofferPool, executable: false, lamports: 1 });
    const d = await disabled.client.quote(0, 1_000n);
    expect(!d.ok && d.error.code).toBe("pool_disabled");
    const unseeded = mockClient(2); unseeded.infos.set(unseeded.lpMint.toBase58(), { data: plainMint(9, 0n), owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1 });
    expect((await unseeded.client.quote(0, 1_000n)).ok).toBe(false);
    const extLp = mockClient(2); extLp.infos.set(extLp.lpMint.toBase58(), { data: feeMint(9, 0, 0n), owner: TOKEN_2022_PROGRAM_ID, executable: false, lamports: 1 });
    const e = await extLp.client.quote(0, 1_000n);
    expect(!e.ok && e.error.code).toBe("unsupported_token_extension");
  });

  test("a dust-sized input is amount_too_small", async () => {
    const m = mockClient(2);
    const r = await m.client.quote(0, 1n);
    expect(!r.ok && r.error.code).toBe("amount_too_small");
  });
});

describe("transaction budget", () => {
  test("N=10 zap fits the packet with the pool ALT plus a wallet ALT and leaves the wallet reserve", async () => {
    const m = mockClient(10);
    const res = await m.client.quote(0, 50_000_000n);
    if (!res.ok) throw new Error(res.error.humanMessage);
    const user = pk();
    const ix = m.client.buildIx(res.data, user);
    const accounts = m.client.accountsFor(res.data, user);
    const table = (key: PublicKey, addresses: PublicKey[]) => new AddressLookupTableAccount({ key, state: { deactivationSlot: (1n << 64n) - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: user, addresses } });
    const poolAlt = table(pk(), [accounts.pool, accounts.lpMint, accounts.cofferPoolProgram, accounts.lpTokenProgram, ...accounts.mints, ...accounts.vaults, ...accounts.tokenPrograms]);
    const walletAlt = table(pk(), m.client.walletLookupAddresses(res.data, user));
    const compiled = compilePlannedZapTransaction({ payer: user, blockhash: PublicKey.default.toBase58(), instructions: [ix], lookupTables: [poolAlt, walletAlt] });
    expect(compiled.wireBytes + compiled.walletReserve).toBeLessThanOrEqual(1232);
    expect(() => compilePlannedZapTransaction({ payer: user, blockhash: PublicKey.default.toBase58(), instructions: [ix], lookupTables: [] })).toThrow(/wallet reserve/);
    // Wallet ALT setup for the 11 user accounts fits one packet.
    const prep = await m.client.prepareWalletLookupTable(user, m.client.walletLookupAddresses(res.data, user));
    expect(prep.instructionBatches).toHaveLength(1);
    expect(prep.instructionBatches[0].every((i) => i.programId.equals(AddressLookupTableProgram.programId))).toBe(true);
  });
});
