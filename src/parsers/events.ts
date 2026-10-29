import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { BorshReader } from "./borsh";
import { decodeContractEvent, ContractEvent } from "./contracts";
import { IDLS } from "../idl";
import type { ContractProgram } from "../types/contracts";
import type { SelloffParams } from "../types/tx";
import {
  AdditionalContractEvent,
  CofferPoolEvent,
  SelloffWindowState,
  SlotState,
  SwapV2Event,
  TypedEventName,
} from "../types/events";
import { LEGACY_EVENT_DISCRIMINATORS } from "./eventPins";

/**
 * Anchor event log format (base64-encoded after `Program data:`):
 *   [ 8-byte discriminator | borsh-encoded event struct ]
 *
 * v6.1 (T11): the discriminator table is built from the vendored IDLs at
 * load time (79 events: coffer_pool 41, protocol_admin 36, STLD 2) and the
 * pre-T11 discriminators are pinned in `eventPins.ts` so a v6 log is
 * reported as `Unknown { name: <legacy name>, data.legacy }` rather than as
 * garbage. Discriminators never collide across the three programs (asserted
 * at load), so the flat `parseCofferPoolEvents` needs no program hint;
 * `parseTransactionEvents` additionally attributes every line to the program
 * on top of the invoke stack (what a CPI-aware indexer needs).
 */

export const PROGRAM_DATA_PREFIX = "Program data: ";

type EventTable = ReadonlyMap<string, string>;

/** Per program: discriminator hex → event name, from the vendored IDL. */
export const EVENT_TABLES: Readonly<Record<ContractProgram, EventTable>> = (() => {
  const tables = {} as Record<ContractProgram, Map<string, string>>;
  const seen = new Map<string, string>();
  for (const program of Object.keys(IDLS) as ContractProgram[]) {
    const table = new Map<string, string>();
    for (const event of (IDLS[program] as { events: Array<{ name: string; discriminator: number[] }> }).events) {
      const hex = Buffer.from(event.discriminator).toString("hex");
      const clash = seen.get(hex);
      if (clash) throw new Error(`event discriminator ${hex} is shared by ${clash} and ${program}.${event.name}`);
      if (LEGACY_EVENT_DISCRIMINATORS.has(hex)) throw new Error(`event ${program}.${event.name} reuses a retired / legacy discriminator ${hex}`);
      seen.set(hex, `${program}.${event.name}`);
      table.set(hex, event.name);
    }
    tables[program] = table;
  }
  return tables;
})();

/** Which program's table holds a discriminator (hex). */
export function eventProgramOf(discriminatorHex: string): { program: ContractProgram; name: string } | null {
  for (const program of Object.keys(EVENT_TABLES) as ContractProgram[]) {
    const name = EVENT_TABLES[program].get(discriminatorHex);
    if (name) return { program, name };
  }
  return null;
}

/** Decode every `Program data:` line (any of the three programs), in log order. */
export function parseCofferPoolEvents(logs: string[]): CofferPoolEvent[] {
  const out: CofferPoolEvent[] = [];
  for (const line of logs) {
    const payload = programDataOf(line);
    if (payload === null) continue;
    out.push(decodeEventLine(payload).event);
  }
  return out;
}

/** One decoded line with its CPI attribution. */
export interface AttributedEvent {
  event: CofferPoolEvent;
  /** The SDK program whose table decoded the line (`null` for `Unknown`). */
  program: ContractProgram | null;
  /** Program on top of the invoke stack when the line was logged (`""` outside any invoke). */
  programId: string;
  /** CPI depth of that program (1 = top level, 2 = one CPI deep, …). */
  depth: number;
  /** Index of the line in `logs`. */
  lineIndex: number;
}

/**
 * Decode with invoke-stack attribution: each `Program data:` line is
 * credited to the program on top of the stack at that line (Anchor's
 * `EventParser` cannot do that across a CPI). When `programIds` names the
 * deployed ids, a line logged by a known program is decoded with THAT
 * program's table only (a foreign program's event that happens to share a
 * discriminator is reported as `Unknown`); lines logged by other programs
 * fall back to the flat lookup.
 */
export function parseTransactionEvents(logs: string[], programIds?: Partial<Record<ContractProgram, PublicKey>>): AttributedEvent[] {
  const byId = new Map<string, ContractProgram>();
  for (const [program, id] of Object.entries(programIds ?? {})) if (id) byId.set(id.toBase58(), program as ContractProgram);
  const out: AttributedEvent[] = [];
  const stack: string[] = [];
  logs.forEach((line, lineIndex) => {
    const invoke = /^Program (\w+) invoke \[(\d+)\]$/.exec(line);
    if (invoke) { stack.push(invoke[1]); return; }
    if (/^Program \w+ success$/.test(line) || /^Program \w+ failed: /.test(line)) { stack.pop(); return; }
    const payload = programDataOf(line);
    if (payload === null) return;
    const programId = stack[stack.length - 1] ?? "";
    const known = byId.get(programId);
    const decoded = decodeEventLine(payload, known);
    out.push({ event: decoded.event, program: decoded.program, programId, depth: stack.length, lineIndex });
  });
  return out;
}

/** `true` when the validator cut the log (`Log truncated`): the last events of the transaction are missing. */
export function logTruncated(logs: string[]): boolean {
  return logs.some((l) => l === "Log truncated");
}

function programDataOf(line: string): string | null {
  const m = /^Program data:\s+(.+)$/.exec(line);
  return m ? m[1] : null;
}

/** Decode one base64 `Program data:` payload; `only` restricts the lookup to one program's table. */
export function decodeEventLine(base64: string, only?: ContractProgram): { event: CofferPoolEvent; program: ContractProgram | null } {
  const wrap = (event: CofferPoolEvent, program: ContractProgram | null) => ({ event, program });
  const buf = Buffer.from(base64, "base64");
  if (buf.length < 8) return wrap({ kind: "Unknown", name: "unknown", data: { error: "payload shorter than a discriminator", payload: buf.toString("base64") } }, null);
  const disc = buf.subarray(0, 8);
  const hex = disc.toString("hex");
  const payload = buf.subarray(8);
  const legacy = LEGACY_EVENT_DISCRIMINATORS.get(hex);
  if (legacy) {
    return wrap({
      kind: "Unknown",
      name: legacy.legacyName,
      data: { legacy: true, retired: legacy.replacedBy === null, replacedBy: legacy.replacedBy, program: legacy.program, disc: hex, payload: payload.toString("base64") },
    }, null);
  }
  const hit = only ? (EVENT_TABLES[only].get(hex) ? { program: only, name: EVENT_TABLES[only].get(hex)! } : null) : eventProgramOf(hex);
  if (!hit) {
    return wrap({ kind: "Unknown", name: "unknown", data: { disc: hex, payload: payload.toString("base64"), ...(only ? { program: only } : {}) } }, null);
  }
  try {
    const typed = decodeTyped(hit.name, payload);
    if (typed) return wrap(typed, hit.program);
    const generic = decodeContractEvent(base64, hit.program);
    if (!generic) return wrap({ kind: "Unknown", name: hit.name, data: { error: "IDL coder refused the payload", payload: payload.toString("base64") } }, null);
    return wrap(camelEvent(generic), hit.program);
  } catch (error) {
    return wrap({ kind: "Unknown", name: hit.name, data: { error: String(error), payload: payload.toString("base64") } }, null);
  }
}

// ─── Typed decoders ──────────────────────────────────────────────────────────

const TYPED: ReadonlySet<string> = new Set<TypedEventName>([
  "SwapV2", "LiquidityAddedV2", "LiquidityRemovedV2", "PoolInitializedV2", "PoolInfoV2", "ProtocolFeesCollectedV2", "CreatorFeesClaimedV2",
  "SidelinedTokenFunded", "VirtualBalancesRescaled", "HookInvoked", "HookDisabledSet", "PoolEnabledUpdated", "SwapsEnabledUpdatedV2", "TokenActiveSetV2",
  "RangeManagerUpdatedV2", "MaxSelloffSetV2", "SingleTokenDepositDirectV2",
]);

/** Event names the hand-written (strict, typed) decoders cover; every other event goes through the IDL coder. */
export const TYPED_EVENT_NAMES: readonly string[] = [...TYPED];

function decodeTyped(name: string, buf: Buffer): CofferPoolEvent | null {
  if (!TYPED.has(name)) return null;
  const r = new BorshReader(buf);
  const ts = () => r.i64().toNumber();
  const bytesAsNumbers = () => [...r.bytes()];
  switch (name as TypedEventName) {
    case "SwapV2": {
      const e: SwapV2Event = {
        kind: "SwapV2",
        pool: r.pubkey(), user: r.pubkey(), tokenInIndex: r.u8(), tokenOutIndex: r.u8(),
        amountIn: r.u64(), transferFeeIn: r.u64(), amountInNet: r.u64(),
        swapFeeRate: r.u32(), effectiveFeeRate: r.u32(), protocolFeeRate: r.u16(), creatorFeeBps: r.u16(),
        feeAmount: r.u64(), protocolFeeAmount: r.u64(), creatorFeeAmount: r.u64(),
        amountOutGross: r.u64(), surgeFeeAmount: r.u64(), surgeProtocolFeeAmount: r.u64(), surgeCreatorFeeAmount: r.u64(),
        amountOut: r.u64(), transferFeeOut: r.u64(),
        inBefore: slotState(r), inAfter: slotState(r), outBefore: slotState(r), outAfter: slotState(r),
        timestamp: ts(),
        selloffWindow: r.option(selloffWindow),
      };
      return e;
    }
    case "LiquidityAddedV2":
      return {
        kind: "LiquidityAddedV2",
        pool: r.pubkey(), user: r.pubkey(), isSeed: r.bool(),
        tokenAmounts: r.vecU64(), creditedAmounts: r.vecU64(), surgeBuyIn: r.vecU64(),
        lpAmount: r.u64(), depositFeeLp: r.u64(), depositFeeBps: r.u16(), lpSupplyBefore: r.u64(), lpSupplyAfter: r.u64(),
        virtualBalancesBefore: r.vecU64(), virtualBalancesAfter: r.vecU64(), actualBalancesBefore: r.vecU64(), actualBalancesAfter: r.vecU64(),
        surgeFeesOwedBefore: r.vecU64(), surgeFeesOwedAfter: r.vecU64(), timestamp: ts(),
      };
    case "LiquidityRemovedV2":
      return {
        kind: "LiquidityRemovedV2",
        pool: r.pubkey(), user: r.pubkey(), requestedLp: r.u64(), lpAmount: r.u64(),
        tokenAmounts: r.vecU64(), surgeAmounts: r.vecU64(), withdrawFeeAmounts: r.vecU64(), withdrawFeeBps: r.u16(), transferFeesOut: r.vecU64(),
        hooksBypassed: r.bool(), lpSupplyBefore: r.u64(), lpSupplyAfter: r.u64(),
        virtualBalancesBefore: r.vecU64(), virtualBalancesAfter: r.vecU64(), actualBalancesBefore: r.vecU64(), actualBalancesAfter: r.vecU64(),
        surgeFeesOwedBefore: r.vecU64(), surgeFeesOwedAfter: r.vecU64(), timestamp: ts(),
      };
    case "PoolInitializedV2":
      return {
        kind: "PoolInitializedV2",
        pool: r.pubkey(), config: r.pubkey(), poolId: r.u64(), poolAdmin: r.pubkey(), lpMint: r.pubkey(), lpTokenProgram: r.pubkey(),
        tokenCount: r.u8(), mints: r.vecPubkey(), tokenPrograms: r.vecPubkey(), decimals: bytesAsNumbers(),
        normalizedWeights: r.vecU64(), initialVirtualBalances: r.vecU64(),
        swapFeeRate: r.u32(), protocolFeeRate: r.u16(), creatorFeeBps: r.u16(), depositFeeBps: r.u16(), withdrawFeeBps: r.u16(),
        lpName: r.string(), lpSymbol: r.string(), lpUri: r.string(),
        hookProgram: r.pubkey(), hookFlags: r.u16(), hookFeeMin: r.u32(), hookFeeMax: r.u32(), hookMaxCu: r.u32(), hookAccountsLen: r.u8(),
        timestamp: ts(),
      };
    case "PoolInfoV2":
      return {
        kind: "PoolInfoV2",
        pool: r.pubkey(), config: r.pubkey(), poolId: r.u64(), layoutVersion: r.u8(), poolAdmin: r.pubkey(), pendingPoolAdmin: r.pubkey(), pendingPoolAdminEta: r.i64(),
        lpMint: r.pubkey(), tokenCount: r.u8(), tokens: r.vecPubkey(), tokenVaults: r.vecPubkey(), tokenPrograms: r.vecPubkey(), decimals: bytesAsNumbers(),
        normalizedWeights: r.vecU64(), virtualBalances: r.vecU64(), actualBalances: r.vecU64(), protocolFeesOwed: r.vecU64(), creatorFeesOwed: r.vecU64(), surgeFeesOwed: r.vecU64(),
        isActive: r.vecBool(), selloffPolicy: r.vec(selloffParams),
        swapFeeRate: r.u32(), protocolFeeRate: r.u16(), creatorFeeBps: r.u16(), depositFeeBps: r.u16(), withdrawFeeBps: r.u16(), liquidityFeeLock: r.u8(),
        poolEnabled: r.bool(), swapsEnabled: r.bool(),
        rangeManager: r.pubkey(), rangeManagerEnabled: r.bool(), rangeManagerLocked: r.bool(), rangeManagerMaxVbChangePct: r.u16(), rangeManagerMaxWeightChangePct: r.u16(),
        rangeManagerMinUpdateIntervalSecs: r.u32(), rangeManagerMaxLeverageBps: r.u32(), rangeManagerMinLeverageBps: r.u32(), rangeManagerLastUpdated: r.i64(),
        lookupTable: r.pubkey(), poolAdminDelaySecs: r.u32(), poolAdminEpoch: r.u32(), pendingActionsMask: r.u16(), pendingEtas: r.vecI64(),
        hookProgram: r.pubkey(), hookFlags: r.u16(), hookDisabled: r.u8(), hookFeeMin: r.u32(), hookFeeMax: r.u32(), hookMaxCu: r.u32(), hookAccountsLen: r.u8(),
        timestamp: ts(),
      };
    case "ProtocolFeesCollectedV2":
      return { kind: "ProtocolFeesCollectedV2", pool: r.pubkey(), authority: r.pubkey(), tokenAmounts: r.vecU64(), recipients: r.vecPubkey(), timestamp: ts() };
    case "CreatorFeesClaimedV2":
      return { kind: "CreatorFeesClaimedV2", pool: r.pubkey(), authority: r.pubkey(), tokenAmounts: r.vecU64(), recipients: r.vecPubkey(), timestamp: ts() };
    case "SidelinedTokenFunded":
      return {
        kind: "SidelinedTokenFunded", pool: r.pubkey(), authority: r.pubkey(), tokenIndex: r.u8(), amountCharged: r.u64(), amountCredited: r.u64(),
        actualAfter: r.u64(), virtualBalance: r.u64(), lpSupply: r.u64(), timestamp: ts(),
      };
    case "VirtualBalancesRescaled":
      return { kind: "VirtualBalancesRescaled", pool: r.pubkey(), authority: r.pubkey(), multiplier: r.u64(), oldVirtualBalances: r.vecU64(), newVirtualBalances: r.vecU64(), timestamp: ts() };
    case "HookInvoked":
      return {
        kind: "HookInvoked", pool: r.pubkey(), hookProgram: r.pubkey(), callback: r.u8(), verdict: r.u8(), hasFeeOverride: r.bool(),
        feeOverride: r.u32(), cuUsed: r.u32(), timestamp: ts(),
      };
    case "HookDisabledSet":
      return { kind: "HookDisabledSet", pool: r.pubkey(), authority: r.pubkey(), oldDisabled: r.bool(), newDisabled: r.bool(), pauseWhenDisabled: r.bool(), timestamp: ts() };
    case "PoolEnabledUpdated":
      return { kind: "PoolEnabledUpdated", pool: r.pubkey(), authority: r.pubkey(), oldValue: r.bool(), newValue: r.bool(), timestamp: ts() };
    case "SwapsEnabledUpdatedV2":
      return { kind: "SwapsEnabledUpdatedV2", pool: r.pubkey(), authority: r.pubkey(), actorKind: r.u8(), oldValue: r.bool(), newValue: r.bool(), timestamp: ts() };
    case "TokenActiveSetV2":
      return { kind: "TokenActiveSetV2", pool: r.pubkey(), authority: r.pubkey(), actorKind: r.u8(), tokenIndex: r.u8(), oldValue: r.bool(), newValue: r.bool(), timestamp: ts() };
    case "RangeManagerUpdatedV2":
      return {
        kind: "RangeManagerUpdatedV2", pool: r.pubkey(), manager: r.pubkey(), vbIndices: bytesAsNumbers(), vbOldValues: r.vecU64(), vbNewValues: r.vecU64(),
        weightIndices: bytesAsNumbers(), weightOldValues: r.vecU64(), weightNewValues: r.vecU64(), timestamp: ts(),
      };
    case "MaxSelloffSetV2":
      return { kind: "MaxSelloffSetV2", pool: r.pubkey(), authority: r.pubkey(), oldParams: r.vec(selloffParams), newParams: r.vec(selloffParams), timestamp: ts() };
    case "SingleTokenDepositDirectV2":
      return {
        kind: "SingleTokenDepositDirectV2", pool: r.pubkey(), user: r.pubkey(), tokenInIndex: r.u8(), amountIn: r.u64(), minimumLpAmount: r.u64(),
        allocations: r.vecU64(), planExpectedState: r.u8Array(32), planQuotedAt: ts(), planValidUntilSlot: r.u64(), innerSwapCount: r.u8(),
        depositedAmounts: r.vecU64(), lpReceived: r.u64(), dustRemaining: r.vecU64(), lpSupplyBefore: r.u64(), lpSupplyAfter: r.u64(), timestamp: ts(),
      };
  }
}

function slotState(r: BorshReader): SlotState {
  return { virtualBalance: r.u64(), actualBalance: r.u64(), protocolFeesOwed: r.u64(), creatorFeesOwed: r.u64(), surgeFeesOwed: r.u64() };
}

function selloffWindow(r: BorshReader): SelloffWindowState {
  return {
    effectiveSelloffBefore: r.u64(), effectiveSelloff: r.u64(), maxSelloffCap: r.u64(), vbSnapshot: r.u64(),
    previousSelloff: r.u64(), currentSelloff: r.u64(), windowStartTimestamp: r.i64().toNumber(),
  };
}

function selloffParams(r: BorshReader): SelloffParams {
  return {
    maxSelloffPct: r.u16(), periodLength: r.u32(), feeThresholdPct: r.u16(), feeSlopeLowPct: r.u16(),
    feeSlopeHighPct: r.u16(), feeSlopeMidPct: r.u16(), feeKinkPct: r.u8(),
  };
}

// ─── Derived views ───────────────────────────────────────────────────────────

/** LP holders' share of a swap's surge fee (booked into `surge_fees_owed[out]`): `surge − surgeProtocol − surgeCreator`. */
export function swapSurgeLpAmount(e: Pick<SwapV2Event, "surgeFeeAmount" | "surgeProtocolFeeAmount" | "surgeCreatorFeeAmount">): BN {
  return e.surgeFeeAmount.sub(e.surgeProtocolFeeAmount).sub(e.surgeCreatorFeeAmount);
}

/**
 * The exact slot deltas a `SwapV2` applied (`after − before`, per field of
 * both touched slots). An integrity replay checks these against the event's
 * own cascade: `in.actual += amountInNet − protocolFeeAmount − creatorFeeAmount`,
 * `out.actual −= amountOutGross`, `out.surge += swapSurgeLpAmount`.
 */
export function swapSlotDeltas(e: SwapV2Event): { in: SlotState; out: SlotState } {
  const diff = (a: SlotState, b: SlotState): SlotState => ({
    virtualBalance: a.virtualBalance.sub(b.virtualBalance), actualBalance: a.actualBalance.sub(b.actualBalance),
    protocolFeesOwed: a.protocolFeesOwed.sub(b.protocolFeesOwed), creatorFeesOwed: a.creatorFeesOwed.sub(b.creatorFeesOwed), surgeFeesOwed: a.surgeFeesOwed.sub(b.surgeFeesOwed),
  });
  return { in: diff(e.inAfter, e.inBefore), out: diff(e.outAfter, e.outBefore) };
}

/**
 * Patch a pool's known vectors with a `SwapV2`'s `*_after` slots (the
 * reducer rule: a swap moves exactly its two slots; untouched slots keep
 * their values). Returns new arrays; the inputs are not mutated.
 */
export function applySwapToVectors(
  e: SwapV2Event,
  vectors: { virtualBalances: BN[]; actualBalances: BN[]; protocolFeesOwed: BN[]; creatorFeesOwed: BN[]; surgeFeesOwed: BN[] },
): { virtualBalances: BN[]; actualBalances: BN[]; protocolFeesOwed: BN[]; creatorFeesOwed: BN[]; surgeFeesOwed: BN[] } {
  const out = {
    virtualBalances: vectors.virtualBalances.slice(), actualBalances: vectors.actualBalances.slice(), protocolFeesOwed: vectors.protocolFeesOwed.slice(),
    creatorFeesOwed: vectors.creatorFeesOwed.slice(), surgeFeesOwed: vectors.surgeFeesOwed.slice(),
  };
  for (const [index, slot] of [[e.tokenInIndex, e.inAfter], [e.tokenOutIndex, e.outAfter]] as const) {
    if (index >= out.virtualBalances.length) throw new Error(`applySwapToVectors: slot ${index} outside the pool's ${out.virtualBalances.length} tokens`);
    out.virtualBalances[index] = slot.virtualBalance; out.actualBalances[index] = slot.actualBalance; out.protocolFeesOwed[index] = slot.protocolFeesOwed;
    out.creatorFeesOwed[index] = slot.creatorFeesOwed; out.surgeFeesOwed[index] = slot.surgeFeesOwed;
  }
  return out;
}

// ─── Generic path ────────────────────────────────────────────────────────────

const camelKey = (key: string): string => key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function camelValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (BN.isBN(value) || value instanceof PublicKey || Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(camelValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [camelKey(k), camelValue(v)]));
  }
  return value;
}

function camelEvent(event: ContractEvent): AdditionalContractEvent {
  const fields: Record<string, unknown> = { kind: event.kind };
  for (const [key, value] of Object.entries(event.data as Record<string, unknown>)) {
    // v6.1 (T3): the cooldown events carry a `kind: u8` data field; it is
    // exposed as `actionKind` so it cannot shadow the event discriminator.
    const name = key === "kind" ? "actionKind" : camelKey(key);
    fields[name] = key === "timestamp" && BN.isBN(value) ? value.toNumber() : camelValue(value);
  }
  return fields as AdditionalContractEvent;
}
