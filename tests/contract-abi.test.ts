import BN from "bn.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { execFileSync } from "child_process";
import { IDLS } from "../src/idl";
import { getConfig } from "../src/config";
import { ContractProgram } from "../src/types/contracts";
import { buildContractInstruction } from "../src/clients/contract-instructions";
import { decodeContractAccount, parseContractEvents } from "../src/parsers/contracts";
import { parseCubicPoolEvents } from "../src/parsers/events";
import { buildAddLiquidityIx, buildRemoveLiquidityIx, buildSingleTokenDepositIx, buildSingleTokenDepositAtaIxs, buildSetMaxSelloffIx, buildSetRangeManagerConfigIx } from "../src/clients/tx-builders";
import { deriveAta } from "../src/utils/pda";
import { PoolInfo } from "../src/types/pool";

const cfg = getConfig("mainnet");
let sequence = 1;
const pk = () => new PublicKey(Buffer.alloc(32, ++sequence % 250 + 1));

function sample(type: any, idl: any): any {
  if (type === "pubkey") return pk();
  if (type === "bool") return true;
  if (type === "bytes") return Buffer.from([1, 3]);
  if (typeof type === "string") {
    if (/^[ui](64|128|256)$/.test(type)) return type[0] === "i" ? new BN(-1234567) : new BN(1).shln(54).addn(++sequence);
    return type === "u8" ? 7 : ++sequence % 10000;
  }
  if (type.vec) return [sample(type.vec, idl), sample(type.vec, idl)];
  if (type.array) return Array.from({ length: type.array[1] }, () => sample(type.array[0], idl));
  if (type.option) return sample(type.option, idl);
  if (type.defined) return fieldsSample(idl.types.find((x: any) => x.name === type.defined.name).type.fields, idl);
  throw new Error(JSON.stringify(type));
}
function fieldsSample(fields: any[], idl: any): any {
  return Object.fromEntries(fields.map(f => [f.name, sample(f.type, idl)]));
}
function u32(value: number): Buffer { const result = Buffer.alloc(4); result.writeUInt32LE(value); return result; }
// Independent Borsh fixtures; neither the SDK builders nor Anchor's coders
// construct these expected bytes. Wide integers exceed JS safe-number range.
function encode(value: any, type: any, idl: any): Buffer {
  if (type === "pubkey") return value.toBuffer();
  if (type === "bool") return Buffer.from([value ? 1 : 0]);
  if (type === "bytes") return Buffer.concat([u32(value.length), value]);
  if (typeof type === "string") {
    const bits = Number(type.slice(1));
    const bn = BN.isBN(value) ? value : new BN(value);
    return (type[0] === "i" ? bn.toTwos(bits) : bn).toArrayLike(Buffer, "le", bits / 8);
  }
  if (type.vec) return Buffer.concat([u32(value.length), ...value.map((v: any) => encode(v, type.vec, idl))]);
  if (type.array) return Buffer.concat(value.map((v: any) => encode(v, type.array[0], idl)));
  if (type.option) return value === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), encode(value, type.option, idl)]);
  if (type.defined) return encodeFields(value, idl.types.find((x: any) => x.name === type.defined.name).type.fields, idl);
  throw new Error(JSON.stringify(type));
}
function encodeFields(value: any, fields: any[], idl: any): Buffer { return Buffer.concat(fields.map(f => encode(value[f.name], f.type, idl))); }
function normalize(value: any): any {
  if (BN.isBN(value)) return value.toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (Buffer.isBuffer(value)) return [...value];
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  return value;
}

const programs = Object.entries(IDLS) as Array<[ContractProgram, any]>;
const instructions = programs.flatMap(([program, idl]) => idl.instructions.map((ix: any) => ({ program, idl, ix })));
const events = programs.flatMap(([program, idl]) => idl.events.map((event: any) => ({ program, idl, event })));

test("generated public types match all shipped IDLs", () => {
  expect(instructions).toHaveLength(59);
  expect(events).toHaveLength(60);
  execFileSync(process.execPath, ["scripts/generate-contract-types.cjs", "--check"], { cwd: process.cwd() });
});

test.each(instructions)("$program.$ix.name: data, ordered accounts and privileges match the ABI", ({ program, idl, ix }) => {
  const args = fieldsSample(ix.args, idl);
  const accounts = Object.fromEntries(ix.accounts.map((a: any) => [a.name, pk()]));
  const remaining = [{ pubkey: pk(), isSigner: true, isWritable: false }];
  const result = (buildContractInstruction as any)(cfg, program, ix.name, args, accounts, remaining);
  expect(result.programId.equals(cfg.programs[program as ContractProgram])).toBe(true);
  expect(result.data).toEqual(Buffer.concat([Buffer.from(ix.discriminator), encodeFields(args, ix.args, idl)]));
  expect(result.keys).toHaveLength(ix.accounts.length + 1);
  ix.accounts.forEach((a: any, i: number) => {
    expect(result.keys[i]).toEqual({ pubkey: accounts[a.name], isSigner: !!a.signer, isWritable: !!a.writable });
  });
  expect(result.keys.at(-1)).toEqual(remaining[0]);
});

test.each(events)("$program.$event.name: every event field is decoded", ({ program, idl, event }) => {
  const fields = idl.types.find((t: any) => t.name === event.name).type.fields;
  const expected = fieldsSample(fields, idl);
  const data = Buffer.concat([Buffer.from(event.discriminator), encodeFields(expected, fields, idl)]);
  const log = `Program data: ${data.toString("base64")}`;
  const decoded = parseContractEvents([log], program);
  expect(decoded).toHaveLength(1);
  expect(decoded[0].kind).toBe(event.name);
  expect(normalize(decoded[0].data)).toEqual(normalize(expected));
  const compatible = parseCubicPoolEvents([log]);
  expect(compatible).toHaveLength(1);
  expect(compatible[0].kind).toBe(event.name);
  expect(compatible[0].kind).not.toBe("Unknown");
});

test.each(programs.flatMap(([program, idl]) => idl.accounts.map((account: any) => ({ program, idl, account }))))(
  "$program.$account.name: full account layout and discriminator", ({ program, idl, account }) => {
    const fields = idl.types.find((t: any) => t.name === account.name).type.fields;
    const expected = fieldsSample(fields, idl);
    const data = Buffer.concat([Buffer.from(account.discriminator), encodeFields(expected, fields, idl)]);
    expect(normalize((decodeContractAccount as any)(program, account.name, data))).toEqual(normalize(expected));
    expect(() => (decodeContractAccount as any)(program, account.name, data.subarray(0, -1))).toThrow();
    data[0] ^= 255;
    expect(() => (decodeContractAccount as any)(program, account.name, data)).toThrow(/discriminator/);
  },
);

test("strict ABI rejects missing/extra fields, wrong widths and unsafe JS integers", () => {
  const accounts = { pool: pk(), authority: pk() };
  const build = (args: any, supplied = accounts) => (buildContractInstruction as any)(cfg, "cubicPool", "set_swap_fee_rate", args, supplied);
  expect(() => build({})).toThrow(/required/);
  expect(() => build({ swap_fee_rate: 10, extra: 0 })).toThrow(/not in/);
  for (const invalid of [-1, 0x100000000, 1.5, NaN]) expect(() => build({ swap_fee_rate: invalid })).toThrow();
  expect(() => build({ swap_fee_rate: 10 }, { ...accounts, wrong: pk() } as any)).toThrow(/not in/);
  expect(() => buildSetRangeManagerConfigIx(cfg, pk(), { authority: pk(), maxVbChangePct: 65536, maxWeightChangePct: 1, minUpdateIntervalSecs: 1, maxLeverageBps: 1, minLeverageBps: 1 })).toThrow(/unsigned 16/);
  const amountAccounts = { treasury: pk(), admin: pk(), recipient: pk() };
  expect(() => (buildContractInstruction as any)(cfg, "protocolAdmin", "withdraw_sol", { amount: new BN(-1) }, amountAccounts)).toThrow(/outside u64/);
  expect(() => (buildContractInstruction as any)(cfg, "protocolAdmin", "withdraw_sol", { amount: 100 }, amountAccounts)).toThrow(/BN/);
});

function poolFixture(): PoolInfo {
  return {
    address: pk(), config: pk(), bump: 1, tokenCount: 2, poolId: new BN(1), bptMint: pk(), bptTokenProgram: TOKEN_2022_PROGRAM_ID,
    bptTotalSupply: new BN(100000), swapFeeRate: 0, protocolFeeRate: 0, poolEnabled: true, swapsEnabled: true, createdAt: 0,
    lookupTable: PublicKey.default, bannedExtensions: new BN(0), syncedAt: 0, unsupportedTokenIndices: [],
    tokens: [0, 1].map(index => ({ index, mint: pk(), tokenProgram: TOKEN_2022_PROGRAM_ID, decimals: 9, weightBps: 5000,
      virtualBalance: new BN(100000), actualBalance: new BN(100000), protocolFeesOwed: new BN(0), vault: pk(), concentration: 1,
      isActive: true, maxSelloffPct: 0, extensions: [], unsupportedExtensions: [] })),
  };
}

test("Token-2022 BPT is used for joins, exits, STLD and ATA setup", () => {
  const pool = poolFixture(); const user = pk();
  const add = buildAddLiquidityIx(cfg, pool, { user, tokenAmounts: [new BN(100), new BN(100)], minimumBptAmount: new BN(1) });
  const remove = buildRemoveLiquidityIx(cfg, pool, { user, bptAmount: new BN(100), minimumTokenAmounts: [new BN(0), new BN(0)] });
  for (const ix of [add, remove]) {
    expect(ix.keys[2].pubkey.equals(deriveAta(user, pool.bptMint, TOKEN_2022_PROGRAM_ID))).toBe(true);
    expect(ix.keys[4].pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  }
  const stld = buildSingleTokenDepositIx(cfg, pool, { user, amountIn: new BN(100), tokenInIndex: 0, minimumBptAmount: new BN(1) });
  expect(stld.keys[7].pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  const atas = buildSingleTokenDepositAtaIxs(cfg, pool, user).slice(-2);
  for (const ix of atas) expect(ix.keys[5].pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
});

test("sell-off convenience builder sends all seven per-token parameters in ABI order", () => {
  const pool = pk(); const authority = pk();
  const result = buildSetMaxSelloffIx(cfg, pool, authority, [{ maxSelloffPct: 300, periodLength: 60, feeThresholdPct: 100, feeSlopeLowPct: 10, feeSlopeHighPct: 900, feeSlopeMidPct: 700, feeKinkPct: 80 }]);
  const expected = buildContractInstruction(cfg, "cubicPool", "set_max_selloff", { params: [{ max_selloff_pct: 300, period_length: 60, fee_threshold_pct: 100, fee_slope_low_pct: 10, fee_slope_high_pct: 900, fee_slope_mid_pct: 700, fee_kink_pct: 80 }] }, { pool, authority });
  expect(result).toEqual(expected);
});

// Compile-time examples pin inference: callers cannot invent instruction names
// or omit newly required fields, even though the API covers every instruction.
if (false) {
  // @ts-expect-error unknown instruction
  buildContractInstruction(cfg, "cubicPool", "unknown_instruction", {}, {});
  // @ts-expect-error required hard floor must not disappear at compile time
  buildContractInstruction(cfg, "cubicPool", "set_banned_extensions", { banned_extensions: new BN(1) }, { config: pk(), authority: pk() });
}

test("every AdminClient operation matches the current protocol-admin ABI", async () => {
  const { AnchorProvider, Wallet } = await import("@coral-xyz/anchor");
  const { Connection } = await import("@solana/web3.js");
  const { AdminClient } = await import("../src/clients/AdminClient");
  const admin = Keypair.generate();
  const client = new AdminClient({ config: cfg, provider: new AnchorProvider(new Connection("http://127.0.0.1:8899"), new Wallet(admin), {}) });
  const a = admin.publicKey, pool = pk(), config = pk(), mint = pk(), recipient = pk(), other = pk();
  const amount = new BN(77);
  const calls: Record<string, () => any> = {
    initialize: () => client.initializeTreasuryIx(a, other),
    initiate_admin_transfer: () => client.initiateAdminTransferIx(a, other),
    accept_admin_transfer: () => client.acceptAdminTransferIx(a),
    cancel_admin_transfer: () => client.cancelAdminTransferIx(a),
    register_token: () => client.registerTokenIx(a, mint),
    withdraw: () => client.withdrawIx(a, mint, recipient, amount),
    transfer_upgrade_authority: () => client.transferUpgradeAuthorityIx(a, cfg.programs.cubicPool, other),
    freeze_pool_program: () => client.freezePoolProgramIx(a, cfg.programs.cubicPool),
    close_pool_program: () => client.closePoolProgramIx(a, cfg.programs.cubicPool, recipient),
    upgrade_pool_program: () => client.upgradePoolProgramIx(a, cfg.programs.cubicPool, other, recipient),
    pool_initialize_config: () => client.poolInitializeConfigIx(a, config, 300),
    pool_set_protocol_fee_rate: () => client.setProtocolFeeRateIx(a, config, pool, 300),
    pool_set_pool_enabled: () => client.setPoolEnabledIx(a, config, pool, true),
    pool_set_swaps_enabled: () => client.setSwapsEnabledIx(a, config, pool, false),
    pool_set_banned_extensions: () => client.setBannedExtensionsIx(a, config, amount, new BN(512)),
    pool_migrate_to_v5: () => client.migratePoolToV5Ix(a, config, pool, false),
    stld_withdraw_sol: () => client.stldWithdrawSolIx(a, config, pool, other, recipient, amount),
    freeze_pools: () => client.freezePoolsIx(a, [{ config, pool }]),
    unfreeze_pools: () => client.unfreezePoolsIx(a, [{ config, pool }]),
    pool_set_token_active: () => client.setTokenActiveIx(a, config, pool, 1, true),
    set_supervisor: () => client.setSupervisorIx(a, other),
    pool_collect_protocol_fees: () => client.collectProtocolFeesIx(a, config, pool, [mint], [recipient]),
    pool_debug_withdraw_liquidity: () => client.debugWithdrawLiquidityIx(a, config, pool, [amount], [mint], [recipient]),
    withdraw_sol: () => client.withdrawSolIx(a, recipient, amount),
    pool_withdraw_sol: () => client.poolWithdrawSolIx(a, config, other, recipient, amount),
    pool_initialize_alt: () => client.poolInitializeAltIx(a, config, pool, new BN(1000)),
    pool_initiate_protocol_admin_transfer: () => client.poolInitiateProtocolAdminTransferIx(a, config, other),
    pool_accept_protocol_admin_transfer: () => client.poolAcceptProtocolAdminTransferIx(a, config),
    pool_cancel_protocol_admin_transfer: () => client.poolCancelProtocolAdminTransferIx(a, config),
  };
  expect(Object.keys(calls).sort()).toEqual(IDLS.protocolAdmin.instructions.map(ix => ix.name).sort());
  for (const schema of IDLS.protocolAdmin.instructions) {
    const ix = await calls[schema.name]();
    expect(ix.programId.equals(cfg.programs.protocolAdmin)).toBe(true);
    expect(ix.data.subarray(0, 8)).toEqual(Buffer.from(schema.discriminator));
    for (let i = 0; i < schema.accounts.length; i++) {
      const declared = schema.accounts[i] as any;
      expect(ix.keys[i].isSigner).toBe(!!declared.signer);
      expect(ix.keys[i].isWritable).toBe(!!declared.writable);
    }
  }
  expect(() => client.withdrawIx(a, mint, recipient, amount, TOKEN_2022_PROGRAM_ID)).toThrow(/classic SPL/);
  expect(() => client.registerTokenIx(a, mint, TOKEN_2022_PROGRAM_ID)).toThrow(/classic SPL/);
});

test("join builder refuses positive BPT backed by a zero rounded live deposit", () => {
  const pool = poolFixture();
  pool.tokens[0].actualBalance = new BN(3);
  pool.tokens[1].actualBalance = new BN(3);
  pool.bptTotalSupply = new BN(1000000);
  expect(() => buildAddLiquidityIx(cfg, pool, { user: pk(), tokenAmounts: [new BN(1), new BN(1)], minimumBptAmount: new BN(1) })).toThrow(/too small/);
});

test("legacy event parser preserves malformed/new unrepresentable events as Unknown", () => {
  const idl = IDLS.protocolAdmin;
  const event = idl.events.find(e => e.name === "SupervisorSet")!;
  const schema = idl.types.find(t => t.name === event.name)!.type as any;
  const value = fieldsSample(schema.fields, idl);
  value.timestamp = new BN(1).shln(62);
  const data = Buffer.concat([Buffer.from(event.discriminator), encodeFields(value, schema.fields, idl)]);
  expect(parseContractEvents([`Program data: ${data.toString("base64")}`])[0].kind).toBe("SupervisorSet");
  expect(parseCubicPoolEvents([`Program data: ${data.toString("base64")}`])[0].kind).toBe("Unknown");
});
