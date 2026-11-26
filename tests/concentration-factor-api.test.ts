/** Public rename compatibility only; historical vectors and wire layouts stay unchanged. */
import { BorshCoder, Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import * as sdk from "../src";
import * as concentrationMath from "../src/math/concentrationFactor";
import type {
  ContractInstructionMap, ContractTypes, PoolInfo, PoolInfoV2Event,
  PoolTokenInfo, SetRangeManagerConfigParams,
} from "../src";

type Assert<T extends true> = T;
type HasKeys<T, K extends PropertyKey> = Exclude<K, keyof T> extends never ? true : false;
type LegacyKeys<T> = {
  [K in keyof T]-?: K extends string
    ? Lowercase<K> extends `${string}leverage${string}` ? K : never
    : never;
}[keyof T];
type NoLegacyKeys<T> = [LegacyKeys<T>] extends [never] ? true : false;
type MathNames = "checkConcentrationFactor" | "concentrationFactorHolds" |
  "concentrationFactorViolations" | "assertConcentrationFactorInvariant" |
  "checkSeedConcentrationFactor" | "checkFundConcentrationFactor";
type RangeArgs = ContractInstructionMap["cofferPool"]["set_range_manager_config"]["args"];
type PendingRange = ContractTypes["cofferPool"]["PendingSetRangeManagerConfig"];

// These constraints must also pass ts-jest's TypeScript diagnostics. A restored
// old key or a removed replacement makes this declaration fail to compile.
const publicTypeChecks: [
  Assert<HasKeys<typeof sdk, MathNames>>, Assert<NoLegacyKeys<typeof sdk>>,
  Assert<HasKeys<PoolTokenInfo, "concentrationFactor">>, Assert<NoLegacyKeys<PoolTokenInfo>>,
  Assert<HasKeys<PoolInfo, "concentrationFactorViolations" |
    "rangeManagerMaxConcentrationFactorBps" | "rangeManagerMinConcentrationFactorBps">>,
  Assert<NoLegacyKeys<PoolInfo>>,
  Assert<HasKeys<SetRangeManagerConfigParams, "maxConcentrationFactorBps" | "minConcentrationFactorBps">>,
  Assert<NoLegacyKeys<SetRangeManagerConfigParams>>,
  Assert<HasKeys<RangeArgs, "max_concentration_factor_bps" | "min_concentration_factor_bps">>,
  Assert<NoLegacyKeys<RangeArgs>>,
  Assert<HasKeys<PendingRange, "max_concentration_factor_bps" | "min_concentration_factor_bps">>,
  Assert<NoLegacyKeys<PendingRange>>,
  Assert<HasKeys<PoolInfoV2Event, "rangeManagerMaxConcentrationFactorBps" | "rangeManagerMinConcentrationFactorBps">>,
  Assert<NoLegacyKeys<PoolInfoV2Event>>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true];

const config = sdk.getConfig("mainnet");
const pool = new PublicKey(Buffer.alloc(32, 1));
const authority = new PublicKey(Buffer.alloc(32, 2));
const accounts = { pool, authority };
const params: SetRangeManagerConfigParams = {
  authority, maxVbChangePct: 500, maxWeightChangePct: 250,
  minUpdateIntervalSecs: 30, maxConcentrationFactorBps: 30_000, minConcentrationFactorBps: 5_000,
};
const args: RangeArgs = {
  max_vb_change_pct: params.maxVbChangePct,
  max_weight_change_pct: params.maxWeightChangePct,
  min_update_interval_secs: params.minUpdateIntervalSecs,
  max_concentration_factor_bps: params.maxConcentrationFactorBps,
  min_concentration_factor_bps: params.minConcentrationFactorBps,
};

function expectNoLegacyKeys(value: object): void {
  expect(Object.keys(value).filter((key) => /leverage/i.test(key))).toEqual([]);
}

function identifierNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(identifierNames);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => {
    if (key === "docs") return [];
    return key === "name" && typeof item === "string" ? [item] : identifierNames(item);
  });
}

function poolBytes(): Buffer {
  // Same legacy discriminator and tail offsets used by the existing T18 fixture.
  const data = Buffer.alloc(sdk.POOL_V4_LEN);
  Buffer.from([137, 210, 42, 22, 209, 156, 43, 78]).copy(data);
  authority.toBuffer().copy(data, 8);
  data[40] = 254;
  data.writeUInt32LE(params.maxConcentrationFactorBps, 1659);
  data.writeUInt32LE(params.minConcentrationFactorBps, 1663);
  return data;
}

describe("concentration-factor public API compatibility", () => {
  test("root and direct math exports expose the replacements without legacy aliases", () => {
    const root = sdk as unknown as Record<string, unknown>;
    const math = concentrationMath as unknown as Record<string, unknown>;
    for (const name of [
      "checkConcentrationFactor", "concentrationFactorHolds", "concentrationFactorViolations",
      "assertConcentrationFactorInvariant", "checkSeedConcentrationFactor", "checkFundConcentrationFactor",
    ]) {
      expect(typeof math[name]).toBe("function");
      expect(root[name]).toBe(math[name]);
    }
    expectNoLegacyKeys(sdk);
    expectNoLegacyKeys(concentrationMath);
    expect(() => require.resolve("../src/math/leverage")).toThrow();
  });

  test("public TypeScript keys retain replacements and reject legacy spellings", () => {
    expect(publicTypeChecks).toEqual(Array(14).fill(true));
  });

  test("all shipped IDL identifier trees use the canonical concentration-factor names", () => {
    for (const idl of Object.values(sdk.IDLS)) {
      const names = identifierNames(idl);
      expect(names.length).toBeGreaterThan(0);
      expect(names.filter((name) => /leverage/i.test(name))).toEqual([]);
    }
    const schema = sdk.COFFER_POOL_IDL.instructions.find((entry) => entry.name === "set_range_manager_config");
    expect(schema).toBeDefined();
    expect(schema!.args.slice(-2).map((entry) => entry.name)).toEqual([
      "max_concentration_factor_bps", "min_concentration_factor_bps",
    ]);
  });

  test("real legacy/current pool decoders expose renamed bounds at unchanged offsets", () => {
    const legacy = poolBytes();
    const current = Buffer.alloc(sdk.POOL_LEN);
    legacy.copy(current);
    current[1683] = 1;
    for (const bytes of [legacy, current]) {
      const decoded = sdk.decodePoolAccount(bytes);
      expect(decoded.rangeManagerMaxConcentrationFactorBps).toBe(params.maxConcentrationFactorBps);
      expect(decoded.rangeManagerMinConcentrationFactorBps).toBe(params.minConcentrationFactorBps);
      expectNoLegacyKeys(decoded);
    }
    const exact = sdk.decodeContractAccount("cofferPool", "CofferPool", current);
    expect(exact.range_manager_max_concentration_factor_bps).toBe(params.maxConcentrationFactorBps);
    expect(exact.range_manager_min_concentration_factor_bps).toBe(params.minConcentrationFactorBps);
    expectNoLegacyKeys(exact);
  });

  test("real range-manager event decoders expose only canonical snake/camel bound keys", () => {
    const state: ContractTypes["cofferPool"]["RangeManagerConfigSet"] = {
      pool, authority, max_vb_change_pct: 500, max_weight_change_pct: 250,
      min_update_interval_secs: 30, timestamp: new BN(123),
      old_max_vb_change_pct: 400, old_max_weight_change_pct: 200,
      old_min_update_interval_secs: 20,
      old_max_concentration_factor_bps: 20_000, new_max_concentration_factor_bps: 30_000,
      old_min_concentration_factor_bps: 4_000, new_min_concentration_factor_bps: 5_000,
    };
    const coder = new BorshCoder(sdk.COFFER_POOL_IDL as unknown as Idl);
    const event = sdk.COFFER_POOL_IDL.events.find((entry) => entry.name === "RangeManagerConfigSet");
    expect(event).toBeDefined();
    const encoded = Buffer.concat([
      Buffer.from(event!.discriminator), coder.types.encode("RangeManagerConfigSet", state),
    ]).toString("base64");
    const exact = sdk.decodeContractEvent(encoded, "cofferPool");
    if (!exact || exact.kind !== "RangeManagerConfigSet") throw new Error("RangeManagerConfigSet did not decode");
    expect(exact.data).toMatchObject({
      old_max_concentration_factor_bps: 20_000, new_max_concentration_factor_bps: 30_000,
      old_min_concentration_factor_bps: 4_000, new_min_concentration_factor_bps: 5_000,
    });
    expectNoLegacyKeys(exact.data);
    const parsed = sdk.parseCofferPoolEvents([`Program data: ${encoded}`]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      kind: "RangeManagerConfigSet", oldMaxConcentrationFactorBps: 20_000,
      newMaxConcentrationFactorBps: 30_000, oldMinConcentrationFactorBps: 4_000,
      newMinConcentrationFactorBps: 5_000,
    });
    expectNoLegacyKeys(parsed[0]);
  });

  test("raw and exact ABI setters and queued actions preserve identical canonical payload bytes", () => {
    const raw = sdk.buildSetRangeManagerConfigIx(config, pool, params);
    const exact = sdk.buildContractInstruction(config, "cofferPool", "set_range_manager_config", args, accounts);
    expect(raw.data.subarray(0, 8).toString("hex")).toBe("67d300c8a4bdf5cd");
    expect(raw.data).toEqual(exact.data);
    expect(raw.keys).toEqual(exact.keys);
    expect(raw.programId.equals(exact.programId)).toBe(true);
    expect(raw.data).toHaveLength(24);
    expect(raw.data.readUInt32LE(16)).toBe(params.maxConcentrationFactorBps);
    expect(raw.data.readUInt32LE(20)).toBe(params.minConcentrationFactorBps);
    const action = sdk.PoolActions.setRangeManagerConfig(params);
    expect(action).toEqual({ SetRangeManagerConfig: args });
    const queued = sdk.buildContractInstruction(config, "cofferPool", "propose_pool_action", { action }, accounts);
    const coder = new BorshCoder(sdk.COFFER_POOL_IDL as unknown as Idl);
    const payload = coder.types.encode("PoolAction", action);
    expect(queued.data.subarray(8)).toEqual(payload);
    expect(payload.subarray(1)).toEqual(exact.data.subarray(8));
  });

  test("exact ABI encoding rejects old-only, mixed and nested legacy bound arguments", () => {
    for (const [canonical, legacy] of [
      ["max_concentration_factor_bps", "max_leverage_bps"],
      ["min_concentration_factor_bps", "min_leverage_bps"],
    ] as const) {
      const oldOnly: Record<string, unknown> = { ...args, [legacy]: args[canonical] };
      delete oldOnly[canonical];
      expect(() => sdk.buildContractInstruction(config, "cofferPool", "set_range_manager_config",
        oldOnly as RangeArgs, accounts)).toThrow(`${canonical} is required`);
      const mixed = { ...args, [legacy]: args[canonical] };
      expect(() => sdk.buildContractInstruction(config, "cofferPool", "set_range_manager_config",
        mixed, accounts)).toThrow(`${legacy} is not in the contract ABI`);
      const action = { SetRangeManagerConfig: mixed };
      expect(() => sdk.buildContractInstruction(config, "cofferPool", "propose_pool_action",
        { action }, accounts)).toThrow(`${legacy} is not in the contract ABI`);
    }
  });
});
