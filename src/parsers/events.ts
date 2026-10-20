import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { BorshReader } from "./borsh";
import { decodeContractEvent, ContractEvent } from "./contracts";
import { CofferPoolEvent, AdditionalContractEvent } from "../types/events";

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
      // The deployed without-SF event ends with timestamp, surge_fee_amount.
      // Optional trailing transfer-fee fields are retained only for decoding
      // logs from other historical builds; they do not imply mint support.
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
      // Absent in the deployed without-SF ABI: expose zero for compatibility.
      const transferFeeIn = r.remaining() >= 8 ? r.u64() : new BN(0);
      const transferFeeOut = r.remaining() >= 8 ? r.u64() : new BN(0);
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
      };
    }
    case "LiquidityAdded": {
      const pool = r.pubkey();
      const user = r.pubkey();
      const tokenAmounts = r.vecU64();
      const lpAmount = r.u64();
      const timestamp = r.i64().toNumber();
      return { kind: "LiquidityAdded", pool, user, tokenAmounts, lpAmount, timestamp };
    }
    case "LiquidityRemoved": {
      const pool = r.pubkey();
      const user = r.pubkey();
      const lpAmount = r.u64();
      const tokenAmounts = r.vecU64();
      const timestamp = r.i64().toNumber();
      return { kind: "LiquidityRemoved", pool, user, lpAmount, tokenAmounts, timestamp };
    }
    case "ProtocolFeesCollected": {
      const pool = r.pubkey();
      const authority = r.pubkey();
      const tokenAmounts = r.vecU64();
      const timestamp = r.i64().toNumber();
      return { kind: "ProtocolFeesCollected", pool, authority, tokenAmounts, timestamp };
    }
    case "PoolInitialized": {
      const pool = r.pubkey();
      const config = r.pubkey();
      const tokenCount = r.u8();
      const lpMint = r.pubkey();
      const timestamp = r.i64().toNumber();
      // Wire slot of the former `banned_extensions` bitmap (v5.1). The policy
      // was removed in v6.1 (T19); the program keeps the slot and emits `0`.
      // Old logs still carry the bitmap they were emitted with.
      const deprecatedBannedExtensions = r.remaining() >= 8 ? r.u64() : new BN(0);
      // Appended in v6: the PDA salt. Guarded for pre-v6 logs (reads as 0).
      const poolId = r.remaining() >= 8 ? r.u64() : new BN(0);
      return { kind: "PoolInitialized", pool, config, tokenCount, lpMint, timestamp, deprecatedBannedExtensions, poolId };
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
      const pool = r.pubkey();
      const virtualBalances = r.vecU64();
      const actualBalances = r.vecU64();
      const protocolFeesOwed = r.vecU64();
      const timestamp = r.i64().toNumber();
      return { kind: "PoolStateLog", pool, virtualBalances, actualBalances, protocolFeesOwed, timestamp };
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
    case "PoolInfo":
      const current = decodeContractEvent(Buffer.concat([DISC[name], buf]).toString("base64"));
      return current ? camelEvent(current) : { kind: "Unknown", name, data: { raw: buf.toString("base64") } };
  }
}

void PublicKey; // keep import used by types above via type inference

function camelEvent(event: ContractEvent): AdditionalContractEvent {
  const fields: Record<string, unknown> = { kind: event.kind };
  for (const [key, value] of Object.entries(event.data)) {
    const name = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    fields[name] = key === "timestamp" && BN.isBN(value) ? value.toNumber() : value;
  }
  return fields as AdditionalContractEvent;
}
