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
export interface CofferConfig {
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
     * hundredths of a basis point (matches coffer-pool's `swap_fee_rate`
     * scale). 50_000 = 5%.
     */
    slippageHundredthsBps: number;
  };
  /** Optional token registry keyed by mint pubkey string. */
  tokens?: Record<string, TokenInfo>;
  /** Optional backend endpoint; consumed by CofferBackendClient. */
  backendEndpoint?: string;
}

export interface CofferConfigOverrides {
  /**
   * Program ids to use instead of the network table. Needed while v6 runs
   * on a local validator or a devnet copy under different addresses; a
   * partial object overrides only the listed programs.
   */
  programs?: Partial<NetworkPrograms>;
  rpcEndpoint?: string;
  rpcEndpoints?: string[];
  rpcTimeoutMs?: number;
  rpcCommitment?: Commitment;
  cuLimit?: number;
  slippageHundredthsBps?: number;
  backendEndpoint?: string;
  tokens?: Record<string, TokenInfo>;
}

/** Build a CofferConfig for the named network with optional overrides. */
export function getConfig(network: Network, overrides: CofferConfigOverrides = {}): CofferConfig {
  const rpcEndpoints = resolveRpcEndpoints(network, overrides);
  return {
    network,
    programs: { ...NETWORK_PROGRAMS[network], ...(overrides.programs ?? {}) },
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

function resolveRpcEndpoints(network: Network, overrides: CofferConfigOverrides): string[] {
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

export const POOL_SEED = Buffer.from("cubic_pool");
export const LP_MINT_SEED = Buffer.from("bpt_mint");
export const STLD_HELPER_SEED = Buffer.from("stld_helper");
export const TREASURY_SEED = Buffer.from("treasury");

/** Contract-level constants mirrored from Rust. */
export const WEIGHT_SCALE = 10_000; // 100 %
export const MIN_WEIGHT = 100; // 1 %
export const MAX_WEIGHT = 9_900; // 99 %
export const MIN_TOKENS = 2;
export const MAX_TOKENS = 10;
export const LP_DECIMALS = 9;
export const SWAP_FEE_PRECISION = 1_000_000; // 100 %
export const PROTOCOL_FEE_PRECISION = 10_000; // 100 %
export const PERCENT_SCALE = 10_000; // 100 % (max-selloff / surge-fee scale)
/** v6: any rate in 0..=100 % is a legal pool configuration (v5 capped at 10 % / 50 %). */
export const MAX_SWAP_FEE_RATE = SWAP_FEE_PRECISION; // 100 %
export const MAX_PROTOCOL_FEE_RATE = PROTOCOL_FEE_PRECISION; // 100 %
export const MIN_LP_SUPPLY = 1_000n;
export const SLIPPAGE_PRECISION = 1_000_000;
export const MIN_SLIPPAGE_HBPS = 10; // 0.001 %

// ── v6.1 constants (mirrored from `programs/coffer-pool/src/constants.rs`) ──

/** T15: every new pool is born with this protocol share of swap + surge fees (bps). */
export const DEFAULT_PROTOCOL_FEE_RATE = 1_000; // 10 %
/** T14: pool admin's share of the LP fee remainder, bps; 100 % allowed. */
export const CREATOR_FEE_PRECISION = 10_000;
export const MAX_CREATOR_FEE_BPS = 10_000;
export const DEFAULT_CREATOR_FEE_BPS = 0;
/** T7: deposit / withdraw fee precision and cap (100 % = closed). */
export const LIQUIDITY_FEE_PRECISION = 10_000;
export const MAX_LIQUIDITY_FEE_BPS = 10_000;
/** T7: `CofferPool.liquidity_fee_lock` bit — once set, `set_liquidity_fees` is rejected for ever. */
export const LIQUIDITY_FEE_LOCK_FROZEN = 0x01;
/** T2: creator-chosen initial LP supply bounds (raw, 9 decimals). */
export const MIN_INITIAL_LP_SUPPLY = 1_000_000_000n; // 1 LP
export const MAX_INITIAL_LP_SUPPLY = 10_000_000_000_000_000n; // 1e7 LP
/** T8: the atomic deploy's default seed supply (1_000 LP). */
export const DEFAULT_INITIAL_LP_SUPPLY = 1_000_000_000_000n;
/** T1: LP metadata limits (bytes). */
export const LP_NAME_MAX_LEN = 32;
export const LP_SYMBOL_MAX_LEN = 10;
export const LP_URI_MAX_LEN = 200;
export const LP_METADATA_POOL_KEY = "pool";
/** T9: `coffer_hook_interface::flags` — `CofferPool.hook_flags` bits. */
export const HOOK_FLAGS = {
  BEFORE_ADD_LIQUIDITY: 1 << 0,
  AFTER_ADD_LIQUIDITY: 1 << 1,
  /** informational: verdict logged, never enforced */
  BEFORE_REMOVE_LIQUIDITY: 1 << 2,
  /** informational: verdict logged, never enforced */
  AFTER_REMOVE_LIQUIDITY: 1 << 3,
  BEFORE_SWAP: 1 << 4,
  AFTER_SWAP: 1 << 5,
  /** before-swap may return a fee override (requires BEFORE_SWAP) */
  DYNAMIC_FEE: 1 << 6,
  /** fail-closed: while disabled, swaps / deposits fail with HookPaused */
  PAUSE_WHEN_DISABLED: 1 << 7,
  ALL_CALLBACKS: 0b11_1111,
  VALID_MASK: 0xff,
} as const;
/** T9: `HookConfig` bounds. */
export const HOOK_MIN_CU = 5_000;
export const HOOK_MAX_CU_CAP = 200_000;
export const HOOK_DEFAULT_MAX_CU = 50_000;
export const HOOK_MIN_ACCOUNTS = 2;
export const HOOK_MAX_ACCOUNTS = 12;
export const HOOK_FEE_FLOOR = 0;
export const HOOK_INTERFACE_VERSION = 1;
/** T9: PDA `[b"coffer_hook_caller"]` under coffer-pool — the only signer of a hook CPI (never the pool PDA). */
export const HOOK_CALLER_SEED = Buffer.from("coffer_hook_caller");
/** T9: `sha256("coffer-hook-interface:<name>")[..8]` per callback (`HookInvoked.callback` index order). */
export const HOOK_CALLBACKS = [
  { index: 0, name: "on-register", discriminator: "5f3032ad60eac0cb" },
  { index: 1, name: "before-swap", discriminator: "40e0cf9c6cdc2499" },
  { index: 2, name: "after-swap", discriminator: "3e93c139b56784aa" },
  { index: 3, name: "before-add-liquidity", discriminator: "11e260373a9e354e" },
  { index: 4, name: "after-add-liquidity", discriminator: "f8950d93727aea93" },
  { index: 5, name: "before-remove-liquidity", discriminator: "741994cb063e0dad" },
  { index: 6, name: "after-remove-liquidity", discriminator: "b1af63ec704ede05" },
] as const;
/** T22: absolute floor of a chosen `virtual_balance` (raw); the effective floor is `max(10^decimals, 1_000)` (`minVirtualBalance`). */
export const MIN_VIRTUAL_BALANCE_ABS = 1_000n;
/** T22: `rescale_virtual_balances` refuses a multiplier below 2 (`InvalidVirtualRescale`). */
export const MIN_VIRTUAL_RESCALE_MULTIPLIER = 2n;
/** FIX-6 / T22: decimals are pinned per slot and clamped at 18 for the floor (`10^18 < 2^63`). */
export const MAX_TOKEN_DECIMALS = 18;
/** T5: Treasury vault PDA seed `[b"vault", mint]` under protocol_admin — the only accepted protocol-fee recipient. */
export const TREASURY_VAULT_SEED = Buffer.from("vault");

export type ProgramIdKind = "cofferPool" | "singleTokenLiquidity" | "protocolAdmin";

export function programId(cfg: CofferConfig, kind: ProgramIdKind): PublicKey {
  return cfg.programs[kind];
}
