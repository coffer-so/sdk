/**
 * Independent Borsh fixture encoder for tests: encodes IDL-typed values
 * without the SDK builders, Anchor's coders or the manual decoders, so the
 * expected bytes come from a second implementation. Supports every type the
 * v6.1 IDLs use (primitives, bool, pubkey, string, bytes, vec, array,
 * option, defined structs and enums).
 */
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

export function u32le(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
}

export function encodeBorsh(value: any, type: any, idl: any): Buffer {
  if (type === "pubkey") return (value as PublicKey).toBuffer();
  if (type === "bool") return Buffer.from([value ? 1 : 0]);
  if (type === "bytes") return Buffer.concat([u32le(value.length), value]);
  if (type === "string") {
    const b = Buffer.from(value, "utf8");
    return Buffer.concat([u32le(b.length), b]);
  }
  if (typeof type === "string") {
    const bits = Number(type.slice(1));
    const bn = BN.isBN(value) ? value : new BN(value);
    return (type[0] === "i" ? bn.toTwos(bits) : bn).toArrayLike(Buffer, "le", bits / 8);
  }
  if (type.vec) return Buffer.concat([u32le(value.length), ...value.map((v: any) => encodeBorsh(v, type.vec, idl))]);
  if (type.array) return Buffer.concat(value.map((v: any) => encodeBorsh(v, type.array[0], idl)));
  if (type.option) return value === null || value === undefined ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), encodeBorsh(value, type.option, idl)]);
  if (type.defined) {
    const def = idl.types.find((x: any) => x.name === type.defined.name).type;
    if (def.kind === "enum") {
      const [name] = Object.keys(value);
      const tag = def.variants.findIndex((v: any) => v.name === name);
      if (tag < 0) throw new Error(`unknown variant ${name}`);
      return Buffer.concat([Buffer.from([tag]), encodeFields(value[name], def.variants[tag].fields ?? [], idl)]);
    }
    return encodeFields(value, def.fields, idl);
  }
  throw new Error(`unsupported type ${JSON.stringify(type)}`);
}

export function encodeFields(value: any, fields: any[], idl: any): Buffer {
  return Buffer.concat(fields.map((f) => encodeBorsh(value[f.name], f.type, idl)));
}

/** Discriminator + Borsh body of an event, as the program logs it (`Program data: <base64>`). */
export function eventLog(idl: any, name: string, value: any): string {
  const event = idl.events.find((e: any) => e.name === name);
  const fields = idl.types.find((t: any) => t.name === name).type.fields;
  const data = Buffer.concat([Buffer.from(event.discriminator), encodeFields(value, fields, idl)]);
  return `Program data: ${data.toString("base64")}`;
}

/** Discriminator + Borsh body truncated to the first `keep` fields (a pre-upgrade log shape). */
export function truncatedEventLog(idl: any, name: string, value: any, keep: number): string {
  const event = idl.events.find((e: any) => e.name === name);
  const fields = idl.types.find((t: any) => t.name === name).type.fields.slice(0, keep);
  const data = Buffer.concat([Buffer.from(event.discriminator), encodeFields(value, fields, idl)]);
  return `Program data: ${data.toString("base64")}`;
}

export function normalize(value: any): any {
  if (BN.isBN(value)) return value.toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (Buffer.isBuffer(value)) return [...value];
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  return value;
}
