import { BorshInstructionCoder, Idl } from "@coral-xyz/anchor";
import { AccountMeta, PublicKey, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { CofferConfig } from "../config";
import { IDLS } from "../idl";
import { ContractInstructionMap, ContractProgram } from "../types/contracts";

type InstructionName<P extends ContractProgram> = keyof ContractInstructionMap[P] & string;
export type ContractInstructionArgs<P extends ContractProgram, I extends InstructionName<P>> =
  ContractInstructionMap[P][I] extends { args: infer A } ? A : never;
export type ContractInstructionAccounts<P extends ContractProgram, I extends InstructionName<P>> =
  ContractInstructionMap[P][I] extends { accounts: infer A } ? A : never;

const coders = new Map<ContractProgram, BorshInstructionCoder>();

/**
 * Build any instruction exposed by the three deployed contracts. Argument and
 * account names use the exact snake_case names from the shipped IDLs; all fixed
 * accounts are explicit. Integer widths, argument fields, account order and
 * signer/writable flags are checked or derived from those IDLs.
 *
 * This only builds an instruction. Required signatures, authority constraints,
 * remaining-account layouts and transaction size still apply. A Treasury PDA
 * can sign only during CPI: use the corresponding protocolAdmin wrapper for
 * governance, rather than sending a cubicPool instruction with a PDA signer.
 */
export function buildContractInstruction<P extends ContractProgram, I extends InstructionName<P>>(
  config: CofferConfig,
  program: P,
  instruction: I,
  args: ContractInstructionArgs<P, I>,
  accounts: ContractInstructionAccounts<P, I>,
  remainingAccounts: AccountMeta[] = [],
): TransactionInstruction {
  const idl = IDLS[program];
  const schema = (idl.instructions as any[]).find((ix) => ix.name === instruction);
  if (!schema) throw new Error(`Unknown ${program} instruction: ${instruction}`);
  validateFields(args, schema.args, idl, `${program}.${instruction}`);
  const supplied = accounts as Record<string, PublicKey>;
  assertObjectFields(supplied, schema.accounts.map((a: any) => a.name), "accounts");
  const keys: AccountMeta[] = schema.accounts.map((a: any) => ({
    pubkey: publicKey(supplied[a.name], `accounts.${a.name}`),
    isSigner: a.signer === true,
    isWritable: a.writable === true,
  }));
  for (const meta of remainingAccounts) {
    if (typeof meta.isSigner !== "boolean" || typeof meta.isWritable !== "boolean") {
      throw new Error("remainingAccounts must contain explicit signer and writable flags");
    }
    keys.push({ ...meta, pubkey: publicKey(meta.pubkey, "remainingAccounts.pubkey") });
  }
  let coder = coders.get(program);
  if (!coder) {
    coder = new BorshInstructionCoder(idl as unknown as Idl);
    coders.set(program, coder);
  }
  return new TransactionInstruction({
    programId: config.programs[program],
    keys,
    data: coder.encode(instruction, args as any),
  });
}

function publicKey(value: any, path: string): PublicKey {
  if (!value || typeof value.toBuffer !== "function") throw new Error(`${path} must be a PublicKey`);
  const bytes = value.toBuffer();
  if (bytes.length !== 32) throw new Error(`${path} must be a 32-byte PublicKey`);
  return new PublicKey(bytes);
}

function assertObjectFields(value: unknown, expected: string[], path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  const names = Object.keys(value);
  for (const key of expected) if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`${path}.${key} is required`);
  for (const key of names) if (!expected.includes(key)) throw new Error(`${path}.${key} is not in the contract ABI`);
}

function validateFields(value: unknown, fields: any[], idl: any, path: string): void {
  assertObjectFields(value, fields.map((f) => f.name), path);
  for (const field of fields) validateType(value[field.name], field.type, idl, `${path}.${field.name}`);
}

function validateType(value: any, type: any, idl: any, path: string): void {
  if (typeof type === "string") {
    if (type === "pubkey") { publicKey(value, path); return; }
    if (type === "bool") { if (typeof value !== "boolean") throw new Error(`${path} must be boolean`); return; }
    if (type === "bytes") { if (!Buffer.isBuffer(value)) throw new Error(`${path} must be a Buffer`); return; }
    const integer = /^([ui])(\d+)$/.exec(type);
    if (integer) {
      const width = Number(integer[2]);
      const signed = integer[1] === "i";
      if (width > 32 ? !BN.isBN(value) : !Number.isSafeInteger(value)) throw new Error(`${path} must be ${width > 32 ? "BN" : "an integer"} (${type})`);
      const n = BN.isBN(value) ? value : new BN(value);
      const min = signed ? new BN(1).shln(width - 1).neg() : new BN(0);
      const max = new BN(1).shln(signed ? width - 1 : width).subn(1);
      if (n.lt(min) || n.gt(max)) throw new Error(`${path} is outside ${type}`);
      return;
    }
    throw new Error(`Unsupported ABI primitive ${type}`);
  }
  if (type.option) { if (value !== null) validateType(value, type.option, idl, path); return; }
  if (type.vec || type.array) {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    if (type.array && value.length !== type.array[1]) throw new Error(`${path} must have ${type.array[1]} entries`);
    value.forEach((v, i) => validateType(v, type.vec ?? type.array[0], idl, `${path}[${i}]`));
    return;
  }
  if (type.defined) {
    const definition = idl.types.find((t: any) => t.name === type.defined.name);
    if (!definition || definition.type.kind !== "struct") throw new Error(`Unsupported ABI type ${type.defined.name}`);
    validateFields(value, definition.type.fields, idl, path);
    return;
  }
  throw new Error(`Unsupported ABI type at ${path}`);
}
