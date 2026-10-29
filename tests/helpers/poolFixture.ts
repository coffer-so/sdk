/**
 * Shared `PoolInfo` fixture for the v6.1 test suites: a synced-looking
 * snapshot with every v6.1 field, no RPC.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import type { PoolInfo, PoolHookInfo, PoolTokenInfo } from "../../src/types/pool";
import { getConfig } from "../../src/config";
import { deriveAta, deriveLpMint, derivePoolPda } from "../../src/utils/pda";
import { POOL_ACTION_KINDS } from "../../src/parsers/layout";

export const cfg = getConfig("localnet");
export const pk = (): PublicKey => Keypair.generate().publicKey;
export const bn = (v: number | bigint | string): BN => new BN(v.toString());

export interface MockPoolOptions {
  tokenCount?: number;
  /** Per-token `[actual, virtual]` (raw). Default `[1e9, 2e9]` — levered 2× (v6.1 T22: `virtual > actual` on every slot). */
  balances?: Array<[bigint, bigint]>;
  /** Per-token surge bucket (raw); default zeros. */
  surge?: bigint[];
  /** Per-token creator bucket (raw); default zeros. */
  creatorOwed?: bigint[];
  protocolOwed?: bigint[];
  weightsBps?: number[];
  decimals?: number[];
  tokenPrograms?: PublicKey[];
  lpSupply?: bigint;
  swapFeeRate?: number;
  protocolFeeRate?: number;
  creatorFeeBps?: number;
  depositFeeBps?: number;
  withdrawFeeBps?: number;
  liquidityFeesLocked?: boolean;
  rangeManagerLocked?: boolean;
  layoutVersion?: 0 | 1;
  poolAdmin?: PublicKey;
  poolEnabled?: boolean;
  swapsEnabled?: boolean;
  hook?: Partial<PoolHookInfo> | null;
  poolAdminDelaySecs?: number;
  poolAdminEpoch?: number;
  pendingEtas?: number[];
  chainTimestamp?: number;
  lpTokenProgram?: PublicKey;
  poolId?: BN;
  configKey?: PublicKey;
}

export function mockPool(o: MockPoolOptions = {}): PoolInfo {
  const n = o.tokenCount ?? (o.balances?.length ?? 2);
  const balances = o.balances ?? Array.from({ length: n }, () => [1_000_000_000n, 2_000_000_000n] as [bigint, bigint]);
  const surge = o.surge ?? Array(n).fill(0n);
  const creatorOwed = o.creatorOwed ?? Array(n).fill(0n);
  const protocolOwed = o.protocolOwed ?? Array(n).fill(0n);
  const weights = o.weightsBps ?? Array.from({ length: n }, (_, i) => (i === n - 1 ? 10_000 - Math.floor(10_000 / n) * (n - 1) : Math.floor(10_000 / n)));
  const decimals = o.decimals ?? Array(n).fill(9);
  const programs = o.tokenPrograms ?? Array(n).fill(TOKEN_PROGRAM_ID);
  const configKey = o.configKey ?? pk();
  const poolId = o.poolId ?? new BN(1);
  const [address] = derivePoolPda(cfg.programs.cofferPool, configKey, poolId);
  const [lpMint] = deriveLpMint(cfg.programs.cofferPool, address);
  const lpTokenProgram = o.lpTokenProgram ?? TOKEN_2022_PROGRAM_ID;
  const layoutVersion = o.layoutVersion ?? 1;
  const tokens: PoolTokenInfo[] = Array.from({ length: n }, (_, index) => {
    const mint = pk();
    return {
      index, mint, tokenProgram: programs[index], decimals: decimals[index], weightBps: weights[index],
      virtualBalance: bn(balances[index][1]), actualBalance: bn(balances[index][0]), protocolFeesOwed: bn(protocolOwed[index]),
      vault: deriveAta(address, mint, programs[index]), concentration: 1, isActive: true, maxSelloffPct: 0,
      maxSelloffPeriodLength: 0, variableFeeThresholdPct: 0, variableFeeSlopeLowPct: 0, variableFeeSlopeHighPct: 0,
      previousSelloff: bn(0), currentSelloff: bn(0), windowStartTimestamp: bn(0), selloffVbSnapshot: bn(0), variableFeeSlopeMidPct: 0, variableFeeKinkPct: 0,
      extensions: [], unsupportedExtensions: [], transferFee: null, transferHookProgram: null, paused: false,
      pinnedDecimals: layoutVersion ? decimals[index] : undefined, pinnedDecimalsMismatch: false,
      creatorFeesOwed: bn(creatorOwed[index]), surgeFeesOwed: bn(surge[index]), sidelined: balances[index][0] === 0n,
    };
  });
  const hook: PoolHookInfo | null = o.hook === undefined || o.hook === null ? null : {
    program: o.hook.program ?? pk(), flags: o.hook.flags ?? 0b110000, disabled: o.hook.disabled ?? false,
    active: o.hook.active ?? !(o.hook.disabled ?? false), feeMin: o.hook.feeMin ?? 0, feeMax: o.hook.feeMax ?? 0,
    maxCu: o.hook.maxCu ?? 50_000, accountsLen: o.hook.accountsLen ?? 3,
  };
  const etas = o.pendingEtas ?? Array(11).fill(0);
  const pendingActions = POOL_ACTION_KINDS.map((name, kind) => ({ kind, name, eta: bn(etas[kind] ?? 0), payload: {} as Record<string, never> }));
  return {
    address, config: configKey, bump: 254, poolId, tokenCount: n, tokens, unsupportedTokenIndices: [], lpMint, lpTokenProgram,
    poolAdmin: o.poolAdmin ?? pk(), pendingPoolAdmin: PublicKey.default, rangeManager: PublicKey.default, rangeManagerEnabled: false,
    chainTimestamp: o.chainTimestamp ?? 1_700_000_000, chainSlot: 1_000, chainEpoch: 1_030, v5Migrated: true,
    lpTotalSupply: bn(o.lpSupply ?? 1_000_000_000_000n), swapFeeRate: o.swapFeeRate ?? 3000, protocolFeeRate: o.protocolFeeRate ?? 1000,
    poolEnabled: o.poolEnabled ?? true, swapsEnabled: o.swapsEnabled ?? true, createdAt: 0, lookupTable: PublicKey.default, syncedAt: 0,
    dataLen: layoutVersion ? 2304 : 1683, layoutVersion, needsLayoutMigration: layoutVersion === 0,
    tokenDecimals: layoutVersion ? decimals : [], creatorFeeBps: o.creatorFeeBps ?? 0,
    creatorFeesOwed: creatorOwed.map(bn), surgeFeesOwed: surge.map(bn),
    depositFeeBps: o.depositFeeBps ?? 0, withdrawFeeBps: o.withdrawFeeBps ?? 0,
    liquidityFeeLock: o.liquidityFeesLocked ? 1 : 0, liquidityFeesLocked: o.liquidityFeesLocked ?? false,
    rangeManagerLocked: o.rangeManagerLocked ?? false, poolAdminDelaySecs: o.poolAdminDelaySecs ?? 0, poolAdminEpoch: o.poolAdminEpoch ?? 0,
    pendingPoolAdminEta: bn(etas[0] ?? 0), pendingActions, pendingActionsMask: etas.reduce((m, e, i) => (e ? m | (1 << i) : m), 0),
    hook, layoutDrift: [], lpMetadata: null,
    leverageViolations: balances.flatMap(([a, v], i) => (v > a ? [] : [i])),
  };
}
