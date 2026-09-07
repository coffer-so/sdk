import { BorshReader, parseCubicPoolEvents, IDLS } from "../src";

test.each(["u8", "u16", "u32", "u64", "i64", "bool", "pubkey"] as const)("%s refuses truncated data", method => {
  const length = {u8:1,u16:2,u32:4,u64:8,i64:8,bool:1,pubkey:32}[method];
  expect(() => new BorshReader(Buffer.alloc(length-1))[method]()).toThrow(/bytes/);
});

test("bounds checks reject invalid skips and oversized vectors before reading", () => {
  for (const count of [-1, 1.5, 9]) expect(() => new BorshReader(Buffer.alloc(8)).skip(count)).toThrow(/bytes/);
  const data = Buffer.alloc(4); data.writeUInt32LE(0xffffffff);
  expect(() => new BorshReader(data).vecU64()).toThrow(/bytes/);
  expect(() => new BorshReader(data).vecPubkey()).toThrow(/bytes/);
  expect(() => new BorshReader(Buffer.from([2])).bool()).toThrow(/bool/);
});

test("short current Swap event becomes Unknown instead of inventing a zero surge fee", () => {
  const discriminator=Buffer.from(IDLS.cubicPool.events.find(e=>e.name==="Swap")!.discriminator);
  // Four public keys, four u64 quantities and one i64 timestamp. The required
  // trailing surge_fee_amount is deliberately missing from this current ABI.
  const data=Buffer.concat([discriminator,Buffer.alloc(4*32+5*8)]);
  expect(parseCubicPoolEvents([`Program data: ${data.toString("base64")}`])[0].kind).toBe("Unknown");
});
