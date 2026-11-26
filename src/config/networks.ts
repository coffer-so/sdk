import { PublicKey } from "@solana/web3.js";
import { COFFER_REWARDS_PROGRAM_ID } from "../rewards/constants";

export type Network = "mainnet" | "devnet" | "localnet";

export interface NetworkPrograms {
  cofferPool: PublicKey;
  singleTokenLiquidity: PublicKey;
  protocolAdmin: PublicKey;
  /**
   * coffer_rewards (boost payouts, since 1.5.0). Optional so hand-built
   * configs keep compiling; read it with `programId(cfg, "cofferRewards")`,
   * which falls back to `COFFER_REWARDS_PROGRAM_ID`.
   */
  cofferRewards?: PublicKey;
}

export const NETWORK_PROGRAMS: Record<Network, NetworkPrograms> = {
  // v6 programs are SEPARATE deployments next to v5 (`@coffer_so/sdk` 1.x
  // keeps the v5 table). Pool accounts are owned by their generation's
  // coffer_pool, so a v5 pool must be driven with the v5 SDK and vice versa.
  mainnet: {
    cofferPool: new PublicKey("6DhW1Ek5WLJSnFSpBBGYeVRbRiWtCXHbqyGJ6LcVZgH9"),
    // TODO(mainnet): single_token_liquidity v6 is NOT deployed on mainnet
    // yet; this is the id reserved for it (protocol_admin v6 already pins
    // it). Planned zap stays disabled until the program is live.
    singleTokenLiquidity: new PublicKey(
      "Dh56yWNdJgmPxYosUu24cUumsEckEw56kXdPTHghLEBy",
    ),
    protocolAdmin: new PublicKey(
      "6VbU3f7VDmvWAtzw1ujz4FmNBtNzgS4mVQVVAP7bc6ck",
    ),
    // Same id on every cluster (declare_id! in programs/coffer-rewards).
    cofferRewards: COFFER_REWARDS_PROGRAM_ID,
  },
  devnet: {
    // v6 built from `contracts` v6 `7d753b3` with devnet `declare_id`s and a
    // devnet `PROTOCOL_ADMIN_PROGRAM_ID`, deployed 2026-10-10. Treasury PDA
    // HLpyYUeWmz7VfNgJG5ZMj4vnpqiJXYUSY9SNwy3u1NVW, CofferPoolConfig
    // 5GTgLMeodBEovfDnwYjpt8ndw8hUcifQJVMVnGRwWEYp. The v5 devnet copy
    // (E6YA… / 6bFD…) is a different program; use `@coffer_so/sdk` for it.
    cofferPool: new PublicKey("Anqy91qJz4Z9faHD6b5bDGYoe1cqYLytPLh4w2Z4UkD1"),
    singleTokenLiquidity: new PublicKey(
      "4Rk88MtVT6CjB5e2EPbzQ4Qs6zKtSFgVZYE79SVenVko",
    ),
    protocolAdmin: new PublicKey(
      "FPwMrsxYpgJsZRCTKJadP97AsNX1WwFBZwBbzTDcYmjU",
    ),
    // Same id on every cluster (declare_id! in programs/coffer-rewards).
    cofferRewards: COFFER_REWARDS_PROGRAM_ID,
  },
  localnet: {
    // `anchor build` of contracts/v6 keeps the historical declare_ids.
    cofferPool: new PublicKey("8iQtGj9mcUfFUGaiCpPy89swC3s8YTC8FhVZWfgeZhwu"),
    singleTokenLiquidity: new PublicKey(
      "7BpdUH1tzTSXLuQNo6YpjJ8Eagw8AkrS6cnkxiJdCFS2",
    ),
    protocolAdmin: new PublicKey(
      "3jiojHZbjJQ7QLMGSTjFwxVEmx4NtuRy34nLAmsJME81",
    ),
    // Same id on every cluster (declare_id! in programs/coffer-rewards).
    cofferRewards: COFFER_REWARDS_PROGRAM_ID,
  },
};

/**
 * v6.1 (T4): the production v5.1 factory the v6.1 upgrade targets
 * (`upgrade_pool_program` keeps the ids; pools grow 1683 → 2304 bytes via
 * `migrate_pool_layout_v61`). It is NOT the default `mainnet` table — that
 * stays the v6 standalone factory until the upgrade lands; pass
 * `getConfig("mainnet", { programs: MAINNET_V51_FACTORY_PROGRAMS })` to
 * drive the upgraded v5.1 factory. Treasury PDA
 * B4gyhrqLzX36VEu54ShqgTkb4TpXooTdxtcmvER3d3Bg.
 */
export const MAINNET_V51_FACTORY_PROGRAMS: NetworkPrograms = {
  cofferPool: new PublicKey("8iQtGj9mcUfFUGaiCpPy89swC3s8YTC8FhVZWfgeZhwu"),
  singleTokenLiquidity: new PublicKey("7BpdUH1tzTSXLuQNo6YpjJ8Eagw8AkrS6cnkxiJdCFS2"),
  protocolAdmin: new PublicKey("3jiojHZbjJQ7QLMGSTjFwxVEmx4NtuRy34nLAmsJME81"),
};

/**
 * Public IDs compiled into the owner-devnet v6.1 candidate (2026-11-02).
 * Deployment, authority and live behavior remain unverified. Select explicitly:
 * getConfig("devnet", { programs: DEVNET_V61_CANDIDATE_PROGRAMS }).
 */
export const DEVNET_V61_CANDIDATE_PROGRAMS: NetworkPrograms = {
  cofferPool: new PublicKey("CVKxMeQbkZKvqSh73BMPKY5Ezq9YRJyczHeZLZLBZ3zV"),
  singleTokenLiquidity: new PublicKey("7BpdUH1tzTSXLuQNo6YpjJ8Eagw8AkrS6cnkxiJdCFS2"),
  protocolAdmin: new PublicKey("HJEiC8TghRX3k1oXkhwhsBBmeP8yyc9XBAhvL6BqP9hU"),
};

/**
 * Devnet stand that runs the v6.1 release candidate (rc9, fresh deployment of 2026-11-24;
 * the earlier upgraded-in-place factory was closed). Select explicitly:
 * getConfig("devnet", { programs: DEVNET_V61_PROGRAMS }).
 */
/** coffer_rewards on the same devnet stand. */
export const DEVNET_V61_REWARDS_PROGRAM_ID = new PublicKey("AWX5kWCVJ6UxBtQceNM6G39sq1n8DjJPSpHbtS345pP7");

export const DEVNET_V61_PROGRAMS: NetworkPrograms = {
  cofferPool: new PublicKey("6dBwFi4fJX2uuQQPvsnjSMF1WRZz2hL1iBGJ2AKfUSem"),
  singleTokenLiquidity: new PublicKey("3z28EafwCzVHGFRXDXDbfhQ3wHA6hMJguHXxaDsmct59"),
  protocolAdmin: new PublicKey("HXNSDFfFhY9mJp8NATAuWSLfp2eFDtRddnPgGoesm8i7"),
  cofferRewards: DEVNET_V61_REWARDS_PROGRAM_ID,
};

/** @deprecated the old name; same value as `DEVNET_V61_PROGRAMS`. */
export const DEVNET_V61_UPGRADED_PROGRAMS: NetworkPrograms = DEVNET_V61_PROGRAMS;

export const DEFAULT_RPC_ENDPOINT: Record<Network, string> = {
  mainnet: "https://solana.drpc.org",
  devnet: "https://api.devnet.solana.com",
  localnet: "http://127.0.0.1:8899",
};

export const DEFAULT_RPC_ENDPOINTS: Record<Network, string[]> = {
  mainnet: [
    "https://solana.drpc.org",
    "https://solana-rpc.publicnode.com",
    "https://solana.api.pocket.network",
  ],
  devnet: ["https://api.devnet.solana.com"],
  localnet: ["http://127.0.0.1:8899"],
};

export const DEFAULT_RPC_TIMEOUT_MS = 2_000;
