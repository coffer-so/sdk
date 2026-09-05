import { PublicKey } from "@solana/web3.js";

export type Network = "mainnet" | "devnet" | "localnet";

export interface NetworkPrograms {
  cubicPool: PublicKey;
  singleTokenLiquidity: PublicKey;
  protocolAdmin: PublicKey;
}

export const NETWORK_PROGRAMS: Record<Network, NetworkPrograms> = {
  mainnet: {
    cubicPool: new PublicKey("8iQtGj9mcUfFUGaiCpPy89swC3s8YTC8FhVZWfgeZhwu"),
    // TODO(mainnet): single_token_liquidity is NOT deployed on mainnet — this
    // is the devnet program ID as a placeholder. Single-token deposit is
    // disabled in the frontend. If/when stld ships on mainnet, replace this
    // with the real mainnet program ID.
    singleTokenLiquidity: new PublicKey(
      "7BpdUH1tzTSXLuQNo6YpjJ8Eagw8AkrS6cnkxiJdCFS2",
    ),
    protocolAdmin: new PublicKey(
      "3jiojHZbjJQ7QLMGSTjFwxVEmx4NtuRy34nLAmsJME81",
    ),
  },
  devnet: {
    // v5.1 (post-audit) copy deployed on devnet under our wallet. The original
    // devnet CVKx/HJEi IDs are unusable: cubic_pool's was closed permanently
    // and protocol_admin's has a non-ours upgrade authority.
    //
    // These binaries are built with devnet `declare_id`s AND a devnet
    // `PROTOCOL_ADMIN_PROGRAM_ID` — cubic_pool pins that constant at compile
    // time to derive the Treasury PDA, so a mainnet build would look for a
    // Treasury that does not exist here.
    cubicPool: new PublicKey("E6YAKuLAd8vBgJnXsVdPCFCdgUef6ZinfDst3JMxuhJJ"),
    // stld IS deployed on devnet and shares its ID with mainnet, because its
    // `declare_id` needed no devnet override.
    singleTokenLiquidity: new PublicKey(
      "7BpdUH1tzTSXLuQNo6YpjJ8Eagw8AkrS6cnkxiJdCFS2",
    ),
    protocolAdmin: new PublicKey(
      "6bFDi7RrLJSbhBpJ2AjHAQfbzBiHGXQXND7no8gv8gux",
    ),
  },
  localnet: {
    cubicPool: new PublicKey("8iQtGj9mcUfFUGaiCpPy89swC3s8YTC8FhVZWfgeZhwu"),
    singleTokenLiquidity: new PublicKey(
      "7BpdUH1tzTSXLuQNo6YpjJ8Eagw8AkrS6cnkxiJdCFS2",
    ),
    protocolAdmin: new PublicKey(
      "3jiojHZbjJQ7QLMGSTjFwxVEmx4NtuRy34nLAmsJME81",
    ),
  },
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
