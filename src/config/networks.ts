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
    // v5 test copy deployed on devnet (fresh program IDs under our wallet;
    // the original devnet CVKx/HJEi IDs have a non-ours upgrade authority).
    cubicPool: new PublicKey("E6YAKuLAd8vBgJnXsVdPCFCdgUef6ZinfDst3JMxuhJJ"),
    // stld NOT deployed on the devnet copy — placeholder (single-token
    // deposit is disabled on devnet). Replace if/when stld ships here.
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
