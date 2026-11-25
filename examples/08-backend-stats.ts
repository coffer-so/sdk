/**
 * Example 08 — Fetch statistics from the Coffer backend.
 */
import { CofferBackendClient } from "../src";

async function main() {
  const backend = new CofferBackendClient({ apiEndpoint: "https://api.coffer.so" });

  const pools = await backend.listPools();
  if (!pools.ok) {
    console.error("listPools:", pools.error.humanMessage);
    return;
  }
  const largest = pools.data.sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0))[0];
  console.log("largest pool:", largest?.address, "tvl=", largest?.tvlUsd);

  const tvl = await backend.getStats("tvl", "30d", largest?.address, "usd");
  if (tvl.ok) console.log("tvl series points:", tvl.data.points.length);
  else console.warn("tvl error:", tvl.error);

  const swapVol = await backend.getStats("volume", "30d", largest?.address, "usd");
  if (swapVol.ok) console.log("swap volume points:", swapVol.data.points.length);
}

main().catch(console.error);
