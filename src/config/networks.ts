import { PublicKey } from "@solana/web3.js";

export type Network = "mainnet" | "devnet" | "localnet";

export interface NetworkPrograms {
  cofferPool: PublicKey;
  singleTokenLiquidity: PublicKey;
  protocolAdmin: PublicKey;
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
