/**
 * Example 03 — Quote a swap including slippage + price impact.
 */
import BN from "bn.js";
import { CofferPoolClient, getConfig } from "../src";
import { PublicKey } from "@solana/web3.js";

async function main() {
  const cfg = getConfig("devnet");
  const addr = new PublicKey(process.env.POOL_ADDRESS ?? "11111111111111111111111111111111");
  const pool = new CofferPoolClient({
    config: cfg,
    poolAddress: addr,
  });
  const sync = await pool.sync();
  if (!sync.ok) throw new Error(sync.error.humanMessage);

  const amountIn = new BN(1_000_000_000); // 1 unit @ 9 decimals
  const q = pool.quoteSwap(0, 1, amountIn, 30_000); // 3 % slippage
  if (!q.ok) {
    console.error(q.error);
    process.exit(1);
  }
  const quote = q.data;
  console.log("amountIn       =", quote.amountIn.toString());
  console.log("amountOut      =", quote.amountOut.toString());
  console.log("spotOut        =", quote.spotOut.toString());
  console.log("minAmountOut   =", quote.minAmountOut.toString());
  console.log("feeAmount      =", quote.feeAmount.toString());
  console.log(
    "priceImpact    =",
    (quote.priceImpactHbps / 10_000).toFixed(4) + " %"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
