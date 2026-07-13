import { Commitment, PublicKey } from "@solana/web3.js";
import {
  NETWORK_PROGRAMS,
  NetworkPrograms,
  Network,
  DEFAULT_RPC_ENDPOINT,
  DEFAULT_RPC_ENDPOINTS,
  DEFAULT_RPC_TIMEOUT_MS,
} from "./networks";
import { TokenInfo } from "./tokens";

export * from "./networks";
export * from "./tokens";

/**
 * Root SDK configuration. Passed into every Client class at construction.
 * Immutable after creation — rebuild if you need to switch networks.
 */
export interface CubeConfig {
  network: Network;
  programs: NetworkPrograms;
  defaults: {
    rpcEndpoint: string;
    rpcEndpoints: string[];
    rpcTimeoutMs: number;
    rpcCommitment: Commitment;
    /** Used by helpers that prepend a ComputeBudget instruction. */
    cuLimit: number;
    /**
     * Default slippage budget when the caller doesn't pass one. Units:
     * hundredths of a basis point (matches cubic-pool's `swap_fee_rate`
     * scale). 50_000 = 5%.
     */
    slippageHundredthsBps: number;
  };
  /** Optional token registry keyed by mint pubkey string. */
  tokens?: Record<string, TokenInfo>;
  /** Optional backend endpoint; consumed by CubeBackendClient. */
  backendEndpoint?: string;
}

export interface CubeConfigOverrides {
  rpcEndpoint?: string;
  rpcEndpoints?: string[];
  rpcTimeoutMs?: number;
  rpcCommitment?: Commitment;
  cuLimit?: number;
  slippageHundredthsBps?: number;
  backendEndpoint?: string;
  tokens?: Record<string, TokenInfo>;
}

/** Build a CubeConfig for the named network with optional overrides. */
export function getConfig(network: Network, overrides: CubeConfigOverrides = {}): CubeConfig {
  const rpcEndpoints = resolveRpcEndpoints(network, overrides);
  return {
    network,
    programs: NETWORK_PROGRAMS[network],
    defaults: {
      rpcEndpoint: rpcEndpoints[0] ?? overrides.rpcEndpoint ?? DEFAULT_RPC_ENDPOINT[network],
      rpcEndpoints,
      rpcTimeoutMs: overrides.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
      rpcCommitment: overrides.rpcCommitment ?? "confirmed",
      cuLimit: overrides.cuLimit ?? 1_400_000,
      slippageHundredthsBps: overrides.slippageHundredthsBps ?? 50_000,
    },
    tokens: overrides.tokens,
    backendEndpoint: overrides.backendEndpoint,
  };
}

function resolveRpcEndpoints(network: Network, overrides: CubeConfigOverrides): string[] {
  if (overrides.rpcEndpoints && overrides.rpcEndpoints.length > 0) {
    return dedupe(overrides.rpcEndpoints);
  }
  if (overrides.rpcEndpoint) {
    return dedupe([overrides.rpcEndpoint, ...DEFAULT_RPC_ENDPOINTS[network]]);
  }
  return [...DEFAULT_RPC_ENDPOINTS[network]];
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

export const CUBIC_POOL_SEED = Buffer.from("cubic_pool");
export const BPT_MINT_SEED = Buffer.from("bpt_mint");
export const STLD_HELPER_SEED = Buffer.from("stld_helper");
export const TREASURY_SEED = Buffer.from("treasury");

/** Contract-level constants mirrored from Rust. */
export const WEIGHT_SCALE = 10_000; // 100 %
export const MIN_WEIGHT = 100; // 1 %
export const MAX_WEIGHT = 9_900; // 99 %
export const MIN_TOKENS = 2;
export const MAX_TOKENS = 10;
export const BPT_DECIMALS = 9;
export const SWAP_FEE_PRECISION = 1_000_000; // 100 %
export const PROTOCOL_FEE_PRECISION = 10_000; // 100 %
export const PERCENT_SCALE = 10_000; // 100 % (max-selloff / surge-fee scale)
export const MAX_SWAP_FEE_RATE = 100_000; // 10 %
export const MAX_PROTOCOL_FEE_RATE = 5_000; // 50 %
export const MINIMUM_INITIAL_BPT = 1_000n;
export const SLIPPAGE_PRECISION = 1_000_000;
export const MIN_SLIPPAGE_HBPS = 10; // 0.001 %

export type ProgramIdKind = "cubicPool" | "singleTokenLiquidity" | "protocolAdmin";

export function programId(cfg: CubeConfig, kind: ProgramIdKind): PublicKey {
  return cfg.programs[kind];
}
