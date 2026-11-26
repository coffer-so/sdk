import { CofferBackendClient } from "../src";

const client = new CofferBackendClient({ apiEndpoint: "https://example.test" });
const summary = {
  address: "pool-a", poolEnabled: true, tvlUsd: 15, volume24hUsd: 0,
  tokens: [{ mint: "mint", symbol: "AAA", weightBps: 1137 }], boost: null,
};
const entity = {
  poolAddress: "pool-a", poolEnabled: true, tvlUsd: 15, volume24h: 0,
  tokens: [{ mintAddress: "mint", ticker: "AAA", weight: 11.37 }], boost: null,
};
const reply = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

afterEach(() => jest.restoreAllMocks());

test("current pool list follows pagination and returns summaries with basis-point weights", async () => {
  const fetch = jest.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(reply({ success: true, data: [entity], hasMore: true, totalCount: 2 }))
    .mockResolvedValueOnce(reply({ success: true, data: [{ ...entity, poolAddress: "pool-b" }], hasMore: false, totalCount: 2 }));
  expect(await client.listPools()).toEqual({ ok: true, data: [summary, { ...summary, address: "pool-b" }] });
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    "https://example.test/api/pools", "https://example.test/api/pools?limit=1&offset=1",
  ]);
});

test("current single pool returns the same summary as the list", async () => {
  jest.spyOn(globalThis, "fetch").mockResolvedValueOnce(reply({ success: true, data: entity }));
  expect(await client.getPool("pool-a")).toEqual({ ok: true, data: summary });
});

test("legacy flat responses preserve fields and existing basis-point weights", async () => {
  const legacy = { ...summary, feeApr7d: 5, custom: "preserved" };
  jest.spyOn(globalThis, "fetch").mockResolvedValueOnce(reply([legacy])).mockResolvedValueOnce(reply(legacy));
  expect(await client.listPools()).toEqual({ ok: true, data: [legacy] });
  expect(await client.getPool("pool-a")).toEqual({ ok: true, data: legacy });
});

test("malformed payloads return parse errors and pagination terminates", async () => {
  jest.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(reply({ data: [], hasMore: true }))
    .mockResolvedValueOnce(reply("invalid"))
    .mockResolvedValueOnce(reply({ data: { ...entity, tokens: [{ ticker: "ABC" }] } }));
  expect(await client.listPools()).toMatchObject({ ok: false, error: { code: "parse_failure" } });
  expect(await client.getPool("pool-a")).toMatchObject({ ok: false, error: { code: "parse_failure" } });
  expect(await client.getPool("pool-a")).toMatchObject({ ok: false, error: { code: "parse_failure" } });
});
