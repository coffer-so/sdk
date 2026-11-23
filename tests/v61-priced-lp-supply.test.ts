/**
 * Priced LP supply: every join / exit / redemption quote runs on the mint
 * supply net of the vested LP burn stream (`priced_lp_supply`), a burn of the
 * whole priced supply pays no withdraw fee, and the protocol-admin recovery
 * of a stranded STLD helper token account.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import { CofferPoolClient } from "../src/clients/CofferPoolClient";
import { quoteRedeemLpTransferFees } from "../src/clients/lpTransferFee";
import { lpBurnStreamOf, lpTransferFeeDrip, pricedLpSupply, pricedLpSupplyOf } from "../src/math/lpTransferFee";
import { exitWithdrawFeeBps } from "../src/math/liquidityFee";
import { calcEffectiveLpBurn, calcJoinRatioAndLp, calcTokensOutGivenLpIn } from "../src/math/poolMath";
import { MIN_LP_SUPPLY, LP_TRANSFER_FEE_BURN_WINDOW_SECS } from "../src/config";
import { deriveHelperPda, deriveTreasuryPda } from "../src/utils/pda";
import { treasuryVaultPda } from "../src/clients/feeClaim";
import { IDLS } from "../src/idl";
import { mockPool, cfg, pk, bn } from "./helpers/poolFixture";
import type { PoolInfo } from "../src/types/pool";

const clientFor = (pool: PoolInfo): CofferPoolClient => {
  const client = new CofferPoolClient({ config: cfg, poolAddress: pool.address });
  (client as unknown as { cache: PoolInfo }).cache = pool;
  return client;
};
const unwrap = <T>(r: { ok: true; data: T } | { ok: false; error: { code: string; humanMessage: string } }): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.humanMessage}`);
  return r.data;
};
const fail = <T>(r: { ok: true; data: T } | { ok: false; error: { code: string; humanMessage: string } }) => {
  if (r.ok) throw new Error("expected a failure");
  return r.error;
};
const big = (b: BN) => BigInt(b.toString());
const LAST = 1_700_000_000;
const END = LAST + LP_TRANSFER_FEE_BURN_WINDOW_SECS;
const HALF = LAST + LP_TRANSFER_FEE_BURN_WINDOW_SECS / 2;

/** A pool whose LP burn stream holds `pending` LP over `[LAST, END]`, snapshotted at `chainTimestamp`. */
function streamPool(pending: bigint, extra: Parameters<typeof mockPool>[0] = {}, chainTimestamp: number | null = HALF): PoolInfo {
  const pool = mockPool({ ...extra, chainTimestamp: chainTimestamp ?? LAST });
  if (chainTimestamp === null) delete pool.chainTimestamp;
  pool.lpTransferFeesPendingBurn = bn(pending);
  pool.lpTransferFeeBurnLastTs = bn(LAST);
  pool.lpTransferFeeBurnEndTs = bn(pending > 0n ? END : LAST);
  return pool;
}

describe("pricedLpSupply (CofferPool::priced_lp_supply)", () => {
  const stream = { pending: 1_000n, lastTs: 100n, endTs: 200n };
  test("mint supply minus the drip: nothing before the segment, linear floor inside, everything at or after the end", () => {
    expect(pricedLpSupply(10_000n, stream, 100)).toBe(10_000n);
    expect(pricedLpSupply(10_000n, stream, 99)).toBe(10_000n);
    expect(pricedLpSupply(10_000n, stream, 150)).toBe(9_500n);
    expect(pricedLpSupply(10_000n, stream, 101)).toBe(9_990n);
    expect(pricedLpSupply(10_000n, stream, 200)).toBe(9_000n);
    expect(pricedLpSupply(10_000n, stream, 10_000)).toBe(9_000n);
    expect(pricedLpSupply(10_000n, { pending: 0n, lastTs: 0n, endTs: 0n }, 1_700_000_000)).toBe(10_000n);
    for (const now of [0, 101, 150, 199, 200, 999]) {
      expect(pricedLpSupply(10_000n, stream, now)).toBe(10_000n - lpTransferFeeDrip(stream.pending, stream.lastTs, stream.endTs, now));
    }
  });
  test("a drip larger than the mint supply is MathUnderflow; a legacy zeroed triple never subtracts", () => {
    expect(() => pricedLpSupply(999n, stream, 200)).toThrow(/MathUnderflow/);
    expect(pricedLpSupply(1_000n, stream, 200)).toBe(0n);
    expect(pricedLpSupply(5n, { pending: 7n, lastTs: 0n, endTs: 0n }, 0)).toBe(5n);
  });
  test("pricedLpSupplyOf prices a snapshot at its chain clock, at an explicit clock, and refuses a stream without any clock", () => {
    const pool = streamPool(100_000_000_000n);
    expect(pricedLpSupplyOf(pool)).toBe(1_000_000_000_000n - 50_000_000_000n);
    expect(pricedLpSupplyOf(pool, LAST)).toBe(1_000_000_000_000n);
    expect(pricedLpSupplyOf(pool, END)).toBe(900_000_000_000n);
    expect(pricedLpSupplyOf(pool, BigInt(END + 1))).toBe(900_000_000_000n);
    expect(() => pricedLpSupplyOf(streamPool(1n, {}, null))).toThrow(/Chain timestamp missing/);
    expect(pricedLpSupplyOf(streamPool(0n, {}, null))).toBe(1_000_000_000_000n);
    expect(lpBurnStreamOf(pool)).toEqual({ pending: 100_000_000_000n, lastTs: BigInt(LAST), endTs: BigInt(END) });
  });
});

describe("CofferPoolClient quotes on the priced supply", () => {
  test("quoteAddLiquidity: lpGross = floor(priced · ratio); the raw mint supply would over-mint", () => {
    const pool = streamPool(100_000_000_000n);
    const c = clientFor(pool);
    const amounts = [new BN(10_000_000), new BN(10_000_000)];
    const q = unwrap(c.quoteAddLiquidity(amounts));
    const priced = 950_000_000_000n;
    const navs = pool.tokens.map((t) => big(t.actualBalance));
    expect(big(q.lpGross)).toBe(calcJoinRatioAndLp(navs, amounts.map(big), priced).lp);
    expect(big(q.lpGross)).toBeLessThan(calcJoinRatioAndLp(navs, amounts.map(big), 1_000_000_000_000n).lp);
    // An explicit clock re-prices: at the segment start nothing has vested, at the end everything.
    expect(big(unwrap(c.quoteAddLiquidity(amounts, undefined, LAST)).lpGross)).toBe(calcJoinRatioAndLp(navs, amounts.map(big), 1_000_000_000_000n).lp);
    expect(big(unwrap(c.quoteAddLiquidity(amounts, undefined, END)).lpGross)).toBe(calcJoinRatioAndLp(navs, amounts.map(big), 900_000_000_000n).lp);
    expect(fail(c.quoteAddLiquidity(amounts, undefined, -1)).code).toBe("invalid_input");
    // The same snapshot without a stream prices on the mint supply.
    expect(big(unwrap(clientFor(streamPool(0n)).quoteAddLiquidity(amounts)).lpGross)).toBe(calcJoinRatioAndLp(navs, amounts.map(big), 1_000_000_000_000n).lp);
  });
  test("quoteAddLiquidity: a pending stream on a snapshot without a clock is unsupported_pool_state; a fully vested supply is PoolNotSeeded", () => {
    const amounts = [new BN(10_000_000), new BN(10_000_000)];
    expect(fail(clientFor(streamPool(5n, {}, null)).quoteAddLiquidity(amounts)).code).toBe("unsupported_pool_state");
    const vested = streamPool(1_000_000_000_000n, {}, END);
    expect(fail(clientFor(vested).quoteAddLiquidity(amounts)).humanMessage).toMatch(/PoolNotSeeded/);
    expect(fail(clientFor(vested).quoteFundSidelinedToken(vested.poolAdmin!, 0, new BN(1))).humanMessage).toMatch(/PoolNotSeeded/);
  });
  test("quoteRemove: payouts are floor(balance · burn / priced) and the burn is capped against the priced supply", () => {
    const pool = streamPool(100_000_000_000n);
    const c = clientFor(pool);
    const priced = 950_000_000_000n;
    const q = unwrap(c.quoteRemove(new BN(95_000_000_000)));
    const actual = pool.tokens.map((t) => big(t.actualBalance));
    expect(q.tokenOuts.map(big)).toEqual(calcTokensOutGivenLpIn(actual, 95_000_000_000n, priced));
    expect(q.tokenOuts.map(big)).toEqual([100_000_000n, 100_000_000n]);
    // More than the priced supply is InvalidLpAmount even though the mint still holds that many units.
    expect(fail(c.quoteRemove(new BN(960_000_000_000))).humanMessage).toMatch(/InvalidLpAmount/);
    expect(big(unwrap(c.quoteRemove(new BN(950_000_000_000))).effectiveLpIn)).toBe(priced - MIN_LP_SUPPLY);
    expect(fail(c.quoteRemove(new BN(950_000_000_000), END)).humanMessage).toMatch(/InvalidLpAmount/);
    expect(big(unwrap(c.quoteRemove(new BN(900_000_000_000), END)).effectiveLpIn)).toBe(900_000_000_000n - MIN_LP_SUPPLY);
  });
  test("quoteRemove: a burn of the whole (priced) supply pays no withdraw fee; any smaller burn pays it", () => {
    const pool = mockPool({ lpSupply: 1_000n, balances: [[1_000_000n, 2_000_000n], [1_000_000n, 2_000_000n]], withdrawFeeBps: 100 });
    const c = clientFor(pool);
    const full = unwrap(c.quoteRemove(new BN(1_000)));
    expect(big(full.effectiveLpIn)).toBe(1_000n);
    expect(full.withdrawFeeBps).toBe(0);
    expect(full.withdrawFeeAmounts.map(big)).toEqual([0n, 0n]);
    expect(full.tokenOuts.map(big)).toEqual([1_000_000n, 1_000_000n]);
    const partial = unwrap(c.quoteRemove(new BN(500)));
    expect(partial.withdrawFeeBps).toBe(100);
    expect(partial.withdrawFeeAmounts.map(big)).toEqual([5_000n, 5_000n]);
    expect(partial.tokenOuts.map(big)).toEqual([495_000n, 495_000n]);
    // Above the floor the burn is capped at supply − MIN_LP_SUPPLY, so it never equals the supply and always pays.
    const above = clientFor(mockPool({ lpSupply: 2_000n, balances: [[1_000_000n, 2_000_000n], [1_000_000n, 2_000_000n]], withdrawFeeBps: 100 }));
    const capped = unwrap(above.quoteRemove(new BN(2_000)));
    expect(big(capped.effectiveLpIn)).toBe(1_000n); expect(capped.withdrawFeeBps).toBe(100); expect(capped.withdrawFeeAmounts.map(big)).toEqual([5_000n, 5_000n]);
    // The whole priced supply at the floor with a vested stream behind it.
    const stream = streamPool(500n, { lpSupply: 1_500n, balances: [[1_000_000n, 2_000_000n], [1_000_000n, 2_000_000n]], withdrawFeeBps: 100 }, END);
    const vested = unwrap(clientFor(stream).quoteRemove(new BN(1_000)));
    expect(big(vested.effectiveLpIn)).toBe(1_000n); expect(vested.withdrawFeeBps).toBe(0); expect(vested.tokenOuts.map(big)).toEqual([1_000_000n, 1_000_000n]);
    expect(exitWithdrawFeeBps(100, 1_000n, 1_000n)).toBe(0); expect(exitWithdrawFeeBps(100, 999n, 1_000n)).toBe(100);
    expect(exitWithdrawFeeBps(100, calcEffectiveLpBurn(2_000n, 2_000n), 2_000n)).toBe(100);
  });
  test("quoteRedeemLpTransferFees prices the protocol redemption like an exit", () => {
    const pool = streamPool(100_000_000_000n);
    pool.lpTokenProgram = TOKEN_2022_PROGRAM_ID;
    pool.lpTransferFeesOwedProtocol = bn(95_000_000_000n);
    const q = quoteRedeemLpTransferFees(pool);
    expect(q.tokenAmounts).toEqual([100_000_000n, 100_000_000n]);
    expect(q.streamBurnNow).toBe(0n);
    const atEnd = quoteRedeemLpTransferFees(pool, { now: END });
    expect(atEnd.tokenAmounts).toEqual(calcTokensOutGivenLpIn([1_000_000_000n, 1_000_000_000n], 95_000_000_000n, 900_000_000_000n));
    expect(atEnd.streamBurnNow).toBe(100_000_000_000n);
    // The MIN_LP_SUPPLY clamp is against the priced supply.
    const tiny = streamPool(500n, { lpSupply: 2_000n }, END);
    tiny.lpTokenProgram = TOKEN_2022_PROGRAM_ID; tiny.lpTransferFeesOwedProtocol = bn(1_500n);
    expect(quoteRedeemLpTransferFees(tiny).lpBurn).toBe(1_500n - MIN_LP_SUPPLY);
    expect(quoteRedeemLpTransferFees(tiny, { now: LAST }).lpBurn).toBe(1_000n);
  });
});

describe("AdminClient.stldCloseHelperTokenAccountIx", () => {
  test("accounts in IDL order, helper and Treasury vault derived, tail appended read-only or writable but never signing", async () => {
    const { AnchorProvider, Wallet } = await import("@coral-xyz/anchor");
    const { Connection } = await import("@solana/web3.js");
    const { AdminClient } = await import("../src/clients/AdminClient");
    const admin = Keypair.generate();
    const client = new AdminClient({ config: cfg, provider: new AnchorProvider(new Connection("http://127.0.0.1:8899"), new Wallet(admin), {}) });
    const config = pk(), pool = pk(), tokenAccount = pk(), mint = pk(), hookExtra = pk();
    const ix = client.stldCloseHelperTokenAccountIx(admin.publicKey, config, pool, tokenAccount, mint, TOKEN_2022_PROGRAM_ID, [{ pubkey: hookExtra, isSigner: false, isWritable: true }]);
    const schema = IDLS.protocolAdmin.instructions.find((i) => i.name === "stld_close_helper_token_account")!;
    expect(ix.programId.equals(cfg.programs.protocolAdmin)).toBe(true);
    expect(ix.data).toEqual(Buffer.from(schema.discriminator));
    const [treasury] = deriveTreasuryPda(cfg.programs.protocolAdmin);
    const [helper] = deriveHelperPda(cfg.programs.singleTokenLiquidity, pool);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      treasury, admin.publicKey, config, pool, helper, tokenAccount, mint, treasuryVaultPda(mint, cfg.programs.protocolAdmin), TOKEN_2022_PROGRAM_ID, cfg.programs.singleTokenLiquidity, hookExtra,
    ].map((k) => k.toBase58()));
    expect(ix.keys.map((k) => k.isWritable)).toEqual([true, false, false, false, false, true, true, true, false, false, true]);
    expect(ix.keys.map((k) => k.isSigner)).toEqual([false, true, false, false, false, false, false, false, false, false, false]);
    expect(schema.accounts.map((a: any) => [!!a.writable, !!a.signer])).toEqual(ix.keys.slice(0, 10).map((k) => [k.isWritable, k.isSigner]));
    expect(client.stldCloseHelperTokenAccountIx(admin.publicKey, config, pool, tokenAccount, mint).keys[8].pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(() => client.stldCloseHelperTokenAccountIx(admin.publicKey, config, pool, tokenAccount, mint, TOKEN_PROGRAM_ID, [{ pubkey: hookExtra, isSigner: true, isWritable: false }])).toThrow(/cannot be signers/);
  });
});

describe("set_supervisor", () => {
  test("carries only treasury and admin", async () => {
    const { AnchorProvider, Wallet } = await import("@coral-xyz/anchor");
    const { Connection } = await import("@solana/web3.js");
    const { AdminClient } = await import("../src/clients/AdminClient");
    const admin = Keypair.generate();
    const client = new AdminClient({ config: cfg, provider: new AnchorProvider(new Connection("http://127.0.0.1:8899"), new Wallet(admin), {}) });
    const ix = await client.setSupervisorIx(admin.publicKey, PublicKey.default);
    expect(ix.keys).toHaveLength(2);
    expect(ix.keys[0].pubkey.equals(deriveTreasuryPda(cfg.programs.protocolAdmin)[0])).toBe(true);
    expect(ix.keys[1].pubkey.equals(admin.publicKey)).toBe(true); expect(ix.keys[1].isSigner).toBe(true);
  });
});
