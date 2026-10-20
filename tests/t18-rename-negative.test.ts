/**
 * T18 (v6.1) — negative / adversarial tests for the BPT → LP / Cubic → Coffer
 * rename and the T19 policy removal.
 *
 * Old names must be gone (no deprecated aliases, decided in T18 §8.4), the
 * removed ABI must be unreachable, the rename must not have moved any byte
 * that is pinned on-chain, and the source tree must not regrow old names.
 */
import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { BorshAccountsCoder, Idl } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import * as sdk from "../src";
import {
  AdminClient,
  AddLiquidityParams,
  COFFER_POOL_IDL,
  DeployPoolParams,
  IDLS,
  NETWORK_PROGRAMS,
  POOL_V4_LEN,
  PROTOCOL_ADMIN_IDL,
  PoolInfo,
  SINGLE_TOKEN_LIQUIDITY_IDL,
  buildContractInstruction,
  buildInitializePoolIx,
  decodeContractAccount,
  decodePoolAccount,
  deriveLpMint,
  derivePoolPda,
  describeProgramError,
  getConfig,
  parseCofferPoolEvents,
  unsupportedMintExtensions,
} from "../src";

const cfg = getConfig("mainnet");
const pk = () => Keypair.generate().publicKey;
const sha8 = (preimage: string) => createHash("sha256").update(preimage).digest().subarray(0, 8);
const hex = (b: Buffer | number[]) => Buffer.from(b).toString("hex");
const u64 = (v: number | BN) => new BN(v).toArrayLike(Buffer, "le", 8);
const OLD = /bpt|cubic|cube/i;
const ROOT = join(__dirname, "..");

const allNames = (key: "instructions" | "events" | "accounts" | "types" | "errors") =>
  (Object.values(IDLS) as any[]).flatMap((idl) => (idl[key] ?? []).map((x: any) => x.name as string));

describe("old names are absent from the package root (no deprecated aliases)", () => {
  test("no root export matches /bpt|cubic|cube/i", () => {
    expect(Object.keys(sdk).filter((name) => OLD.test(name))).toEqual([]);
  });

  test.each([
    "CubicPoolClient", "CubicPoolClientParams", "parseCubicPoolEvents", "deriveBptMint", "CUBIC_POOL_SEED", "BPT_MINT_SEED",
    "MINIMUM_INITIAL_BPT", "BPT_DECIMALS", "calcBptOutGivenExactTokensIn", "calcTokensOutGivenBptIn", "calcJoinRatioAndBpt",
    "calcEffectiveBptBurn", "buildInitializeCubicPoolIx", "CUBIC_POOL_IDL", "CubeBackendClient",
    "DEFAULT_BANNED_EXTENSIONS", "HARD_BANNED_EXTENSIONS", "bannedMintExtensions",
  ])("%s is not exported", (name) => {
    expect((sdk as any)[name]).toBeUndefined();
  });

  test("the `cubicPool` program key is gone from the id table, the config and the IDL map", () => {
    expect((NETWORK_PROGRAMS.mainnet as any).cubicPool).toBeUndefined();
    expect((cfg.programs as any).cubicPool).toBeUndefined();
    expect((IDLS as any).cubicPool).toBeUndefined();
    expect(() => sdk.programId(cfg, "cubicPool" as any)).not.toThrow(); // returns undefined, no alias
    expect(sdk.programId(cfg, "cubicPool" as any)).toBeUndefined();
  });

  test("AdminClient.setBannedExtensionsIx no longer exists", () => {
    expect((AdminClient.prototype as any).setBannedExtensionsIx).toBeUndefined();
  });

  test("the policy bitmap cannot be smuggled back into unsupportedMintExtensions", () => {
    // A second argument used to be accepted; passing one now changes nothing.
    expect((unsupportedMintExtensions as any)([12, 18], 1n << 12n)).toEqual([]);
    expect((unsupportedMintExtensions as any)([9], 0n)).toEqual([9]);
  });
});

describe("removed / renamed ABI is unreachable", () => {
  test("IDLs contain no bpt/cubic names and none of the deleted T19 symbols", () => {
    for (const key of ["instructions", "events", "accounts", "types", "errors"] as const) {
      expect(allNames(key).filter((n) => OLD.test(n))).toEqual([]);
    }
    expect(allNames("instructions")).not.toContain("initialize_cubic_pool");
    expect(allNames("instructions")).not.toContain("set_banned_extensions");
    expect(allNames("instructions")).not.toContain("pool_set_banned_extensions");
    expect(allNames("events")).not.toContain("BannedExtensionsUpdated");
    expect(allNames("events")).not.toContain("PoolBannedExtensionsSet");
    expect(allNames("accounts")).not.toContain("CubicPool");
    expect(allNames("types")).not.toContain("CubicPoolConfig");
  });

  test("the old initialize_cubic_pool discriminator is not accepted by any instruction (0.1.x → InstructionFallbackNotFound)", () => {
    const old = hex(sha8("global:initialize_cubic_pool"));
    expect(old).toBe("d79474cf79686f83");
    for (const idl of Object.values(IDLS) as any[]) {
      expect(idl.instructions.map((ix: any) => hex(ix.discriminator))).not.toContain(old);
    }
  });

  test("the deleted instructions' discriminators are gone too", () => {
    const gone = [hex(sha8("global:set_banned_extensions")), hex(sha8("global:pool_set_banned_extensions"))];
    for (const idl of Object.values(IDLS) as any[]) {
      for (const ix of idl.instructions) expect(gone).not.toContain(hex(ix.discriminator));
    }
  });

  test("buildContractInstruction rejects the old instruction name", () => {
    expect(() => (buildContractInstruction as any)(cfg, "cofferPool", "initialize_cubic_pool", {}, {})).toThrow(/Unknown cofferPool instruction/);
  });

  test("buildContractInstruction rejects the removed banned_extensions_override arg", () => {
    const pool = pk();
    expect(() => (buildContractInstruction as any)(cfg, "cofferPool", "initialize_pool", {
      normalized_weights: [new BN(5000), new BN(5000)], initial_virtual_balances: [new BN(1), new BN(1)],
      swap_fee_rate: 3000, pool_id: new BN(1), banned_extensions_override: null,
    }, { config: pk(), pool, lp_mint: deriveLpMint(cfg.programs.cofferPool, pool)[0], payer: pk(), token_program: TOKEN_PROGRAM_ID,
         associated_token_program: pk(), system_program: pk() })).toThrow(/banned_extensions_override is not in the contract ABI/);
  });

  test("buildContractInstruction rejects old arg / account names on add_liquidity", () => {
    const accounts = { pool: pk(), lp_mint: pk(), user_lp_account: pk(), user: pk(), token_program: TOKEN_PROGRAM_ID };
    expect(() => (buildContractInstruction as any)(cfg, "cofferPool", "add_liquidity",
      { token_amounts: [new BN(1)], minimum_bpt_amount: new BN(1) }, accounts)).toThrow(/minimum_lp_amount is required/);
    expect(() => (buildContractInstruction as any)(cfg, "cofferPool", "add_liquidity",
      { token_amounts: [new BN(1)], minimum_lp_amount: new BN(1) },
      { pool: accounts.pool, bpt_mint: pk(), user_bpt_account: pk(), user: pk(), token_program: TOKEN_PROGRAM_ID })).toThrow(/lp_mint is required/);
  });

  test("buildContractInstruction rejects the old program key", () => {
    expect(() => (buildContractInstruction as any)(cfg, "cubicPool", "swap", {}, {})).toThrow();
  });

  test("deploy builder ignores a stray bannedExtensions property instead of encoding an Option tag", () => {
    const base = {
      payer: pk(), configKey: pk(), poolId: new BN(5), tokens: [pk(), pk()], weightsBps: [5000, 5000],
      virtualBalances: [new BN(1), new BN(1)], swapFeeRate: 3000,
    };
    const clean = buildInitializePoolIx(cfg, base);
    const smuggled = buildInitializePoolIx(cfg, { ...base, bannedExtensions: new BN(0x6410e0a) } as DeployPoolParams);
    expect(smuggled.data.equals(clean.data)).toBe(true);
    // 0.1.x appended at least a 1-byte `None` tag after pool_id; that byte is gone.
    expect(clean.data.length).toBe(8 + (4 + 16) + (4 + 16) + 4 + 8);
    expect(clean.data.length).not.toBe(8 + (4 + 16) + (4 + 16) + 4 + 8 + 1);
  });
});

describe("the rename moved no pinned byte", () => {
  const POOL_DISC = Buffer.from([137, 210, 42, 22, 209, 156, 43, 78]);
  const poolBytes = (disc: Buffer) => { const b = Buffer.alloc(POOL_V4_LEN); disc.copy(b, 0); b[40] = 1; return b; };

  test("a pool account stamped with sha256(account:CofferPool) is rejected — the pin is load-bearing", () => {
    const newNameHash = sha8("account:CofferPool");
    expect(hex(newNameHash)).not.toBe(hex(POOL_DISC));
    expect(() => decodePoolAccount(poolBytes(newNameHash))).toThrow(/discriminator/);
    expect(() => decodeContractAccount("cofferPool", "CofferPool", poolBytes(newNameHash))).toThrow();
    expect(() => decodePoolAccount(poolBytes(POOL_DISC))).not.toThrow();
  });

  test("a config stamped with sha256(account:CofferPoolConfig) is rejected", async () => {
    const coder = new BorshAccountsCoder(COFFER_POOL_IDL as unknown as Idl);
    const good = await coder.encode("CofferPoolConfig", {
      protocol_admin: pk(), pending_protocol_admin: pk(), default_protocol_fee_rate: 1,
      _deprecated_extension_policy: Array(16).fill(0), reserved: Array(112).fill(0),
    });
    const bad = Buffer.from(good);
    sha8("account:CofferPoolConfig").copy(bad, 0);
    expect(() => decodeContractAccount("cofferPool", "CofferPoolConfig", bad)).toThrow();
    expect(() => decodeContractAccount("cofferPool", "CofferPoolConfig", good)).not.toThrow();
  });

  test("renamed seed strings would derive different PDAs (so the byte strings must stay)", () => {
    const config = pk(), poolId = new BN(1);
    const [pool] = derivePoolPda(cfg.programs.cofferPool, config, poolId);
    const [wrongPool] = PublicKey.findProgramAddressSync([Buffer.from("coffer_pool"), config.toBuffer(), u64(1)], cfg.programs.cofferPool);
    expect(wrongPool.equals(pool)).toBe(false);
    const [lp] = deriveLpMint(cfg.programs.cofferPool, pool);
    const [wrongLp] = PublicKey.findProgramAddressSync([Buffer.from("lp_mint"), pool.toBuffer()], cfg.programs.cofferPool);
    expect(wrongLp.equals(lp)).toBe(false);
  });

  test("a config passed where a pool is expected still fails the discriminator check (type cosplay)", async () => {
    const coder = new BorshAccountsCoder(COFFER_POOL_IDL as unknown as Idl);
    const config = await coder.encode("CofferPoolConfig", {
      protocol_admin: pk(), pending_protocol_admin: pk(), default_protocol_fee_rate: 1,
      _deprecated_extension_policy: Array(16).fill(0), reserved: Array(112).fill(0),
    });
    const padded = Buffer.alloc(POOL_V4_LEN);
    config.copy(padded, 0);
    expect(() => decodePoolAccount(padded)).toThrow(/discriminator/);
  });

  test("decoded pool objects carry no `bannedExtensions` key and PoolInfo has none either", () => {
    const raw = decodePoolAccount(poolBytes(POOL_DISC)) as any;
    expect("bannedExtensions" in raw).toBe(false);
    expect(Object.keys(raw).filter((k) => OLD.test(k))).toEqual([]);
    const info: PoolInfo = {
      address: pk(), config: pk(), bump: 1, tokenCount: 0, poolId: new BN(0), lpMint: pk(), lpTotalSupply: new BN(0),
      swapFeeRate: 0, protocolFeeRate: 0, poolEnabled: true, swapsEnabled: true, createdAt: 0, lookupTable: PublicKey.default,
      syncedAt: 0, tokens: [],
    };
    expect("bannedExtensions" in info).toBe(false);
  });

  test("event / error names carry no old spelling; 6007/6017 are no longer *Bpt*", () => {
    expect(describeProgramError(6007)?.name).not.toBe("InsufficientBptOut");
    expect(describeProgramError(6017)?.name).not.toBe("InvalidBptAmount");
    expect(allNames("errors").filter((n) => /Bpt|Cubic/.test(n))).toEqual([]);
  });

  test("a BannedExtensionsUpdated log from a pre-T19 program is reported as Unknown, not decoded", () => {
    const oldDisc = Buffer.from([107, 126, 13, 149, 182, 108, 139, 202]);
    expect(hex(oldDisc)).toBe(hex(sha8("event:BannedExtensionsUpdated")));
    const payload = Buffer.concat([pk().toBuffer(), pk().toBuffer(), u64(1), u64(2), u64(3), u64(0), u64(0)]);
    const [parsed] = parseCofferPoolEvents([`Program data: ${Buffer.concat([oldDisc, payload]).toString("base64")}`]);
    expect(parsed.kind).toBe("Unknown");
  });

  test("LiquidityAdded parses with no bptAmount key", () => {
    const disc = Buffer.from((COFFER_POOL_IDL as any).events.find((e: any) => e.name === "LiquidityAdded").discriminator);
    const payload = Buffer.concat([pk().toBuffer(), pk().toBuffer(), Buffer.concat([Buffer.from([1, 0, 0, 0]), u64(1)]), u64(5), u64(1)]);
    const [parsed] = parseCofferPoolEvents([`Program data: ${Buffer.concat([disc, payload]).toString("base64")}`]) as any[];
    expect(parsed.kind).toBe("LiquidityAdded");
    expect("bptAmount" in parsed).toBe(false);
    expect(Object.keys(parsed).filter((k) => OLD.test(k))).toEqual([]);
  });
});

describe("source tree guard", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (["node_modules", ".git", "dist"].includes(entry)) continue;
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  for (const top of ["src", "tests", "examples", "docs", "scripts"]) walk(join(ROOT, top));
  files.push(join(ROOT, "README.md"), join(ROOT, "package.json"));

  // Allow-list for src/examples/scripts: on-chain seed byte strings, the backend
  // DTO field (backend renamed under T4) and the one comment that documents the
  // re-cut `initialize_cubic_pool` discriminator for 0.1.x users.
  const ALLOWED_LINE = /Buffer\.from\("cubic_pool"\)|Buffer\.from\("bpt_mint"\)|bptMint: string \| null;|`initialize_cubic_pool` \(d79474cf79686f83\)/;

  test("no file name under src/ tests/ examples/ contains bpt/cubic/cube", () => {
    expect(files.map((f) => relative(ROOT, f)).filter((f) => OLD.test(f.split("/").pop()!))).toEqual([]);
  });

  test("the old IDL file and the old client/math files are gone", () => {
    for (const gone of ["src/idl/cubic_pool.json", "src/clients/CubicPoolClient.ts", "src/math/cubicMath.ts", "tests/cubic-pool-client.test.ts", "tests/math/cubicMath.test.ts"]) {
      expect(existsSync(join(ROOT, gone))).toBe(false);
    }
    for (const present of ["src/idl/coffer_pool.json", "src/clients/CofferPoolClient.ts", "src/math/poolMath.ts"]) {
      expect(existsSync(join(ROOT, present))).toBe(true);
    }
  });

  test("no bpt/cubic/cube remains in src/, examples/, scripts/ (outside the allow-listed lines)", () => {
    const offenders: string[] = [];
    const scanned = files.filter((p) => /\.(ts|cjs|json)$/.test(p) && !p.includes("/idl/") && !p.includes("/tests/"));
    expect(scanned.length).toBeGreaterThan(50);
    for (const f of scanned) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (OLD.test(line) && !ALLOWED_LINE.test(line)) offenders.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test("the IDL JSON files carry no bpt/cubic in any name (docs may cite legacy seed bytes)", () => {
    for (const idl of [COFFER_POOL_IDL, PROTOCOL_ADMIN_IDL, SINGLE_TOKEN_LIQUIDITY_IDL] as any[]) {
      const names = JSON.stringify(idl).match(/"name":"[^"]*"/g) ?? [];
      expect(names.filter((n) => OLD.test(n))).toEqual([]);
    }
    expect((COFFER_POOL_IDL as any).metadata.name).not.toBe("cubic_pool");
  });
});

// Compile-time negatives: the removed / renamed properties must not type-check.
// ts-jest reports an unused `@ts-expect-error` as an error, so each line below
// is a test that the old property is really gone from the type.
if (false) {
  const info = {} as PoolInfo;
  // @ts-expect-error PoolInfo.bannedExtensions was removed (T19)
  info.bannedExtensions;
  // @ts-expect-error PoolInfo.bptMint was renamed to lpMint (T18)
  info.bptMint;
  // @ts-expect-error PoolInfo.bptTotalSupply was renamed to lpTotalSupply (T18)
  info.bptTotalSupply;
  const deploy = {} as DeployPoolParams;
  // @ts-expect-error DeployPoolParams.bannedExtensions was removed (T19)
  deploy.bannedExtensions;
  // @ts-expect-error DeployPoolParams.bptTokenProgram was renamed to lpTokenProgram (T18)
  deploy.bptTokenProgram;
  const add = {} as AddLiquidityParams;
  // @ts-expect-error AddLiquidityParams.minimumBptAmount was renamed to minimumLpAmount (T18)
  add.minimumBptAmount;
  // @ts-expect-error "cubicPool" is not a program key any more
  getConfig("mainnet").programs.cubicPool;
}
