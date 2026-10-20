/**
 * Bit-for-bit parity of the TypeScript planner with the canonical Rust
 * planner (`cargo build -p single-token-liquidity --example zap_plan` on a
 * contracts `v6` checkout).
 *
 * The three fixtures under `tests/fixtures/zap-plan/` were produced by that
 * binary from the synthetic snapshots built here (equal weights; unequal
 * weights with swap/protocol fees; Token-2022 fee mints with an active
 * sell-off window and surge curve). CI compares `quoteZap` to them without
 * Rust. To regenerate, point `ZAP_PLAN_BINARY` at the built example:
 *
 *   ZAP_PLAN_BINARY=../contracts/target/debug/examples/zap_plan SKIP_MAINNET_TESTS=1 npx jest tests/zap-plan-fixtures
 */
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import { IDLS, getConfig, deriveLpMint, decodePoolAccount, decodeMintAccount, selectEpochFee, quoteZap, replay } from "../src";
import type { QuotePool } from "../src";
import { ContractAccountMap } from "../src/types/contracts";

type State = ContractAccountMap["cofferPool"]["CofferPool"];
// The fixtures were produced by the `zap_plan` binary built from contracts
// v6 `7d753b3`, whose `declare_id` is the localnet table — snapshot keys
// derived under it (LP mint PDA, pool owner) must not drift when the
// mainnet/devnet tables change.
const cfg = getConfig("localnet");
const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const bn = (v: number | bigint | string) => new BN(v.toString());
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
const poolBytes = (state: State) => Buffer.concat([Buffer.from(IDLS.cofferPool.accounts[0].discriminator), ...fields("CofferPool").map((f) => encode((state as any)[f.name], f.type))]);
function plainMint(decimals: number, supply: bigint): Buffer {
  const b = Buffer.alloc(82); b[44] = decimals; b[45] = 1; b.writeBigUInt64LE(supply, 36); return b;
}
function feeMint(decimals: number, bps: number, maxFee: bigint): Buffer {
  const base = plainMint(decimals, 0n);
  const body = Buffer.alloc(108); body.writeBigUInt64LE(0n, 72); body.writeBigUInt64LE(maxFee, 80); body.writeUInt16LE(bps, 88); body.writeBigUInt64LE(0n, 90); body.writeBigUInt64LE(maxFee, 98); body.writeUInt16LE(bps, 106);
  const h = Buffer.alloc(4); h.writeUInt16LE(1, 0); h.writeUInt16LE(108, 2);
  return Buffer.concat([base, Buffer.alloc(83), Buffer.from([1]), h, body, Buffer.alloc(8)]);
}

interface Scenario {
  name: string;
  tokenCount: number;
  weights: number[];
  balances: Array<[bigint, bigint]>;
  swapFeeRate: number;
  protocolFeeRate: number;
  feeMints: Record<number, [number, bigint]>;
  windows?: Record<number, { pct: number; period: number; prev: bigint; cur: bigint; ws: bigint; snap: bigint; curve: [number, number, number, number, number] }>;
  inputs: Array<[number, bigint]>;
}
const SCENARIOS: Scenario[] = [
  { name: "equal-weights", tokenCount: 3, weights: [3333, 3333, 3334], balances: [[1_000_000_000n, 1_000_000_000n], [2_000_000_000n, 2_500_000_000n], [500_000_000n, 500_000_000n]],
    swapFeeRate: 0, protocolFeeRate: 0, feeMints: {}, inputs: [[0, 50_000_000n], [2, 12_345_678n]] },
  { name: "unequal-weights-fees", tokenCount: 4, weights: [4000, 3000, 2000, 1000], balances: [[5_000_000_000n, 6_000_000_000n], [1_000_000_000n, 1_000_000_000n], [700_000_000n, 900_000_000n], [10_000_000_000n, 12_000_000_000n]],
    swapFeeRate: 3000, protocolFeeRate: 2000, feeMints: {}, inputs: [[1, 200_000_000n], [3, 999_999_999n]] },
  { name: "fee-mints-active-window", tokenCount: 3, weights: [5000, 3000, 2000], balances: [[1_000_000_000n, 1_200_000_000n], [800_000_000n, 800_000_000n], [300_000_000n, 350_000_000n]],
    swapFeeRate: 5000, protocolFeeRate: 2000, feeMints: { 0: [100, 1_000_000n], 2: [250, 50n] },
    windows: { 0: { pct: 2000, period: 3600, prev: 60_000_000n, cur: 80_000_000n, ws: 1_788_799_000n, snap: 1_000_000_000n, curve: [6000, 100, 1800, 8000, 75] } },
    inputs: [[0, 100_000_000n], [1, 40_000_000n]] },
];

function snapshot(sc: Scenario) {
  const address = key(1);
  const [lpMint] = deriveLpMint(cfg.programs.cofferPool, address);
  const programs = Array.from({ length: sc.tokenCount }, (_, i) => (sc.feeMints[i] ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID));
  const slot = (i: number) => {
    const w = sc.windows?.[i];
    return {
      config: { mint: key(100 + i), token_program: programs[i], normalized_weight: bn(sc.weights[i]), max_selloff_pct: w?.pct ?? 0, max_selloff_period_length: w?.period ?? 0,
        variable_fee_threshold_pct: w?.curve[0] ?? 0, variable_fee_slope_low_pct: w?.curve[1] ?? 0, variable_fee_slope_high_pct: w?.curve[3] ?? 0, is_active: true, variable_fee_slope_mid_pct: w?.curve[2] ?? 0, variable_fee_kink_pct: w?.curve[4] ?? 0 },
      dynamics: { virtual_balance: bn(sc.balances[i][1]), actual_balance: bn(sc.balances[i][0]), protocol_fees_owed: bn(0), previous_selloff: bn(w?.prev ?? 0n), current_selloff: bn(w?.cur ?? 0n), window_start_timestamp: bn(w?.ws ?? 0n), selloff_vb_snapshot: bn(w?.snap ?? 0n) },
    };
  };
  const empty = () => ({ config: { ...slot(0).config, mint: PublicKey.default, token_program: PublicKey.default, normalized_weight: bn(0), max_selloff_pct: 0, max_selloff_period_length: 0, variable_fee_threshold_pct: 0, variable_fee_slope_low_pct: 0, variable_fee_slope_high_pct: 0, variable_fee_slope_mid_pct: 0, variable_fee_kink_pct: 0 }, dynamics: { virtual_balance: bn(0), actual_balance: bn(0), protocol_fees_owed: bn(0), previous_selloff: bn(0), current_selloff: bn(0), window_start_timestamp: bn(0), selloff_vb_snapshot: bn(0) } });
  const state = {
    config: key(2), bump: 254, token_count: sc.tokenCount, pool_id: bn(1), swap_fee_rate: sc.swapFeeRate, protocol_fee_rate: sc.protocolFeeRate, created_at: bn(1),
    pool_enabled: true, swaps_enabled: true, pool_admin: key(3), pending_pool_admin: PublicKey.default, range_manager: PublicKey.default,
    range_manager_enabled: false, range_manager_max_vb_change_pct: 0, range_manager_max_weight_change_pct: 0, range_manager_min_update_interval_secs: 0,
    range_manager_last_updated: bn(0), tokens: Array.from({ length: 10 }, (_, i) => (i < sc.tokenCount ? slot(i) : empty())),
    lookup_table: PublicKey.default, _deprecated_banned_extensions: bn(0), range_manager_max_leverage_bps: 0, range_manager_min_leverage_bps: 0,
    reserved: [0x56, 0x35, 0x4d, 0x31, ...Array(12).fill(0)],
  } as unknown as State;
  const mints = Array.from({ length: sc.tokenCount }, (_, i) => ({ key: key(100 + i), owner: programs[i], data: sc.feeMints[i] ? feeMint(6, sc.feeMints[i][0], sc.feeMints[i][1]) : plainMint(6, 0n) }));
  return { pool: { key: address, owner: cfg.programs.cofferPool, data: poolBytes(state) }, lpMint: { key: lpMint, owner: TOKEN_PROGRAM_ID, data: plainMint(9, 3_000_000_000n) }, mints, epoch: 1030n, now: 1_788_799_999n };
}

function quotePoolOf(s: ReturnType<typeof snapshot>): QuotePool {
  const raw = decodePoolAccount(s.pool.data);
  const supply = BigInt(decodeMintAccount(s.lpMint.data).supply.toString());
  return {
    tokens: Array.from({ length: raw.tokenCount }, (_, i) => {
      const mint = decodeMintAccount(s.mints[i].data);
      return {
        virtualBalance: BigInt(raw.virtualBalances[i].toString()), actualBalance: BigInt(raw.actualBalances[i].toString()), protocolFeesOwed: BigInt(raw.protocolFeesOwed[i].toString()),
        weightBps: BigInt(raw.normalizedWeights[i].toString()), isActive: raw.isActive[i], maxSelloffPct: raw.maxSelloffPct[i], maxSelloffPeriodLength: raw.maxSelloffPeriodLength[i],
        curve: { thresholdPct: raw.variableFeeThresholdPct[i], slopeLowPct: raw.variableFeeSlopeLowPct[i], slopeMidPct: raw.variableFeeSlopeMidPct[i], slopeHighPct: raw.variableFeeSlopeHighPct[i], kinkPct: raw.variableFeeKinkPct[i] },
        window: { previousSelloff: BigInt(raw.previousSelloff[i].toString()), currentSelloff: BigInt(raw.currentSelloff[i].toString()), windowStartTimestamp: BigInt(raw.windowStartTimestamp[i].toString()), selloffVbSnapshot: BigInt(raw.selloffVbSnapshot[i].toString()) },
        transferFee: mint.transferFeeConfig ? selectEpochFee(mint.transferFeeConfig, s.epoch) : null,
      };
    }),
    lpSupply: supply, swapFeeRate: raw.swapFeeRate, protocolFeeRate: raw.protocolFeeRate, now: s.now,
  };
}

const hex = (b: Buffer) => b.toString("hex");
const dir = join(__dirname, "fixtures", "zap-plan");
const fixturePath = (sc: Scenario, input: number, amount: bigint) => join(dir, `${sc.name}-in${input}-${amount}.json`);
const BINARY = process.env.ZAP_PLAN_BINARY;

describe("TypeScript planner vs canonical zap_plan fixtures", () => {
  for (const sc of SCENARIOS) {
    for (const [input, amount] of sc.inputs) {
      test(`${sc.name}: input ${input}, amount ${amount}`, () => {
        const s = snapshot(sc);
        const request = {
          pool: { key: s.pool.key.toBase58(), owner: s.pool.owner.toBase58(), data: hex(s.pool.data) },
          lpMint: { key: s.lpMint.key.toBase58(), owner: s.lpMint.owner.toBase58(), data: hex(s.lpMint.data) },
          mints: s.mints.map((m) => ({ key: m.key.toBase58(), owner: m.owner.toBase58(), data: hex(m.data) })),
          epoch: s.epoch.toString(), now: s.now.toString(), amountIn: amount.toString(), inputIndex: input.toString(),
        };
        const path = fixturePath(sc, input, amount);
        if (BINARY) {
          const out = execFileSync(BINARY, [], { input: JSON.stringify(request), maxBuffer: 4 * 1024 * 1024 }).toString();
          mkdirSync(dir, { recursive: true });
          writeFileSync(path, JSON.stringify({ request, response: JSON.parse(out) }, null, 2) + "\n");
        }
        if (!existsSync(path)) throw new Error(`Missing fixture ${path}; set ZAP_PLAN_BINARY to generate it`);
        const fixture = JSON.parse(readFileSync(path, "utf8"));
        expect(fixture.request).toEqual(request); // the snapshot builder must stay deterministic
        const expected = fixture.response;
        const pool = quotePoolOf(s);
        const q = quoteZap(pool, input, amount);
        expect(q.allocations.map(String)).toEqual(expected.allocations);
        expect(q.lp.toString()).toBe(expected.estimatedLp);
        expect(q.ratio.toString()).toBe(expected.ratio);
        expect(q.available.map(String)).toEqual(expected.available);
        expect(q.depositedGross.map(String)).toEqual(expected.depositedGross);
        expect(q.creditedNet.map(String)).toEqual(expected.creditedNet);
        expect(q.dust.map(String)).toEqual(expected.dust);
        expect(q.swaps.map((sw) => ({ input: sw.input, output: sw.output, grossInput: sw.grossInput.toString(), netInput: sw.netInput.toString(), baseFee: sw.baseFee.toString(), protocolFee: sw.protocolFee.toString(), rawOutput: sw.rawOutput.toString(), surgeFee: sw.surgeFee.toString(), grossOutput: sw.grossOutput.toString(), netOutput: sw.netOutput.toString() }))).toEqual(expected.swaps);
        expect(q.stateAfter.tokens.map((t) => ({ actualBalance: t.actualBalance.toString(), virtualBalance: t.virtualBalance.toString(), protocolFeesOwed: t.protocolFeesOwed.toString(), previousSelloff: t.window.previousSelloff.toString(), currentSelloff: t.window.currentSelloff.toString(), windowStartTimestamp: t.window.windowStartTimestamp.toString(), selloffVbSnapshot: t.window.selloffVbSnapshot.toString() }))).toEqual(expected.stateAfter);
        expect(q.stateAfter.lpSupply.toString()).toBe(expected.lpSupplyAfter);
        // The fixture's own plan replays to the same economics.
        expect(replay(pool, input, amount, expected.allocations.map(BigInt)).lp.toString()).toBe(expected.estimatedLp);
      });
    }
  }
});
