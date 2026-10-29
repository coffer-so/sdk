/**
 * T18 (v6.1) — positive tests for the BPT → LP / Cubic → Coffer rename and
 * the T19 removal of the Token-2022 extension policy.
 *
 * What these pin: the renamed public surface exists, on-chain facts that must
 * NOT move with the rename (seed bytes, account/event discriminators, byte
 * offsets, error codes) did not move, the one deliberately re-cut
 * instruction (`initialize_pool`) carries its new discriminator, and the
 * deploy builder no longer encodes the removed `Option<u64>` argument.
 */
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { BorshAccountsCoder, Idl } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import * as sdk from "../src";
import {
  AdminClient,
  COFFER_POOL_IDL,
  CofferPoolClient,
  IDLS,
  LP_DECIMALS,
  LP_MINT_SEED,
  MIN_LP_SUPPLY,
  MintExtension,
  NETWORK_PROGRAMS,
  POOL_SEED,
  POOL_V4_LEN,
  PROTOCOL_ADMIN_IDL,
  PoolFactoryClient,
  PoolInfo,
  SINGLE_TOKEN_LIQUIDITY_IDL,
  buildContractInstruction,
  buildInitializePoolIx,
  decodeContractAccount,
  decodeContractEvent,
  decodePoolAccount,
  deriveLpMint,
  derivePoolPda,
  describeProgramError,
  getConfig,
  mintExtensionName,
  parseCofferPoolEvents,
  parseContractEvents,
  parseMintExtensions,
  unsupportedMintExtensions,
} from "../src";

const cfg = getConfig("mainnet");
const pk = () => Keypair.generate().publicKey;
const sha8 = (preimage: string) => createHash("sha256").update(preimage).digest().subarray(0, 8);
const hex = (b: Buffer | number[]) => Buffer.from(b).toString("hex");
const u64 = (v: number | BN) => new BN(v).toArrayLike(Buffer, "le", 8);
const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const u8 = (v: number) => Buffer.from([v]);
const vecU64 = (xs: BN[]) => Buffer.concat([u32(xs.length), ...xs.map(u64)]);
const log = (disc: Buffer | number[], payload: Buffer) => `Program data: ${Buffer.concat([Buffer.from(disc), payload]).toString("base64")}`;
const ix = (name: string, idl: any = COFFER_POOL_IDL) => (idl.instructions as any[]).find((c) => c.name === name);
const ev = (name: string, idl: any = COFFER_POOL_IDL) => (idl.events as any[]).find((c) => c.name === name);
const acct = (name: string, idl: any) => (idl.accounts as any[]).find((c) => c.name === name);

const POOL_DISCRIMINATOR = Buffer.from([137, 210, 42, 22, 209, 156, 43, 78]); // sha256("account:CubicPool")[..8], pinned

/** 1683-byte pool account: token_count 0, every slot zero, chosen tail bytes. */
function poolBytes(tail: { deprecated: BN; maxLev: number; minLev: number }): Buffer {
  const buf = Buffer.alloc(POOL_V4_LEN);
  POOL_DISCRIMINATOR.copy(buf, 0);
  pk().toBuffer().copy(buf, 8); // config
  buf[40] = 254; // bump
  buf[41] = 0; // token_count
  u64(tail.deprecated).copy(buf, 1651);
  u32(tail.maxLev).copy(buf, 1659);
  u32(tail.minLev).copy(buf, 1663);
  return buf;
}

function poolFixture(): PoolInfo {
  const tokens = [0, 1].map((index) => ({
    index, mint: pk(), tokenProgram: TOKEN_PROGRAM_ID, decimals: 9, weightBps: 5000,
    virtualBalance: new BN(1_000_000), actualBalance: new BN(1_000_000), protocolFeesOwed: new BN(0), vault: pk(),
    concentration: 1, isActive: true, maxSelloffPct: 0, extensions: [], unsupportedExtensions: [], transferFee: null,
  }));
  return {
    address: pk(), config: pk(), bump: 1, tokenCount: 2, poolId: new BN(1), lpMint: pk(), lpTokenProgram: TOKEN_PROGRAM_ID,
    lpTotalSupply: new BN(1_000_000), swapFeeRate: 3000, protocolFeeRate: 2000, poolEnabled: true, swapsEnabled: true,
    createdAt: 0, lookupTable: PublicKey.default, syncedAt: 0, unsupportedTokenIndices: [], tokens, poolAdmin: pk(),
  };
}

describe("T18 package surface", () => {
  const pkgJson = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));

  test("package is @coffer_so/sdk-v6 at 0.2.0 (breaking rename, no aliases)", () => {
    expect(pkgJson.name).toBe("@coffer_so/sdk-v6");
    expect(pkgJson.version).toBe("0.2.0");
  });

  test("renamed clients and helpers are exported from the package root", () => {
    for (const name of [
      "CofferPoolClient", "CofferBackendClient", "PoolFactoryClient", "AdminClient", "PlannedZapClient",
      "parseCofferPoolEvents", "deriveLpMint", "derivePoolPda", "buildInitializePoolIx", "buildDeployPoolTx",
      "calcLpOutGivenExactTokensIn", "calcTokensOutGivenLpIn", "calcJoinRatioAndLp", "calcEffectiveLpBurn",
      "POOL_SEED", "LP_MINT_SEED", "LP_DECIMALS", "MIN_LP_SUPPLY", "COFFER_POOL_IDL", "IDLS",
    ]) {
      expect(typeof (sdk as any)[name]).not.toBe("undefined");
    }
  });

  test("program-id table and config use the `cofferPool` key", () => {
    expect(Object.keys(NETWORK_PROGRAMS.mainnet).sort()).toEqual(["cofferPool", "protocolAdmin", "singleTokenLiquidity"]);
    expect(cfg.programs.cofferPool.toBase58()).toBe("6DhW1Ek5WLJSnFSpBBGYeVRbRiWtCXHbqyGJ6LcVZgH9");
    expect(sdk.programId(cfg, "cofferPool").equals(cfg.programs.cofferPool)).toBe(true);
    expect(Object.keys(IDLS).sort()).toEqual(["cofferPool", "protocolAdmin", "singleTokenLiquidity"]);
  });

  test("constants keep their on-chain values under the new names", () => {
    expect(LP_DECIMALS).toBe(9);
    expect(MIN_LP_SUPPLY).toBe(1_000n);
  });

  test("the mint TLV parser survives T19 (data source for the frontend extension alert)", () => {
    expect(typeof parseMintExtensions).toBe("function");
    expect(mintExtensionName(MintExtension.PermanentDelegate)).toBe("PermanentDelegate");
    expect(mintExtensionName(MintExtension.TransferHook)).toBe("TransferHook");
    expect(unsupportedMintExtensions.length).toBe(1); // the policy bitmap argument is gone
  });
});

describe("T18 PDA seeds are the legacy byte strings", () => {
  test("POOL_SEED and LP_MINT_SEED bytes are unchanged (27 mainnet pools derive from them)", () => {
    expect(POOL_SEED.toString("ascii")).toBe("cubic_pool");
    expect(LP_MINT_SEED.toString("ascii")).toBe("bpt_mint");
  });

  test("derivePoolPda matches a manual derivation over b\"cubic_pool\"", () => {
    const config = pk();
    const poolId = new BN(42);
    const [expected, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from("cubic_pool"), config.toBuffer(), poolId.toArrayLike(Buffer, "le", 8)],
      cfg.programs.cofferPool,
    );
    const [pool, poolBump] = derivePoolPda(cfg.programs.cofferPool, config, poolId);
    expect(pool.equals(expected)).toBe(true);
    expect(poolBump).toBe(bump);
  });

  test("deriveLpMint matches a manual derivation over b\"bpt_mint\"", () => {
    const pool = pk();
    const [expected] = PublicKey.findProgramAddressSync([Buffer.from("bpt_mint"), pool.toBuffer()], cfg.programs.cofferPool);
    expect(deriveLpMint(cfg.programs.cofferPool, pool)[0].equals(expected)).toBe(true);
  });

  test("PoolFactoryClient.buildDeployPoolTx reports the same lpMint as deriveLpMint", () => {
    const factory = new PoolFactoryClient({ config: cfg });
    const configKey = pk();
    const result = factory.buildDeployPoolTx({
      payer: pk(), configKey, poolId: new BN(7), tokens: [pk(), pk()], weightsBps: [5000, 5000],
      virtualBalances: [new BN(1), new BN(1)], swapFeeRate: 3000, lpMetadata: { name: "Coffer LP", symbol: "cLP", uri: "https://coffer.so/lp.json" },
    });
    if (!result.ok) throw new Error(result.error.humanMessage);
    const [pool] = derivePoolPda(cfg.programs.cofferPool, configKey, new BN(7));
    expect(result.data.pool.equals(pool)).toBe(true);
    expect(result.data.lpMint.equals(deriveLpMint(cfg.programs.cofferPool, pool)[0])).toBe(true);
  });
});

describe("T18 IDL: names renamed, discriminators pinned", () => {
  test("coffer_pool IDL metadata carries the new program name and the v6 mainnet address", () => {
    expect((COFFER_POOL_IDL as any).metadata.name).toBe("coffer_pool");
    expect((COFFER_POOL_IDL as any).address).toBe("6DhW1Ek5WLJSnFSpBBGYeVRbRiWtCXHbqyGJ6LcVZgH9");
  });

  test("CofferPool / CofferPoolConfig / Treasury keep the pre-rename account discriminators", () => {
    expect(hex(acct("CofferPool", COFFER_POOL_IDL).discriminator)).toBe("89d22a16d19c2b4e");
    expect(hex(acct("CofferPoolConfig", COFFER_POOL_IDL).discriminator)).toBe("041df30a8e40e876");
    expect(hex(acct("Treasury", PROTOCOL_ADMIN_IDL).discriminator)).toBe("eeef7bee5901a8fd");
    // The STLD IDL repeats both pool schemas; they must agree.
    expect(hex(acct("CofferPool", SINGLE_TOKEN_LIQUIDITY_IDL).discriminator)).toBe("89d22a16d19c2b4e");
    expect(hex(acct("CofferPoolConfig", SINGLE_TOKEN_LIQUIDITY_IDL).discriminator)).toBe("041df30a8e40e876");
  });

  test("the pinned account discriminators are the OLD struct-name hashes, not the new ones", () => {
    expect(hex(sha8("account:CubicPool"))).toBe("89d22a16d19c2b4e");
    expect(hex(sha8("account:CubicPoolConfig"))).toBe("041df30a8e40e876");
  });

  test("initialize_pool carries the re-cut discriminator; the four v6 args are followed by the v6.1 tail", () => {
    expect(hex(ix("initialize_pool").discriminator)).toBe("5fb40aac54aee828");
    expect(hex(ix("initialize_pool").discriminator)).toBe(hex(sha8("global:initialize_pool")));
    expect(ix("initialize_pool").args.map((a: any) => a.name)).toEqual([
      "normalized_weights", "initial_virtual_balances", "swap_fee_rate", "pool_id",
      "lp_metadata", "creator_fee_bps", "deposit_fee_bps", "withdraw_fee_bps", "hook_config",
    ]);
  });

  test.each([
    ["swap", "f8c69e91e17587c8"],
    ["add_liquidity", "b59d59438fb63448"],
    ["remove_liquidity", "5055d14818ceb16c"],
    ["initialize_pool_alt", "fb874202f4490c90"],
    ["initialize_config", "d07f1501c2bec446"],
    ["set_range_manager", "6766ad7008022584"],
    ["set_range_manager_config", "67d300c8a4bdf5cd"],
    ["range_manager_update", "f5b72345c80aac2c"],
  ])("%s keeps its 0.1.x discriminator %s (positional args; old clients still work)", (name, pinned) => {
    expect(hex(ix(name).discriminator)).toBe(pinned);
  });

  test("every instruction discriminator in all three IDLs is sha256(global:<name>)", () => {
    for (const idl of Object.values(IDLS)) {
      for (const candidate of (idl as any).instructions) {
        expect(hex(candidate.discriminator)).toBe(hex(sha8(`global:${candidate.name}`)));
      }
    }
  });

  test("every event discriminator is sha256(event:<Name>); T18 renamed none, T11 re-cut the changed payloads", () => {
    for (const idl of Object.values(IDLS)) {
      for (const candidate of (idl as any).events) {
        expect(hex(candidate.discriminator)).toBe(hex(sha8(`event:${candidate.name}`)));
      }
    }
    // T18 kept these; T11 re-cut them (the legacy hashes are pinned in parsers/eventPins.ts).
    expect(hex(sha8("event:PoolInitialized"))).toBe("6476ad570cc6fee5");
    expect(hex(sha8("event:LiquidityAdded"))).toBe("9a1add6cee40d9a1");
    expect(hex(sha8("event:LiquidityRemoved"))).toBe("e169d8277c74a9bd");
    expect(hex(ev("PoolInitializedV2").discriminator)).toBe("a5d9f342e388a1f3");
    expect(hex(ev("LiquidityAddedV2").discriminator)).toBe("32430f2490367820");
    expect(hex(ev("LiquidityRemovedV2").discriminator)).toBe("e67f3f261c2e9d07");
  });

  test("IDL field / account / arg names use lp_* and coffer_*", () => {
    expect(ix("add_liquidity").args.map((a: any) => a.name)).toEqual(["token_amounts", "minimum_lp_amount"]);
    expect(ix("add_liquidity").accounts.map((a: any) => a.name)).toEqual(["pool", "lp_mint", "user_lp_account", "user", "token_program"]);
    expect(ix("remove_liquidity").args.map((a: any) => a.name)).toEqual(["lp_amount", "minimum_token_amounts"]);
    expect(ix("deposit_single_token_planned", SINGLE_TOKEN_LIQUIDITY_IDL).accounts.map((a: any) => a.name)).toContain("coffer_pool_program");
    expect(ix("pool_set_pool_enabled", PROTOCOL_ADMIN_IDL).accounts.map((a: any) => a.name)).toContain("coffer_pool_program");
    const poolInit = (COFFER_POOL_IDL as any).types.find((t: any) => t.name === "PoolInitializedV2").type.fields.map((f: any) => f.name);
    expect(poolInit.slice(0, 6)).toEqual(["pool", "config", "pool_id", "pool_admin", "lp_mint", "lp_token_program"]);
    expect(poolInit).toEqual(expect.arrayContaining(["lp_name", "lp_symbol", "lp_uri"])); // v6.1 T1 metadata (no banned_extensions since T19)
  });

  test("error names are renamed while their numeric codes stay", () => {
    expect(describeProgramError(6007)).toMatchObject({ name: "InsufficientLpOut", sdkCode: "slippage_exceeded" });
    expect(describeProgramError(6017)).toMatchObject({ name: "InvalidLpAmount", sdkCode: "invalid_input" });
    expect(describeProgramError(6019, "singleTokenLiquidity")?.name).toBe("InsufficientLp");
    expect(describeProgramError(6020, "singleTokenLiquidity")?.name).toBe("InvalidLpMint");
    expect(describeProgramError(6021, "singleTokenLiquidity")?.name).toBe("InvalidCofferPoolProgram");
    expect(describeProgramError(6022, "singleTokenLiquidity")?.name).toBe("InvalidUserLpAccount");
    expect(describeProgramError(6023, "singleTokenLiquidity")?.name).toBe("InvalidHelperLpAccount");
    // T19: the error slot survives (append-only table) but is documented as never raised.
    expect(describeProgramError(6025)?.name).toBe("BannedExtension");
  });

  test("ABI size after v6.1: 107 instructions and 79 events across the three programs (59 / 59 after T19)", () => {
    const programs = Object.values(IDLS) as any[];
    expect(programs.reduce((n, idl) => n + idl.instructions.length, 0)).toBe(107);
    expect(programs.reduce((n, idl) => n + idl.events.length, 0)).toBe(79);
  });
});

describe("T18/T19 account layouts", () => {
  test("pool decoder keeps every byte offset: deprecated slot at 1651, leverage bounds at 1659/1663", () => {
    const raw = decodePoolAccount(poolBytes({ deprecated: new BN("104890890"), maxLev: 30_000, minLev: 5_000 }));
    expect(raw.deprecatedBannedExtensions.toString()).toBe("104890890");
    expect(raw.rangeManagerMaxLeverageBps).toBe(30_000);
    expect(raw.rangeManagerMinLeverageBps).toBe(5_000);
    expect(raw.reserved).toHaveLength(16);
  });

  test("a pool written by the pre-T19 program (non-zero bitmap at 1651) still decodes and is not interpreted", () => {
    const raw = decodePoolAccount(poolBytes({ deprecated: new BN("9223372036854776320"), maxLev: 0, minLev: 0 }));
    expect(raw.deprecatedBannedExtensions.toString()).toBe("9223372036854776320");
    expect(raw.tokenCount).toBe(0);
  });

  test("generic decoder reads the 202-byte config with a 16-byte deprecated policy blob before reserved[112]", async () => {
    const coder = new BorshAccountsCoder(COFFER_POOL_IDL as unknown as Idl);
    const policy = Array.from({ length: 16 }, (_, i) => i + 1);
    const state = {
      protocol_admin: pk(), pending_protocol_admin: pk(), default_protocol_fee_rate: 300,
      _deprecated_extension_policy: policy, reserved: Array(112).fill(0),
    };
    const encoded = Buffer.alloc(202);
    const body = await coder.encode("CofferPoolConfig", state);
    body.copy(encoded);
    expect(body.length).toBe(202);
    expect(hex(encoded.subarray(0, 8))).toBe("041df30a8e40e876");
    expect([...encoded.subarray(74, 90)]).toEqual(policy);
    const decoded = decodeContractAccount("cofferPool", "CofferPoolConfig", encoded) as any;
    expect([...decoded._deprecated_extension_policy]).toEqual(policy);
    expect(decoded.default_protocol_fee_rate).toBe(300);
  });

  test("generic CofferPool decoding agrees with the manual decoder on the deprecated slot", () => {
    // The generic (strict-size) decoder wants the 2304-byte v6.1 account; the legacy bytes are its prefix.
    const buf = Buffer.alloc(2304); poolBytes({ deprecated: new BN(6), maxLev: 1, minLev: 2 }).copy(buf); buf[1683] = 1;
    const decoded = decodeContractAccount("cofferPool", "CofferPool", buf) as any;
    expect(decoded._deprecated_banned_extensions.toNumber()).toBe(6);
    expect(decoded.range_manager_max_leverage_bps).toBe(1);
    expect(decodePoolAccount(buf).deprecatedBannedExtensions.toNumber()).toBe(6);
  });
});

describe("T19 deploy builder encodes no Option<u64> policy argument", () => {
  const LP_META = { name: "Coffer LP", symbol: "cLP", uri: "https://coffer.so/lp.json" };
  const LP_META_LEN = 12 + LP_META.name.length + LP_META.symbol.length + LP_META.uri.length;
  const params = () => ({
    payer: pk(), configKey: pk(), poolId: new BN(99), tokens: [pk(), pk(), pk()],
    weightsBps: [2000, 3000, 5000], virtualBalances: [new BN(1), new BN(2), new BN(3)], swapFeeRate: 3000, lpMetadata: LP_META,
  });

  test("instruction data is disc + Vec<u64> + Vec<u64> + u32 + u64 (pool_id) + the v6.1 tail (lp_metadata, 3 × u16, Option<HookConfig> = None)", () => {
    const p = params();
    const built = buildInitializePoolIx(cfg, p);
    const n = p.tokens.length;
    const prefix = 8 + (4 + 8 * n) + (4 + 8 * n) + 4 + 8;
    expect(built.data.length).toBe(prefix + LP_META_LEN + 2 + 2 + 2 + 1);
    expect(hex(built.data.subarray(0, 8))).toBe("5fb40aac54aee828");
    expect(built.data.subarray(prefix - 8, prefix).equals(u64(99))).toBe(true);
    expect(built.data[built.data.length - 1]).toBe(0); // no hook
  });

  test("hand-built data equals the IDL-driven encoder's data for initialize_pool", () => {
    const p = params();
    const built = buildInitializePoolIx(cfg, p);
    const [pool] = derivePoolPda(cfg.programs.cofferPool, p.configKey, p.poolId);
    const [lpMint] = deriveLpMint(cfg.programs.cofferPool, pool);
    const generic = buildContractInstruction(cfg, "cofferPool", "initialize_pool", {
      normalized_weights: p.weightsBps.map((w) => new BN(w)), initial_virtual_balances: p.virtualBalances,
      swap_fee_rate: p.swapFeeRate, pool_id: p.poolId, lp_metadata: LP_META, creator_fee_bps: 0, deposit_fee_bps: 0, withdraw_fee_bps: 0, hook_config: null,
    }, {
      config: p.configKey, pool, lp_mint: lpMint, payer: p.payer, lp_token_program: TOKEN_2022_PROGRAM_ID,
      associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID, system_program: SystemProgram.programId,
    });
    expect(built.data.equals(generic.data)).toBe(true);
    expect(built.keys[1].pubkey.equals(pool)).toBe(true);
    expect(built.keys[2].pubkey.equals(lpMint)).toBe(true);
  });

  test("add_liquidity through the generic encoder accepts the renamed arg and account names", () => {
    const pool = pk();
    const [lpMint] = deriveLpMint(cfg.programs.cofferPool, pool);
    const built = buildContractInstruction(cfg, "cofferPool", "add_liquidity",
      { token_amounts: [new BN(1), new BN(2)], minimum_lp_amount: new BN(3) },
      { pool, lp_mint: lpMint, user_lp_account: pk(), user: pk(), token_program: TOKEN_PROGRAM_ID });
    expect(hex(built.data.subarray(0, 8))).toBe("b59d59438fb63448");
    expect(built.data.subarray(8).equals(Buffer.concat([vecU64([new BN(1), new BN(2)]), u64(3)]))).toBe(true);
  });
});

describe("T18 event parsers expose lp_* / lp* fields", () => {
  const pool = pk(), user = pk();
  const vec2 = (a: number, b: number) => vecU64([new BN(a), new BN(b)]);

  test("LiquidityAddedV2 → lpAmount (camelCase API) and lp_amount (IDL API)", () => {
    const payload = Buffer.concat([
      pool.toBuffer(), user.toBuffer(), Buffer.from([0]), vec2(10, 20), vec2(10, 20), vec2(0, 0), u64(5), u64(0), Buffer.from([0, 0]), u64(1_000), u64(1_005),
      vec2(100, 200), vec2(101, 202), vec2(50, 100), vec2(60, 120), vec2(0, 0), vec2(0, 0), u64(1_700_000_000),
    ]);
    const line = log(ev("LiquidityAddedV2").discriminator, payload);
    const [camel] = parseCofferPoolEvents([line]) as any[];
    expect(camel.kind).toBe("LiquidityAddedV2");
    expect(camel.lpAmount.toNumber()).toBe(5);
    expect(camel.lpSupplyAfter.toNumber()).toBe(1_005);
    const [exact] = parseContractEvents([line], "cofferPool") as any[];
    expect(exact.data.lp_amount.toNumber()).toBe(5);
    expect(exact.data.lp_supply_after.toNumber()).toBe(1_005);
  });

  test("LiquidityRemovedV2 → requestedLp, lpAmount before token_amounts (field order pinned)", () => {
    const fields = (COFFER_POOL_IDL as any).types.find((t: any) => t.name === "LiquidityRemovedV2").type.fields.map((f: any) => f.name);
    expect(fields.slice(0, 5)).toEqual(["pool", "user", "requested_lp", "lp_amount", "token_amounts"]);
    const payload = Buffer.concat([
      pool.toBuffer(), user.toBuffer(), u64(9), u64(7), vec2(1, 2), vec2(0, 0), vec2(0, 0), Buffer.from([0, 0]), vec2(0, 0), Buffer.from([0]), u64(100), u64(93),
      vec2(10, 20), vec2(9, 18), vec2(5, 10), vec2(4, 8), vec2(0, 0), vec2(0, 0), u64(1),
    ]);
    const [camel] = parseCofferPoolEvents([log(ev("LiquidityRemovedV2").discriminator, payload)]) as any[];
    expect(camel.kind).toBe("LiquidityRemovedV2");
    expect(camel.requestedLp.toNumber()).toBe(9);
    expect(camel.lpAmount.toNumber()).toBe(7);
    expect(camel.tokenAmounts.map((x: BN) => x.toNumber())).toEqual([1, 2]);
  });

  test("PoolInitializedV2 → lpMint, lpTokenProgram, poolId; no banned_extensions slot any more (T19)", () => {
    const config = pk(), lpMint = pk(), lpProgram = pk();
    const str = (x: string) => { const b = Buffer.from(x); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
    const mints = [pk(), pk()];
    const payload = Buffer.concat([
      pool.toBuffer(), config.toBuffer(), u64(77), user.toBuffer(), lpMint.toBuffer(), lpProgram.toBuffer(), u8(2),
      Buffer.concat([Buffer.from([2, 0, 0, 0]), mints[0].toBuffer(), mints[1].toBuffer()]), Buffer.concat([Buffer.from([2, 0, 0, 0]), TOKEN_PROGRAM_ID.toBuffer(), TOKEN_PROGRAM_ID.toBuffer()]),
      Buffer.from([2, 0, 0, 0, 6, 9]), vec2(5_000, 5_000), vec2(1_000_000, 1_000_000_000), Buffer.from([0xb8, 0x0b, 0, 0]), Buffer.from([0xe8, 0x03]), Buffer.alloc(6),
      str("LP"), str("cLP"), str("https://x"), Buffer.alloc(32), Buffer.alloc(2 + 4 + 4 + 4 + 1), u64(1),
    ]);
    const line = log(ev("PoolInitializedV2").discriminator, payload);
    const [camel] = parseCofferPoolEvents([line]) as any[];
    expect(camel.kind).toBe("PoolInitializedV2");
    expect(camel.lpMint.equals(lpMint)).toBe(true);
    expect(camel.lpTokenProgram.equals(lpProgram)).toBe(true);
    expect(camel.poolId.toNumber()).toBe(77);
    expect(camel.decimals).toEqual([6, 9]);
    expect("deprecatedBannedExtensions" in camel).toBe(false);
    const exact = decodeContractEvent(line.slice("Program data: ".length), "cofferPool") as any;
    expect(exact.data.lp_mint.equals(lpMint)).toBe(true);
  });

  test("a pre-T11 PoolInitialized log (legacy discriminator) is Unknown, not decoded positionally", () => {
    const payload = Buffer.concat([pool.toBuffer(), pk().toBuffer(), u8(3), pk().toBuffer(), u64(1), u64(0x6410e0a), u64(1)]);
    const [camel] = parseCofferPoolEvents([log(Buffer.from("6476ad570cc6fee5", "hex"), payload)]) as any[];
    expect(camel.kind).toBe("Unknown");
    expect(camel.name).toBe("PoolInitialized");
    expect(camel.data.replacedBy).toBe("PoolInitializedV2");
  });

  test("SingleTokenDepositDirectV2 → lpReceived, lpSupplyBefore / After", () => {
    const payload = Buffer.concat([
      pool.toBuffer(), user.toBuffer(), u8(0), u64(100), u64(1), vec2(50, 50), Buffer.alloc(32), u64(1), u64(2), u8(1), vec2(49, 48),
      u64(12), vec2(1, 2), u64(100), u64(112), u64(1),
    ]);
    const [camel] = parseCofferPoolEvents([log(ev("SingleTokenDepositDirectV2", SINGLE_TOKEN_LIQUIDITY_IDL).discriminator, payload)]) as any[];
    expect(camel.kind).toBe("SingleTokenDepositDirectV2");
    expect(camel.lpReceived.toNumber()).toBe(12);
    expect(camel.lpSupplyAfter.toNumber()).toBe(112);
  });
});

describe("T18 client quote surfaces", () => {
  test("quoteAddLiquidity returns lpOut / minimumLpAmount; quoteRemove returns effectiveLpIn", () => {
    const pool = poolFixture();
    const client = new CofferPoolClient({ config: cfg, poolAddress: pool.address });
    (client as unknown as { cache: PoolInfo }).cache = pool;
    const add = client.quoteAddLiquidity([new BN(10_000), new BN(10_000)]);
    if (!add.ok) throw new Error(add.error.humanMessage);
    expect(add.data.lpOut.toNumber()).toBe(10_000);
    expect(add.data.minimumLpAmount.lte(add.data.lpOut)).toBe(true);
    const remove = client.quoteRemove(new BN(1_000_000));
    if (!remove.ok) throw new Error(remove.error.humanMessage);
    expect(remove.data.effectiveLpIn.toNumber()).toBe(1_000_000 - 1_000); // MIN_LP_SUPPLY clamp
  });

  test("buildRemoveLiquidityTx takes lpAmount; buildAddLiquidityTx takes minimumLpAmount", () => {
    const pool = poolFixture();
    const client = new CofferPoolClient({ config: cfg, poolAddress: pool.address });
    (client as unknown as { cache: PoolInfo }).cache = pool;
    const user = pk();
    const remove = client.buildRemoveLiquidityTx({ user, lpAmount: new BN(1_000), minimumTokenAmounts: [new BN(0), new BN(0)] });
    expect(remove.ok).toBe(true);
    const add = client.buildAddLiquidityTx({ user, tokenAmounts: [new BN(10_000), new BN(10_000)], minimumLpAmount: new BN(1) });
    expect(add.ok).toBe(true);
    if (add.ok) expect(add.data.instructions.at(-1)!.keys[1].pubkey.equals(pool.lpMint)).toBe(true);
  });

  test("AdminClient keeps its governance surface minus the policy setter", () => {
    for (const method of ["setPoolEnabledIx", "setSwapsEnabledIx", "setProtocolFeeRateIx", "poolInitializeConfigIx", "migratePoolToV5Ix"]) {
      expect(typeof (AdminClient.prototype as any)[method]).toBe("function");
    }
  });
});
