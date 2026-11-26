/**
 * lpTransferFee — builders for the LP transfer fee feature (2026-11-19):
 * the Token-2022 `TransferFeeConfig` every new pool's LP mint carries
 * (both authorities = the pool PDA, `maximum_fee = u64::MAX`).
 *
 * | instruction | program | signer | gate |
 * |---|---|---|---|
 * | `set_lp_transfer_fee(bps)` | coffer_pool | `pool.pool_admin` | D-class (I-1): direct at `pool_admin_delay_secs == 0`, else kind-11 queue; ≤ 10 %; refused for ever once `lock_liquidity_fees` ran |
 * | `propose_pool_action(SetLpTransferFee { bps })` / `cancel_pool_action(11)` | coffer_pool | `pool.pool_admin` | the kind-11 queue (`PoolActions.setLpTransferFee`) |
 * | `execute_set_lp_transfer_fee` | coffer_pool | `pool.pool_admin` | ready kind-11 slot; same accounts as the direct setter; re-checks the lock |
 * | `set_lp_transfer_fee_protocol_share(bps)` | coffer_pool | `config.protocol_admin` (Treasury PDA — CPI only) | ≤ 100 % |
 * | `pool_set_lp_transfer_fee_protocol_share(bps)` | protocol_admin | `Treasury.admin` | D-class: direct at `delay_secs == 0`, else kind-15 queue |
 * | `execute_pool_set_lp_transfer_fee_protocol_share` | protocol_admin | `Treasury.admin` | ready kind-15 slot (`sha256(pool)[..16]` pin) |
 * | `collect_lp_transfer_fees` | coffer_pool | none (permissionless) | sweeps withheld LP into `ATA(pool, lp_mint)`, burns what the 24 h stream released, queues the non-protocol part (L-1) |
 * | `redeem_lp_transfer_fees` | coffer_pool | `config.protocol_admin` (CPI only) | burns the protocol's LP for the underlying; never the pending stream |
 * | `pool_redeem_lp_transfer_fees` | protocol_admin | `Treasury.admin` | instant; recipients pinned to the Treasury vault PDAs |
 *
 * The LP fee account `ATA(pool PDA, lp_mint, Token-2022)` is created
 * permissionlessly (idempotent ATA create; `buildCollectLpTransferFeesTx`
 * prepends it). A pre-feature LP mint (no extension) fails every one of
 * these with `LpTransferFeeUnsupported` (6112). Invariant after every
 * collect: `lp_fee_account.amount == lp_transfer_fees_owed_protocol +
 * lp_transfer_fees_pending_burn`.
 */
import { ComputeBudgetProgram, PublicKey, TransactionInstruction, type AccountMeta, type Commitment, type Connection } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, type TransferFeeConfig } from "@solana/spl-token";
import { sha256 } from "@noble/hashes/sha256";
import BN from "bn.js";
import { CofferConfig, MIN_LP_SUPPLY } from "../config";
import { COFFER_POOL_IDL, PROTOCOL_ADMIN_IDL } from "../idl";
import { MathError } from "../math/fixedPoint";
import { calcEffectiveLpBurn, calcTokensOutGivenLpIn } from "../math/poolMath";
import { lpBurnStreamOf, lpTransferFeeDrip, pricedLpSupplyOf, validateLpTransferFeeBps, validateLpTransferFeeProtocolShareBps } from "../math/lpTransferFee";
import { POOL_ACTION_KIND } from "../parsers/layout";
import { decodeMintAccount } from "../parsers/mintAccount";
import type { PoolInfo } from "../types/pool";
import type { BuiltTx } from "../types/tx";
import type { MintAccountReader } from "../utils/lpMetadata";
import { deriveAta, deriveLpMint, deriveTreasuryPda } from "../utils/pda";
import { buildContractInstruction } from "./contract-instructions";
import { PoolActions, buildCancelPoolActionIx, buildExecutePoolActionIx, buildProposePoolActionIx } from "./cooldown";
import { treasuryVaultPda } from "./feeClaim";

// ─── Discriminators (pinned in contracts idl/abi-pins.json `addedInstructions`) ──

const PINS = {
  set_lp_transfer_fee: "da8162567b51dd69",
  execute_set_lp_transfer_fee: "e35b25e5e4e08a9b",
  set_lp_transfer_fee_protocol_share: "634341a9d2099cb2",
  collect_lp_transfer_fees: "1433ed8b8eea4644",
  redeem_lp_transfer_fees: "33b96e8af96ebb32",
  pool_set_lp_transfer_fee_protocol_share: "445ed675b1b305ff",
  execute_pool_set_lp_transfer_fee_protocol_share: "0403cae680edac1f",
  pool_redeem_lp_transfer_fees: "c40538f8c88d25f7",
} as const;

function disc(idl: { instructions: unknown }, name: keyof typeof PINS): Buffer {
  const ix = (idl.instructions as Array<{ name: string; discriminator: number[] }>).find((i) => i.name === name);
  if (!ix) throw new Error(`lpTransferFee: no "${name}" instruction in the IDL`);
  const bytes = Buffer.from(ix.discriminator);
  if (bytes.toString("hex") !== PINS[name]) {
    throw new Error(`lpTransferFee: IDL discriminator for "${name}" is ${bytes.toString("hex")}, pinned value is ${PINS[name]}`);
  }
  return bytes;
}

/** Verified at load so a bad IDL copy fails at import time, never as `InstructionFallbackNotFound` on chain. */
export const LP_TRANSFER_FEE_DISC = {
  setLpTransferFee: disc(COFFER_POOL_IDL, "set_lp_transfer_fee"),
  executeSetLpTransferFee: disc(COFFER_POOL_IDL, "execute_set_lp_transfer_fee"),
  setLpTransferFeeProtocolShare: disc(COFFER_POOL_IDL, "set_lp_transfer_fee_protocol_share"),
  collectLpTransferFees: disc(COFFER_POOL_IDL, "collect_lp_transfer_fees"),
  redeemLpTransferFees: disc(COFFER_POOL_IDL, "redeem_lp_transfer_fees"),
  poolSetLpTransferFeeProtocolShare: disc(PROTOCOL_ADMIN_IDL, "pool_set_lp_transfer_fee_protocol_share"),
  executePoolSetLpTransferFeeProtocolShare: disc(PROTOCOL_ADMIN_IDL, "execute_pool_set_lp_transfer_fee_protocol_share"),
  poolRedeemLpTransferFees: disc(PROTOCOL_ADMIN_IDL, "pool_redeem_lp_transfer_fees"),
};

const w = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
const r = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });

// ─── Derivations ─────────────────────────────────────────────────────────────

/**
 * The pool's LP fee account: `ATA(pool PDA, lp_mint, Token-2022)` (owner off
 * curve — the ATA derivation does not care). Owned by the pool PDA, which
 * is the burn / redeem authority; holds the protocol's collected LP
 * (`lp_transfer_fees_owed_protocol`) between collections and redemptions.
 */
export function deriveLpFeeAccount(pool: PublicKey, lpMint: PublicKey): PublicKey {
  return deriveAta(pool, lpMint, TOKEN_2022_PROGRAM_ID);
}

/** LP mint PDA + LP fee account of `pool` under `cfg.programs.cofferPool`. */
export function lpFeeAccountsOf(cfg: CofferConfig, pool: PublicKey): { lpMint: PublicKey; lpFeeAccount: PublicKey } {
  const [lpMint] = deriveLpMint(cfg.programs.cofferPool, pool);
  return { lpMint, lpFeeAccount: deriveLpFeeAccount(pool, lpMint) };
}

/**
 * `Treasury::pool_tag`: `sha256(pool)[..16]`, the pool pin of the compact
 * kind-15 slot (`pending_pool_set_lp_transfer_fee_protocol_share.pool_tag`).
 * Compare with `RawTreasuryAccount.pendingActions[15].payload.poolTag`
 * (hex) to learn which pool a pending share change targets.
 */
export function treasuryPoolTag(pool: PublicKey): Buffer {
  return Buffer.from(sha256(pool.toBuffer())).subarray(0, 16);
}

/** `treasuryPoolTag` as the hex string the Treasury decoder exposes. */
export function treasuryPoolTagHex(pool: PublicKey): string {
  return treasuryPoolTag(pool).toString("hex");
}

// ─── Reading the LP mint's TransferFeeConfig ─────────────────────────────────

/** The LP mint's `TransferFeeConfig` from its raw account bytes; `null` without the extension (a plain SPL / pre-feature mint decodes too). */
export function readLpTransferFeeConfig(mintData: Buffer): TransferFeeConfig | null {
  return decodeMintAccount(mintData).transferFeeConfig;
}

/** What `fetchLpTransferFeeConfig` returns. */
export interface FetchedLpTransferFeeConfig {
  /** `null` for a pre-feature LP mint — every `*_lp_transfer_fee*` instruction fails with `LpTransferFeeUnsupported` (6112). */
  config: TransferFeeConfig | null;
  /** Owner of the mint (SPL Token or Token-2022). */
  tokenProgram: PublicKey;
  supply: bigint;
}

/**
 * Read an LP mint's `TransferFeeConfig` (both schedules, withheld amount,
 * authorities). Throws when the account is missing or is not a token mint.
 */
export async function fetchLpTransferFeeConfig(
  connection: MintAccountReader | Connection,
  lpMint: PublicKey,
  commitment: Commitment = "confirmed",
): Promise<FetchedLpTransferFeeConfig> {
  const info = await connection.getAccountInfo(lpMint, commitment);
  if (!info) throw new Error(`LP mint ${lpMint.toBase58()} does not exist`);
  const mint = decodeMintAccount(info.data);
  return {
    config: info.owner.equals(TOKEN_2022_PROGRAM_ID) ? mint.transferFeeConfig : null,
    tokenProgram: info.owner,
    supply: BigInt(mint.supply.toString()),
  };
}

/** `true` iff the snapshot says the LP mint carries the fee extension (unknown ⇒ `true`: let the program decide). */
export function lpTransferFeeSupported(pool: Pick<PoolInfo, "lpTransferFeeConfig" | "lpTokenProgram">): boolean {
  if (pool.lpTokenProgram && !pool.lpTokenProgram.equals(TOKEN_2022_PROGRAM_ID)) return false;
  return pool.lpTransferFeeConfig !== null;
}

function requireLpTransferFeeSupported(pool: Pick<PoolInfo, "lpTransferFeeConfig" | "lpTokenProgram" | "address">, op: string): void {
  if (!lpTransferFeeSupported(pool)) {
    throw new Error(`${op}: LP mint of pool ${pool.address.toBase58()} has no transfer fee extension (LpTransferFeeUnsupported, 6112)`);
  }
}

function requirePoolKey(pool: PoolInfo | PublicKey): PublicKey {
  return pool instanceof PublicKey ? pool : pool.address;
}

// ─── set_lp_transfer_fee (pool admin, coffer_pool; D-class, kind 11) ─────────

export interface SetLpTransferFeeParams {
  /** Pool PDA or a synced snapshot (the snapshot is checked for the extension / admin / lock / cooldown). */
  pool: PoolInfo | PublicKey;
  /** Must be `pool.pool_admin` (`Unauthorized`; `PoolAdminDisabled` once renounced). */
  authority: PublicKey;
  /** New rate, `0..=1_000` bps (10 %). Token-2022 applies it two epochs later. */
  bps: number;
  /** LP mint PDA; derived from the pool when omitted. */
  lpMint?: PublicKey;
}

/** Pool-admin cooldown kind of `SetLpTransferFee` (11): `cancel_pool_action` arg, `pending_actions_mask` bit, `PoolActionProposed.kind`. */
export const SET_LP_TRANSFER_FEE_KIND = POOL_ACTION_KIND.SetLpTransferFee;

/** Snapshot pre-checks shared by the direct setter, the proposal and the execute (same refusals the program makes, in its order). */
function requireLpTransferFeeAdmin(pool: PoolInfo | PublicKey, authority: PublicKey, op: string): void {
  if (pool instanceof PublicKey) return;
  if (pool.poolAdmin) {
    if (pool.poolAdmin.equals(PublicKey.default)) throw new Error(`${op}: PoolAdminDisabled (6033)`);
    if (!pool.poolAdmin.equals(authority)) throw new Error(`${op}: authority must be the pool admin (Unauthorized, 6018)`);
  }
  if (pool.liquidityFeesLocked) throw new Error(`${op}: the liquidity fees are locked for ever (LiquidityFeesLocked, 6084)`);
  requireLpTransferFeeSupported(pool, op);
}

/**
 * `set_lp_transfer_fee(bps)` — `[pool w, lp_mint w, authority s, lp_token_program]`,
 * data = disc + u16. D-class since I-1: direct only while
 * `pool_admin_delay_secs == 0` (`CooldownRequired` 6089 otherwise — use
 * `buildProposeSetLpTransferFeeIx` → `buildExecuteSetLpTransferFeeIx`, kind
 * 11). Refused once `lock_liquidity_fees` ran (`LiquidityFeesLocked`). Check
 * order on chain: cooldown → lock → cap → extension. Token-2022's two-epoch
 * activation adds its own notice on top of the delay.
 */
export function buildSetLpTransferFeeIx(cfg: CofferConfig, params: SetLpTransferFeeParams): TransactionInstruction {
  validateLpTransferFeeBps(params.bps);
  const poolKey = requirePoolKey(params.pool);
  if (!(params.pool instanceof PublicKey) && (params.pool.poolAdminDelaySecs ?? 0) > 0) {
    throw new Error(`set_lp_transfer_fee: pool_admin_delay_secs is ${params.pool.poolAdminDelaySecs} — direct path closed (CooldownRequired, 6089); propose PoolActions.setLpTransferFee (kind 11) and execute after the delay`);
  }
  requireLpTransferFeeAdmin(params.pool, params.authority, "set_lp_transfer_fee");
  const lpMint = params.lpMint ?? deriveLpMint(cfg.programs.cofferPool, poolKey)[0];
  return buildContractInstruction(cfg, "cofferPool", "set_lp_transfer_fee", { bps: params.bps }, {
    pool: poolKey, lp_mint: lpMint, authority: params.authority, lp_token_program: TOKEN_2022_PROGRAM_ID,
  });
}

/**
 * `propose_pool_action(SetLpTransferFee { bps })` — `[pool w, authority s]`,
 * Borsh tag 10 = kind 11. One live slot per kind (re-proposing overwrites);
 * `eta = now + pool_admin_delay_secs`; the program checks the lock and the
 * cap at proposal time and again at execution. Works at delay 0 too.
 */
export function buildProposeSetLpTransferFeeIx(cfg: CofferConfig, params: Omit<SetLpTransferFeeParams, "lpMint">): TransactionInstruction {
  requireLpTransferFeeAdmin(params.pool, params.authority, "propose_pool_action(SetLpTransferFee)");
  return buildProposePoolActionIx(cfg, requirePoolKey(params.pool), params.authority, PoolActions.setLpTransferFee(params.bps));
}

/** `cancel_pool_action(11)` — `[pool w, authority s]`; `NoPendingAction` when the slot is empty. */
export function buildCancelSetLpTransferFeeIx(cfg: CofferConfig, pool: PoolInfo | PublicKey, authority: PublicKey): TransactionInstruction {
  return buildCancelPoolActionIx(cfg, requirePoolKey(pool), authority, SET_LP_TRANSFER_FEE_KIND);
}

/**
 * `execute_set_lp_transfer_fee()` for a ready kind-11 slot — `[pool w,
 * lp_mint w, authority s, lp_token_program]`, no args (the stored `bps` is
 * applied). `CooldownNotElapsed` before `eta`, `ActionExpired` after the
 * 14-day grace, `LiquidityFeesLocked` if the lock landed in between. Emits
 * `LpTransferFeeUpdated` then `PoolActionExecuted`.
 */
export function buildExecuteSetLpTransferFeeIx(cfg: CofferConfig, params: Omit<SetLpTransferFeeParams, "bps">): TransactionInstruction {
  requireLpTransferFeeAdmin(params.pool, params.authority, "execute_set_lp_transfer_fee");
  const poolKey = requirePoolKey(params.pool);
  if (params.lpMint === undefined) return buildExecutePoolActionIx(cfg, poolKey, params.authority, SET_LP_TRANSFER_FEE_KIND);
  return buildContractInstruction(cfg, "cofferPool", "execute_set_lp_transfer_fee", {}, {
    pool: poolKey, lp_mint: params.lpMint, authority: params.authority, lp_token_program: TOKEN_2022_PROGRAM_ID,
  });
}

// ─── set_lp_transfer_fee_protocol_share (protocol admin) ─────────────────────

/**
 * Raw `coffer_pool::set_lp_transfer_fee_protocol_share(bps)` —
 * `[config, pool w, authority s]`, `authority` = `config.protocol_admin`
 * (the Treasury PDA; no wallet can sign it — the callable route is
 * `buildPoolSetLpTransferFeeProtocolShareIx` / `AdminClient`). Kept for the
 * wire format. `0..=10_000` bps; never retroactive.
 */
export function buildSetLpTransferFeeProtocolShareIx(cfg: CofferConfig, config: PublicKey, pool: PublicKey, authority: PublicKey, bps: number): TransactionInstruction {
  validateLpTransferFeeProtocolShareBps(bps);
  return buildContractInstruction(cfg, "cofferPool", "set_lp_transfer_fee_protocol_share", { bps }, { config, pool, authority });
}

export interface PoolSetLpTransferFeeProtocolShareParams {
  /** `Treasury.admin` (signer). */
  admin: PublicKey;
  /** `CofferPoolConfig` the pool belongs to. */
  config: PublicKey;
  pool: PublicKey;
  /** `0..=10_000` bps. */
  bps: number;
}

/**
 * `protocol_admin::pool_set_lp_transfer_fee_protocol_share(bps)` —
 * `[treasury, admin s, config, pool w, coffer_pool_program]`. D-class:
 * direct only while `Treasury.delay_secs == 0` (`CooldownRequired`
 * otherwise — queue `ProtocolActions.poolSetLpTransferFeeProtocolShare`,
 * kind 15). Emits `PoolLpTransferFeeProtocolShareSet` (old read pre-CPI).
 */
export function buildPoolSetLpTransferFeeProtocolShareIx(cfg: CofferConfig, p: PoolSetLpTransferFeeProtocolShareParams): TransactionInstruction {
  validateLpTransferFeeProtocolShareBps(p.bps);
  const [treasury] = deriveTreasuryPda(cfg.programs.protocolAdmin);
  return buildContractInstruction(cfg, "protocolAdmin", "pool_set_lp_transfer_fee_protocol_share", { bps: p.bps }, {
    treasury, admin: p.admin, config: p.config, pool: p.pool, coffer_pool_program: cfg.programs.cofferPool,
  });
}

/**
 * `execute_pool_set_lp_transfer_fee_protocol_share` for a ready kind-15
 * slot — `[treasury w, admin s, config, pool w, coffer_pool_program]`. The
 * passed pool must hash to the slot's `pool_tag` (`treasuryPoolTag`); the
 * stored `bps` is applied.
 */
export function buildExecutePoolSetLpTransferFeeProtocolShareIx(cfg: CofferConfig, p: Omit<PoolSetLpTransferFeeProtocolShareParams, "bps">): TransactionInstruction {
  const [treasury] = deriveTreasuryPda(cfg.programs.protocolAdmin);
  return buildContractInstruction(cfg, "protocolAdmin", "execute_pool_set_lp_transfer_fee_protocol_share", {}, {
    treasury, admin: p.admin, config: p.config, pool: p.pool, coffer_pool_program: cfg.programs.cofferPool,
  });
}

// ─── collect_lp_transfer_fees (permissionless) ───────────────────────────────

export interface CollectLpTransferFeesParams {
  /** Pool PDA or a synced snapshot. */
  pool: PoolInfo | PublicKey;
  /** LP mint PDA; derived when omitted. */
  lpMint?: PublicKey;
  /**
   * LP token accounts whose withheld fees to sweep (`WithdrawWithheldTokensFromAccounts`),
   * any owner, any number (transaction size permitting). Token-2022 refuses
   * an account of another mint. The mint's own `withheld_amount` (filled by
   * anyone's `HarvestWithheldTokensToMint`) is swept regardless.
   */
  sources?: PublicKey[];
}

/**
 * `collect_lp_transfer_fees()` — `[pool w, lp_mint w, lp_fee_account w,
 * lp_token_program]` + remaining = the writable `sources`. The LP fee
 * account must exist (`buildCollectLpTransferFeesTx` creates it
 * idempotently). Not gated on `pool_enabled`; emits `LpTransferFeesCollected`.
 * Burns only what the stream released since the last collect
 * (`quoteLpTransferFeeBurnStream`); the new collection's burn part is queued.
 */
export function buildCollectLpTransferFeesIx(cfg: CofferConfig, params: CollectLpTransferFeesParams): TransactionInstruction {
  const poolKey = requirePoolKey(params.pool);
  if (!(params.pool instanceof PublicKey)) requireLpTransferFeeSupported(params.pool, "collect_lp_transfer_fees");
  const lpMint = params.lpMint ?? deriveLpMint(cfg.programs.cofferPool, poolKey)[0];
  const lpFeeAccount = deriveLpFeeAccount(poolKey, lpMint);
  const seen = new Set<string>();
  const remaining: AccountMeta[] = [];
  for (const source of params.sources ?? []) {
    const key = source.toBase58();
    if (seen.has(key)) throw new Error(`collect_lp_transfer_fees: duplicate source ${key}`);
    if (source.equals(lpFeeAccount)) throw new Error("collect_lp_transfer_fees: the LP fee account is the destination, not a source");
    seen.add(key);
    remaining.push(w(source));
  }
  return buildContractInstruction(cfg, "cofferPool", "collect_lp_transfer_fees", {}, {
    pool: poolKey, lp_mint: lpMint, lp_fee_account: lpFeeAccount, lp_token_program: TOKEN_2022_PROGRAM_ID,
  }, remaining);
}

export interface CollectLpTransferFeesTxParams extends CollectLpTransferFeesParams {
  /** Fee payer; funds the LP fee account's rent when it is created. */
  payer: PublicKey;
  /** `true` (default): prepend the idempotent ATA create of the LP fee account. */
  createFeeAccount?: boolean;
  /** CU limit; default scales with the source count. */
  computeUnitLimit?: number;
}

/** Idempotent LP fee account create (`ATA(pool, lp_mint, Token-2022)`, payer-funded) — anyone may run it. */
export function buildCreateLpFeeAccountIx(cfg: CofferConfig, pool: PublicKey, payer: PublicKey, lpMint?: PublicKey): TransactionInstruction {
  const mint = lpMint ?? deriveLpMint(cfg.programs.cofferPool, pool)[0];
  return createAssociatedTokenAccountIdempotentInstruction(payer, deriveLpFeeAccount(pool, mint), pool, mint, TOKEN_2022_PROGRAM_ID);
}

/** `[ComputeBudget, (idempotent fee-account create), collect_lp_transfer_fees]`. */
export function buildCollectLpTransferFeesTx(cfg: CofferConfig, params: CollectLpTransferFeesTxParams): BuiltTx {
  const poolKey = requirePoolKey(params.pool);
  const lpMint = params.lpMint ?? deriveLpMint(cfg.programs.cofferPool, poolKey)[0];
  const units = params.computeUnitLimit ?? Math.min(1_400_000, 100_000 + 20_000 * (params.sources?.length ?? 0));
  const instructions: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units })];
  if (params.createFeeAccount !== false) instructions.push(buildCreateLpFeeAccountIx(cfg, poolKey, params.payer, lpMint));
  instructions.push(buildCollectLpTransferFeesIx(cfg, { ...params, lpMint }));
  return { instructions, suggestedCuLimit: units };
}

// ─── redeem_lp_transfer_fees (protocol admin) ────────────────────────────────

/**
 * The `remove_liquidity`-shaped block: `[vault_i, recipient_i]×n, mint×n,
 * token_program×n` + the Token-2022 tail (hook extras / memo). No native
 * hook slice: the protocol path runs no hook. `recipients[i]` must be a
 * token account of `mint_i` under `token_program_i` (the wrapper pins it to
 * the Treasury vault PDA); every slot gets one, zero-payout slots included.
 */
export function redeemLpTransferFeesRemainingAccounts(pool: PoolInfo, recipients: PublicKey[], tail: AccountMeta[] = []): AccountMeta[] {
  if (recipients.length !== pool.tokenCount) {
    throw new Error(`redeem_lp_transfer_fees: recipients length (${recipients.length}) must equal the pool's token count (${pool.tokenCount})`);
  }
  const remaining: AccountMeta[] = [];
  for (let i = 0; i < pool.tokenCount; i++) remaining.push(w(pool.tokens[i].vault), w(recipients[i]));
  for (let i = 0; i < pool.tokenCount; i++) remaining.push(r(pool.tokens[i].mint));
  for (let i = 0; i < pool.tokenCount; i++) remaining.push(r(pool.tokens[i].tokenProgram));
  const seen = new Set<string>();
  for (const meta of tail) {
    if (meta.isSigner) throw new Error(`redeem_lp_transfer_fees: tail accounts cannot be signers (${meta.pubkey.toBase58()})`);
    if (seen.has(meta.pubkey.toBase58())) throw new Error(`redeem_lp_transfer_fees: duplicate tail account ${meta.pubkey.toBase58()}`);
    seen.add(meta.pubkey.toBase58());
    remaining.push({ pubkey: meta.pubkey, isSigner: false, isWritable: meta.isWritable });
  }
  return remaining;
}

function requireRedeemable(pool: PoolInfo, op: string): void {
  requireLpTransferFeeSupported(pool, op);
  if (!pool.poolEnabled) throw new Error(`${op}: PoolDisabled (6020)`);
  if (pool.lpTransferFeesOwedProtocol !== undefined && pool.lpTransferFeesOwedProtocol.isZero()) {
    throw new Error(`${op}: pool ${pool.address.toBase58()} owes the protocol no LP transfer fees (NoLpTransferFeesOwed, 6114)`);
  }
  // At or below the floor the whole fee account must go; an unburned stream next to the owed LP makes that impossible.
  // Without a chain timestamp the mint supply stands in for the priced one (the program decides).
  const supply = pool.chainTimestamp === undefined ? BigInt(pool.lpTotalSupply.toString()) : pricedLpSupplyOf(pool);
  if (supply <= MIN_LP_SUPPLY && pool.lpTransferFeesPendingBurn !== undefined && !pool.lpTransferFeesPendingBurn.isZero()) {
    throw new Error(`${op}: LP supply is at the floor and ${pool.lpTransferFeesPendingBurn.toString()} LP are still pending in the burn stream (FullExitRequiredBelowFloor, 6109) — run collect_lp_transfer_fees after the burn window first`);
  }
}

export interface RedeemLpTransferFeesParams {
  pool: PoolInfo;
  /** `config.protocol_admin` — the Treasury PDA (CPI only). */
  authority: PublicKey;
  /** Destination token accounts in pool slot order (`tokenCount` entries). */
  recipients: PublicKey[];
  /** Token-2022 transfer-hook / memo tail. */
  tail?: AccountMeta[];
}

/**
 * Raw `coffer_pool::redeem_lp_transfer_fees()` — `[config, pool w, lp_mint w,
 * lp_fee_account w, authority s, lp_token_program]` + the exit block.
 * `authority` must be the Treasury PDA, so this is callable only through
 * `buildPoolRedeemLpTransferFeesIx`; kept for the wire format. Burns
 * `calcEffectiveLpBurn(owed, supply)` from the LP fee account (no withdraw
 * fee, no hooks); the fee account must hold `owed + pending_burn`
 * (`LpFeeAccountUnderfunded`) and the pending stream is never redeemed. At
 * or below the `MIN_LP_SUPPLY` floor the whole fee account must go
 * (`FullExitRequiredBelowFloor` — run `collect_lp_transfer_fees` first,
 * after the burn window, when a donation or an unburned stream sits next
 * to the owed LP).
 */
export function buildRedeemLpTransferFeesIx(cfg: CofferConfig, p: RedeemLpTransferFeesParams): TransactionInstruction {
  requireRedeemable(p.pool, "redeem_lp_transfer_fees");
  const lpFeeAccount = deriveLpFeeAccount(p.pool.address, p.pool.lpMint);
  return buildContractInstruction(cfg, "cofferPool", "redeem_lp_transfer_fees", {}, {
    config: p.pool.config, pool: p.pool.address, lp_mint: p.pool.lpMint, lp_fee_account: lpFeeAccount,
    authority: p.authority, lp_token_program: TOKEN_2022_PROGRAM_ID,
  }, redeemLpTransferFeesRemainingAccounts(p.pool, p.recipients, p.tail ?? []));
}

export interface PoolRedeemLpTransferFeesParams {
  /** `Treasury.admin` (signer). */
  admin: PublicKey;
  pool: PoolInfo;
  /** Token-2022 transfer-hook / memo tail. */
  tail?: AccountMeta[];
}

/**
 * `protocol_admin::pool_redeem_lp_transfer_fees()` — `[treasury, admin s,
 * config, pool w, lp_mint w, lp_fee_account w, lp_token_program,
 * coffer_pool_program]` + the exit block with every recipient = the
 * Treasury vault PDA `[b"vault", mint_i]` (the program pins every payable
 * slot to it: `InvalidVault` 6002 otherwise). Instant (value can only move
 * INTO the Treasury). Register each pool mint first (`buildRegisterTokenIx`).
 * Emits `PoolLpTransferFeesRedeemed` + `LpTransferFeesRedeemed`.
 */
export function buildPoolRedeemLpTransferFeesIx(cfg: CofferConfig, p: PoolRedeemLpTransferFeesParams): TransactionInstruction & { recipients: PublicKey[] } {
  requireRedeemable(p.pool, "pool_redeem_lp_transfer_fees");
  const recipients = p.pool.tokens.map((t) => treasuryVaultPda(t.mint, cfg.programs.protocolAdmin));
  const [treasury] = deriveTreasuryPda(cfg.programs.protocolAdmin);
  const ix = buildContractInstruction(cfg, "protocolAdmin", "pool_redeem_lp_transfer_fees", {}, {
    treasury, admin: p.admin, config: p.pool.config, pool: p.pool.address, lp_mint: p.pool.lpMint,
    lp_fee_account: deriveLpFeeAccount(p.pool.address, p.pool.lpMint), lp_token_program: TOKEN_2022_PROGRAM_ID,
    coffer_pool_program: cfg.programs.cofferPool,
  }, redeemLpTransferFeesRemainingAccounts(p.pool, recipients, p.tail ?? []));
  return Object.assign(ix, { recipients });
}

/** `quoteRedeemLpTransferFees` result. */
export interface RedeemLpTransferFeesQuote {
  /** `calcEffectiveLpBurn(owed, supply)` on the priced supply: capped at `supply − MIN_LP_SUPPLY` above the floor, the whole `owed` at or below it. */
  lpBurn: bigint;
  /** `owed − lpBurn`, stays owed for a later redemption. */
  remainderOwed: bigint;
  /** Gross reserve legs per slot (no withdraw fee). */
  tokenAmounts: bigint[];
  /** Surge-bucket legs per slot. */
  surgeAmounts: bigint[];
  /** `lp_transfer_fees_pending_burn` — stays in the fee account, never redeemed. */
  pendingBurn: bigint;
  /** `owed + pendingBurn`: the least the LP fee account must hold (`LpFeeAccountUnderfunded` 6115 below it). */
  feeAccountReserved: bigint;
  /** LP of the stream a `collect_lp_transfer_fees` at `now` would burn first (`lpTransferFeeDrip` over `[burnLastTs, burnEndTs]`); `0n` without `now`. */
  streamBurnNow: bigint;
}

/**
 * What a redemption pays out of the snapshot, pending-aware (L-1): the
 * effective burn, the gross reserve + surge legs per slot (no withdraw fee),
 * the stream that stays behind and the balance the fee account must show.
 * Priced on `pricedLpSupplyOf(pool, now)` (the mint supply net of the
 * vested burn stream; `now` defaults to the synced `chainTimestamp`).
 *
 * Throws `MathError`:
 * - a pending burn stream without any timestamp (sync or pass `now`).
 * - `MathUnderflow` — the vested stream exceeds the mint supply.
 * - `FullExitRequiredBelowFloor` (6109) — `supply ≤ MIN_LP_SUPPLY` while
 *   `pendingBurn > 0` (or, with `feeAccountAmount`, while the account holds
 *   more than `lpBurn`): the program insists on burning the whole fee
 *   account at the floor. Collect after the burn window first.
 * - `LpFeeAccountUnderfunded` (6115) — `feeAccountAmount < owed + pendingBurn`.
 * - `InvalidLpAmount` — nothing owed (`NoLpTransferFeesOwed` 6114 on chain).
 */
export function quoteRedeemLpTransferFees(pool: PoolInfo, opts: { feeAccountAmount?: bigint; now?: bigint | number } = {}): RedeemLpTransferFeesQuote {
  const owed = BigInt((pool.lpTransferFeesOwedProtocol ?? new BN(0)).toString());
  const pendingBurn = BigInt((pool.lpTransferFeesPendingBurn ?? new BN(0)).toString());
  // The redemption is priced on the supply net of the vested burn stream, like a user exit.
  const supply = pricedLpSupplyOf(pool, opts.now);
  const feeAccountReserved = owed + pendingBurn;
  if (opts.feeAccountAmount !== undefined && opts.feeAccountAmount < feeAccountReserved) throw new MathError("LpFeeAccountUnderfunded");
  const lpBurn = calcEffectiveLpBurn(owed, supply);
  if (supply <= MIN_LP_SUPPLY && (pendingBurn > 0n || (opts.feeAccountAmount !== undefined && opts.feeAccountAmount !== lpBurn))) {
    throw new MathError("FullExitRequiredBelowFloor");
  }
  const tokenAmounts = calcTokensOutGivenLpIn(pool.tokens.map((t) => BigInt(t.actualBalance.toString())), lpBurn, supply);
  const surgeAmounts = calcTokensOutGivenLpIn(pool.tokens.map((t) => BigInt((t.surgeFeesOwed ?? pool.surgeFeesOwed?.[t.index] ?? new BN(0)).toString())), lpBurn, supply);
  const stream = lpBurnStreamOf(pool);
  const streamBurnNow = opts.now === undefined ? 0n : lpTransferFeeDrip(stream.pending, stream.lastTs, stream.endTs, opts.now);
  return { lpBurn, remainderOwed: owed - lpBurn, tokenAmounts, surgeAmounts, pendingBurn, feeAccountReserved, streamBurnNow };
}
