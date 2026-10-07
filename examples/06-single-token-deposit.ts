/**
 * v6 planned single-token deposit: snapshot → local plan → instruction.
 *
 * Run: npx ts-node examples/06-single-token-deposit.ts <pool> <tokenInIndex> <amountInRaw> [rpc]
 * Nothing is signed or sent; the script prints the plan, the quote and the
 * compiled wire size.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { CubicPoolClient, getConfig } from "../src";

async function main() {
  const [poolArg, indexArg, amountArg, rpc] = process.argv.slice(2);
  if (!poolArg || !indexArg || !amountArg) throw new Error("usage: <pool> <tokenInIndex> <amountInRaw> [rpc]");
  const config = getConfig("mainnet", rpc ? { rpcEndpoints: [rpc] } : {});
  const pool = new CubicPoolClient({ config, poolAddress: new PublicKey(poolArg) });
  const user = Keypair.generate().publicKey; // stand-in wallet

  const synced = await pool.sync();
  if (!synced.ok) throw new Error(synced.error.humanMessage);

  // 1. One bank snapshot, plan and price. `slippageHundredthsBps` 5_000 = 0.5 %.
  const quote = await pool.plannedZap.quote(Number(indexArg), BigInt(amountArg), { slippageHundredthsBps: 5_000, validForSlots: 120 });
  if (!quote.ok) throw new Error(quote.error.humanMessage);
  const q = quote.data;
  console.log("plan allocations:", q.plan.allocations.map(String));
  console.log("estimated BPT:", q.estimatedBpt.toString(), "minimum:", q.minimumBpt.toString());
  console.log("swap legs:", q.economics.swaps.map((s) => `${s.input}->${s.output} gross ${s.grossInput} net out ${s.netOutput} surge ${s.surgeFee}`));
  console.log("dust left in wallet:", q.dustAmounts.map(String));
  console.log(`quotedAt ${q.plan.quotedAt}, valid until slot ${q.plan.validUntilSlot}, epoch ${q.chainEpoch}`);

  // 2. ATAs the program requires (send first if any is missing).
  const setup = pool.plannedZap.ensureUserTokenAccountIxs(q, user);
  console.log("ATA setup instructions:", setup.length);

  // 3. Hook/memo tail, 4. instruction.
  const tail = await pool.plannedZap.resolveExtraAccounts(q, user);
  if (!tail.ok) throw new Error(tail.error.humanMessage);
  const built = pool.plannedZap.buildTx(q, user, tail.data);
  if (!built.ok) throw new Error(built.error.humanMessage);
  console.log("instruction keys:", built.data.instructions[1].keys.length, "data bytes:", built.data.instructions[1].data.length);

  // 5/6. Packet budget with the pool ALT (and a wallet ALT for large pools).
  const poolAlt = await pool.plannedZap.poolLookupTable(synced.data.lookupTable);
  if (!poolAlt.ok) throw new Error(poolAlt.error.humanMessage);
  const compiled = pool.plannedZap.compileTransaction({
    payer: user,
    blockhash: PublicKey.default.toBase58(),
    instructions: built.data.instructions,
    lookupTables: poolAlt.data ? [poolAlt.data] : [],
  });
  if (compiled.ok) console.log(`wire ${compiled.data.wireBytes} bytes, ${compiled.data.remainingBytes} left`);
  else console.log("needs a wallet ALT:", compiled.error.humanMessage, "→", pool.plannedZap.walletLookupAddresses(q, user, tail.data).length, "addresses");
}

main().catch((e) => { console.error(e); process.exit(1); });
