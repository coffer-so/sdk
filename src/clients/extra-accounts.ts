/**
 * Per-instruction transfer legs → remaining-account tail, for the v6
 * swap / add_liquidity / remove_liquidity builders. Only pools holding a
 * Token-2022 mint with an ARMED transfer hook, or a destination that
 * requires memos, produce a non-empty tail; classic pools resolve to `[]`
 * without any RPC read.
 */
import type { AccountMeta, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import { PoolInfo } from "../types/pool";
import { AddLiquidityParams, RemoveLiquidityParams, SwapParams } from "../types/tx";
import { deriveAta } from "../utils/pda";
import { AccountReader, MintSnapshot, resolveTransferExtraAccounts, ResolveTransferExtraAccountsOptions, TransferLeg } from "../utils/transferProfile";
import { calcEffectiveBptBurn, calcTokensOutGivenBptIn } from "../math/cubicMath";

const bi = (v: BN): bigint => BigInt(v.toString());

/** Whether any leg could need a tail at all (saves the RPC round trip). */
function needsResolution(pool: PoolInfo, indices: number[]): boolean {
  return indices.some((i) => pool.tokens[i]?.tokenProgram.equals(TOKEN_2022_PROGRAM_ID));
}

export interface ResolveExtraAccountsParams extends ResolveTransferExtraAccountsOptions {
  /**
   * Mint account snapshots for the pool's Token-2022 mints. Omit to fetch
   * them (one `getMultipleAccountsInfo`); pass the bytes a quote was taken
   * on to keep the tail consistent with that snapshot.
   */
  mintSnapshots?: MintSnapshot[];
}

async function mintSnapshots(reader: AccountReader, pool: PoolInfo, indices: number[], params: ResolveExtraAccountsParams): Promise<MintSnapshot[]> {
  const wanted = indices.filter((i) => pool.tokens[i].tokenProgram.equals(TOKEN_2022_PROGRAM_ID)).map((i) => pool.tokens[i].mint);
  if (params.mintSnapshots) return params.mintSnapshots;
  const infos = await reader.getMultipleAccountsInfo(wanted, params.commitment ?? "confirmed");
  return wanted.map((address, i) => {
    const info = infos[i];
    if (!info) throw new Error(`Mint account missing: ${address.toBase58()}`);
    return { address, owner: info.owner, data: info.data };
  });
}

function coreKeys(pool: PoolInfo, user: PublicKey): PublicKey[] {
  return [user, pool.address, pool.bptMint];
}

/**
 * Tail for `swap`: the user→vault_in transfer of `amountIn` and the
 * vault_out→user transfer of `amountOut` (the quoted vault debit; a hook
 * whose seeds depend on the amount needs the exact value, so pass the
 * quote's `amountOut`, not the slippage floor).
 */
export async function resolveSwapExtraAccounts(
  reader: AccountReader,
  pool: PoolInfo,
  params: Pick<SwapParams, "user" | "tokenInIndex" | "tokenOutIndex" | "amountIn"> & { amountOut: BN },
  options: ResolveExtraAccountsParams = {}
): Promise<AccountMeta[]> {
  const indices = [params.tokenInIndex, params.tokenOutIndex];
  if (!needsResolution(pool, indices)) return [];
  const inTok = pool.tokens[params.tokenInIndex], outTok = pool.tokens[params.tokenOutIndex];
  const legs: TransferLeg[] = [
    { mint: inTok.mint, tokenProgram: inTok.tokenProgram, source: deriveAta(params.user, inTok.mint, inTok.tokenProgram), destination: inTok.vault, authority: params.user, amount: bi(params.amountIn) },
    { mint: outTok.mint, tokenProgram: outTok.tokenProgram, source: outTok.vault, destination: deriveAta(params.user, outTok.mint, outTok.tokenProgram), authority: pool.address, amount: bi(params.amountOut) },
  ];
  return resolveTransferExtraAccounts(reader, legs, await mintSnapshots(reader, pool, indices, options), coreKeys(pool, params.user), options);
}

/**
 * Tail for `add_liquidity`: one user→vault transfer per leg with a positive
 * ceiling. The program debits the grossed-up credit, so pass the quote's
 * `chargedAmounts` as `tokenAmounts` when a hook's seeds depend on the amount.
 */
export async function resolveAddLiquidityExtraAccounts(
  reader: AccountReader,
  pool: PoolInfo,
  params: Pick<AddLiquidityParams, "user" | "tokenAmounts">,
  options: ResolveExtraAccountsParams = {}
): Promise<AccountMeta[]> {
  const indices = params.tokenAmounts.flatMap((a, i) => (a.gt(new BN(0)) ? [i] : []));
  if (!needsResolution(pool, indices)) return [];
  const legs: TransferLeg[] = indices.map((i) => {
    const t = pool.tokens[i];
    return { mint: t.mint, tokenProgram: t.tokenProgram, source: deriveAta(params.user, t.mint, t.tokenProgram), destination: t.vault, authority: params.user, amount: bi(params.tokenAmounts[i]) };
  });
  return resolveTransferExtraAccounts(reader, legs, await mintSnapshots(reader, pool, indices, options), coreKeys(pool, params.user), options);
}

/**
 * Tail for `remove_liquidity`: one vault→user transfer per leg with a
 * positive proportional payout at the synced state.
 */
export async function resolveRemoveLiquidityExtraAccounts(
  reader: AccountReader,
  pool: PoolInfo,
  params: Pick<RemoveLiquidityParams, "user" | "bptAmount">,
  options: ResolveExtraAccountsParams = {}
): Promise<AccountMeta[]> {
  const supply = bi(pool.bptTotalSupply);
  const effective = calcEffectiveBptBurn(bi(params.bptAmount), supply);
  const payouts = calcTokensOutGivenBptIn(pool.tokens.map((t) => bi(t.actualBalance)), effective, supply);
  const indices = payouts.flatMap((p, i) => (p > 0n ? [i] : []));
  if (!needsResolution(pool, indices)) return [];
  const legs: TransferLeg[] = indices.map((i) => {
    const t = pool.tokens[i];
    return { mint: t.mint, tokenProgram: t.tokenProgram, source: t.vault, destination: deriveAta(params.user, t.mint, t.tokenProgram), authority: pool.address, amount: payouts[i] };
  });
  return resolveTransferExtraAccounts(reader, legs, await mintSnapshots(reader, pool, indices, options), coreKeys(pool, params.user), options);
}
