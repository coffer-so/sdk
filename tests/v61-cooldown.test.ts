/**
 * T3 cooldown: PoolAction / ProtocolAction payload constructors, kind
 * mapping, propose / cancel / execute builders, pending-slot decoding and
 * the pendingStatus state machine.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { BorshCoder } from "@coral-xyz/anchor";
import {
  PoolActions, ProtocolActions, poolActionKindOf, protocolActionKindOf, poolActionKindName, protocolActionKindName,
  POOL_EXECUTE_INSTRUCTION, PROTOCOL_EXECUTE_INSTRUCTIONS, buildProposePoolActionIx, buildCancelPoolActionIx, buildExecutePoolActionIx,
  proposeActionRemainingAccounts, selloffParamsArg,
} from "../src/clients/cooldown";
import { POOL_ACTION_KINDS, POOL_ACTION_KIND, PROTOCOL_ACTION_KINDS, PROTOCOL_ACTION_KIND, pendingStatus, GRACE_PERIOD_SECS, POOL_LAYOUT, TREASURY_LAYOUT } from "../src/parsers/layout";
import { decodePoolCooldownBlock } from "../src/parsers/poolAccount";
import { decodeTreasuryCooldownBlock, treasuryNeedsLayoutMigration } from "../src/parsers/treasuryAccount";
import cofferPoolIdl from "../src/idl/coffer_pool.json";
import protocolAdminIdl from "../src/idl/protocol_admin.json";
import { cfg } from "./helpers/poolFixture";

const pk = (): PublicKey => Keypair.generate().publicKey;
const poolCoder = new BorshCoder(cofferPoolIdl as any);
const adminCoder = new BorshCoder(protocolAdminIdl as any);
const ixName = (idl: any, data: Buffer) => (idl.instructions as any[]).find((i) => Buffer.from(i.discriminator).equals(data.subarray(0, 8)))?.name;

describe("PoolAction payloads and kinds", () => {
  test("[P01] every constructor maps to its kind 1..10 (tag = kind − 1) and the kind table is 11 long", () => {
    expect(POOL_ACTION_KINDS.length).toBe(11); expect(POOL_ACTION_KINDS[0]).toBe("TransferPoolAdmin");
    const all = [
      PoolActions.setDelay(1), PoolActions.setSwapFeeRate(2), PoolActions.setCreatorFeeBps(3), PoolActions.setLiquidityFees(4, 5),
      PoolActions.lockLiquidityFees(), PoolActions.lockRangeManager(), PoolActions.setRangeManager(pk(), true),
      PoolActions.setRangeManagerConfig({ maxVbChangePct: 1, maxWeightChangePct: 2, minUpdateIntervalSecs: 3, maxLeverageBps: 4, minLeverageBps: 5 }),
      PoolActions.setMaxSelloff([{ maxSelloffPct: 1, periodLength: 2, feeThresholdPct: 3, feeSlopeLowPct: 4, feeSlopeHighPct: 5, feeSlopeMidPct: 6, feeKinkPct: 7 }]),
      PoolActions.setTokenActive(1),
    ];
    expect(all.map(poolActionKindOf)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    all.forEach((a, i) => {
      const encoded = poolCoder.types.encode("PoolAction", a);
      expect(encoded[0]).toBe(i); // Borsh enum tag
      expect(POOL_ACTION_KIND[Object.keys(a)[0] as keyof typeof POOL_ACTION_KIND]).toBe(i + 1);
    });
  });
  test("[P02] kind ↔ name round trip and the execute-instruction table covers every kind", () => {
    for (let k = 0; k < 11; k++) { expect(poolActionKindName(k)).toBe(POOL_ACTION_KINDS[k]); expect(poolActionKindName(POOL_ACTION_KINDS[k])).toBe(POOL_ACTION_KINDS[k]); }
    for (const name of POOL_ACTION_KINDS) {
      const ix = POOL_EXECUTE_INSTRUCTION[name];
      expect((cofferPoolIdl.instructions as any[]).some((i) => i.name === ix)).toBe(true);
    }
  });
  test("[P03] propose_pool_action encodes the enum through the IDL coder ([pool w, authority s])", () => {
    const pool = pk(), auth = pk();
    const ix = buildProposePoolActionIx(cfg, pool, auth, PoolActions.setSwapFeeRate(1234));
    expect(ixName(cofferPoolIdl, ix.data)).toBe("propose_pool_action");
    const decoded = poolCoder.instruction.decode(ix.data) as any;
    expect(decoded.data.action).toEqual({ SetSwapFeeRate: { rate: 1234 } });
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([[pool.toBase58(), false, true], [auth.toBase58(), true, false]]);
  });
  test("[P04] cancel_pool_action(kind) by number or name, kind 0 included", () => {
    const pool = pk(), auth = pk();
    for (const [arg, kind] of [[0, 0], [3, 3], ["SetMaxSelloff", 9], ["SetTokenActive", 10]] as const) {
      const ix = buildCancelPoolActionIx(cfg, pool, auth, arg);
      expect(ixName(cofferPoolIdl, ix.data)).toBe("cancel_pool_action");
      expect((poolCoder.instruction.decode(ix.data) as any).data.kind).toBe(kind);
    }
  });
  test("[P05] execute_* per kind: no-arg executes, set_max_selloff with params, kind 0 → accept_pool_admin_transfer by the nominee", () => {
    const pool = pk(), auth = pk();
    for (const kind of [1, 2, 3, 4, 5, 6, 7, 8, 10]) {
      const ix = buildExecutePoolActionIx(cfg, pool, auth, kind);
      expect(ixName(cofferPoolIdl, ix.data)).toBe(POOL_EXECUTE_INSTRUCTION[POOL_ACTION_KINDS[kind]]);
      expect(ix.data.length).toBe(8);
      expect(ix.keys[1].pubkey.equals(auth) && ix.keys[1].isSigner).toBe(true);
    }
    const params = [{ maxSelloffPct: 1000, periodLength: 3600, feeThresholdPct: 10, feeSlopeLowPct: 1, feeSlopeHighPct: 2, feeSlopeMidPct: 3, feeKinkPct: 75 }];
    const sm = buildExecutePoolActionIx(cfg, pool, auth, "SetMaxSelloff", params);
    expect(ixName(cofferPoolIdl, sm.data)).toBe("execute_set_max_selloff");
    expect((poolCoder.instruction.decode(sm.data) as any).data.params).toEqual(params.map(selloffParamsArg));
    const accept = buildExecutePoolActionIx(cfg, pool, auth, 0);
    expect(ixName(cofferPoolIdl, accept.data)).toBe("accept_pool_admin_transfer");
    expect(accept.keys.some((k) => k.pubkey.equals(auth) && k.isSigner)).toBe(true);
  });
  test("[P06] the proposed SetMaxSelloff payload and the executed params use the same IDL shape", () => {
    const p = [{ maxSelloffPct: 1, periodLength: 2, feeThresholdPct: 3, feeSlopeLowPct: 4, feeSlopeHighPct: 5, feeSlopeMidPct: 6, feeKinkPct: 7 }];
    const prop = poolCoder.instruction.decode(buildProposePoolActionIx(cfg, pk(), pk(), PoolActions.setMaxSelloff(p)).data) as any;
    const exec = poolCoder.instruction.decode(buildExecutePoolActionIx(cfg, pk(), pk(), 9, p).data) as any;
    expect(prop.data.action.SetMaxSelloff.params).toEqual(exec.data.params);
  });
  test("[N01] malformed actions: two keys, unknown variant, empty object, kind 0 as action", () => {
    expect(() => poolActionKindOf({ SetDelay: { secs: 1 }, SetSwapFeeRate: { rate: 1 } } as any)).toThrow(/exactly one variant/);
    expect(() => poolActionKindOf({ Bogus: {} } as any)).toThrow(/not a PoolAction/);
    expect(() => poolActionKindOf({} as any)).toThrow(/exactly one variant/);
    expect(() => poolActionKindOf({ TransferPoolAdmin: {} } as any)).toThrow(/not a PoolAction/);
    expect(() => buildProposePoolActionIx(cfg, pk(), pk(), { Bogus: {} } as any)).toThrow();
  });
  test("[N02] cancel / execute kind out of range or wrong params", () => {
    expect(() => buildCancelPoolActionIx(cfg, pk(), pk(), 11)).toThrow(/out of range/);
    expect(() => buildCancelPoolActionIx(cfg, pk(), pk(), -1)).toThrow(/out of range/);
    expect(() => buildCancelPoolActionIx(cfg, pk(), pk(), "Nope" as any)).toThrow(/unknown pool action kind/);
    expect(() => buildExecutePoolActionIx(cfg, pk(), pk(), 9)).toThrow(/pass the proposed SelloffParams/);
    expect(() => buildExecutePoolActionIx(cfg, pk(), pk(), 9, [])).toThrow(/pass the proposed SelloffParams/);
    expect(() => buildExecutePoolActionIx(cfg, pk(), pk(), 2, [])).toThrow(/takes no params/);
    expect(() => buildExecutePoolActionIx(cfg, pk(), pk(), 11)).toThrow(/out of range/);
  });
  test("[N03] the IDL coder rejects out-of-range payloads (u16 / u32 overflow) at build time", () => {
    expect(() => buildProposePoolActionIx(cfg, pk(), pk(), PoolActions.setCreatorFeeBps(70_000))).toThrow();
    expect(() => buildProposePoolActionIx(cfg, pk(), pk(), PoolActions.setDelay(-1))).toThrow();
  });
});

describe("ProtocolAction payloads and kinds", () => {
  test("[P07] every constructor maps to kind 1..13 and the tag is kind − 1", () => {
    expect(PROTOCOL_ACTION_KINDS.length).toBe(14); expect(PROTOCOL_ACTION_KINDS[0]).toBe("TransferAdmin"); expect(PROTOCOL_ACTION_KINDS[13]).toBe("PoolRescaleVirtualBalances");
    const all = [
      ProtocolActions.setDelay(1), ProtocolActions.setSupervisor(pk()), ProtocolActions.withdraw(pk(), pk(), new BN(1)),
      ProtocolActions.withdrawSol(1, pk(), pk(), new BN(2)), ProtocolActions.poolDebugWithdraw(pk(), [new BN(1), new BN(2)], [pk(), pk()]),
      ProtocolActions.poolSetProtocolFeeRate(pk(), 1000), ProtocolActions.poolSetPoolEnabled(pk()), ProtocolActions.poolSetTokenActive(pk(), 1),
      ProtocolActions.unfreezePools([pk()]), ProtocolActions.poolProtocolAdminTransfer(pk(), pk()), ProtocolActions.upgradeProgram(pk(), pk()),
      ProtocolActions.programOp(2, pk(), pk()), ProtocolActions.poolRescaleVirtualBalances(pk(), 1_000_000_000n),
    ];
    expect(all.map(protocolActionKindOf)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    all.forEach((a, i) => {
      expect(adminCoder.types.encode("ProtocolAction", a)[0]).toBe(i);
      expect(PROTOCOL_ACTION_KIND[Object.keys(a)[0] as keyof typeof PROTOCOL_ACTION_KIND]).toBe(i + 1);
    });
  });
  test("[P08] execute tables name real protocol_admin instructions, multi-route kinds in route order", () => {
    for (const name of PROTOCOL_ACTION_KINDS) for (const ix of PROTOCOL_EXECUTE_INSTRUCTIONS[name]) {
      expect((protocolAdminIdl.instructions as any[]).some((i) => i.name === ix)).toBe(true);
    }
    expect(PROTOCOL_EXECUTE_INSTRUCTIONS.WithdrawSol.length).toBe(3); expect(PROTOCOL_EXECUTE_INSTRUCTIONS.ProgramOp.length).toBe(3);
    for (let k = 0; k < 14; k++) expect(protocolActionKindName(k)).toBe(PROTOCOL_ACTION_KINDS[k]);
    expect(PROTOCOL_EXECUTE_INSTRUCTIONS.PoolRescaleVirtualBalances).toEqual(["execute_pool_rescale_virtual_balances"]);
  });
  test("[P09] UpgradeProgram needs the buffer as remaining account 0; others none", () => {
    const buffer = pk();
    expect(proposeActionRemainingAccounts(ProtocolActions.upgradeProgram(pk(), buffer))).toEqual([{ pubkey: buffer, isSigner: false, isWritable: false }]);
    expect(proposeActionRemainingAccounts(ProtocolActions.setDelay(1))).toEqual([]);
  });
  test("[N04] malformed protocol actions", () => {
    expect(() => protocolActionKindOf({ TransferAdmin: {} } as any)).toThrow(/not a ProtocolAction/);
    expect(() => protocolActionKindOf([] as any)).toThrow(/exactly one variant/);
    expect(() => protocolActionKindName(14)).toThrow(/out of range/);
    expect(() => ProtocolActions.poolRescaleVirtualBalances(pk(), 1)).toThrow(/InvalidVirtualRescale/);
    expect(() => ProtocolActions.poolRescaleVirtualBalances(pk(), -2)).toThrow(/unsigned/);
    expect(() => protocolActionKindName("Nope" as any)).toThrow(/unknown/);
  });
});

describe("pending slots and pendingStatus", () => {
  const now = 1_700_000_000;
  test("[P10] none / waiting / ready / expired at exact boundaries", () => {
    expect(pendingStatus(0n, now)).toBe("none");
    expect(pendingStatus(BigInt(now + 1), now)).toBe("waiting");
    expect(pendingStatus(BigInt(now), now)).toBe("ready");
    expect(pendingStatus(BigInt(now - GRACE_PERIOD_SECS), now)).toBe("ready");
    expect(pendingStatus(BigInt(now - GRACE_PERIOD_SECS - 1), now)).toBe("expired");
    expect(GRACE_PERIOD_SECS).toBe(14 * 86_400);
  });
  test("[P11] a custom grace period", () => {
    expect(pendingStatus(BigInt(now - 10), now, 10)).toBe("ready");
    expect(pendingStatus(BigInt(now - 11), now, 10)).toBe("expired");
  });
  test("[P12] decodePoolCooldownBlock reads delay, epoch and every typed slot from a 2304-byte image", () => {
    const b = Buffer.alloc(2304);
    b.writeUInt32LE(3600, POOL_LAYOUT.POOL_ADMIN_DELAY_SECS.offset); b.writeUInt32LE(7, POOL_LAYOUT.POOL_ADMIN_EPOCH.offset);
    b.writeBigInt64LE(BigInt(now + 50), POOL_LAYOUT.PENDING_POOL_ADMIN_ETA.offset);
    b.writeBigInt64LE(BigInt(now), POOL_LAYOUT.PENDING_SET_SWAP_FEE_RATE.offset); b.writeUInt32LE(1234, POOL_LAYOUT.PENDING_SET_SWAP_FEE_RATE.offset + 8);
    b.writeBigInt64LE(BigInt(now), POOL_LAYOUT.PENDING_SET_CREATOR_FEE_BPS.offset); b.writeUInt16LE(2500, POOL_LAYOUT.PENDING_SET_CREATOR_FEE_BPS.offset + 8);
    b.writeBigInt64LE(BigInt(now), POOL_LAYOUT.PENDING_SET_LIQUIDITY_FEES.offset); b.writeUInt16LE(10, POOL_LAYOUT.PENDING_SET_LIQUIDITY_FEES.offset + 8); b.writeUInt16LE(20, POOL_LAYOUT.PENDING_SET_LIQUIDITY_FEES.offset + 10);
    const mgr = pk();
    b.writeBigInt64LE(BigInt(now), POOL_LAYOUT.PENDING_SET_RANGE_MANAGER.offset); mgr.toBuffer().copy(b, POOL_LAYOUT.PENDING_SET_RANGE_MANAGER.offset + 8); b[POOL_LAYOUT.PENDING_SET_RANGE_MANAGER.offset + 40] = 1;
    b.writeBigInt64LE(BigInt(now), POOL_LAYOUT.PENDING_SET_TOKEN_ACTIVE.offset); b[POOL_LAYOUT.PENDING_SET_TOKEN_ACTIVE.offset + 8] = 3;
    const blk = decodePoolCooldownBlock(b);
    expect(blk.poolAdminDelaySecs).toBe(3600); expect(blk.poolAdminEpoch).toBe(7);
    expect(blk.pendingActions.length).toBe(11);
    expect(blk.pendingActions[0].eta.toString()).toBe(String(now + 50));
    expect(blk.pendingActions[2].payload).toEqual({ rate: 1234 });
    expect(blk.pendingActions[3].payload).toEqual({ bps: 2500 });
    expect(blk.pendingActions[4].payload).toEqual({ depositFeeBps: 10, withdrawFeeBps: 20 });
    expect((blk.pendingActions[7].payload as any).manager.toBase58()).toBe(mgr.toBase58()); expect((blk.pendingActions[7].payload as any).enabled).toBe(true);
    expect(blk.pendingActions[10].payload).toEqual({ tokenIndex: 3 });
    expect(blk.pendingActionsMask).toBe((1 << 0) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 7) | (1 << 10));
    expect(blk.pendingActions.filter((a) => a.eta.isZero()).length).toBe(5);
  });
  test("[P13] decodeTreasuryCooldownBlock on a 1624-byte Treasury image; v2 (818) needs migration", () => {
    const b = Buffer.alloc(1624);
    b.writeUInt32LE(86_400, TREASURY_LAYOUT.DELAY_SECS.offset); b.writeUInt32LE(2, TREASURY_LAYOUT.ADMIN_EPOCH.offset);
    b.writeBigInt64LE(BigInt(now), TREASURY_LAYOUT.PENDING_SET_DELAY.offset); b.writeUInt32LE(600, TREASURY_LAYOUT.PENDING_SET_DELAY.offset + 8);
    const blk = decodeTreasuryCooldownBlock(b);
    expect(blk.delaySecs).toBe(86_400); expect(blk.adminEpoch).toBe(2);
    expect(blk.pendingActions.length).toBe(14); expect(blk.pendingActions[1].payload).toEqual({ secs: 600 });
    expect(blk.pendingActionsMask).toBe(1 << 1);
    expect(treasuryNeedsLayoutMigration({ length: 818 })).toBe(true); expect(treasuryNeedsLayoutMigration(Buffer.alloc(1624))).toBe(false);
  });
  test("[N05] short buffers are refused by the block decoders", () => {
    expect(() => decodePoolCooldownBlock(Buffer.alloc(1683))).toThrow();
    expect(() => decodeTreasuryCooldownBlock(Buffer.alloc(818))).toThrow();
  });
  test("[N06] pendingStatus: a negative clock is never ready; a fractional clock throws", () => {
    expect(pendingStatus(1n, -1)).toBe("waiting");
    expect(() => pendingStatus(1n, 1.5)).toThrow(RangeError);
  });
});
