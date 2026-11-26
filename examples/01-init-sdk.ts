/**
 * Example 01 — Initialise the SDK for a given network.
 *
 * Run: `npx ts-node examples/01-init-sdk.ts`
 */
import "./env";
import { getConfig, CofferPoolClient, CofferBackendClient } from "../src";
import { PublicKey } from "@solana/web3.js";

const config = getConfig("mainnet", {
  rpcEndpoint: process.env.RPC_URL,
  backendEndpoint: process.env.COFFER_API_URL ?? "https://api.coffer.so",
  slippageHundredthsBps: 50_000, // 5 %
  cuLimit: 1_400_000,
  rpcTimeoutMs: 2_000,
});

console.log("Network:", config.network);
console.log("Programs:", {
  cofferPool: config.programs.cofferPool.toBase58(),
  singleTokenLiquidity: config.programs.singleTokenLiquidity.toBase58(),
});

// Backend client
const backend = new CofferBackendClient({ apiEndpoint: config.backendEndpoint! });
void backend;

// Pool client (substitute a real pool address)
const poolAddr = new PublicKey("EFfVk5qcKBKEQXeWwWjVsnit3YqLNXNENUDW5Fxdfyjy");
const pool = new CofferPoolClient({
  config,
  poolAddress: poolAddr,
});
void pool;
