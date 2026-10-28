/**
 * feeClaim — v6.1 (T5 / T14) protocol-fee and creator-fee claims. Port of
 * `contracts/scripts/cli/claim-revenue-plan.ts` onto `PoolInfo`.
 *
 * Two `collect_protocol_fees` wire layouts exist ({@link ClaimAbi}):
 *   * `v5`  — production v5.1 program: `[vault_i, recipient_i, token_program_i] × n`,
 *             EXACTLY 3n accounts, plain `transfer`, no tail.
 *   * `v61` — `coffer_pool::collect_protocol_fees`: `[vault_i, recipient_i,
 *             mint_i, token_program_i] × n` (≥ 4n) + optional transfer-hook /
 *             memo tail, `transfer_checked`.
 * A wrong ABI fails at simulation with `InvalidArrayLength` (6064).
 *
 * Recipients of the PROTOCOL claim are ALWAYS the Treasury vault PDAs
 * `[b"vault", mint]` under `cfg.programs.protocolAdmin` (the v6.1 wrapper
 * enforces it on-chain with `InvalidVault` 6002; the SDK applies the same
 * rule to the v5 ABI). Zero-owed slots carry placeholder accounts (the pool
 * key, repeated): both handlers skip such slots without reading their
 * accounts, so the transaction stays small.
 *
 * Every instruction here is a `protocol_admin` wrapper (`pool_collect_protocol_fees`,
 * `register_token`, `withdraw`) except `claim_creator_fees`, which is a plain
 * pool-admin instruction on coffer_pool.
 */
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  type AccountMeta,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import { CofferConfig, TREASURY_VAULT_SEED } from "../config";
import { PROTOCOL_ADMIN_IDL, COFFER_POOL_IDL } from "../idl";
import type { PoolInfo } from "../types/pool";
import type { ClaimAbi, ClaimAccounts, ClaimSlot } from "../types/tx-v61";
import { deriveAta, deriveTreasuryPda } from "../utils/pda";

// ─── Discriminators (pinned in contracts idl/abi-pins.json) ──────────────────

const PINS = {
  pool_collect_protocol_fees: "84ba795c3c3dd8a8",
  claim_creator_fees: "00177dea9c768659",
  register_token: "209224f050b72454",
  withdraw: "b712469c946da122",
} as const;

function disc(idl: { instructions: unknown }, name: keyof typeof PINS): Buffer {
  const ix = (idl.instructions as Array<{ name: string; discriminator: number[] }>).find((i) => i.name === name);
  if (!ix) throw new Error(`feeClaim: no "${name}" instruction in the IDL`);
  const bytes = Buffer.from(ix.discriminator);
  if (bytes.toString("hex") !== PINS[name]) {
    throw new Error(`feeClaim: IDL discriminator for "${name}" is ${bytes.toString("hex")}, pinned value is ${PINS[name]}`);
  }
  return bytes;
}

const DISC = {
  poolCollectProtocolFees: disc(PROTOCOL_ADMIN_IDL, "pool_collect_protocol_fees"),
  registerToken: disc(PROTOCOL_ADMIN_IDL, "register_token"),
  withdraw: disc(PROTOCOL_ADMIN_IDL, "withdraw"),
  claimCreatorFees: disc(COFFER_POOL_IDL, "claim_creator_fees"),
};

const w = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
const r = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });

/** Remaining accounts per pool token (3 for `v5`, 4 for `v61`). */
export const CLAIM_ACCOUNTS_PER_TOKEN: Record<ClaimAbi, 3 | 4> = { v5: 3, v61: 4 };

// ─── PDAs ────────────────────────────────────────────────────────────────────

/** Treasury vault PDA `[b"vault", mint]` under `protocolAdmin` — the only accepted protocol-fee recipient. */
export function treasuryVaultPda(mint: PublicKey, protocolAdmin: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([TREASURY_VAULT_SEED, mint.toBuffer()], protocolAdmin)[0];
}

function assertTail(tail: AccountMeta[], op: string): AccountMeta[] {
  return tail.map((meta) => {
    if (meta.isSigner) throw new Error(`${op}: transfer-hook / memo tail accounts cannot be signers`);
    return { pubkey: meta.pubkey, isSigner: false, isWritable: meta.isWritable };
  });
}

function requireTokenProgram(program: PublicKey, op: string): void {
  if (!program.equals(TOKEN_PROGRAM_ID) && !program.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(`${op}: token program ${program.toBase58()} is neither SPL Token nor Token-2022`);
  }
}

// ─── Account blocks ──────────────────────────────────────────────────────────

/**
 * The per-token block for `abi`, Treasury vault PDAs as recipients,
 * `placeholder` (default: the pool key) ×k for zero-owed slots, `tail`
 * appended verbatim (v61 only; a tail on the v5 ABI is refused — the v5
 * handler requires exactly 3n accounts).
 */
export function buildClaimAccounts(
  cfg: CofferConfig,
  abi: ClaimAbi,
  pool: PoolInfo,
  tail: AccountMeta[] = [],
  placeholder?: PublicKey,
): ClaimAccounts {
  if (abi !== "v5" && abi !== "v61") throw new Error(`buildClaimAccounts: unknown ABI ${String(abi)}`);
  if (abi === "v5" && tail.length) throw new Error("the v5 claim ABI takes no extra-account tail (exactly 3 accounts per token)");
  const per = CLAIM_ACCOUNTS_PER_TOKEN[abi];
  const ph = placeholder ?? pool.address;
  const remaining: AccountMeta[] = [];
  const claims: ClaimSlot[] = [];
  for (const t of pool.tokens) {
    if (t.protocolFeesOwed.isZero()) {
      for (let k = 0; k < per; k++) remaining.push(r(ph));
      continue;
    }
    requireTokenProgram(t.tokenProgram, "collect_protocol_fees");
    const treasuryVault = treasuryVaultPda(t.mint, cfg.programs.protocolAdmin);
    claims.push({ index: t.index, mint: t.mint, tokenProgram: t.tokenProgram, vault: t.vault, owed: t.protocolFeesOwed, recipient: treasuryVault });
    remaining.push(w(t.vault), w(treasuryVault));
    if (abi === "v61") remaining.push(r(t.mint));
    remaining.push(r(t.tokenProgram));
  }
  return { remaining: [...remaining, ...assertTail(tail, "collect_protocol_fees")], claims };
}

/**
 * Pool-admin sibling (T14 `coffer_pool::claim_creator_fees`): the same
 * `[vault, recipient, mint, program] × n` block, recipients = `recipients[i]`
 * (default: `owner`'s ATAs) for the slots with `creatorFeesOwed > 0`,
 * placeholders (the pool key) elsewhere. v6.1 ABI only.
 */
export function buildCreatorClaimAccounts(
  pool: PoolInfo,
  owner: PublicKey,
  tail: AccountMeta[] = [],
  recipients?: PublicKey[],
  placeholder?: PublicKey,
): ClaimAccounts {
  if (recipients && recipients.length !== pool.tokenCount) {
    throw new Error(`claim_creator_fees: recipients length (${recipients.length}) must equal the pool's token count (${pool.tokenCount})`);
  }
  const ph = placeholder ?? pool.address;
  const remaining: AccountMeta[] = [];
  const claims: ClaimSlot[] = [];
  for (const t of pool.tokens) {
    const owed = t.creatorFeesOwed ?? pool.creatorFeesOwed?.[t.index] ?? new BN(0);
    if (owed.isZero()) {
      for (let k = 0; k < 4; k++) remaining.push(r(ph));
      continue;
    }
    requireTokenProgram(t.tokenProgram, "claim_creator_fees");
    const recipient = recipients?.[t.index] ?? deriveAta(owner, t.mint, t.tokenProgram);
    claims.push({ index: t.index, mint: t.mint, tokenProgram: t.tokenProgram, vault: t.vault, owed, recipient });
    remaining.push(w(t.vault), w(recipient), r(t.mint), r(t.tokenProgram));
  }
  return { remaining: [...remaining, ...assertTail(tail, "claim_creator_fees")], claims };
}

// ─── Instructions ────────────────────────────────────────────────────────────

export interface CollectProtocolFeesParams {
  cfg: CofferConfig;
  abi: ClaimAbi;
  pool: PoolInfo;
  /** `Treasury.admin` (signer). */
  admin: PublicKey;
  /** Transfer-hook / memo tail (v61 only). */
  tail?: AccountMeta[];
  /** Account used for zero-owed slots; default = the pool key. */
  placeholder?: PublicKey;
}

/**
 * `protocol_admin::pool_collect_protocol_fees` with recipients FORCED to the
 * Treasury vault PDAs. Fixed accounts `[treasury, admin s, config, pool w,
 * coffer_pool_program]`; remaining = `buildClaimAccounts`. Throws when
 * nothing is owed (the program would be a no-op costing a fee).
 */
export function buildCollectProtocolFeesIx(params: CollectProtocolFeesParams): TransactionInstruction & { claims: ClaimSlot[] } {
  const { cfg, abi, pool, admin } = params;
  const { remaining, claims } = buildClaimAccounts(cfg, abi, pool, params.tail ?? [], params.placeholder);
  if (claims.length === 0) throw new Error(`collect_protocol_fees: pool ${pool.address.toBase58()} owes no protocol fees`);
  const [treasury] = deriveTreasuryPda(cfg.programs.protocolAdmin);
  const ix = new TransactionInstruction({
    programId: cfg.programs.protocolAdmin,
    keys: [
      r(treasury),
      { pubkey: admin, isSigner: true, isWritable: false },
      r(pool.config),
      w(pool.address),
      r(cfg.programs.cofferPool),
      ...remaining,
    ],
    data: Buffer.from(DISC.poolCollectProtocolFees),
  });
  return Object.assign(ix, { claims });
}

/**
 * `coffer_pool::claim_creator_fees` signed by the pool admin. Remaining =
 * `[vault, recipient, mint, token_program] × n` (+ tail); recipients default
 * to the authority's ATAs, placeholders for zero-owed slots. v6.1 ABI only.
 */
export function buildClaimCreatorFeesIx(
  cfg: CofferConfig,
  pool: PoolInfo,
  authority: PublicKey,
  recipients?: PublicKey[],
  tail: AccountMeta[] = [],
): TransactionInstruction & { claims: ClaimSlot[] } {
  if (pool.poolAdmin && !pool.poolAdmin.equals(authority)) throw new Error("claim_creator_fees: authority must be the pool admin (Unauthorized)");
  const { remaining, claims } = buildCreatorClaimAccounts(pool, authority, tail, recipients);
  if (claims.length === 0) throw new Error(`claim_creator_fees: pool ${pool.address.toBase58()} owes no creator fees`);
  const ix = new TransactionInstruction({
    programId: cfg.programs.cofferPool,
    keys: [w(pool.address), { pubkey: authority, isSigner: true, isWritable: false }, ...remaining],
    data: Buffer.from(DISC.claimCreatorFees),
  });
  return Object.assign(ix, { claims });
}

/**
 * `protocol_admin::register_token`: create the Treasury vault
 * `[b"vault", mint]` under the mint's token program. Accounts `[treasury w,
 * mint, vault w, admin w s, token_program, system_program]`. v6.1 lifts the
 * v5.1 10-mint cap (`MaxTokensReached` is never raised any more).
 */
export function buildRegisterTokenIx(cfg: CofferConfig, admin: PublicKey, mint: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM_ID): TransactionInstruction {
  requireTokenProgram(tokenProgram, "register_token");
  const [treasury] = deriveTreasuryPda(cfg.programs.protocolAdmin);
  return new TransactionInstruction({
    programId: cfg.programs.protocolAdmin,
    keys: [
      w(treasury),
      r(mint),
      w(treasuryVaultPda(mint, cfg.programs.protocolAdmin)),
      { pubkey: admin, isSigner: true, isWritable: true },
      r(tokenProgram),
      r(SystemProgram.programId),
    ],
    data: Buffer.from(DISC.registerToken),
  });
}

/**
 * `protocol_admin::withdraw(amount)` from a Treasury vault. ABI differs:
 * v5.1 = `[treasury, vault w, recipient w, admin s, token_program]` (SPL
 * Token only, plain `transfer`); v6.1 = `[treasury, mint, vault w,
 * recipient w, admin s, token_program]` + optional hook / memo tail
 * (`transfer_checked`, Token-2022 aware). Under the T3 cooldown a non-zero
 * Treasury delay requires `propose_action(Withdraw)` → `execute_withdraw`
 * instead (`CooldownRequired`).
 */
export function buildTreasuryWithdrawIx(
  cfg: CofferConfig,
  abi: ClaimAbi,
  admin: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
  recipient: PublicKey,
  amount: BN | bigint,
  tail: AccountMeta[] = [],
): TransactionInstruction {
  const amt = BN.isBN(amount) ? amount : new BN(amount.toString());
  if (amt.isNeg() || amt.isZero() || amt.bitLength() > 64) throw new Error("withdraw: amount must be a positive u64 (ZeroAmount)");
  requireTokenProgram(tokenProgram, "withdraw");
  if (abi === "v5" && (tail.length || !tokenProgram.equals(TOKEN_PROGRAM_ID))) {
    throw new Error("the v5.1 withdraw takes SPL Token vaults only and no tail");
  }
  const data = Buffer.concat([DISC.withdraw, amt.toArrayLike(Buffer, "le", 8)]);
  const [treasury] = deriveTreasuryPda(cfg.programs.protocolAdmin);
  const vault = treasuryVaultPda(mint, cfg.programs.protocolAdmin);
  const adminMeta = { pubkey: admin, isSigner: true, isWritable: false };
  const keys = abi === "v5"
    ? [r(treasury), w(vault), w(recipient), adminMeta, r(tokenProgram)]
    : [r(treasury), r(mint), w(vault), w(recipient), adminMeta, r(tokenProgram), ...assertTail(tail, "withdraw")];
  return new TransactionInstruction({ programId: cfg.programs.protocolAdmin, keys, data });
}

// ─── Transaction form ────────────────────────────────────────────────────────

export const MAX_TX_BYTES = 1232;
export const CLAIM_CU_LIMIT = 1_400_000;
const DUMMY_BLOCKHASH = "11111111111111111111111111111111";

export const claimComputeBudgetIx = (units = CLAIM_CU_LIMIT): TransactionInstruction => ComputeBudgetProgram.setComputeUnitLimit({ units });

/**
 * Wire size of a legacy transaction (signature slots included), computed
 * from the compiled message layout: `Message.serialize()` encodes into a
 * fixed buffer and throws once the message outgrows it, and an oversize
 * claim is exactly what this function must report.
 */
export function legacyTxSize(ixs: TransactionInstruction[], feePayer: PublicKey): number {
  const tx = new Transaction();
  tx.add(...ixs);
  tx.feePayer = feePayer;
  tx.recentBlockhash = DUMMY_BLOCKHASH;
  const m = tx.compileMessage();
  let size = 3 /* header */ + compactLen(m.accountKeys.length) + 32 * m.accountKeys.length + 32 /* blockhash */ + compactLen(m.instructions.length);
  // Compiled instructions keep the input order; the data length is the raw one.
  m.instructions.forEach((ix, i) => {
    const dataLen = ixs[i].data.length;
    size += 1 + compactLen(ix.accounts.length) + ix.accounts.length + compactLen(dataLen) + dataLen;
  });
  const n = m.header.numRequiredSignatures;
  return compactLen(n) + 64 * n + size;
}

const compactLen = (n: number): number => (n < 0x80 ? 1 : n < 0x4000 ? 2 : 3);

/**
 * Wire size of a v0 transaction compiled against `alts`, computed from the
 * message layout (web3.js's `MessageV0.serialize` throws past 1232 bytes,
 * and an oversize claim is exactly what this function must report).
 */
export function v0TxSize(ixs: TransactionInstruction[], feePayer: PublicKey, alts: AddressLookupTableAccount[]): number {
  const m = new TransactionMessage({ payerKey: feePayer, recentBlockhash: DUMMY_BLOCKHASH, instructions: ixs }).compileToV0Message(alts);
  let size = 1 /* version prefix */ + 3 /* header */ + compactLen(m.staticAccountKeys.length) + 32 * m.staticAccountKeys.length + 32 /* blockhash */;
  size += compactLen(m.compiledInstructions.length);
  for (const ix of m.compiledInstructions) size += 1 + compactLen(ix.accountKeyIndexes.length) + ix.accountKeyIndexes.length + compactLen(ix.data.length) + ix.data.length;
  size += compactLen(m.addressTableLookups.length);
  for (const l of m.addressTableLookups) size += 32 + compactLen(l.writableIndexes.length) + l.writableIndexes.length + compactLen(l.readonlyIndexes.length) + l.readonlyIndexes.length;
  const n = m.header.numRequiredSignatures;
  return compactLen(n) + 64 * n + size;
}

export const uniqueKeys = (ixs: TransactionInstruction[], feePayer: PublicKey): number =>
  new Set([feePayer.toBase58(), ...ixs.flatMap((ix) => [ix.programId.toBase58(), ...ix.keys.map((k) => k.pubkey.toBase58())])]).size;

export type TxForm =
  | { kind: "legacy"; size: number }
  | { kind: "v0"; size: number; alts: AddressLookupTableAccount[]; needsAuxAlt: false }
  | { kind: "v0"; size: number; alts: AddressLookupTableAccount[]; needsAuxAlt: true; auxAddresses: PublicKey[] }
  | { kind: "too-large"; size: number; reason: string };

export interface TxFormOptions {
  /** Never build a v0 transaction (Ledger / wallet without v0 support). */
  legacyOnly?: boolean;
  /** The pool's own lookup table, when it exists and is active. */
  poolAlt?: AddressLookupTableAccount | null;
}

/**
 * Decide how a claim transaction ships: legacy when it fits; else v0 with
 * the pool ALT; else v0 with the pool ALT plus a throw-away ALT holding
 * the addresses still outside any table (sized as if that table existed).
 */
export function chooseTxForm(ixs: TransactionInstruction[], feePayer: PublicKey, opts: TxFormOptions = {}): TxForm {
  const legacy = legacyTxSize(ixs, feePayer);
  if (legacy <= MAX_TX_BYTES) return { kind: "legacy", size: legacy };
  if (opts.legacyOnly) return { kind: "too-large", size: legacy, reason: `legacy transaction is ${legacy} B > ${MAX_TX_BYTES} and legacyOnly is set` };
  const alts = opts.poolAlt ? [opts.poolAlt] : [];
  const withPool = v0TxSize(ixs, feePayer, alts);
  if (withPool <= MAX_TX_BYTES) return { kind: "v0", size: withPool, alts, needsAuxAlt: false };
  // Everything not covered by the pool ALT (and not a signer / program id) goes into an aux table.
  const covered = new Set(alts.flatMap((a) => a.state.addresses.map((k) => k.toBase58())));
  const signers = new Set(ixs.flatMap((ix) => ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())));
  signers.add(feePayer.toBase58());
  const programs = new Set(ixs.map((ix) => ix.programId.toBase58()));
  const aux = new Map<string, PublicKey>();
  for (const ix of ixs) for (const k of ix.keys) {
    const s = k.pubkey.toBase58();
    if (!covered.has(s) && !signers.has(s) && !programs.has(s)) aux.set(s, k.pubkey);
  }
  const auxAddresses = [...aux.values()];
  const fake = new AddressLookupTableAccount({
    key: PublicKey.default,
    state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: feePayer, addresses: auxAddresses },
  });
  const withAux = v0TxSize(ixs, feePayer, [...alts, fake]);
  if (withAux <= MAX_TX_BYTES) return { kind: "v0", size: withAux, alts, needsAuxAlt: true, auxAddresses };
  return { kind: "too-large", size: withAux, reason: `even with lookup tables the transaction is ${withAux} B > ${MAX_TX_BYTES}` };
}

/** Custom-error names for claim simulation reports (numbers pinned in contracts idl/abi-pins.json). */
export const CLAIM_ERROR_NAMES: Record<"cofferPool" | "protocolAdmin", Record<number, string>> = {
  cofferPool: {
    6014: "TokenMintMismatch", 6019: "InvalidMint", 6030: "InvalidVault", 6056: "MemoProgramMissing",
    6064: "InvalidArrayLength (claim ABI mismatch? try the other abi)", 6070: "LayoutVersionMismatch (migrate_pool_layout_v61 first)",
    6018: "Unauthorized", 6080: "CreatorFeesUnclaimed",
  },
  protocolAdmin: {
    6000: "Unauthorized (signer is not Treasury.admin)", 6001: "MaxTokensReached (v5.1 Treasury: 10 registered mints max)",
    6002: "InvalidVault (recipient is not the Treasury vault PDA)", 6010: "CooldownRequired (propose_action first)",
  },
};
