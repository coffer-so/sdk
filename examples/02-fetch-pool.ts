/**
 * Example 02 — Fetch + parse pool state from chain.
 */
import { CofferPoolClient, getConfig } from "../src";
import { PublicKey } from "@solana/web3.js";

async function main() {
  const cfg = getConfig("devnet");
  const addr = new PublicKey(process.env.POOL_ADDRESS ?? "11111111111111111111111111111111");
  const pool = new CofferPoolClient({
    config: cfg,
    poolAddress: addr,
  });
  const res = await pool.sync();
  if (!res.ok) {
    console.error("sync failed:", res.error);
    process.exit(1);
  }
  const info = res.data;
  console.log("=== pool", info.address.toBase58());
  console.log("tokens:", info.tokenCount);
  for (const t of info.tokens) {
    console.log(
      `  [${t.index}] ${t.metadata?.symbol ?? t.mint.toBase58().slice(0, 4)} ` +
        `w=${(t.weightBps / 100).toFixed(2)}% ` +
        `actBal=${t.actualBalance.toString()} ` +
        `virtBal=${t.virtualBalance.toString()} ` +
        `conc=${t.concentration.toFixed(4)}`
    );
  }
  console.log(
    "swapFeeRate=",
    info.swapFeeRate,
    "protocolFeeRate=",
    info.protocolFeeRate,
    "lpSupply=",
    info.lpTotalSupply.toString()
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
