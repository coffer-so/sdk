import { PublicKey } from "@solana/web3.js";
import { CubicPoolClient, getConfig } from "../src";

describe("RPC defaults in config", () => {
  test("mainnet config exposes a no-key fallback endpoint list", () => {
    const cfg = getConfig("mainnet");

    expect(cfg.defaults.rpcEndpoint).toBe("https://solana.drpc.org");
    expect(cfg.defaults.rpcEndpoints).toEqual([
      "https://solana.drpc.org",
      "https://solana-rpc.publicnode.com",
      "https://solana.api.pocket.network",
    ]);
    expect(cfg.defaults.rpcTimeoutMs).toBe(2_000);
  });

  test("rpcEndpoint override is prepended to the default fallback list", () => {
    const cfg = getConfig("mainnet", {
      rpcEndpoint: "https://paid.rpc.example",
    });

    expect(cfg.defaults.rpcEndpoint).toBe("https://paid.rpc.example");
    expect(cfg.defaults.rpcEndpoints).toEqual([
      "https://paid.rpc.example",
      "https://solana.drpc.org",
      "https://solana-rpc.publicnode.com",
      "https://solana.api.pocket.network",
    ]);
  });

  test("rpcEndpoints override replaces the default fallback list", () => {
    const cfg = getConfig("mainnet", {
      rpcEndpoints: ["https://one.rpc", "https://two.rpc"],
      rpcTimeoutMs: 750,
    });

    expect(cfg.defaults.rpcEndpoint).toBe("https://one.rpc");
    expect(cfg.defaults.rpcEndpoints).toEqual(["https://one.rpc", "https://two.rpc"]);
    expect(cfg.defaults.rpcTimeoutMs).toBe(750);
  });

  test("CubicPoolClient uses config RPC defaults when rpc is omitted", () => {
    const cfg = getConfig("mainnet", {
      rpcEndpoints: ["https://one.rpc", "https://two.rpc"],
      rpcTimeoutMs: 750,
    });

    const client = new CubicPoolClient({
      config: cfg,
      poolAddress: PublicKey.default,
    });

    expect(client.rpc.endpoints).toEqual(["https://one.rpc", "https://two.rpc"]);
  });

  test("CubicPoolClient preserves explicit single-endpoint rpc configuration", () => {
    const cfg = getConfig("mainnet", {
      rpcEndpoints: ["https://one.rpc", "https://two.rpc"],
    });

    const client = new CubicPoolClient({
      config: cfg,
      poolAddress: PublicKey.default,
      rpc: { endpoint: "https://explicit.rpc" },
    });

    expect(client.rpc.endpoints).toEqual(["https://explicit.rpc"]);
  });
});
