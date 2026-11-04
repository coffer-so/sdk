import { BorshAccountsCoder, BorshEventCoder, Idl } from "@coral-xyz/anchor";
import { IdlCoder } from "@coral-xyz/anchor/dist/cjs/coder/borsh/idl";
import { IDLS } from "../idl";
import { ContractAccountMap, ContractEventMap, ContractProgram } from "../types/contracts";

export type ContractEvent = {
  [P in ContractProgram]: {
    [E in keyof ContractEventMap[P]]: { program: P; kind: E; data: ContractEventMap[P][E] }
  }[keyof ContractEventMap[P]]
}[ContractProgram];

const accountCoders = new Map<ContractProgram, BorshAccountsCoder>();
const eventCoders = new Map<ContractProgram, BorshEventCoder>();
const eventLayouts = new Map<string, ReturnType<typeof IdlCoder.typeDefLayout>>();

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
 *
 * Strict (v6.1, T11): Anchor's layout reader tolerates a payload cut inside
 * its last fields (it reads the missing bytes as zeros), so the decoded
 * value is re-encoded and must reproduce the payload byte for byte; trailing
 * bytes after a complete payload are ignored. A truncated log is therefore
 * `null`, never a half value.
 */
export function decodeContractEvent(base64: string, program?: ContractProgram): ContractEvent | null {
  const programs = program ? [program] : Object.keys(IDLS) as ContractProgram[];
  const raw = Buffer.from(base64, "base64");
  if (raw.length < 8 || raw.length > 32768) return null;
  for (const candidate of programs) {
    let coder = eventCoders.get(candidate);
    if (!coder) {
      coder = new BorshEventCoder(IDLS[candidate] as unknown as Idl);
      eventCoders.set(candidate, coder);
    }
    try {
      const result = coder.decode(base64);
      if (!result) continue;
      // Use the same installed Anchor source-IDL layout with a bounded buffer
      // sized to the actual payload. BorshTypesCoder.encode hardcodes1000 bytes;
      // valid N10 PoolInitializedV2 events are1135 bytes including discriminator.
      const payload = raw.subarray(8), key = candidate + ":" + result.name;
      let layout = eventLayouts.get(key);
      if (!layout) {
        const idl = IDLS[candidate] as unknown as Idl;
        const typeDef = idl.types?.find(type => type.name === result.name);
        if (!typeDef || !idl.types) return null;
        layout = IdlCoder.typeDefLayout({ typeDef, types: idl.types });
        eventLayouts.set(key, layout);
      }
      const scratch = Buffer.alloc(payload.length);
      const encoded = scratch.subarray(0, layout.encode(result.data, scratch));
      if (encoded.length > payload.length || !encoded.equals(payload.subarray(0, encoded.length))) return null;
      return { program: candidate, kind: result.name, data: result.data } as ContractEvent;
    } catch { /* Try the other ABI, or report an undecodable event. */ }
  }
  return null;
}

/** Parse every current event; fields and names match the shipped contract IDLs.
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
