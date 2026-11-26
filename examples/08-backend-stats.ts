/**
 * Example 08 — Fetch statistics from the Coffer backend.
 */
import "./env";
import { CofferBackendClient } from "../src";

async function main() {
  const backend = new CofferBackendClient({ apiEndpoint: process.env.COFFER_API_URL ?? "https://api.coffer.so" });

  const pools = await backend.listPools();
  if (!pools.ok) throw new Error(pools.error.humanMessage);
  if (!pools.data.length) {
    console.log("No pools found");
    return;
  }
  const largest = pools.data.sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0))[0];
  console.log("largest pool:", largest.address, "tvl=", largest.tvlUsd);

  const tvl = await backend.getStats("tvl", "30d", largest.address, "usd");
  if (!tvl.ok) throw new Error(tvl.error.humanMessage);
  console.log("tvl series points:", tvl.data.points.length);

  const swapVol = await backend.getStats("volume", "30d", largest.address, "usd");
  if (!swapVol.ok) throw new Error(swapVol.error.humanMessage);
  console.log("swap volume points:", swapVol.data.points.length);
}

main().catch(e => { console.error(e.message); process.exitCode = 1; });
