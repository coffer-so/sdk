import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { BorshReader } from "./borsh";
import { decodeContractEvent, ContractEvent } from "./contracts";
import { CofferPoolEvent, AdditionalContractEvent, PoolInitializedEvent } from "../types/events";

/**
 * Anchor event log format (base64-encoded after `Program data:`):
 *   [ 8-byte discriminator | borsh-encoded event struct ]
 *
 * Discriminators for coffer-pool and single-token-liquidity are hard-coded
 * here from the generated IDL. Never guess from event name — the Anchor
 * macro actually uses `sha256("event:<Name>")[0..8]`, but for robustness
 * we pin the bytes.
 */

// Coffer-pool event discriminators (from target/idl/coffer_pool.json):
const DISC = {
  PoolInitialized:          Buffer.from([100, 118, 173, 87, 12, 198, 254, 229]),
  Swap:                     Buffer.from([81, 108, 227, 190, 205, 208, 10, 196]),
  LiquidityAdded:           Buffer.from([154, 26, 221, 108, 238, 64, 217, 161]),
  LiquidityRemoved:         Buffer.from([225, 105, 216, 39, 124, 116, 169, 189]),
  ProtocolFeesCollected:    Buffer.from([165, 34, 125, 155, 15, 86, 99, 191]),
  SwapFeeRateUpdated:       Buffer.from([101, 132, 24, 255, 91, 253, 227, 101]),
  ProtocolFeeRateUpdated:   Buffer.from([189, 56, 7, 65, 0, 95, 192, 6]),
  PoolEnabledUpdated:       Buffer.from([101, 47, 3, 240, 197, 181, 236, 142]),
  SwapsEnabledUpdated:      Buffer.from([55, 116, 118, 138, 102, 26, 227, 223]),
  DebugLiquidityWithdrawn:  Buffer.from([174, 59, 149, 22, 135, 129, 129, 83]),
  PoolStateLog:             Buffer.from([59, 254, 237, 111, 163, 10, 140, 224]),
  PoolInfo:                 Buffer.from([207, 20, 87, 97, 251, 212, 234, 45]),
  MaxSelloffWindowAdvanced: Buffer.from([229, 227, 163, 30, 22, 183, 78, 57]),
  // Stld:
  SingleTokenDeposit:       Buffer.from([215, 54, 137, 104, 219, 39, 164, 235]),
  SingleTokenDepositDirect: Buffer.from([78, 128, 118, 93, 148, 179, 216, 112]),
};

type DiscName = keyof typeof DISC;

export function parseCofferPoolEvents(logs: string[]): CofferPoolEvent[] {
  const out: CofferPoolEvent[] = [];
  for (const line of logs) {
    const m = line.match(/^Program data:\s+(.+)$/);
    if (!m) continue;
    const buf = Buffer.from(m[1], "base64");
    if (buf.length < 8) continue;
    const disc = buf.slice(0, 8);
    const payload = buf.slice(8);
    const name = matchDiscriminator(disc);
    if (!name) {
      const current = decodeContractEvent(m[1]);
      if (current) {
        try { out.push(camelEvent(current)); }
        catch (error) { out.push({ kind: "Unknown", name: current.kind, data: { error: String(error), payload: payload.toString("base64") } }); }
        continue;
      }
      out.push({ kind: "Unknown", name: "unknown", data: { disc: disc.toString("base64"), payload: payload.toString("base64") } });
      continue;
    }
    try {
      const ev = decodeEvent(name, payload);
      if (ev) out.push(ev);
    } catch (e) {
      out.push({
        kind: "Unknown",
        name,
        data: { error: String(e), payload: payload.toString("base64") },
      });
    }
  }
  return out;
}

function matchDiscriminator(d: Buffer): DiscName | null {
  for (const [name, bytes] of Object.entries(DISC)) {
    if (bytes.equals(d)) return name as DiscName;
  }
  return null;
}

function decodeEvent(name: DiscName, buf: Buffer): CofferPoolEvent | null {
  const r = new BorshReader(buf);
  switch (name) {
    case "Swap": {
      // Wire order (IDL `Swap`): prefix … timestamp, surge_fee_amount, then the
      // append-only tails: v6 transfer_fee_in/out, T15 swap_fee_rate /
      // protocol_fee_rate / surge_protocol_fee_amount, T14 creator_fee_amount /
      // surge_creator_fee_amount / creator_fee_bps, T12 surge_fee_lp_amount,
      // T9 effective_fee_rate. Every tail is optional (pre-upgrade logs).
      const pool = r.pubkey();
      const user = r.pubkey();
      const tokenIn = r.pubkey();
      const tokenOut = r.pubkey();
      const amountIn = r.u64();
      const amountOut = r.u64();
      const feeAmount = r.u64();
      const protocolFeeAmount = r.u64();
      const timestamp = r.i64().toNumber();
      const surgeFeeAmount = r.u64();
      const transferFeeIn = optU64(r);
      const transferFeeOut = optU64(r);
      const swapFeeRate = optU32(r);
      const protocolFeeRate = optU16(r);
      const surgeProtocolFeeAmount = optU64(r);
      const creatorFeeAmount = optU64(r);
      const surgeCreatorFeeAmount = optU64(r);
      const creatorFeeBps = optU16(r);
      const surgeFeeLpAmount = optU64(r);
      const v61Tail = r.remaining() >= 4;
      const effectiveFeeRate = v61Tail ? r.u32() : swapFeeRate;
      return {
        kind: "Swap",
        pool,
        user,
        tokenIn,
        tokenOut,
        amountIn,
        amountOut,
        feeAmount,
        protocolFeeAmount,
        surgeFeeAmount,
        timestamp,
        transferFeeIn,
        transferFeeOut,
        swapFeeRate,
        protocolFeeRate,
        surgeProtocolFeeAmount,
        creatorFeeAmount,
        surgeCreatorFeeAmount,
        creatorFeeBps,
        surgeFeeLpAmount,
        effectiveFeeRate,
        v61Tail,
      };
    }
    case "LiquidityAdded": {
      // Tails (append-only): T2 is_seed / credited_amounts / lp_supply_before /
      // lp_supply_after / initial_lp_supply, T7 deposit_fee_lp / deposit_fee_bps,
      // T12 surge_buy_in.
      const pool = r.pubkey();
      const user = r.pubkey();
      const tokenAmounts = r.vecU64();
      const lpAmount = r.u64();
      const timestamp = r.i64().toNumber();
      const isSeed = r.remaining() >= 1 ? r.bool() : false;
      const creditedAmounts = optVecU64(r);
      const lpSupplyBefore = optU64(r);
      const lpSupplyAfter = optU64(r);
      const initialLpSupply = optU64(r);
      const depositFeeLp = optU64(r);
      const depositFeeBps = optU16(r);
      const v61Tail = r.remaining() >= 4;
      const surgeBuyIn = optVecU64(r);
      return { kind: "LiquidityAdded", pool, user, tokenAmounts, lpAmount, timestamp, isSeed, creditedAmounts, lpSupplyBefore, lpSupplyAfter, initialLpSupply, depositFeeLp, depositFeeBps, surgeBuyIn, v61Tail };
    }
    case "LiquidityRemoved": {
      // Tails: T7 withdraw_fee_amounts / withdraw_fee_bps / lp_supply_before /
      // lp_supply_after, T12 surge_amounts.
      const pool = r.pubkey();
      const user = r.pubkey();
      const lpAmount = r.u64();
      const tokenAmounts = r.vecU64();
      const timestamp = r.i64().toNumber();
      const withdrawFeeAmounts = optVecU64(r);
      const withdrawFeeBps = optU16(r);
      const lpSupplyBefore = optU64(r);
      const lpSupplyAfter = optU64(r);
      const v61Tail = r.remaining() >= 4;
      const surgeAmounts = optVecU64(r);
      return { kind: "LiquidityRemoved", pool, user, lpAmount, tokenAmounts, timestamp, withdrawFeeAmounts, withdrawFeeBps, lpSupplyBefore, lpSupplyAfter, surgeAmounts, v61Tail };
    }
    case "ProtocolFeesCollected": {
      const pool = r.pubkey();
      const authority = r.pubkey();
      const tokenAmounts = r.vecU64();
      const timestamp = r.i64().toNumber();
      // v6.1 (T5): the Treasury vault PDAs that received every paid slot.
      const recipients = r.remaining() >= 4 ? r.vecPubkey() : [];
      return { kind: "ProtocolFeesCollected", pool, authority, tokenAmounts, timestamp, recipients };
    }
    case "PoolInitialized": {
      const pool = r.pubkey();
      const config = r.pubkey();
      const tokenCount = r.u8();
      const lpMint = r.pubkey();
      const timestamp = r.i64().toNumber();
      // Wire slot of the former `banned_extensions` bitmap (v5.1). The policy
      // was removed in v6.1 (T19); the program keeps the slot and emits `0`.
      const deprecatedBannedExtensions = optU64(r);
      // Appended in v6: the PDA salt. Guarded for pre-v6 logs (reads as 0).
      const poolId = optU64(r);
      // v6.1 tails: T1 lp_name / lp_symbol / lp_uri / lp_token_program, T14
      // creator_fee_bps, T7 deposit_fee_bps / withdraw_fee_bps, T9 hook block.
      const lpName = optString(r);
      const lpSymbol = optString(r);
      const lpUri = optString(r);
      const lpTokenProgram = optPubkey(r);
      const creatorFeeBps = optU16(r);
      const depositFeeBps = optU16(r);
      const withdrawFeeBps = optU16(r);
      const v61Tail = r.remaining() >= 32 + 2 + 4 + 4 + 4 + 1;
      const hookProgram = optPubkey(r);
      const hookFlags = optU16(r);
      const hookFeeMin = optU32(r);
      const hookFeeMax = optU32(r);
      const hookMaxCu = optU32(r);
      const hookAccountsLen = r.remaining() >= 1 ? r.u8() : 0;
      return {
        kind: "PoolInitialized", pool, config, tokenCount, lpMint, timestamp, deprecatedBannedExtensions, poolId,
        lpName, lpSymbol, lpUri, lpTokenProgram, creatorFeeBps, depositFeeBps, withdrawFeeBps,
        hookProgram, hookFlags, hookFeeMin, hookFeeMax, hookMaxCu, hookAccountsLen,
      } satisfies PoolInitializedEvent;
    }
    case "PoolEnabledUpdated": {
      const pool = r.pubkey();
      const authority = r.pubkey();
      const oldValue = r.bool();
      const newValue = r.bool();
      const timestamp = r.i64().toNumber();
      return { kind: "PoolEnabledUpdated", pool, authority, oldValue, newValue, timestamp };
    }
    case "SwapsEnabledUpdated": {
      const pool = r.pubkey();
      const authority = r.pubkey();
      const oldValue = r.bool();
      const newValue = r.bool();
      const timestamp = r.i64().toNumber();
      return { kind: "SwapsEnabledUpdated", pool, authority, oldValue, newValue, timestamp };
    }
    case "SingleTokenDeposit": {
      // Verified against `SingleTokenDeposit` in
      // src/idl/single_token_liquidity.json:
      //   helper, pool, user, token_in_index, amount_in, allocations,
      //   deposited_amounts, lp_received, dust_refunded, timestamp
      //
      // Two fixes vs. the previous decoder:
      //  1. There is NO `slippage_hundredths_bps: u32` field. The per-call
      //     slippage argument was removed from `deposit_single_token` (the
      //     single `minimum_lp_amount` guard replaced it) and the event
      //     field went with it. Reading a phantom u32 here shifted every
      //     later field by 4 bytes.
      //  2. `dust_refunded` is `Vec<u64>` (index-aligned with the pool's
      //     tokens), not a scalar `u64`.
      const helper = r.pubkey();
      const pool = r.pubkey();
      const user = r.pubkey();
      const tokenInIndex = r.u8();
      const amountIn = r.u64();
      const allocations = r.vecU64();
      const depositedAmounts = r.vecU64();
      const lpReceived = r.u64();
      const dustRefunded = r.vecU64();
      const timestamp = r.i64().toNumber();
      return {
        kind: "SingleTokenDeposit",
        helper,
        pool,
        user,
        tokenInIndex,
        amountIn,
        allocations,
        depositedAmounts,
        lpReceived,
        dustRefunded,
        timestamp,
      };
    }
    case "SingleTokenDepositDirect": {
      // v6 planned zap receipt (`SingleTokenDepositDirect` in
      // src/idl/single_token_liquidity.json): pool, user, token_in_index,
      // amount_in, allocations, deposited_amounts, lp_received,
      // dust_remaining, timestamp. No helper: swaps and the join run with
      // the user's own accounts, so `dust_remaining` is what stayed in them.
      const pool = r.pubkey();
      const user = r.pubkey();
      const tokenInIndex = r.u8();
      const amountIn = r.u64();
      const allocations = r.vecU64();
      const depositedAmounts = r.vecU64();
      const lpReceived = r.u64();
      const dustRemaining = r.vecU64();
      const timestamp = r.i64().toNumber();
      return { kind: "SingleTokenDepositDirect", pool, user, tokenInIndex, amountIn, allocations, depositedAmounts, lpReceived, dustRemaining, timestamp };
    }
    case "PoolStateLog": {
      // Tails: T14 creator_fees_owed, T7 deposit_fee_bps / withdraw_fee_bps /
      // liquidity_fee_lock, T12 surge_fees_owed, T3 pool_admin_delay_secs /
      // pool_admin_epoch / pending_actions_mask.
      const pool = r.pubkey();
      const virtualBalances = r.vecU64();
      const actualBalances = r.vecU64();
      const protocolFeesOwed = r.vecU64();
      const timestamp = r.i64().toNumber();
      const creatorFeesOwed = optVecU64(r);
      const depositFeeBps = optU16(r);
      const withdrawFeeBps = optU16(r);
      const liquidityFeeLock = r.remaining() >= 1 ? r.u8() : 0;
      const surgeFeesOwed = optVecU64(r);
      const v61Tail = r.remaining() >= 10;
      const poolAdminDelaySecs = optU32(r);
      const poolAdminEpoch = optU32(r);
      const pendingActionsMask = optU16(r);
      return { kind: "PoolStateLog", pool, virtualBalances, actualBalances, protocolFeesOwed, timestamp, creatorFeesOwed, depositFeeBps, withdrawFeeBps, liquidityFeeLock, surgeFeesOwed, poolAdminDelaySecs, poolAdminEpoch, pendingActionsMask, v61Tail };
    }
    case "PoolInfo": {
      // `get_pool_info` read-only event. Tails: T14 creator_fee_bps /
      // creator_fees_owed, T6 range_manager_locked, T7 fee trio, T12
      // surge_fees_owed, T3 delay / epoch / mask / pending_etas, T9 hook block.
      const pool = r.pubkey();
      const config = r.pubkey();
      const lpMint = r.pubkey();
      const tokenCount = r.u8();
      const poolId = r.u64();
      const tokens = r.vecPubkey();
      const tokenVaults = r.vecPubkey();
      const normalizedWeights = r.vecU64();
      const virtualBalances = r.vecU64();
      const actualBalances = r.vecU64();
      const protocolFeesOwed = r.vecU64();
      const swapFeeRate = r.u32();
      const protocolFeeRate = r.u16();
      const poolEnabled = r.bool();
      const swapsEnabled = r.bool();
      const tokenPrograms = r.vecPubkey();
      const timestamp = r.i64().toNumber();
      const creatorFeeBps = optU16(r);
      const creatorFeesOwed = optVecU64(r);
      const rangeManagerLocked = r.remaining() >= 1 ? r.bool() : false;
      const depositFeeBps = optU16(r);
      const withdrawFeeBps = optU16(r);
      const liquidityFeeLock = r.remaining() >= 1 ? r.u8() : 0;
      const surgeFeesOwed = optVecU64(r);
      const poolAdminDelaySecs = optU32(r);
      const poolAdminEpoch = optU32(r);
      const pendingActionsMask = optU16(r);
      const pendingEtas = r.remaining() >= 4 ? r.vecI64() : [];
      const v61Tail = r.remaining() >= 32 + 2 + 1 + 4 + 4 + 4 + 1;
      const hookProgram = optPubkey(r);
      const hookFlags = optU16(r);
      const hookDisabled = r.remaining() >= 1 ? r.u8() : 0;
      const hookFeeMin = optU32(r);
      const hookFeeMax = optU32(r);
      const hookMaxCu = optU32(r);
      const hookAccountsLen = r.remaining() >= 1 ? r.u8() : 0;
      return {
        kind: "PoolInfo", pool, config, lpMint, tokenCount, poolId, tokens, tokenVaults, normalizedWeights, virtualBalances, actualBalances,
        protocolFeesOwed, swapFeeRate, protocolFeeRate, poolEnabled, swapsEnabled, tokenPrograms, timestamp, creatorFeeBps, creatorFeesOwed,
        rangeManagerLocked, depositFeeBps, withdrawFeeBps, liquidityFeeLock, surgeFeesOwed, poolAdminDelaySecs, poolAdminEpoch, pendingActionsMask,
        pendingEtas, hookProgram, hookFlags, hookDisabled, hookFeeMin, hookFeeMax, hookMaxCu, hookAccountsLen, v61Tail,
      };
    }
    case "MaxSelloffWindowAdvanced": {
      const pool = r.pubkey();
      const tokenIndex = r.u8();
      const effectiveSelloff = r.u64();
      const maxSelloffCap = r.u64();
      const vbSnapshot = r.u64();
      const previousSelloff = r.u64();
      const currentSelloff = r.u64();
      const windowStartTimestamp = r.i64().toNumber();
      const timestamp = r.i64().toNumber();
      return {
        kind: "MaxSelloffWindowAdvanced",
        pool,
        tokenIndex,
        effectiveSelloff,
        maxSelloffCap,
        vbSnapshot,
        previousSelloff,
        currentSelloff,
        windowStartTimestamp,
        timestamp,
      };
    }
    // Decode the remaining current events through the complete shipped ABI.
    case "SwapFeeRateUpdated":
    case "ProtocolFeeRateUpdated":
    case "DebugLiquidityWithdrawn":
      const current = decodeContractEvent(Buffer.concat([DISC[name], buf]).toString("base64"));
      return current ? camelEvent(current) : { kind: "Unknown", name, data: { raw: buf.toString("base64") } };
  }
}

void PublicKey; // keep import used by types above via type inference

// Tolerant readers for append-only tails: a log emitted before the tail
// existed simply ends early, and the field reads as its default.
const optU64 = (r: BorshReader): BN => (r.remaining() >= 8 ? r.u64() : new BN(0));
const optU32 = (r: BorshReader): number => (r.remaining() >= 4 ? r.u32() : 0);
const optU16 = (r: BorshReader): number => (r.remaining() >= 2 ? r.u16() : 0);
const optVecU64 = (r: BorshReader): BN[] => (r.remaining() >= 4 ? r.vecU64() : []);
const optString = (r: BorshReader): string => (r.remaining() >= 4 ? r.string() : "");
const optPubkey = (r: BorshReader): PublicKey => (r.remaining() >= 32 ? r.pubkey() : PublicKey.default);

function camelEvent(event: ContractEvent): AdditionalContractEvent {
  const fields: Record<string, unknown> = { kind: event.kind };
  for (const [key, value] of Object.entries(event.data)) {
    // v6.1 (T3): the cooldown events carry a `kind: u8` data field; it is
    // exposed as `actionKind` so it cannot shadow the event discriminator.
    const name = key === "kind" ? "actionKind" : key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    fields[name] = key === "timestamp" && BN.isBN(value) ? value.toNumber() : value;
  }
  return fields as AdditionalContractEvent;
}
