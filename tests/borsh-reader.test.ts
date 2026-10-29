import { BorshReader, parseCofferPoolEvents, IDLS } from "../src";

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

test("short current SwapV2 event becomes Unknown instead of inventing zero slots", () => {
  const discriminator=Buffer.from(IDLS.cofferPool.events.find(e=>e.name==="SwapV2")!.discriminator);
  // Two public keys, the two indices and the twenty scalar cascade fields; the
  // four SlotState blocks, the timestamp and the Option tag are missing.
  const data=Buffer.concat([discriminator,Buffer.alloc(2*32+2+8*3+4*2+2*2+8*9)]);
  expect(parseCofferPoolEvents([`Program data: ${data.toString("base64")}`])[0].kind).toBe("Unknown");
});

test("Option / Vec<bool> / fixed array readers", () => {
  const r = new BorshReader(Buffer.from([1, 7, 0, 2, 0, 0, 0, 1, 0, 9, 8]));
  expect(r.option((x) => x.u8())).toBe(7);
  expect(r.option((x) => x.u8())).toBeNull();
  expect(r.vecBool()).toEqual([true, false]);
  expect([...r.u8Array(2)]).toEqual([9, 8]);
  expect(() => new BorshReader(Buffer.from([2])).option((x) => x.u8())).toThrow(/Option tag/);
  expect(() => new BorshReader(Buffer.from([1])).option((x) => x.u8())).toThrow(/bytes/);
  expect(() => new BorshReader(Buffer.from([5, 0, 0, 0, 1])).vecBool()).toThrow(/bytes/);
  expect(() => new BorshReader(Buffer.from([2, 0, 0, 0, 1, 3])).vecBool()).toThrow(/bool/);
  expect(() => new BorshReader(Buffer.from([0xff, 0xff, 0xff, 0xff])).vec((x) => x.u8())).toThrow(/vector length/);
});
