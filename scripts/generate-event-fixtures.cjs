// Generate Borsh event fixtures from the vendored IDLs (v6.1, T11).
//
// For every event of the three programs: deterministic sample values (seeded
// by the event name), encoded by an INDEPENDENT Borsh encoder (no SDK code,
// no Anchor coder), written to tests/fixtures/events/<program>.json as
// `{ name, variant, discriminator, base64, value }`. Events with an
// `Option<T>` field get a `some` and a `none` variant. The decoder tests
// round-trip these: bytes → decode → re-encode → the same bytes.
//
// Usage: node scripts/generate-event-fixtures.cjs [--check]
const fs = require("fs");
const path = require("path");
const { PublicKey } = require("@solana/web3.js");

const root = path.resolve(__dirname, "..");
const programs = { cofferPool: "coffer_pool", protocolAdmin: "protocol_admin", singleTokenLiquidity: "single_token_liquidity" };
const CONTRACTS_COMMIT = "409067d";
/** i64 fields the typed decoders expose as JS numbers (Clock seconds): kept inside ±2^40. */
const SMALL_I64 = new Set(["timestamp", "plan_quoted_at", "window_start_timestamp"]);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash32(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

function sampler(seed) {
  const rnd = mulberry32(seed);
  const int = (max) => Math.floor(rnd() * max);
  const big = (bits) => { let v = 0n; for (let i = 0; i < bits; i += 16) v = (v << 16n) | BigInt(int(65536)); return v & ((1n << BigInt(bits)) - 1n); };
  const sample = (type, idl, fieldName) => {
    if (type === "pubkey") { const b = Buffer.alloc(32); for (let i = 0; i < 32; i++) b[i] = int(256); return new PublicKey(b).toBase58(); }
    if (type === "bool") return rnd() < 0.5;
    if (type === "bytes") return Array.from({ length: 1 + int(3) }, () => int(256));
    if (type === "string") return ["Coffer LP", "cLP-ÜSDX", "https://arweave.net/äbc", "Пул"][int(4)] + String(int(100));
    if (typeof type === "string") {
      const bits = Number(type.slice(1));
      if (type[0] === "i") {
        if (SMALL_I64.has(fieldName)) { const v = big(40); return (rnd() < 0.25 ? -v : v).toString(); }
        const v = big(bits - 1); return (rnd() < 0.5 ? -v - 1n : v).toString();
      }
      if (bits >= 64) return big(bits).toString();
      return int(2 ** bits);
    }
    if (type.vec) { const n = 2 + int(2); return Array.from({ length: n }, () => sample(type.vec, idl, fieldName)); }
    if (type.array) return Array.from({ length: type.array[1] }, () => sample(type.array[0], idl, fieldName));
    if (type.option) return sample(type.option, idl, fieldName);
    if (type.defined) {
      const def = idl.types.find((x) => x.name === type.defined.name).type;
      if (def.kind === "enum") { const v = def.variants[def.variants.length - 1]; return { [v.name]: fields(v.fields || [], idl) }; }
      return fields(def.fields, idl);
    }
    throw new Error("unsupported " + JSON.stringify(type));
  };
  const fields = (list, idl) => Object.fromEntries(list.map((f) => [f.name, sample(f.type, idl, f.name)]));
  return { sample, fields };
}

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
function encode(value, type, idl) {
  if (type === "pubkey") return new PublicKey(value).toBuffer();
  if (type === "bool") return Buffer.from([value ? 1 : 0]);
  if (type === "bytes") return Buffer.concat([u32(value.length), Buffer.from(value)]);
  if (type === "string") { const b = Buffer.from(value, "utf8"); return Buffer.concat([u32(b.length), b]); }
  if (typeof type === "string") {
    const bits = Number(type.slice(1));
    let v = BigInt(value);
    if (v < 0n) v += 1n << BigInt(bits);
    const out = Buffer.alloc(bits / 8);
    for (let i = 0; i < out.length; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
    return out;
  }
  if (type.vec) return Buffer.concat([u32(value.length), ...value.map((v) => encode(v, type.vec, idl))]);
  if (type.array) return Buffer.concat(value.map((v) => encode(v, type.array[0], idl)));
  if (type.option) return value === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), encode(value, type.option, idl)]);
  if (type.defined) {
    const def = idl.types.find((x) => x.name === type.defined.name).type;
    if (def.kind === "enum") {
      const [name] = Object.keys(value);
      const tag = def.variants.findIndex((v) => v.name === name);
      return Buffer.concat([Buffer.from([tag]), encodeFields(value[name], def.variants[tag].fields || [], idl)]);
    }
    return encodeFields(value, def.fields, idl);
  }
  throw new Error("unsupported " + JSON.stringify(type));
}
const encodeFields = (value, list, idl) => Buffer.concat(list.map((f) => encode(value[f.name], f.type, idl)));

const outputs = {};
for (const [program, file] of Object.entries(programs)) {
  const idl = JSON.parse(fs.readFileSync(path.join(root, "src/idl", file + ".json"), "utf8"));
  const events = [];
  for (const event of idl.events) {
    const list = idl.types.find((t) => t.name === event.name).type.fields;
    const optional = list.filter((f) => typeof f.type === "object" && f.type.option).map((f) => f.name);
    const variants = optional.length ? ["some", "none"] : ["full"];
    for (const variant of variants) {
      const value = sampler(hash32(`${program}:${event.name}:${variant}`)).fields(list, idl);
      if (variant === "none") for (const name of optional) value[name] = null;
      const data = Buffer.concat([Buffer.from(event.discriminator), encodeFields(value, list, idl)]);
      events.push({ name: event.name, variant, discriminator: Buffer.from(event.discriminator).toString("hex"), base64: data.toString("base64"), value });
    }
  }
  outputs[program] = {
    $comment: `Generated by scripts/generate-event-fixtures.cjs from src/idl/${file}.json (contracts ${CONTRACTS_COMMIT}); u64/i64 as decimal strings, pubkeys base58, bytes as byte arrays. Do not edit.`,
    program, contracts: CONTRACTS_COMMIT, events,
  };
}

const dir = path.join(root, "tests/fixtures/events");
let stale = false;
for (const [program, output] of Object.entries(outputs)) {
  const file = path.join(dir, `${programs[program]}.json`);
  const text = JSON.stringify(output, null, 1) + "\n";
  if (process.argv.includes("--check")) {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text) { stale = true; process.stderr.write(`${file} is stale\n`); }
  } else {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, text);
    process.stdout.write(`${file}: ${output.events.length} fixtures\n`);
  }
}
if (stale) { process.stderr.write("Run node scripts/generate-event-fixtures.cjs\n"); process.exitCode = 1; }
