/**
 * Wallet-side Address Lookup Table preparation and bounded transaction
 * compilation for the planned zap (based on
 * `contracts/programs/single-token-liquidity/client/wallet-alt.ts`).
 *
 * A 10-token planned zap references 36–37 static keys plus the user's own
 * token accounts; the pool's ALT covers vaults/mints/programs but not the
 * user's ATAs, so a second, wallet-owned ALT is needed for large pools.
 * Setup creates lookup metadata only — it never moves tokens or liquidity.
 */
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Commitment,
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { AccountInfo } from "@solana/web3.js";

/** The subset of `Connection` these helpers need. */
export interface AltConnection {
  getAccountInfo(key: PublicKey, commitment?: Commitment): Promise<AccountInfo<Buffer> | null>;
  getSlot(commitment?: Commitment): Promise<number>;
}

const ACTIVE_SLOT = (1n << 64n) - 1n;
export const PACKET_BYTES = 1232;
/** Measured wallet-mutation reserve for setup packets (create + extend). */
export const DEFAULT_SETUP_WALLET_RESERVE = 520;
/** Measured reserve for the financial packet (N10 14-assertion Lighthouse profile + compute price). */
export const DEFAULT_FINANCIAL_WALLET_RESERVE = 653;
const unique = (keys: PublicKey[]) => [...new Map(keys.map((key) => [key.toBase58(), key])).values()];
function walletReserve(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value >= PACKET_BYTES) throw new Error("Invalid wallet reserve");
  return value;
}
/** v0 without lookups is two bytes larger than the legacy equivalent, covering either signing format. */
function setupWireBytes(instructions: TransactionInstruction[], wallet: PublicKey): number {
  const message = new TransactionMessage({ payerKey: wallet, recentBlockhash: PublicKey.default.toBase58(), instructions }).compileToV0Message();
  return new VersionedTransaction(message).serialize().length;
}
async function fetchTable(connection: AltConnection, address: PublicKey): Promise<AddressLookupTableAccount | null> {
  const account = await connection.getAccountInfo(address, "confirmed");
  if (!account) return null;
  if (!account.owner.equals(AddressLookupTableProgram.programId) || account.executable) throw new Error("Invalid wallet ALT owner or executable account");
  return new AddressLookupTableAccount({ key: address, state: AddressLookupTableAccount.deserialize(account.data) });
}

export interface WalletLookupPreparation {
  address: PublicKey;
  requiredAddresses: PublicKey[];
  /**
   * Send each batch with the wallet as sole payer/signer, then await
   * warm-up (`waitForWalletLookupTable`). Each batch leaves room for the
   * configured wallet-mutation reserve; a different fee payer or extra
   * instructions need re-measuring.
   */
  instructionBatches: TransactionInstruction[][];
}

/**
 * Plan the ALT setup for `requiredAddresses`: create (unless `existing`)
 * and extend in packets that fit `walletReserve`. An existing table must be
 * active, wallet-owned (or frozen and already complete) and have room.
 */
export async function buildWalletLookupPreparation(
  connection: AltConnection,
  wallet: PublicKey,
  requiredAddresses: PublicKey[],
  existing?: PublicKey,
  options: { walletReserve?: number } = {}
): Promise<WalletLookupPreparation> {
  const reserve = walletReserve(options.walletReserve ?? DEFAULT_SETUP_WALLET_RESERVE);
  const required = unique(requiredAddresses.filter((key) => !key.equals(wallet)));
  if (!required.length || required.length > 256) throw new Error("Wallet ALT requires 1..256 nonsigner addresses");
  let create: TransactionInstruction | undefined;
  let address: PublicKey;
  if (existing) address = existing;
  else [create, address] = AddressLookupTableProgram.createLookupTable({ authority: wallet, payer: wallet, recentSlot: await connection.getSlot("finalized") });
  const current = await fetchTable(connection, address);
  if (existing && !current) throw new Error("Selected wallet ALT does not exist");
  if (current) {
    create = undefined;
    if (current.state.deactivationSlot !== ACTIVE_SLOT) throw new Error("Wallet ALT is deactivated or deactivating");
    if (current.state.authority && !current.state.authority.equals(wallet)) throw new Error("Wallet ALT authority does not match the wallet");
  }
  const have = new Set(current?.state.addresses.map((key) => key.toBase58()) ?? []);
  const missing = required.filter((key) => !have.has(key.toBase58()));
  if (current && !current.state.authority && missing.length) throw new Error("Frozen wallet ALT cannot be extended");
  if ((current?.state.addresses.length ?? 0) + missing.length > 256) throw new Error("Wallet ALT is full; prepare a new table");
  const batches: TransactionInstruction[][] = [];
  let start = 0;
  while (start < missing.length) {
    let accepted: TransactionInstruction[] | undefined;
    let end = start;
    for (let next = start + 1; next <= missing.length; next++) {
      const candidate = [
        ...(create ? [create] : []),
        AddressLookupTableProgram.extendLookupTable({ authority: wallet, payer: wallet, lookupTable: address, addresses: missing.slice(start, next) }),
      ];
      // Stop before the first overflowing batch; with a tiny reserve the
      // serializer itself may hit its fixed packet-sized buffer.
      let bytes: number;
      try { bytes = setupWireBytes(candidate, wallet); }
      catch (error) { if (error instanceof RangeError) break; throw error; }
      if (bytes + reserve > PACKET_BYTES) break;
      accepted = candidate;
      end = next;
    }
    if (!accepted) {
      // A large custom reserve may fit create and extend separately but not together.
      if (create && setupWireBytes([create], wallet) + reserve <= PACKET_BYTES) {
        batches.push([create]);
        create = undefined;
        continue;
      }
      throw new Error(`Wallet ALT setup cannot fit one address plus ${reserve} wallet reserve`);
    }
    batches.push(accepted);
    create = undefined;
    start = end;
  }
  return { address, requiredAddresses: required, instructionBatches: batches };
}

/** Load and validate a warm wallet ALT that covers `requiredAddresses`. */
export async function resolveWalletLookupTable(connection: AltConnection, address: PublicKey, wallet: PublicKey, requiredAddresses: PublicKey[]): Promise<AddressLookupTableAccount> {
  const table = await fetchTable(connection, address);
  if (!table) throw new Error("Wallet ALT does not exist");
  if (table.state.deactivationSlot !== ACTIVE_SLOT) throw new Error("Wallet ALT is deactivated or deactivating");
  if (table.state.authority && !table.state.authority.equals(wallet)) throw new Error("Wallet ALT authority does not match the wallet");
  const have = new Set(table.state.addresses.map((key) => key.toBase58()));
  if (requiredAddresses.some((key) => !key.equals(wallet) && !have.has(key.toBase58()))) throw new Error("Wallet ALT does not cover all required addresses");
  if ((await connection.getSlot("confirmed")) <= table.state.lastExtendedSlot) throw new Error("Wallet ALT is not warm yet");
  return table;
}

/** Poll until the prepared table is warm (an ALT is usable one slot after its last extension). */
export async function waitForWalletLookupTable(connection: AltConnection, preparation: WalletLookupPreparation, wallet: PublicKey, timeoutMs = 30_000): Promise<AddressLookupTableAccount> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await resolveWalletLookupTable(connection, preparation.address, wallet, preparation.requiredAddresses);
    } catch (error) {
      if (!/not warm yet|does not exist|does not cover/.test(String(error)) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

export interface CompiledPlannedZap {
  transaction: VersionedTransaction;
  wireBytes: number;
  walletReserve: number;
  remainingBytes: number;
}

/**
 * Compile the financial transaction (compute limit + the given instructions)
 * against `lookupTables` and refuse it when the wire size plus the wallet
 * reserve exceeds the 1232-byte packet. The reserve does not control any
 * wallet's policy; always simulate the final transaction.
 */
export function compilePlannedZapTransaction(options: {
  payer: PublicKey;
  blockhash: string;
  instructions: TransactionInstruction[];
  lookupTables: AddressLookupTableAccount[];
  walletReserve?: number;
  computeUnits?: number;
}): CompiledPlannedZap {
  const reserve = walletReserve(options.walletReserve ?? DEFAULT_FINANCIAL_WALLET_RESERVE);
  const message = new TransactionMessage({
    payerKey: options.payer,
    recentBlockhash: options.blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: options.computeUnits ?? 1_400_000 }), ...options.instructions],
  }).compileToV0Message(options.lookupTables);
  const transaction = new VersionedTransaction(message);
  let wireBytes: number;
  try {
    wireBytes = transaction.serialize().length;
  } catch (error) {
    // web3.js serializes into a fixed packet-sized buffer: an overrun IS the budget failure.
    if (error instanceof RangeError) throw new Error(`Planned zap exceeds the ${PACKET_BYTES}-byte packet before the ${reserve}-byte wallet reserve; prepare/extend the wallet ALT or reduce the transfer profile`);
    throw error;
  }
  if (wireBytes + reserve > PACKET_BYTES) {
    throw new Error(`Planned zap is ${wireBytes} bytes + ${reserve} wallet reserve > ${PACKET_BYTES}; prepare/extend the wallet ALT or reduce the transfer profile`);
  }
  return { transaction, wireBytes, walletReserve: reserve, remainingBytes: PACKET_BYTES - wireBytes };
}
