import { BorshAccountsCoder, BorshEventCoder, Idl } from "@coral-xyz/anchor";
import { IDLS } from "../idl";
import { ContractAccountMap, ContractEventMap, ContractProgram } from "../types/contracts";

export type ContractEvent = {
  [P in ContractProgram]: {
    [E in keyof ContractEventMap[P]]: { program: P; kind: E; data: ContractEventMap[P][E] }
  }[keyof ContractEventMap[P]]
}[ContractProgram];

const accountCoders = new Map<ContractProgram, BorshAccountsCoder>();
const eventCoders = new Map<ContractProgram, BorshEventCoder>();

/** Decode any account in the current ABI, including Config and Treasury.
 * Fields retain IDL snake_case names; u64/i64 values remain BN without loss.
 * The discriminator is verified. Check RPC account ownership separately.
 */
export function decodeContractAccount<P extends ContractProgram, A extends keyof ContractAccountMap[P] & string>(
  program: P, account: A, data: Buffer,
): ContractAccountMap[P][A] {
  let coder = accountCoders.get(program);
  if (!coder) {
    coder = new BorshAccountsCoder(IDLS[program] as unknown as Idl);
    accountCoders.set(program, coder);
  }
  const expectedSize = coder.size(account);
  if (data.length !== expectedSize) throw new Error(`${account} has ${data.length} bytes; expected ${expectedSize} for the current ABI`);
  return coder.decode(account, data);
}

/** Decode the payload following `Program data:` using all current event fields.
 * Returns null for an unknown or malformed event. `program` limits decoding to
 * one ABI when the emitting program is known from the transaction invoke stack.
 */
export function decodeContractEvent(base64: string, program?: ContractProgram): ContractEvent | null {
  const programs = program ? [program] : Object.keys(IDLS) as ContractProgram[];
  for (const candidate of programs) {
    let coder = eventCoders.get(candidate);
    if (!coder) {
      coder = new BorshEventCoder(IDLS[candidate] as unknown as Idl);
      eventCoders.set(candidate, coder);
    }
    try {
      const result = coder.decode(base64);
      if (result) return { program: candidate, kind: result.name, data: result.data } as ContractEvent;
    } catch { /* Try the other ABI, or report an undecodable event. */ }
  }
  return null;
}

/** Parse all 60 known events; fields and names match the shipped contract IDLs.
 * This is decoding, not proof of the emitting program's identity. Consumers
 * must verify transaction success and program provenance before indexing.
 */
export function parseContractEvents(logs: string[], program?: ContractProgram): ContractEvent[] {
  const events: ContractEvent[] = [];
  for (const line of logs) {
    const payload = /^Program data:\s+(.+)$/.exec(line)?.[1];
    if (!payload) continue;
    const event = decodeContractEvent(payload, program);
    if (event) events.push(event);
  }
  return events;
}
