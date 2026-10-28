import BN from "bn.js";
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { CofferPoolClient, RpcClient, decodePoolAccount, decodeContractAccount, deriveLpMint, deriveAta, getConfig, IDLS } from "../src";
import { ContractAccountMap } from "../src/types/contracts";

type State = ContractAccountMap["cofferPool"]["CofferPool"];
const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const bn = (n: number | string | bigint) => new BN(n.toString());
const wide = bn("9007199254741017");
const fields = (name: string) => (IDLS.cofferPool.types.find(t => t.name === name)!.type as any).fields as {name: string; type: any}[];

// Borsh encoder independent of the manual SDK account decoder and its offsets.
function encode(value: any, type: any): Buffer {
  if (type === "pubkey") return value.toBuffer();
  if (type === "bool") return Buffer.from([Number(value)]);
  if (typeof type === "string") {
    const bits = Number(type.slice(1));
    return (BN.isBN(value) ? value : bn(value)).toTwos(bits).toArrayLike(Buffer, "le", bits / 8);
  }
  if (type.array) return Buffer.concat(value.map((v: any) => encode(v, type.array[0])));
  if (type.vec) return Buffer.concat([bn(value.length).toArrayLike(Buffer, "le", 4), ...value.map((v: any) => encode(v, type.vec))]);
  if (type.defined) return Buffer.concat(fields(type.defined.name).map(f => encode(value[f.name], f.type)));
  throw new Error("Unknown fixture type");
}
function bytes(state: State): Buffer {
  return Buffer.concat([Buffer.from(IDLS.cofferPool.accounts[0].discriminator), ...fields("CofferPool").map(f => encode((state as any)[f.name], f.type))]);
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
    lookup_table: key(30), _deprecated_banned_extensions: bn("9223372036854776320"),
    range_manager_max_leverage_bps: 876543, range_manager_min_leverage_bps: 12345,
    reserved: Array.from({length:16}, (_,i) => i+1),
    // ── v6.1 appended block (2304-byte layout) ──
    layout_version: 1,
    token_decimals: [6, 7, 8, 0, 0, 0, 0, 0, 0, 0],
    creator_fee_bps: 2500,
    creator_fees_owed: Array.from({length: 10}, (_, i) => i < 3 ? wide.addn(130 + i) : bn(0)),
    surge_fees_owed: Array.from({length: 10}, (_, i) => i < 3 ? wide.addn(150 + i) : bn(0)),
    deposit_fee_bps: 5, withdraw_fee_bps: 7, liquidity_fee_lock: 1, range_manager_locked: true,
    pool_admin_delay_secs: 86400, pool_admin_epoch: 3, pending_pool_admin_eta: bn(1700000000),
    pending_set_delay: { eta: bn(1700000001), secs: 3600 },
    pending_set_swap_fee_rate: { eta: bn(0), rate: 0 },
    pending_set_creator_fee_bps: { eta: bn(1700000003), bps: 1234 },
    pending_set_liquidity_fees: { eta: bn(0), deposit_fee_bps: 0, withdraw_fee_bps: 0 },
    pending_lock_liquidity_fees: { eta: bn(1700000005) },
    pending_lock_range_manager: { eta: bn(0) },
    pending_set_range_manager: { eta: bn(1700000007), manager: key(40), enabled: true },
    pending_set_range_manager_config: { eta: bn(0), max_vb_change_pct: 0, max_weight_change_pct: 0, min_update_interval_secs: 0, max_leverage_bps: 0, min_leverage_bps: 0 },
    pending_set_max_selloff: { eta: bn(1700000009), params_hash: Array.from({length: 32}, (_, i) => 200 + i % 50) },
    pending_set_token_active: { eta: bn(-5), token_index: 2 },
    hook_program: key(41), hook_flags: 0b1110000, hook_disabled: 1, hook_fee_min: 100, hook_fee_max: 50000, hook_max_cu: 60000, hook_accounts_len: 4,
    reserved_v61: Array.from({length: 202}, () => 0),
  };
}
const poolMap = {
  config: "config", bump: "bump", token_count: "tokenCount", pool_id: "poolId", swap_fee_rate: "swapFeeRate",
  protocol_fee_rate: "protocolFeeRate", created_at: "createdAt", pool_enabled: "poolEnabled", swaps_enabled: "swapsEnabled",
  pool_admin: "poolAdmin", pending_pool_admin: "pendingPoolAdmin", range_manager: "rangeManager",
  range_manager_enabled: "rangeManagerEnabled", range_manager_max_vb_change_pct: "rangeManagerMaxVbChangePct",
  range_manager_max_weight_change_pct: "rangeManagerMaxWeightChangePct", range_manager_min_update_interval_secs: "rangeManagerMinUpdateIntervalSecs",
  range_manager_last_updated: "rangeManagerLastUpdated", lookup_table: "lookupTable", _deprecated_banned_extensions: "deprecatedBannedExtensions",
  range_manager_max_leverage_bps: "rangeManagerMaxLeverageBps", range_manager_min_leverage_bps: "rangeManagerMinLeverageBps",
  // v6.1
  layout_version: "layoutVersion", token_decimals: "tokenDecimals", creator_fee_bps: "creatorFeeBps", creator_fees_owed: "creatorFeesOwed",
  surge_fees_owed: "surgeFeesOwed", deposit_fee_bps: "depositFeeBps", withdraw_fee_bps: "withdrawFeeBps", liquidity_fee_lock: "liquidityFeeLock",
  range_manager_locked: "rangeManagerLocked", pool_admin_delay_secs: "poolAdminDelaySecs", pool_admin_epoch: "poolAdminEpoch",
  pending_pool_admin_eta: "pendingPoolAdminEta", hook_program: "hookProgram", hook_flags: "hookFlags", hook_disabled: "hookDisabled",
  hook_fee_min: "hookFeeMin", hook_fee_max: "hookFeeMax", hook_max_cu: "hookMaxCu", hook_accounts_len: "hookAccountsLen", reserved_v61: "reservedV61",
} as const;
/** v6.1 (T3) typed slots: wire field → (pendingActions kind, payload keys in wire order). */
const pendingMap: Record<string, [number, string[]]> = {
  pending_set_delay: [1, ["secs"]], pending_set_swap_fee_rate: [2, ["rate"]], pending_set_creator_fee_bps: [3, ["bps"]],
  pending_set_liquidity_fees: [4, ["depositFeeBps", "withdrawFeeBps"]], pending_lock_liquidity_fees: [5, []], pending_lock_range_manager: [6, []],
  pending_set_range_manager: [7, ["manager", "enabled"]],
  pending_set_range_manager_config: [8, ["maxVbChangePct", "maxWeightChangePct", "minUpdateIntervalSecs", "maxLeverageBps", "minLeverageBps"]],
  pending_set_max_selloff: [9, ["paramsHash"]], pending_set_token_active: [10, ["tokenIndex"]],
};
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

test("field mapping covers every current CofferPool and token-slot ABI field", () => {
  expect([...Object.keys(poolMap), ...Object.keys(pendingMap), "tokens", "reserved"].sort()).toEqual(fields("CofferPool").map(f => f.name).sort());
  expect(Object.keys(configMap).sort()).toEqual(fields("AssetConfig").map(f => f.name).sort());
  expect(Object.keys(dynamicsMap).sort()).toEqual(fields("AssetDynamics").map(f => f.name).sort());
});

test("manual pool decoder preserves every field, signed i64, wide u64 and padding", () => {
  const state = fixture(), encoded = bytes(state), raw = decodePoolAccount(encoded) as any;
  expect(normalize(decodeContractAccount("cofferPool", "CofferPool", encoded))).toEqual(normalize(state));
  for (const [wire, name] of Object.entries(poolMap)) expect(normalize(raw[name])).toEqual(normalize((state as any)[wire]));
  for (let i=0; i<10; i++) {
    for (const [wire,[name]] of Object.entries(configMap)) expect(normalize(raw[name][i])).toEqual(normalize((state.tokens[i].config as any)[wire]));
    for (const [wire,[name]] of Object.entries(dynamicsMap)) expect(normalize(raw[name][i])).toEqual(normalize((state.tokens[i].dynamics as any)[wire]));
  }
  expect([...raw.reserved]).toEqual(state.reserved);
  raw.reserved[0] = 255;
  expect(encoded[1667]).toBe(1); // caller mutation must not alter the input buffer
  // v6.1 (T3): every typed slot lands in `pendingActions` with its eta and payload in wire order.
  expect(encoded.length).toBe(2304);
  expect(raw.layoutDrift).toEqual([]);
  expect(raw.pendingActions).toHaveLength(11);
  expect(normalize(raw.pendingActions[0].eta)).toBe(normalize(state.pending_pool_admin_eta));
  expect(normalize(raw.pendingActions[0].payload.newAdmin)).toBe(normalize(state.pending_pool_admin));
  for (const [wire, [kind, keys]] of Object.entries(pendingMap)) {
    const slot = (state as any)[wire];
    expect(raw.pendingActions[kind].kind).toBe(kind);
    expect(normalize(raw.pendingActions[kind].eta)).toBe(normalize(slot.eta));
    const wireKeys = Object.keys(slot).filter(k => k !== "eta");
    expect(Object.keys(raw.pendingActions[kind].payload)).toEqual(keys);
    wireKeys.forEach((wk, j) => {
      const expected = wk === "params_hash" ? Buffer.from(slot[wk]).toString("hex") : slot[wk];
      expect(normalize(raw.pendingActions[kind].payload[keys[j]])).toEqual(normalize(expected));
    });
  }
  expect(raw.pendingActionsMask).toBe((1 << 0) | (1 << 1) | (1 << 3) | (1 << 5) | (1 << 7) | (1 << 9) | (1 << 10));
});

test("an unmigrated 1683-byte pool decodes read-only with layout_version 0 and v6.1 defaults", () => {
  const state = fixture(), encoded = bytes(state).subarray(0, 1683), raw = decodePoolAccount(encoded) as any;
  expect(raw.dataLen).toBe(1683);
  expect(raw.layoutVersion).toBe(0);
  for (const [wire, name] of Object.entries(poolMap)) {
    if (["layout_version", "token_decimals", "creator_fee_bps", "creator_fees_owed", "surge_fees_owed", "deposit_fee_bps", "withdraw_fee_bps",
      "liquidity_fee_lock", "range_manager_locked", "pool_admin_delay_secs", "pool_admin_epoch", "pending_pool_admin_eta", "hook_program", "hook_flags",
      "hook_disabled", "hook_fee_min", "hook_fee_max", "hook_max_cu", "hook_accounts_len", "reserved_v61"].includes(wire)) continue;
    expect(normalize(raw[name])).toEqual(normalize((state as any)[wire]));
  }
  expect(raw.tokenDecimals).toEqual(Array(10).fill(0));
  expect(raw.creatorFeesOwed.every((x: BN) => x.isZero())).toBe(true);
  expect(raw.surgeFeesOwed.every((x: BN) => x.isZero())).toBe(true);
  expect(raw.hookProgram.equals(PublicKey.default)).toBe(true);
  expect(raw.pendingActions).toEqual([]);
  expect(raw.reservedV61.length).toBe(0);
  expect(raw.layoutDrift).toEqual([]);
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
  infos.set(address.toBase58(), {data,owner:cfg.programs.cofferPool,lamports:123});
  const lp = deriveLpMint(cfg.programs.cofferPool,address)[0];
  infos.set(lp.toBase58(), {data:mint(9,wide.addn(999)),owner:TOKEN_2022_PROGRAM_ID,lamports:456});
  state.tokens.slice(0,state.token_count).forEach((s,i) => infos.set(s.config.mint.toBase58(),{data:mint(6+i,wide.addn(i)),owner:s.config.token_program,lamports:789}));
  const clock=Buffer.alloc(40); clock.writeBigUInt64LE(445105299n,0); clock.writeBigUInt64LE(1030n,16); clock.writeBigInt64LE(1788799999n,32);
  infos.set(SYSVAR_CLOCK_PUBKEY.toBase58(),{data:clock,owner:key(55),lamports:1});
  const rpc = new RpcClient({endpoint:"http://127.0.0.1:8899",connectionFactory:() => ({
    getAccountInfo: async (key: PublicKey) => infos.get(key.toBase58()) ?? null,
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(k => infos.get(k.toBase58()) ?? null),
    getSlot: async () => 1,
  })});
  return new CofferPoolClient({config:cfg,poolAddress:address,rpc});
}

test("sync maps every operational field and token program with full-width balances", async () => {
  const state = fixture(), client = mockClient(state), result = await client.sync();
  if (!result.ok) throw new Error(result.error.humanMessage);
  const info = result.data as any;
  const hookMap: Record<string, string> = { hook_program: "program", hook_flags: "flags", hook_fee_min: "feeMin", hook_fee_max: "feeMax", hook_max_cu: "maxCu", hook_accounts_len: "accountsLen" };
  for (const [wire,name] of Object.entries(poolMap)) {
    if (wire === "_deprecated_banned_extensions" || wire === "reserved_v61") { expect(info[name]).toBeUndefined(); continue; }
    if (hookMap[wire]) { expect(normalize(info.hook[hookMap[wire]])).toEqual(normalize((state as any)[wire])); continue; }
    if (wire === "hook_disabled") { expect(info.hook.disabled).toBe(true); expect(info.hook.active).toBe(false); continue; }
    if (wire === "token_decimals" || wire === "creator_fees_owed" || wire === "surge_fees_owed") {
      expect(normalize(info[name])).toEqual(normalize((state as any)[wire].slice(0, state.token_count)));
      continue;
    }
    const expected = wire === "created_at" ? state.created_at.toNumber() : (state as any)[wire];
    expect(normalize(info[name])).toEqual(normalize(expected));
  }
  expect(info.needsLayoutMigration).toBe(false);
  expect(info.liquidityFeesLocked).toBe(true);
  expect(info.pendingActions).toHaveLength(11);
  expect(info.pendingActionsMask).toBe(0b11010101011);
  expect(info.lpMetadata).toBeNull(); // 82-byte legacy mint in this fixture
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
  expect(info.lpTokenProgram.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  expect(info.lpTotalSupply.eq(wide.addn(999))).toBe(true);
  expect(info.chainTimestamp).toBe(1788799999);
  expect(info.chainSlot).toBe(445105299);
  expect(info.chainEpoch).toBe(1030);
  expect(info.v5Migrated).toBe(false);
  for (const t of info.tokens) expect([t.transferFee, t.transferHookProgram, t.paused]).toEqual([null, null, false]);
  expect(client.getCached()).toBe(info);
});

test("the V5M1 marker in reserved[0..4] reads as v5Migrated", async () => {
  const state=fixture(); state.reserved=[0x56,0x35,0x4d,0x31, ...Array.from({length:12}, (_,i) => i+5)];
  expect(decodePoolAccount(bytes(state)).v5Migrated).toBe(true);
  expect(decodePoolAccount(bytes(state)).reserved.subarray(0,4).toString("ascii")).toBe("V5M1");
  const result=await mockClient(state).sync();
  if (!result.ok) throw new Error(result.error.humanMessage);
  expect(result.data.v5Migrated).toBe(true);
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
