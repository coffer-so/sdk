/**
 * Remaining-account tail resolver for v6 transfers (Token-2022 transfer
 * hooks + memo program). Browser-safe: reads only through an
 * `AccountReader` (a `Connection` or anything with `getAccountInfo` /
 * `getMultipleAccountsInfo`).
 *
 * The v6 program (`util::token::build_transfer_checked`) appends every
 * remaining account after the instruction's fixed layout to each
 * `transfer_checked` CPI, read-only or writable as supplied, never as a
 * signer. An ARMED transfer hook then resolves its `ExtraAccountMetaList`
 * against that tail; a destination with `MemoTransfer` needs the memo
 * program in the tail (`invoke_memo_if_required`). The SDK therefore
 * computes, for every gross transfer an instruction performs, the union of
 * the hook's resolved extra metas plus the memo program, de-duplicated with
 * writable-OR, and refuses the v6 transfer profile when a hook asks for an
 * additional signer or for one of the instruction's core accounts.
 *
 * Based on `contracts/programs/single-token-liquidity/client/extensions.ts`.
 */
import type { AccountInfo, AccountMeta, Commitment, Connection, PublicKey as PublicKeyType } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import {
  createExecuteInstruction,
  getExtraAccountMetaAddress,
  getExtraAccountMetas,
  getMemoTransfer,
  getTransferHook,
  resolveExtraAccountMeta,
  TOKEN_2022_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import type { ExtraAccountMeta } from "@solana/spl-token";

/** SPL Memo v2, the program `invoke_memo_if_required` calls. */
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const EXECUTE_DISCRIMINATOR = Buffer.from([105, 37, 101, 197, 75, 251, 102, 26]);
const EXTRA_META_SIZE = 35;

/** The subset of `Connection` the resolver needs. */
export interface AccountReader {
  getAccountInfo(key: PublicKeyType, commitment?: Commitment): Promise<AccountInfo<Buffer> | null>;
  getMultipleAccountsInfo(keys: PublicKeyType[], commitment?: Commitment): Promise<(AccountInfo<Buffer> | null)[]>;
}

/** One `transfer_checked` the instruction will perform. */
export interface TransferLeg {
  mint: PublicKeyType;
  tokenProgram: PublicKeyType;
  source: PublicKeyType;
  destination: PublicKeyType;
  /** Signing authority of the transfer: the user for deposits, the pool PDA for payouts. */
  authority: PublicKeyType;
  /** Gross amount passed to `transfer_checked` (what a hook's instruction-data seeds see). */
  amount: bigint;
  /**
   * The transaction itself creates `destination` when it does not exist yet
   * (the user's ATA, via `createAssociatedTokenAccountIdempotent` ahead of
   * the instruction). Such a destination may be absent at resolution time:
   * a fresh account cannot have `MemoTransfer` enabled, so it needs no memo.
   * Pool vaults never set this — a missing vault is an error.
   */
  destinationCreatedInTx?: boolean;
}

/** Mint account bytes as fetched (the same snapshot a quote was computed on). */
export interface MintSnapshot {
  address: PublicKeyType;
  owner: PublicKeyType;
  data: Buffer | Uint8Array;
}

/** Thrown when a hook needs something the v6 transfer profile cannot supply. */
export class UnsupportedTransferProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedTransferProfileError";
  }
}

/**
 * Strict `ExtraAccountMetaList` decoding, matching Rust's
 * `TlvStateBorrowed` + `get_first_bytes::<ExecuteInstruction>` +
 * `PodSlice<ExtraAccountMeta>`. The JS SPL decoder alone ignores the TLV
 * tag, the declared length and an excessive item count, and assumes the
 * Execute entry comes first. Other TLV entries, repeated tags, spare
 * PodSlice capacity and uninitialized trailing space are legal; only the
 * first Execute entry supplies the metas.
 */
export function executeMetas(address: PublicKeyType, info: AccountInfo<Buffer>): ExtraAccountMeta[] {
  const data = info.data;
  const invalid = (reason: string): never => {
    throw new Error(`Malformed transfer-hook Execute registry ${address.toBase58()}: ${reason}`);
  };
  let execute: Buffer | undefined;
  for (let offset = 0; offset < data.length; ) {
    if (data.length - offset < 8) {
      if (data.subarray(offset).some((byte) => byte !== 0)) invalid("truncated TLV discriminator");
      break;
    }
    const tag = data.subarray(offset, offset + 8);
    // Rust stops at the first Uninitialized discriminator; bytes after it
    // are not entries even if space was preallocated.
    if (tag.every((byte) => byte === 0)) break;
    if (data.length - offset < 12) invalid("truncated TLV length");
    const length = data.readUInt32LE(offset + 8);
    const end = offset + 12 + length;
    if (end > data.length) invalid("TLV length exceeds account data");
    if (!execute && tag.equals(EXECUTE_DISCRIMINATOR)) {
      if (length < 4 || (length - 4) % EXTRA_META_SIZE !== 0) invalid("invalid Execute PodSlice length");
      const count = data.readUInt32LE(offset + 12);
      if (count > (length - 4) / EXTRA_META_SIZE) invalid("Execute count exceeds allocated entries");
      // Decode only the used entries, not spare capacity or other records.
      execute = Buffer.from(data.subarray(offset, offset + 16 + count * EXTRA_META_SIZE));
      execute.writeUInt32LE(4 + count * EXTRA_META_SIZE, 8);
    }
    offset = end;
  }
  if (!execute) return invalid("Execute discriminator not found");
  try {
    return getExtraAccountMetas({ ...info, data: execute });
  } catch {
    return invalid("invalid Execute account-meta encoding");
  }
}

export interface ResolveTransferExtraAccountsOptions {
  /** Commitment pinned on every RPC read (default `"confirmed"`). */
  commitment?: Commitment;
}

/**
 * Resolve the remaining-account tail for `transfers`: hook extras (via the
 * SPL resolver against the strictly decoded registry), the hook program and
 * its registry, and the memo program when any Token-2022 destination
 * requires incoming memos. `mints` must hold a snapshot for every
 * Token-2022 mint in `transfers`. `forbiddenKeys` are the instruction's
 * core accounts (user, pool, LP mint, …): a hook that requests one of them,
 * or any signer, is outside the supported profile and throws
 * `UnsupportedTransferProfileError`.
 *
 * Registry contents and hook state are external, mutable state: simulate
 * the built transaction before signing.
 */
export async function resolveTransferExtraAccounts(
  reader: AccountReader,
  transfers: TransferLeg[],
  mints: MintSnapshot[],
  forbiddenKeys: PublicKeyType[],
  options: ResolveTransferExtraAccountsOptions = {}
): Promise<AccountMeta[]> {
  const commitment = options.commitment ?? "confirmed";
  const forbidden = new Set(forbiddenKeys.map((k) => k.toBase58()));
  const union = new Map<string, AccountMeta>();
  const add = (meta: AccountMeta): void => {
    if (meta.isSigner || forbidden.has(meta.pubkey.toBase58())) {
      throw new UnsupportedTransferProfileError(
        `Transfer hook requires a signer or a core account (${meta.pubkey.toBase58()}) in the tail; outside the v6 transfer profile`
      );
    }
    const old = union.get(meta.pubkey.toBase58());
    union.set(meta.pubkey.toBase58(), { pubkey: meta.pubkey, isSigner: false, isWritable: meta.isWritable || !!old?.isWritable });
  };
  const snapshots = new Map(mints.map((m) => [m.address.toBase58(), m]));
  const unpackedMints = new Map<string, ReturnType<typeof unpackMint>>();
  const mintOf = (leg: TransferLeg) => {
    const key = leg.mint.toBase58();
    let unpacked = unpackedMints.get(key);
    if (!unpacked) {
      const snapshot = snapshots.get(key);
      if (!snapshot) throw new Error(`Mint snapshot missing for ${key}`);
      unpacked = unpackMint(leg.mint, { owner: snapshot.owner, data: Buffer.from(snapshot.data), lamports: 0, executable: false }, leg.tokenProgram);
      unpackedMints.set(key, unpacked);
    }
    return unpacked;
  };

  const destinations = new Map<string, { key: PublicKeyType; program: PublicKeyType; createdInTx: boolean }>();
  const registries = new Map<string, { info: AccountInfo<Buffer>; metas: ExtraAccountMeta[] }>();
  // SPL's seed resolver only reads `getAccountInfo`. Serve a registry from
  // its checked snapshot so account-data seeds cannot race a second fetch,
  // and pin every other read to the same commitment.
  const resolutionConnection = {
    getAccountInfo: (key: PublicKeyType, c?: Commitment | unknown) =>
      registries.has(key.toBase58())
        ? Promise.resolve(registries.get(key.toBase58())!.info)
        : reader.getAccountInfo(key, typeof c === "string" ? (c as Commitment) : commitment),
  } as unknown as Connection;

  for (const transfer of transfers) {
    if (!transfer.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) continue;
    const destinationKey = transfer.destination.toBase58();
    // The same account may be a vault for one leg and a user ATA for another
    // in theory; strictness wins when any leg needs the account to exist.
    const existing = destinations.get(destinationKey);
    destinations.set(destinationKey, {
      key: transfer.destination,
      program: transfer.tokenProgram,
      createdInTx: (existing?.createdInTx ?? true) && !!transfer.destinationCreatedInTx,
    });
    const hook = getTransferHook(mintOf(transfer));
    if (!hook || hook.programId.equals(PublicKey.default)) continue;
    const registry = getExtraAccountMetaAddress(transfer.mint, hook.programId);
    let checked = registries.get(registry.toBase58());
    if (!checked) {
      const [program, info] = await Promise.all([
        reader.getAccountInfo(hook.programId, commitment),
        reader.getAccountInfo(registry, commitment),
      ]);
      if (!program) throw new Error(`Missing transfer-hook program ${hook.programId.toBase58()}`);
      if (!program.executable) throw new Error(`Transfer-hook program ${hook.programId.toBase58()} is not executable`);
      if (!info) throw new Error(`Missing transfer-hook registry ${registry.toBase58()}`);
      if (!info.owner.equals(hook.programId) || info.executable) {
        throw new Error(`Invalid transfer-hook registry owner or executable state: ${registry.toBase58()}`);
      }
      const snapshot = { ...info, data: Buffer.from(info.data) };
      checked = { info: snapshot, metas: executeMetas(registry, snapshot) };
      registries.set(registry.toBase58(), checked);
    }
    const execute = createExecuteInstruction(
      hook.programId, transfer.source, transfer.mint, transfer.destination, transfer.authority, registry, transfer.amount
    );
    for (const extra of checked.metas) {
      const meta = await resolveExtraAccountMeta(resolutionConnection, extra, execute.keys, execute.data, hook.programId);
      // SPL's deEscalateAccountMeta: a duplicate of a fixed Execute account
      // keeps at most the privileges that account already has.
      const duplicates = execute.keys.filter((existing) => existing.pubkey.equals(meta.pubkey));
      if (duplicates.length) {
        meta.isSigner = meta.isSigner && duplicates.some((existing) => existing.isSigner);
        meta.isWritable = meta.isWritable && duplicates.some((existing) => existing.isWritable);
      }
      execute.keys.push(meta);
      add(meta);
    }
    add({ pubkey: hook.programId, isSigner: false, isWritable: false });
    add({ pubkey: registry, isSigner: false, isWritable: false });
  }

  const destinationList = [...destinations.values()];
  if (destinationList.length) {
    const infos = await reader.getMultipleAccountsInfo(destinationList.map((item) => item.key), commitment);
    for (let i = 0; i < destinationList.length; i++) {
      const item = destinationList[i];
      const info = infos[i];
      if (!info) {
        // A user ATA the transaction creates itself may not exist yet (first
        // swap/remove into a mint the user never held): a fresh account cannot
        // have `MemoTransfer` enabled, so it needs no memo in the tail. Any
        // other destination (a pool vault) must exist.
        if (item.createdInTx) continue;
        throw new Error(`Missing transfer destination ${item.key.toBase58()}`);
      }
      if (getMemoTransfer(unpackAccount(item.key, info, item.program))?.requireIncomingTransferMemos) {
        add({ pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false });
      }
    }
  }
  return [...union.values()];
}
