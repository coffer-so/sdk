import BN from "bn.js";
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { CubicPoolClient, RpcClient, decodePoolAccount, decodeContractAccount, deriveBptMint, deriveAta, getConfig, IDLS } from "../src";
import { ContractAccountMap } from "../src/types/contracts";

type State = ContractAccountMap["cubicPool"]["CubicPool"];
const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const bn = (n: number | string | bigint) => new BN(n.toString());
const wide = bn("9007199254741017");
const fields = (name: string) => (IDLS.cubicPool.types.find(t => t.name === name)!.type as any).fields as {name: string; type: any}[];

// Borsh encoder independent of the manual SDK account decoder and its offsets.
function encode(value: any, type: any): Buffer {
  if (type === "pubkey") return value.toBuffer();
  if (type === "bool") return Buffer.from([Number(value)]);
  if (typeof type === "string") {
    const bits = Number(type.slice(1));
    return (BN.isBN(value) ? value : bn(value)).toTwos(bits).toArrayLike(Buffer, "le", bits / 8);
  }
  if (type.array) return Buffer.concat(value.map((v: any) => encode(v, type.array[0])));
  if (type.defined) return Buffer.concat(fields(type.defined.name).map(f => encode(value[f.name], f.type)));
  throw new Error("Unknown fixture type");
}
function bytes(state: State): Buffer {
  return Buffer.concat([Buffer.from(IDLS.cubicPool.accounts[0].discriminator), ...fields("CubicPool").map(f => encode((state as any)[f.name], f.type))]);
}
function normalize(v: any): any {
  if (BN.isBN(v)) return v.toString();
  if (v instanceof PublicKey) return v.toBase58();
  if (Buffer.isBuffer(v)) return [...v];
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k,v]) => [k, normalize(v)]));
  return v;
}
function fixture(): State {
  return {
    config: key(2), bump: 254, token_count: 3, pool_id: wide,
    swap_fee_rate: 1357, protocol_fee_rate: 2468, created_at: bn(-1234567),
    pool_enabled: true, swaps_enabled: false, pool_admin: key(3), pending_pool_admin: key(4),
    range_manager: key(5), range_manager_enabled: true, range_manager_max_vb_change_pct: 321,
    range_manager_max_weight_change_pct: 432, range_manager_min_update_interval_secs: 7654321,
    range_manager_last_updated: bn("-9223372036854775808"),
    tokens: Array.from({length: 10}, (_, i) => ({
      config: { mint: key(10+i), token_program: i % 2 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
        normalized_weight: bn(2000+i), max_selloff_pct: 101+i, max_selloff_period_length: 123456+i,
        variable_fee_threshold_pct: 3000+i, variable_fee_slope_low_pct: 401+i,
        variable_fee_slope_high_pct: 8000+i, is_active: i % 2 === 0,
        variable_fee_slope_mid_pct: 5000+i, variable_fee_kink_pct: 91+i },
      dynamics: {virtual_balance: wide.addn(10+i), actual_balance: wide.addn(30+i),
        protocol_fees_owed: wide.addn(50+i), previous_selloff: wide.addn(70+i),
        current_selloff: wide.addn(90+i), window_start_timestamp: bn(-900-i), selloff_vb_snapshot: wide.addn(110+i)},
    })),
    lookup_table: key(30), banned_extensions: bn("9223372036854776320"),
    range_manager_max_leverage_bps: 876543, range_manager_min_leverage_bps: 12345,
    reserved: Array.from({length:16}, (_,i) => i+1),
  };
}
const poolMap = {
  config: "config", bump: "bump", token_count: "tokenCount", pool_id: "poolId", swap_fee_rate: "swapFeeRate",
  protocol_fee_rate: "protocolFeeRate", created_at: "createdAt", pool_enabled: "poolEnabled", swaps_enabled: "swapsEnabled",
  pool_admin: "poolAdmin", pending_pool_admin: "pendingPoolAdmin", range_manager: "rangeManager",
  range_manager_enabled: "rangeManagerEnabled", range_manager_max_vb_change_pct: "rangeManagerMaxVbChangePct",
  range_manager_max_weight_change_pct: "rangeManagerMaxWeightChangePct", range_manager_min_update_interval_secs: "rangeManagerMinUpdateIntervalSecs",
  range_manager_last_updated: "rangeManagerLastUpdated", lookup_table: "lookupTable", banned_extensions: "bannedExtensions",
  range_manager_max_leverage_bps: "rangeManagerMaxLeverageBps", range_manager_min_leverage_bps: "rangeManagerMinLeverageBps",
} as const;
const configMap = {
  mint: ["tokenMints", "mint"], token_program: ["tokenPrograms", "tokenProgram"], normalized_weight: ["normalizedWeights", "weightBps"],
  max_selloff_pct: ["maxSelloffPct", "maxSelloffPct"], max_selloff_period_length: ["maxSelloffPeriodLength", "maxSelloffPeriodLength"],
  variable_fee_threshold_pct: ["variableFeeThresholdPct", "variableFeeThresholdPct"], variable_fee_slope_low_pct: ["variableFeeSlopeLowPct", "variableFeeSlopeLowPct"],
  variable_fee_slope_high_pct: ["variableFeeSlopeHighPct", "variableFeeSlopeHighPct"], is_active: ["isActive", "isActive"],
  variable_fee_slope_mid_pct: ["variableFeeSlopeMidPct", "variableFeeSlopeMidPct"], variable_fee_kink_pct: ["variableFeeKinkPct", "variableFeeKinkPct"],
} as const;
const dynamicsMap = {
  virtual_balance: ["virtualBalances", "virtualBalance"], actual_balance: ["actualBalances", "actualBalance"],
  protocol_fees_owed: ["protocolFeesOwed", "protocolFeesOwed"], previous_selloff: ["previousSelloff", "previousSelloff"],
  current_selloff: ["currentSelloff", "currentSelloff"], window_start_timestamp: ["windowStartTimestamp", "windowStartTimestamp"],
  selloff_vb_snapshot: ["selloffVbSnapshot", "selloffVbSnapshot"],
} as const;

test("field mapping covers every current CubicPool and token-slot ABI field", () => {
  expect([...Object.keys(poolMap), "tokens", "reserved"].sort()).toEqual(fields("CubicPool").map(f => f.name).sort());
  expect(Object.keys(configMap).sort()).toEqual(fields("AssetConfig").map(f => f.name).sort());
  expect(Object.keys(dynamicsMap).sort()).toEqual(fields("AssetDynamics").map(f => f.name).sort());
});

test("manual pool decoder preserves every field, signed i64, wide u64 and padding", () => {
  const state = fixture(), encoded = bytes(state), raw = decodePoolAccount(encoded) as any;
  expect(normalize(decodeContractAccount("cubicPool", "CubicPool", encoded))).toEqual(normalize(state));
  for (const [wire, name] of Object.entries(poolMap)) expect(normalize(raw[name])).toEqual(normalize((state as any)[wire]));
  for (let i=0; i<10; i++) {
    for (const [wire,[name]] of Object.entries(configMap)) expect(normalize(raw[name][i])).toEqual(normalize((state.tokens[i].config as any)[wire]));
    for (const [wire,[name]] of Object.entries(dynamicsMap)) expect(normalize(raw[name][i])).toEqual(normalize((state.tokens[i].dynamics as any)[wire]));
  }
  expect([...raw.reserved]).toEqual(state.reserved);
  raw.reserved[0] = 255;
  expect(encoded[1667]).toBe(1); // caller mutation must not alter the input buffer
});

test("pool decoder rejects a wrong discriminator, impossible count and noncanonical bools", () => {
  for (const [offset, value, message] of [[0,0,"discriminator"], [41,11,"token_count"], [64,2,"bool"], [65,2,"bool"], [162,2,"bool"], [179+84,2,"bool"]] as const) {
    const data = bytes(fixture()); data[offset] = value;
    expect(() => decodePoolAccount(data)).toThrow(message);
  }
});

function mockClient(state: State, data = bytes(state)) {
  const cfg = getConfig("mainnet"), address = key(1);
  const mint = (decimals: number, supply: BN) => { const b = Buffer.alloc(82); b[44]=decimals; b[45]=1; supply.toArrayLike(Buffer,"le",8).copy(b,36); return b; };
  const infos = new Map<string, any>();
  infos.set(address.toBase58(), {data,owner:cfg.programs.cubicPool,lamports:123});
  const bpt = deriveBptMint(cfg.programs.cubicPool,address)[0];
  infos.set(bpt.toBase58(), {data:mint(9,wide.addn(999)),owner:TOKEN_2022_PROGRAM_ID,lamports:456});
  state.tokens.slice(0,state.token_count).forEach((s,i) => infos.set(s.config.mint.toBase58(),{data:mint(6+i,wide.addn(i)),owner:s.config.token_program,lamports:789}));
  const clock=Buffer.alloc(40); clock.writeBigInt64LE(1788799999n,32);
  infos.set(SYSVAR_CLOCK_PUBKEY.toBase58(),{data:clock,owner:key(55),lamports:1});
  const rpc = new RpcClient({endpoint:"http://127.0.0.1:8899",connectionFactory:() => ({
    getAccountInfo: async (key: PublicKey) => infos.get(key.toBase58()) ?? null,
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(k => infos.get(k.toBase58()) ?? null),
    getSlot: async () => 1,
  })});
  return new CubicPoolClient({config:cfg,poolAddress:address,rpc});
}

test("sync maps every operational field and token program with full-width balances", async () => {
  const state = fixture(), client = mockClient(state), result = await client.sync();
  if (!result.ok) throw new Error(result.error.humanMessage);
  const info = result.data as any;
  for (const [wire,name] of Object.entries(poolMap)) {
    const expected = wire === "created_at" ? state.created_at.toNumber() : (state as any)[wire];
    expect(normalize(info[name])).toEqual(normalize(expected));
  }
  expect(info.tokens).toHaveLength(state.token_count);
  for (let i=0;i<state.token_count;i++) {
    for (const [wire,[,name]] of Object.entries(configMap)) {
      const expected = wire === "normalized_weight" ? state.tokens[i].config.normalized_weight.toNumber() : (state.tokens[i].config as any)[wire];
      expect(normalize(info.tokens[i][name])).toEqual(normalize(expected));
    }
    for (const [wire,[,name]] of Object.entries(dynamicsMap)) expect(normalize(info.tokens[i][name])).toEqual(normalize((state.tokens[i].dynamics as any)[wire]));
    expect(info.tokens[i].decimals).toBe(6+i);
    expect(info.tokens[i].vault.equals(deriveAta(info.address, info.tokens[i].mint, info.tokens[i].tokenProgram))).toBe(true);
    expect(info.tokens[i].extensions).toEqual([]);
  }
  expect(info.bptTokenProgram.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  expect(info.bptTotalSupply.eq(wide.addn(999))).toBe(true);
  expect(info.chainTimestamp).toBe(1788799999);
  expect(client.getCached()).toBe(info);
});

test("sync returns a parse failure for a same-owner account with a wrong discriminator", async () => {
  const state=fixture(), data=bytes(state); data[0]^=255;
  const result=await mockClient(state,data).sync();
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("parse_failure");
});

test("sync reports unsafe numeric timestamps as a result error; raw decoding stays lossless", async () => {
  const state=fixture(); state.created_at=bn("9223372036854775807");
  expect(decodePoolAccount(bytes(state)).createdAt.toString()).toBe("9223372036854775807");
  const result=await mockClient(state).sync();
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("parse_failure");
});
