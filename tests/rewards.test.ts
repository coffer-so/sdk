import { createHash, createPublicKey, verify as verifySignature } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import BN from "bn.js";
import { Ed25519Program, Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_SLOT_HASHES_PUBKEY, ComputeBudgetProgram } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  COFFER_REWARDS_IDL,
  COFFER_REWARDS_PROGRAM_ID,
  CofferBackendClient,
  NETWORK_PROGRAMS,
  REWARD_RECEIPT_RENT_LAMPORTS,
  SPL_MEMO_PROGRAM_ID,
  boostsCampaignId,
  buildContractInstruction,
  buildPoolAdminCampaignSetup,
  suggestedPayoutLimit,
  buildRewardClaimTx,
  buildRewardCloseIx,
  buildRewardCloseReceiptIx,
  buildRewardDepositIx,
  buildRewardInitializeIx,
  buildRewardReturnSurplusIx,
  buildRewardRotateSignerIx,
  buildRewardSetPayoutLimitIx,
  buildRewardWithdrawIx,
  decodeContractAccount,
  decodeRewardCampaignAccount,
  decodeRewardCampaignClosedEvent,
  decodeRewardReceiptAccount,
  isRewardClosedCampaign,
  rewardCampaignClaimable,
  rewardWindowResetsAt,
  deriveAta,
  deriveRewardCampaignPda,
  deriveRewardReceiptPda,
  deriveRewardSolVaultPda,
  describeProgramError,
  getConfig,
  getRewardsApiError,
  loadRewardClaimState,
  parseRewardPaidEvents,
  parseRewardVoucher,
  programId,
  rewardClaimPayout,
  rewardTransferFeeAt,
  parseRewardMintTransferFee,
  rewardVerificationInstruction,
  rewardVoucherMessage,
  toSdkError,
} from "../src";
import type { RewardVoucherResponse } from "../src";
import { sha256 } from "../src/rewards/sha256";

const vectors = JSON.parse(readFileSync(join(__dirname, "fixtures/rewards-vectors.json"), "utf8")) as {
  messageLen: number;
  ixDataLen: number;
  vectors: Array<{
    name: string; programId: string; campaign: string; beneficiary: string; domainHex: string; signerEpoch: string; totalRaw: string;
    expiresAt: string; signer: string; messageHex: string; signatureHex: string; ixProgramId: string; ixDataHex: string;
  }>;
};

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;
// The vectors expire at 1_795_655_200 (2026-11-26 01:00 UTC); claims are built an hour before.
const NOW_UNIX = 1_795_651_600;
let nowSpy: jest.SpyInstance;
beforeAll(() => {
  nowSpy = jest.spyOn(Date, "now").mockReturnValue(NOW_UNIX * 1000);
});
afterAll(() => nowSpy.mockRestore());
const idl = COFFER_REWARDS_IDL as any;
const ixSchema = (name: string) => idl.instructions.find((ix: any) => ix.name === name);

function voucherOf(v: (typeof vectors.vectors)[number], extra: Partial<RewardVoucherResponse> = {}): RewardVoucherResponse {
  return {
    programId: v.programId,
    campaign: v.campaign,
    beneficiary: v.beneficiary,
    domain: Buffer.from(v.domainHex, "hex").toString("base64"),
    signerEpoch: v.signerEpoch,
    totalRaw: v.totalRaw,
    expiresAt: v.expiresAt,
    signer: v.signer,
    signature: Buffer.from(v.signatureHex, "hex").toString("base64"),
    message: Buffer.from(v.messageHex, "hex").toString("base64"),
    claimedRaw: "0",
    claimableNowRaw: "1000",
    liquidityRaw: "5000000000",
    mint: USDC.toBase58(),
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    decimals: 6,
    ...extra,
  };
}

const usdcVector = vectors.vectors.find((v) => v.name.startsWith("USDC-size"))!;
const fieldsOf = (v: (typeof vectors.vectors)[number]) => ({
  program: new PublicKey(v.programId),
  campaign: new PublicKey(v.campaign),
  domain: Buffer.from(v.domainHex, "hex"),
  user: new PublicKey(v.beneficiary),
  epoch: BigInt(v.signerEpoch),
  total: BigInt(v.totalRaw),
  expiresAt: BigInt(v.expiresAt),
});

function expectKeysMatchIdl(keys: Array<{ isSigner: boolean; isWritable: boolean }>, name: string) {
  const schema = ixSchema(name);
  schema.accounts.forEach((a: any, i: number) => {
    expect(keys[i].isSigner).toBe(!!a.signer);
    expect(keys[i].isWritable).toBe(!!a.writable);
  });
}

// ── Token account / mint fixtures ──

function tokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint, extensions: Array<[number, Buffer]> = []): Buffer {
  const base = Buffer.alloc(165);
  mint.toBuffer().copy(base, 0);
  owner.toBuffer().copy(base, 32);
  base.writeBigUInt64LE(amount, 64);
  base[108] = 1;
  if (!extensions.length) return base;
  return Buffer.concat([base, Buffer.from([2]), ...extensions.map(([type, value]) => tlv(type, value))]);
}

function tlv(type: number, value: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16LE(type, 0);
  head.writeUInt16LE(value.length, 2);
  return Buffer.concat([head, value]);
}

function mint2022(extensions: Array<[number, Buffer]>): Buffer {
  const base = Buffer.alloc(165);
  base[44] = 6;
  base[45] = 1;
  return Buffer.concat([base, Buffer.from([1]), ...extensions.map(([type, value]) => tlv(type, value))]);
}

function transferFeeConfig(older: [bigint, bigint, number], newer: [bigint, bigint, number]): Buffer {
  const value = Buffer.alloc(108);
  const put = (off: number, [epoch, max, bps]: [bigint, bigint, number]) => {
    value.writeBigUInt64LE(epoch, off);
    value.writeBigUInt64LE(max, off + 8);
    value.writeUInt16LE(bps, off + 16);
  };
  put(72, older);
  put(90, newer);
  return value;
}

type CampaignFields = {
  admin: PublicKey; id: Buffer; bump: number; mint: PublicKey; tokenProgram: PublicKey; signer: PublicKey; epoch: bigint; liquidity: bigint; metadata: string;
  domain?: Buffer; payoutLimit?: bigint; windowSeconds?: bigint; windowStart?: bigint; windowPaid?: bigint;
};

function campaignData(fields: CampaignFields): Buffer {
  const buf = Buffer.alloc(518);
  Buffer.from(idl.accounts.find((a: any) => a.name === "Campaign").discriminator).copy(buf, 0);
  buf[8] = 1; // version
  buf[9] = fields.bump;
  fields.admin.toBuffer().copy(buf, 10);
  fields.id.copy(buf, 42);
  (fields.domain ?? Buffer.alloc(32, 7)).copy(buf, 74);
  fields.mint.toBuffer().copy(buf, 106);
  fields.tokenProgram.toBuffer().copy(buf, 138);
  fields.signer.toBuffer().copy(buf, 170);
  buf.writeBigUInt64LE(fields.epoch, 202);
  buf.writeBigUInt64LE(fields.liquidity, 210);
  buf.writeBigUInt64LE(fields.payoutLimit ?? 0n, 218);
  buf.writeBigUInt64LE(fields.windowSeconds ?? 0n, 226);
  buf.writeBigInt64LE(fields.windowStart ?? 0n, 234);
  buf.writeBigUInt64LE(fields.windowPaid ?? 0n, 242);
  const meta = Buffer.from(fields.metadata, "utf8");
  buf.writeUInt32LE(meta.length, 314);
  meta.copy(buf, 318);
  return buf;
}

function receiptData(claimed: bigint): Buffer {
  const buf = Buffer.alloc(32);
  Buffer.from(idl.accounts.find((a: any) => a.name === "Receipt").discriminator).copy(buf, 0);
  buf[8] = 1;
  buf.writeBigUInt64LE(claimed, 9);
  return buf;
}

// ── IDL, program id, errors ──

describe("coffer_rewards IDL and config", () => {
  test("src/idl/coffer_rewards.json is the contracts v6.1-rc9 copy (sha256 pinned)", () => {
    const bytes = readFileSync(join(__dirname, "../src/idl/coffer_rewards.json"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("1ec8bfa8878293e766a013351a1e24a6eb27c289bf250ab3a4ddfa89ac477bbe");
    expect(idl.address).toBe(COFFER_REWARDS_PROGRAM_ID.toBase58());
    expect(idl.instructions).toHaveLength(15);
    expect(idl.events.map((e: any) => e.name).sort()).toEqual(["CampaignClosed", "RewardPaid"]);
  });

  test("every network has the program; a config without it falls back", () => {
    for (const net of ["mainnet", "devnet", "localnet"] as const) expect(NETWORK_PROGRAMS[net].cofferRewards!.equals(COFFER_REWARDS_PROGRAM_ID)).toBe(true);
    const cfg = getConfig("mainnet");
    const legacy = { ...cfg, programs: { cofferPool: cfg.programs.cofferPool, singleTokenLiquidity: cfg.programs.singleTokenLiquidity, protocolAdmin: cfg.programs.protocolAdmin } };
    expect(programId(legacy, "cofferRewards").equals(COFFER_REWARDS_PROGRAM_ID)).toBe(true);
    const ix = buildContractInstruction(legacy, "cofferRewards", "rotate_signer", { backend_signer: Keypair.generate().publicKey }, { admin: PublicKey.default, campaign: PublicKey.default });
    expect(ix.programId.equals(COFFER_REWARDS_PROGRAM_ID)).toBe(true);
  });

  test("error table 6000–6011", () => {
    const names = [
      "InvalidVoucher", "AlreadyClaimed", "InsufficientLiquidity", "ZeroPayment", "InvalidSigner", "MetadataTooLong",
      "WrongAsset", "CallbackAccounts", "Arithmetic", "VoucherExpired", "PayoutLimitReached", "InvalidPayoutLimit",
    ];
    names.forEach((name, i) => expect(describeProgramError(6000 + i, "cofferRewards")?.name).toBe(name));
    expect(describeProgramError(6012, "cofferRewards")).toBeUndefined();
    expect(describeProgramError(6002, "cofferRewards")?.sdkCode).toBe("insufficient_funds");
    expect(describeProgramError(6008, "cofferRewards")?.sdkCode).toBe("math_overflow");
    const e = toSdkError(new Error("failed to send transaction: custom program error: 0x1771"), "cofferRewards");
    expect(e.humanMessage).toBe("The voucher ceiling has already been reached");
    // The cubic-pool table is unchanged.
    expect(toSdkError(new Error("custom program error: 0x1771")).humanMessage).not.toBe(e.humanMessage);
  });
});

// ── Hashing, PDAs ──

describe("campaign id and PDAs", () => {
  test("sha256 matches node:crypto across block boundaries", () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const data = Buffer.alloc(n, n % 251);
      expect(sha256(data).toString("hex")).toBe(createHash("sha256").update(data).digest("hex"));
    }
  });

  test("boostsCampaignId = sha256(\"coffer-boosts:v2:<cluster>:<mint|native>:<generation>\") as in the backend", () => {
    const ref = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
    expect(boostsCampaignId("mainnet", USDC).toString("hex")).toBe(ref(`coffer-boosts:v2:mainnet:${USDC.toBase58()}:0`));
    expect(boostsCampaignId("devnet", USDC.toBase58(), 3).toString("hex")).toBe(ref(`coffer-boosts:v2:devnet:${USDC.toBase58()}:3`));
    expect(boostsCampaignId("mainnet", "native").toString("hex")).toBe(ref("coffer-boosts:v2:mainnet:native:0"));
    expect(boostsCampaignId("mainnet", "native").equals(boostsCampaignId("devnet", "native"))).toBe(false);
    expect(boostsCampaignId("mainnet", "native", 1).equals(boostsCampaignId("mainnet", "native"))).toBe(false);
    expect(() => boostsCampaignId("mainnet", "native", -1)).toThrow(/generation/);
  });

  test("campaign, receipt and vault seeds", () => {
    const admin = Keypair.generate().publicKey;
    const id = boostsCampaignId("mainnet", USDC);
    const [campaign, bump] = deriveRewardCampaignPda(admin, id);
    expect(campaign.equals(PublicKey.findProgramAddressSync([Buffer.from("campaign"), admin.toBuffer(), id], COFFER_REWARDS_PROGRAM_ID)[0])).toBe(true);
    expect(bump).toBeLessThan(256);
    const user = Keypair.generate().publicKey;
    expect(deriveRewardReceiptPda(campaign, user)[0].equals(PublicKey.findProgramAddressSync([Buffer.from("receipt"), campaign.toBuffer(), user.toBuffer()], COFFER_REWARDS_PROGRAM_ID)[0])).toBe(true);
    expect(deriveRewardSolVaultPda(campaign)[0].equals(PublicKey.findProgramAddressSync([Buffer.from("sol"), campaign.toBuffer()], COFFER_REWARDS_PROGRAM_ID)[0])).toBe(true);
    expect(() => deriveRewardCampaignPda(admin, Buffer.alloc(31))).toThrow(/32 bytes/);
  });
});

// ── Vouchers ──

describe("vouchers (golden vectors shared with the backend)", () => {
  test.each(vectors.vectors)("$name: message, Ed25519 instruction and signature", (v) => {
    const message = rewardVoucherMessage(fieldsOf(v));
    expect(message).toHaveLength(vectors.messageLen);
    expect(message.toString("hex")).toBe(v.messageHex);
    const ix = rewardVerificationInstruction(fieldsOf(v), new PublicKey(v.signer), Buffer.from(v.signatureHex, "hex"));
    expect(ix.programId.toBase58()).toBe(v.ixProgramId);
    expect(ix.programId.equals(Ed25519Program.programId)).toBe(true);
    expect(ix.keys).toHaveLength(0);
    expect(ix.data).toHaveLength(vectors.ixDataLen);
    expect(ix.data.toString("hex")).toBe(v.ixDataHex);
    // The header voucher.rs compares byte for byte: every instruction index 0xffff.
    expect(ix.data.subarray(0, 16).toString("hex")).toBe("01003000ffff1000ffff7000a900ffff");
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: new PublicKey(v.signer).toBuffer().toString("base64url") }, format: "jwk" });
    expect(verifySignature(null, message, key, Buffer.from(v.signatureHex, "hex"))).toBe(true);
    const parsed = parseRewardVoucher(voucherOf(v));
    expect(parsed.totalRaw).toBe(BigInt(v.totalRaw));
    expect(parsed.signerEpoch).toBe(BigInt(v.signerEpoch));
    expect(parsed.expiresAt).toBe(BigInt(v.expiresAt));
    expect(parsed.domain.toString("hex")).toBe(v.domainHex);
    expect(parsed.message.toString("hex")).toBe(v.messageHex);
  });

  test("bounds of the message: u64 epoch and total, i64 expiry, 32-byte domain", () => {
    const k = PublicKey.default;
    const base = { program: k, campaign: k, domain: Buffer.alloc(32), user: k, epoch: 0n, total: 0n, expiresAt: 0n };
    expect(() => rewardVoucherMessage({ ...base, epoch: -1n })).toThrow(/u64/);
    expect(() => rewardVoucherMessage({ ...base, total: U64_MAX + 1n })).toThrow(/u64/);
    expect(() => rewardVoucherMessage({ ...base, expiresAt: I64_MAX + 1n })).toThrow(/i64/);
    expect(() => rewardVoucherMessage({ ...base, domain: Buffer.alloc(31) })).toThrow(/32 bytes/);
    expect(rewardVoucherMessage({ ...base, expiresAt: I64_MAX }).subarray(161).toString("hex")).toBe("ffffffffffffff7f");
  });

  test("parseRewardVoucher rejects a mismatch, malformed fields and the wrong program or wallet", () => {
    const good = voucherOf(usdcVector);
    const reject = (patch: Partial<RewardVoucherResponse>, re: RegExp, expectArgs?: Parameters<typeof parseRewardVoucher>[1]) =>
      expect(() => parseRewardVoucher({ ...good, ...patch }, expectArgs)).toThrow(re);
    reject({ totalRaw: (BigInt(usdcVector.totalRaw) + 1n).toString() }, /does not match/);
    reject({ signerEpoch: "4" }, /does not match/);
    reject({ beneficiary: Keypair.generate().publicKey.toBase58() }, /does not match/);
    reject({ expiresAt: (BigInt(usdcVector.expiresAt) + 1n).toString() }, /does not match/);
    reject({ domain: Buffer.alloc(32, 9).toString("base64") }, /does not match/);
    reject({ domain: Buffer.alloc(31).toString("base64") }, /32 bytes/);
    reject({ expiresAt: "1e9" }, /i64 decimal/);
    reject({ expiresAt: (I64_MAX + 1n).toString() }, /outside i64/);
    const tampered = Buffer.from(usdcVector.messageHex, "hex");
    tampered[168] ^= 1;
    reject({ message: tampered.toString("base64") }, /does not match/);
    reject({ message: Buffer.alloc(168).toString("base64") }, /169 bytes/);
    reject({ signature: Buffer.alloc(63).toString("base64") }, /64 bytes/);
    reject({ signature: "not base64!" }, /64 bytes/);
    reject({ totalRaw: "1.5" }, /u64 decimal/);
    reject({ totalRaw: "01" }, /u64 decimal/);
    reject({ claimedRaw: (U64_MAX + 1n).toString() }, /above u64/);
    reject({ liquidityRaw: 5 as any }, /u64 decimal/);
    reject({ decimals: 1.5 }, /u8/);
    reject({ signer: PublicKey.default.toBase58() }, /Ed25519/);
    reject({}, /expected/, { programId: Keypair.generate().publicKey });
    reject({}, /not/, { beneficiary: Keypair.generate().publicKey });
    expect(parseRewardVoucher(good, { beneficiary: new PublicKey(usdcVector.beneficiary) }).native).toBe(false);
    expect(parseRewardVoucher({ ...good, mint: PublicKey.default.toBase58() }).native).toBe(true);
  });
});

// ── Accounts and events ──

describe("decoders", () => {
  const admin = Keypair.generate().publicKey;
  const signer = Keypair.generate().publicKey;
  const id = boostsCampaignId("mainnet", USDC);

  test("Campaign (518 bytes) agrees with the IDL decoder", () => {
    const domain = Buffer.alloc(32, 0xab);
    const data = campaignData({
      admin, id, bump: 254, mint: USDC, tokenProgram: TOKEN_PROGRAM_ID, signer, epoch: 3n, liquidity: U64_MAX, metadata: "USDC boosts ✓",
      domain, payoutLimit: 5_000_000n, windowSeconds: 86_400n, windowStart: -5n, windowPaid: 1_000n,
    });
    const c = decodeRewardCampaignAccount(data);
    expect(c.version).toBe(1);
    expect(c.admin.equals(admin)).toBe(true);
    expect(c.id.equals(id)).toBe(true);
    expect(c.domain.equals(domain)).toBe(true);
    expect(c.bump).toBe(254);
    expect(c.native).toBe(false);
    expect(c.signerEpoch).toBe(3n);
    expect(c.liquidity).toBe(U64_MAX);
    expect([c.payoutLimit, c.windowSeconds, c.windowStart, c.windowPaid]).toEqual([5_000_000n, 86_400n, -5n, 1_000n]);
    expect(c.metadata).toBe("USDC boosts ✓");
    const generic = decodeContractAccount("cofferRewards", "Campaign", data);
    expect(generic.backend_signer.equals(c.backendSigner)).toBe(true);
    expect(generic.liquidity.toString()).toBe(c.liquidity.toString());
    expect(generic.payout_limit.toString()).toBe("5000000");
    expect(generic.window_start.toString()).toBe("-5");
    expect(Buffer.from(generic.domain).equals(domain)).toBe(true);
    expect(generic.metadata).toBe(c.metadata);
    expect(decodeRewardCampaignAccount(campaignData({ admin, id, bump: 1, mint: PublicKey.default, tokenProgram: PublicKey.default, signer, epoch: 0n, liquidity: 0n, metadata: "" })).native).toBe(true);
  });

  test("Campaign, Receipt and the ClosedCampaign marker reject other bytes", () => {
    const data = campaignData({ admin, id, bump: 1, mint: USDC, tokenProgram: TOKEN_PROGRAM_ID, signer, epoch: 0n, liquidity: 0n, metadata: "" });
    expect(() => decodeRewardCampaignAccount(data.subarray(0, 517))).toThrow(/518/);
    const wrong = Buffer.from(data);
    wrong[0] ^= 1;
    expect(() => decodeRewardCampaignAccount(wrong)).toThrow(/discriminator/);
    const long = Buffer.from(data);
    long.writeUInt32LE(201, 314);
    expect(() => decodeRewardCampaignAccount(long)).toThrow(/metadata/);
    const badUtf8 = Buffer.from(data);
    badUtf8.writeUInt32LE(1, 314);
    badUtf8[318] = 0xff;
    expect(() => decodeRewardCampaignAccount(badUtf8)).toThrow();

    const closed = Buffer.concat([Buffer.from(idl.accounts.find((a: any) => a.name === "ClosedCampaign").discriminator), Buffer.from([1])]);
    expect(isRewardClosedCampaign(closed)).toBe(true);
    expect(isRewardClosedCampaign(data)).toBe(false);
    expect(() => decodeRewardCampaignAccount(closed)).toThrow(/closed/);

    const receipt = receiptData(1_000_000n);
    expect(decodeRewardReceiptAccount(receipt).claimed).toBe(1_000_000n);
    expect(decodeContractAccount("cofferRewards", "Receipt", receipt).claimed.toString()).toBe("1000000");
    expect(() => decodeRewardReceiptAccount(receipt.subarray(0, 31))).toThrow(/32/);
    expect(() => decodeRewardReceiptAccount(Buffer.concat([Buffer.alloc(8), receipt.subarray(8)]))).toThrow(/discriminator/);
  });

  test("payout window: claimable at a time, reset time", () => {
    const fields = { liquidity: 1_000n, payoutLimit: 300n, windowSeconds: 3_600n, windowStart: 10_000n, windowPaid: 200n };
    expect(rewardCampaignClaimable(fields, 10_500)).toBe(100n);
    expect(rewardCampaignClaimable({ ...fields, windowPaid: 300n }, 10_500)).toBe(0n);
    expect(rewardCampaignClaimable(fields, 13_600)).toBe(300n); // elapsed: the whole limit
    expect(rewardCampaignClaimable({ ...fields, payoutLimit: 0n, windowSeconds: 0n }, 10_500)).toBe(1_000n);
    expect(rewardCampaignClaimable({ ...fields, liquidity: 50n }, 10_500)).toBe(50n);
    expect(rewardWindowResetsAt(fields, 10_500)).toBe(13_600n);
    expect(rewardWindowResetsAt(fields, 13_600)).toBeNull();
  });

  test("CampaignClosed event", () => {
    const b = Buffer.alloc(72);
    Buffer.from(idl.events.find((e: any) => e.name === "CampaignClosed").discriminator).copy(b, 0);
    USDC.toBuffer().copy(b, 8);
    admin.toBuffer().copy(b, 40);
    const e = decodeRewardCampaignClosedEvent(b)!;
    expect(e.campaign.equals(USDC) && e.admin.equals(admin)).toBe(true);
    expect(decodeRewardCampaignClosedEvent(b.subarray(0, 71))).toBeNull();
  });

  test("RewardPaid: only lines of the rewards program on top of the invoke stack, nothing after truncation", () => {
    const event = (user: PublicKey, net: bigint) => {
      const b = Buffer.alloc(104);
      Buffer.from(idl.events.find((e: any) => e.name === "RewardPaid").discriminator).copy(b, 0);
      USDC.toBuffer().copy(b, 8);
      user.toBuffer().copy(b, 40);
      b.writeBigUInt64LE(100n, 72);
      b.writeBigUInt64LE(net + 1n, 80);
      b.writeBigUInt64LE(net, 88);
      b.writeBigUInt64LE(net, 96);
      return `Program data: ${b.toString("base64")}`;
    };
    const R = COFFER_REWARDS_PROGRAM_ID.toBase58();
    const other = Keypair.generate().publicKey.toBase58();
    const [a, b, c, d] = [0, 1, 2, 3].map(() => Keypair.generate().publicKey);
    const logs = [
      "Program ComputeBudget111111111111111111111111111111 invoke [1]",
      "Program ComputeBudget111111111111111111111111111111 success",
      `Program ${R} invoke [1]`,
      "Program log: Instruction: ClaimToken",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]",
      event(d, 9n), // printed by the token program frame
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success",
      event(a, 10n),
      `Program ${R} success`,
      `Program ${other} invoke [1]`,
      event(c, 11n), // same bytes from another program
      `Program ${R} invoke [2]`,
      event(b, 12n), // a claim through CPI counts
      `Program ${R} success`,
      `Program ${other} success`,
      "Log truncated",
      event(c, 13n),
    ];
    const events = parseRewardPaidEvents(logs);
    expect(events.map((e) => [e.user.toBase58(), e.netCredit])).toEqual([[a.toBase58(), 10n], [b.toBase58(), 12n]]);
    expect(events[0].grossDebit).toBe(11n);
    expect(events[0].campaign.equals(USDC)).toBe(true);
  });
});

// ── Payout ──

describe("rewardClaimPayout (assets.rs claim_transfer_amount)", () => {
  const pay = (fee: { basisPoints: number; maximumFee: bigint } | null, due: bigint, available: bigint) =>
    rewardClaimPayout({ totalRaw: due, claimedRaw: 0n, liquidityRaw: available, vaultRaw: available, native: false, fee });

  test("the Rust unit tests", () => {
    expect(pay({ basisPoints: 1000, maximumFee: U64_MAX }, 100n, 11n)).toEqual({ grossRaw: 10n, netRaw: 9n, failure: null });
    expect(pay(null, 100n, 60n)).toEqual({ grossRaw: 60n, netRaw: 60n, failure: null });
    expect(pay({ basisPoints: 1, maximumFee: 7n }, U64_MAX, U64_MAX)).toEqual({ grossRaw: U64_MAX, netRaw: U64_MAX - 7n, failure: null });
    expect(pay({ basisPoints: 10_000, maximumFee: 60n }, U64_MAX, 60n).failure).toBe("ZeroPayment");
    expect(pay({ basisPoints: 10_000, maximumFee: 60n }, U64_MAX, 61n)).toEqual({ grossRaw: 61n, netRaw: 1n, failure: null });
    expect(pay({ basisPoints: 10_000, maximumFee: 60n }, 3n, 100n)).toEqual({ grossRaw: 63n, netRaw: 3n, failure: null });
    expect(pay({ basisPoints: 10_000, maximumFee: U64_MAX }, U64_MAX, U64_MAX).failure).toBe("ZeroPayment");
  });

  test("program order of failures, min(vault, liquidity), native", () => {
    const base = { totalRaw: 100n, claimedRaw: 0n, liquidityRaw: 50n, vaultRaw: 80n, native: true };
    expect(rewardClaimPayout(base)).toEqual({ grossRaw: 50n, netRaw: 50n, failure: null });
    expect(rewardClaimPayout({ ...base, claimedRaw: 100n }).failure).toBe("AlreadyClaimed");
    expect(rewardClaimPayout({ ...base, liquidityRaw: 0n }).failure).toBe("InsufficientLiquidity");
    expect(rewardClaimPayout({ ...base, vaultRaw: 0n }).failure).toBe("InsufficientLiquidity");
    // A fee is ignored for SOL.
    expect(rewardClaimPayout({ ...base, fee: { basisPoints: 5000, maximumFee: U64_MAX } }).netRaw).toBe(50n);
    // The payout window clips the gross; an exhausted window fails before the liquidity check.
    expect(rewardClaimPayout({ ...base, windowAllowanceRaw: 30n })).toEqual({ grossRaw: 30n, netRaw: 30n, failure: null });
    expect(rewardClaimPayout({ ...base, windowAllowanceRaw: 0n, liquidityRaw: 0n }).failure).toBe("PayoutLimitReached");
    expect(rewardClaimPayout({ ...base, windowAllowanceRaw: null }).grossRaw).toBe(50n);
    // An expired voucher fails first.
    expect(rewardClaimPayout({ ...base, claimedRaw: 100n, expiresAt: 10n, now: 11n }).failure).toBe("VoucherExpired");
    expect(rewardClaimPayout({ ...base, expiresAt: 10n, now: 10n }).failure).toBeNull();
  });

  test("TransferFeeConfig from mint data and the epoch schedule", () => {
    const data = mint2022([[1, transferFeeConfig([0n, 1000n, 50], [700n, 5000n, 100])]]);
    const config = parseRewardMintTransferFee(data)!;
    expect(config.newerEpoch).toBe(700n);
    expect(rewardTransferFeeAt(config, 699)).toEqual({ basisPoints: 50, maximumFee: 1000n });
    expect(rewardTransferFeeAt(config, 700n)).toEqual({ basisPoints: 100, maximumFee: 5000n });
    expect(rewardTransferFeeAt(config)).toEqual({ basisPoints: 100, maximumFee: 5000n });
    expect(parseRewardMintTransferFee(mint2022([]))).toBeNull();
    const classic = Buffer.alloc(82);
    classic[45] = 1;
    expect(parseRewardMintTransferFee(classic)).toBeNull();
  });
});

// ── Claim transaction ──

describe("buildRewardClaimTx", () => {
  const voucher = voucherOf(usdcVector);
  const user = new PublicKey(usdcVector.beneficiary);
  const campaign = new PublicKey(usdcVector.campaign);

  test("token claim: [ComputeBudget, ATA, Ed25519, claim_token] with the IDL layout", () => {
    const res = buildRewardClaimTx(voucher, { beneficiary: user });
    if (!res.ok) throw new Error(res.error.humanMessage);
    const tx = res.data;
    const [cb, ata, ed, claim] = tx.instructions;
    expect(tx.instructions).toHaveLength(4);
    expect(cb.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(ata.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(ed.data.toString("hex")).toBe(usdcVector.ixDataHex);
    expect(claim.programId.equals(COFFER_REWARDS_PROGRAM_ID)).toBe(true);
    const total = Buffer.alloc(8);
    total.writeBigUInt64LE(BigInt(usdcVector.totalRaw));
    const expires = Buffer.alloc(8);
    expires.writeBigInt64LE(BigInt(usdcVector.expiresAt));
    expect(claim.data.toString("hex")).toBe(Buffer.concat([Buffer.from(ixSchema("claim_token").discriminator), total, expires, Buffer.from([0, 0])]).toString("hex"));
    const destination = deriveAta(user, USDC, TOKEN_PROGRAM_ID);
    const expected = [user, campaign, deriveRewardReceiptPda(campaign, user)[0], USDC, TOKEN_PROGRAM_ID, deriveAta(campaign, USDC, TOKEN_PROGRAM_ID), destination, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram.programId];
    expect(claim.keys.map((k) => k.pubkey.toBase58())).toEqual(expected.map((k) => k.toBase58()));
    expectKeysMatchIdl(claim.keys, "claim_token");
    expect(tx.destination.equals(destination)).toBe(true);
    expect(tx.createsDestination).toBe(true);
    expect(tx.receiptRentLamports).toBe(REWARD_RECEIPT_RENT_LAMPORTS);
    expect(tx.destinationRentLamports).toBe(2_039_280);
    expect(tx.receiptRentLamports).toBe(1_113_600);
    expect(tx.rentLamports).toBe(1_113_600 + 2_039_280);
    expect(tx.expectedNetRaw).toBe(1000n);
    expect(tx.memo).toBe(false);
  });

  test("existing destination with required memos: no ATA, SPL Memo in the hook slice", () => {
    const destinationData = tokenAccount(USDC, user, 5n, [[7, Buffer.alloc(0)], [8, Buffer.from([1])]]);
    const receipt = receiptData(5n);
    const res = buildRewardClaimTx({ ...voucher, tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58() }, {
      computeUnitLimit: null,
      destinationData,
      receiptData: receipt,
      mintData: mint2022([]),
      vaultRaw: 10_000n,
      liquidityRaw: 7_000n,
    });
    if (!res.ok) throw new Error(res.error.humanMessage);
    const [ed, claim] = res.data.instructions;
    expect(res.data.instructions).toHaveLength(2);
    expect(ed.programId.equals(Ed25519Program.programId)).toBe(true);
    expect(claim.data[24]).toBe(1); // hook_accounts
    expect(claim.keys).toHaveLength(10);
    expect(claim.keys[9]).toEqual({ pubkey: SPL_MEMO_PROGRAM_ID, isSigner: false, isWritable: false });
    expect(res.data.memo).toBe(true);
    expect(res.data.rentLamports).toBe(0);
    expect(res.data.expectedNetRaw).toBe(7_000n);
  });

  test("Token-2022 with an unknown destination passes SPL Memo; a known missing ATA does not", () => {
    const v2022 = { ...voucher, tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58() };
    const unknown = buildRewardClaimTx(v2022);
    if (!unknown.ok) throw new Error(unknown.error.humanMessage);
    const claim = unknown.data.instructions[unknown.data.instructions.length - 1];
    expect(unknown.data.memo).toBe(true);
    expect(claim.data[24]).toBe(1); // hook_accounts
    expect(claim.keys[9]).toEqual({ pubkey: SPL_MEMO_PROGRAM_ID, isSigner: false, isWritable: false });
    const missing = buildRewardClaimTx(v2022, { destinationData: null });
    expect(missing.ok && missing.data.memo).toBe(false);
    const forced = buildRewardClaimTx(v2022, { memo: false });
    expect(forced.ok && forced.data.memo).toBe(false);
    // SPL Token has no MemoTransfer.
    const spl = buildRewardClaimTx(voucher);
    expect(spl.ok && spl.data.memo).toBe(false);
  });

  test("a missing destination that is not the ATA is refused", () => {
    const res = buildRewardClaimTx(voucher, { destination: Keypair.generate().publicKey, destinationData: null });
    expect(!res.ok && res.error.code).toBe("account_not_found");
  });

  test("transfer-fee mint: the campaign pays the fee, the preview is net", () => {
    const res = buildRewardClaimTx({ ...voucher, tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58() }, {
      mintData: mint2022([[1, transferFeeConfig([0n, U64_MAX, 1000], [0n, U64_MAX, 1000])]]),
      destinationData: null,
      vaultRaw: 11n,
      liquidityRaw: 100n,
      epoch: 1,
    });
    if (!res.ok) throw new Error(res.error.humanMessage);
    expect(res.data.expectedGrossRaw).toBe(10n);
    expect(res.data.expectedNetRaw).toBe(9n);
    // Token-2022 ATA with ImmutableOwner and TransferFeeAmount: 182 bytes.
    expect(res.data.destinationRentLamports).toBe((128 + 182) * 6960);
  });

  test("refusals: hook mint, all claimed, empty vault, foreign destination, tampered voucher", () => {
    const hook = buildRewardClaimTx({ ...voucher, tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58() }, { mintData: mint2022([[14, Buffer.alloc(64)]]) });
    expect(!hook.ok && hook.error.code).toBe("unsupported_token_extension");
    const claimed = buildRewardClaimTx({ ...voucher, claimedRaw: usdcVector.totalRaw });
    expect(!claimed.ok && claimed.error.code).toBe("invalid_input");
    const empty = buildRewardClaimTx(voucher, { vaultRaw: 0n });
    expect(!empty.ok && empty.error.code).toBe("insufficient_funds");
    const noneNow = buildRewardClaimTx({ ...voucher, claimableNowRaw: "0" });
    expect(!noneNow.ok && noneNow.error.code).toBe("insufficient_funds");
    const foreign = buildRewardClaimTx(voucher, { destinationData: tokenAccount(USDC, Keypair.generate().publicKey, 0n) });
    expect(!foreign.ok && foreign.error.code).toBe("invalid_input");
    const other = buildRewardClaimTx(voucher, { beneficiary: Keypair.generate().publicKey });
    expect(!other.ok && other.error.code).toBe("invalid_input");
    const tampered = buildRewardClaimTx({ ...voucher, totalRaw: "1" });
    expect(!tampered.ok && tampered.error.code).toBe("backend_invalid_response");
    const expired = buildRewardClaimTx(voucher, { nowUnix: Number(usdcVector.expiresAt) + 1 });
    expect(!expired.ok && expired.error.humanMessage).toMatch(/6009/);
    const window = buildRewardClaimTx(voucher, { vaultRaw: 10_000n, liquidityRaw: 10_000n, windowAllowanceRaw: 0n });
    expect(!window.ok && window.error.humanMessage).toMatch(/6010/);
  });

  test("SOL claim: [ComputeBudget, Ed25519, claim_native]", () => {
    const res = buildRewardClaimTx({ ...voucher, mint: PublicKey.default.toBase58(), tokenProgram: PublicKey.default.toBase58(), decimals: 9 }, { vaultRaw: 400n, liquidityRaw: 1_000n });
    if (!res.ok) throw new Error(res.error.humanMessage);
    const [, ed, claim] = res.data.instructions;
    expect(res.data.instructions).toHaveLength(3);
    expect(ed.data.toString("hex")).toBe(usdcVector.ixDataHex);
    const total = Buffer.alloc(8);
    total.writeBigUInt64LE(BigInt(usdcVector.totalRaw));
    const expires = Buffer.alloc(8);
    expires.writeBigInt64LE(BigInt(usdcVector.expiresAt));
    expect(claim.data.toString("hex")).toBe(Buffer.concat([Buffer.from(ixSchema("claim_native").discriminator), total, expires, Buffer.from([0])]).toString("hex"));
    const expected = [user, campaign, deriveRewardSolVaultPda(campaign)[0], deriveRewardReceiptPda(campaign, user)[0], SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram.programId];
    expect(claim.keys.map((k) => k.pubkey.toBase58())).toEqual(expected.map((k) => k.toBase58()));
    expectKeysMatchIdl(claim.keys, "claim_native");
    expect(res.data.destination.equals(user)).toBe(true);
    expect(res.data.expectedNetRaw).toBe(400n);
    expect(res.data.destinationRentLamports).toBe(0);
  });
});

describe("loadRewardClaimState", () => {
  const voucher = voucherOf(usdcVector);
  const user = new PublicKey(usdcVector.beneficiary);
  const campaign = new PublicKey(usdcVector.campaign);
  const signer = new PublicKey(usdcVector.signer);
  const account = (owner: PublicKey, data: Buffer, lamports = 2_000_000) => ({ owner, data, lamports, executable: false, rentEpoch: 0 });

  function connection(campaignBytes: Buffer, mintData: Buffer, owner = TOKEN_2022_PROGRAM_ID) {
    const asked: string[][] = [];
    const conn = {
      getMultipleAccountsInfo: async (keys: PublicKey[]) => {
        asked.push(keys.map((k) => k.toBase58()));
        return [
          account(COFFER_REWARDS_PROGRAM_ID, campaignBytes),
          null,
          account(owner, tokenAccount(USDC, campaign, 11n)),
          account(owner, mintData),
          null,
        ];
      },
      getEpochInfo: async () => ({ epoch: 800, slotIndex: 0, slotsInEpoch: 1, absoluteSlot: 0 }),
    };
    return { conn: conn as any, asked };
  }

  const campaignBytes = (epoch: bigint, extra: Partial<CampaignFields> = {}) =>
    campaignData({
      admin: user, id: Buffer.alloc(32, 1), bump: 255, mint: USDC, tokenProgram: TOKEN_2022_PROGRAM_ID, signer, epoch, liquidity: 100n, metadata: "",
      domain: Buffer.from(usdcVector.domainHex, "hex"), ...extra,
    });
  const feeMint = mint2022([[1, transferFeeConfig([0n, U64_MAX, 5000], [700n, U64_MAX, 1000])]]);
  const v2022 = { ...voucher, tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58() };

  test("reads campaign, receipt, vault, mint, destination and the epoch; the claim previews from them", async () => {
    const { conn, asked } = connection(campaignBytes(BigInt(usdcVector.signerEpoch)), feeMint);
    const state = await loadRewardClaimState(conn, v2022);
    if (!state.ok) throw new Error(state.error.humanMessage);
    expect(asked[0]).toEqual([campaign, deriveRewardReceiptPda(campaign, user)[0], deriveAta(campaign, USDC, TOKEN_2022_PROGRAM_ID), USDC, deriveAta(user, USDC, TOKEN_2022_PROGRAM_ID)].map((k) => k.toBase58()));
    expect(state.data.vaultRaw).toBe(11n);
    expect(state.data.liquidityRaw).toBe(100n);
    expect(state.data.receiptData).toBeNull();
    expect(state.data.destinationData).toBeNull();
    expect(state.data.epoch).toBe(800n);
    const tx = buildRewardClaimTx(v2022, state.data);
    if (!tx.ok) throw new Error(tx.error.humanMessage);
    // Epoch 800 ≥ 700: 10 % fee, so 10 gross pays 9 net out of 11 in the vault.
    expect([tx.data.expectedGrossRaw, tx.data.expectedNetRaw]).toEqual([10n, 9n]);
    expect(tx.data.receiptRentLamports).toBe(REWARD_RECEIPT_RENT_LAMPORTS);
  });

  test("the destination it read is spread into the claim", async () => {
    const { conn, asked } = connection(campaignBytes(BigInt(usdcVector.signerEpoch)), feeMint);
    const other = Keypair.generate().publicKey;
    const state = await loadRewardClaimState(conn, v2022, { destination: other });
    if (!state.ok) throw new Error(state.error.humanMessage);
    expect(asked[0][4]).toBe(other.toBase58());
    expect(state.data.destination?.equals(other)).toBe(true);
    // destinationData is null (missing) and `other` is not the ATA: refused, not sent to the ATA.
    const tx = buildRewardClaimTx(v2022, { ...state.data });
    expect(!tx.ok && tx.error.code).toBe("account_not_found");
  });

  test("a rotated signer epoch, another domain and a closed campaign are refused before building", async () => {
    const rotated = await loadRewardClaimState(connection(campaignBytes(BigInt(usdcVector.signerEpoch) + 1n), feeMint).conn, v2022);
    expect(!rotated.ok && rotated.error.humanMessage).toMatch(/6000/);
    const otherDomain = await loadRewardClaimState(connection(campaignBytes(BigInt(usdcVector.signerEpoch), { domain: Buffer.alloc(32, 1) }), feeMint).conn, v2022);
    expect(!otherDomain.ok && otherDomain.error.humanMessage).toMatch(/domain/);
    const closedBytes = Buffer.concat([Buffer.from(idl.accounts.find((a: any) => a.name === "ClosedCampaign").discriminator), Buffer.from([1])]);
    const closed = await loadRewardClaimState(connection(closedBytes, feeMint).conn, v2022);
    expect(!closed.ok && closed.error.humanMessage).toMatch(/closed/);
  });

  test("the payout window's allowance is read and clips the preview", async () => {
    const bytes = campaignBytes(BigInt(usdcVector.signerEpoch), { payoutLimit: 6n, windowSeconds: 86_400n, windowStart: BigInt(NOW_UNIX - 60), windowPaid: 0n });
    const state = await loadRewardClaimState(connection(bytes, feeMint).conn, v2022);
    if (!state.ok) throw new Error(state.error.humanMessage);
    expect(state.data.windowAllowanceRaw).toBe(6n);
    const tx = buildRewardClaimTx(v2022, state.data);
    if (!tx.ok) throw new Error(tx.error.humanMessage);
    // 6 gross at a 10 % fee: 5 net (⌈6·0.1⌉ = 1).
    expect([tx.data.expectedGrossRaw, tx.data.expectedNetRaw]).toEqual([6n, 5n]);
  });
});

// ── Admin builders ──

describe("admin instruction builders", () => {
  const admin = Keypair.generate().publicKey;
  const signer = Keypair.generate().publicKey;
  const id = boostsCampaignId("devnet", USDC);
  const [campaign] = deriveRewardCampaignPda(admin, id);
  const usdc = { mint: USDC, tokenProgram: TOKEN_PROGRAM_ID };
  const u64 = (n: bigint) => new BN(n.toString()).toArrayLike(Buffer, "le", 8);
  const disc = (name: string) => Buffer.from(ixSchema(name).discriminator);

  test("initialize: token and native", () => {
    const token = buildRewardInitializeIx({ admin, campaign, id, backendSigner: signer, metadata: "USDC", asset: usdc });
    const meta = Buffer.from("USDC");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(meta.length);
    expect(token.data).toEqual(Buffer.concat([disc("initialize_token"), id, signer.toBuffer(), len, meta]));
    expect(token.keys.map((k) => k.pubkey.toBase58())).toEqual([admin, campaign, USDC, TOKEN_PROGRAM_ID, deriveAta(campaign, USDC, TOKEN_PROGRAM_ID), SYSVAR_SLOT_HASHES_PUBKEY, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId].map((k) => k.toBase58()));
    expectKeysMatchIdl(token.keys, "initialize_token");
    const native = buildRewardInitializeIx({ admin, campaign, id, backendSigner: signer, asset: { native: true } });
    expect(native.data.subarray(0, 8)).toEqual(disc("initialize_native"));
    expect(native.keys[2].pubkey.equals(deriveRewardSolVaultPda(campaign)[0])).toBe(true);
    expect(native.keys[3].pubkey.equals(SYSVAR_SLOT_HASHES_PUBKEY)).toBe(true);
    expectKeysMatchIdl(native.keys, "initialize_native");
    expect(() => buildRewardInitializeIx({ admin, campaign, id, backendSigner: signer, metadata: "x".repeat(201), asset: usdc })).toThrow(/6005/);
    expect(() => buildRewardInitializeIx({ admin, campaign, id, backendSigner: PublicKey.default, asset: usdc })).toThrow(/6004/);
    expect(() => buildRewardInitializeIx({ admin, campaign, id: id.subarray(1), backendSigner: signer, asset: usdc })).toThrow(/32 bytes/);
    expect(() => buildRewardInitializeIx({ admin, campaign, id, backendSigner: signer, asset: { mint: USDC, tokenProgram: SystemProgram.programId } })).toThrow(/token program/);
  });

  test("deposit, withdraw (memo), rotate, return surplus", () => {
    const deposit = buildRewardDepositIx({ admin, campaign, amount: 5_000_000n, asset: usdc });
    expect(deposit.data).toEqual(Buffer.concat([disc("deposit_token"), u64(5_000_000n)]));
    expect(deposit.keys[5].pubkey.equals(deriveAta(admin, USDC, TOKEN_PROGRAM_ID))).toBe(true);
    expectKeysMatchIdl(deposit.keys, "deposit_token");
    // rc8+: anyone funds — the first account is the funder.
    const funder = Keypair.generate().publicKey;
    const byOther = buildRewardDepositIx({ admin: funder, campaign, amount: 1n, asset: { native: true } });
    expect(byOther.keys[0]).toEqual({ pubkey: funder, isSigner: true, isWritable: true });
    expectKeysMatchIdl(byOther.keys, "deposit_native");
    const withdraw = buildRewardWithdrawIx({ admin, campaign, amount: U64_MAX, asset: usdc, memo: true });
    expect(withdraw.data).toEqual(Buffer.concat([disc("withdraw_token"), u64(U64_MAX)]));
    expect(withdraw.keys).toHaveLength(7);
    expectKeysMatchIdl(withdraw.keys, "withdraw_token");
    expect(withdraw.keys[6].pubkey.equals(SPL_MEMO_PROGRAM_ID)).toBe(true);
    const sol = buildRewardWithdrawIx({ admin, campaign, amount: 1n, asset: { native: true } });
    expect(sol.data.subarray(0, 8)).toEqual(disc("withdraw_native"));
    expectKeysMatchIdl(sol.keys, "withdraw_native");
    expect(() => buildRewardDepositIx({ admin, campaign, amount: 0n, asset: usdc })).toThrow(/6003/);
    expect(() => buildRewardDepositIx({ admin, campaign, amount: U64_MAX + 1n, asset: usdc })).toThrow(/u64/);

    const rotate = buildRewardRotateSignerIx({ admin, campaign, backendSigner: signer });
    expect(rotate.data).toEqual(Buffer.concat([disc("rotate_signer"), signer.toBuffer()]));
    expectKeysMatchIdl(rotate.keys, "rotate_signer");
    // An off-curve key (a PDA) is not a valid signer.
    expect(() => buildRewardRotateSignerIx({ admin, campaign, backendSigner: campaign })).toThrow(/6004/);

    const recipient = Keypair.generate().publicKey;
    const fromCampaign = buildRewardReturnSurplusIx({ admin, campaign, amount: 7n, native: true, source: "campaign", recipient });
    expect(fromCampaign.keys[3].pubkey.equals(campaign)).toBe(true);
    expectKeysMatchIdl(fromCampaign.keys, "return_surplus_native");
    const fromVault = buildRewardReturnSurplusIx({ admin, campaign, amount: 7n, native: true, source: "vault", recipient });
    expect(fromVault.keys[3].pubkey.equals(deriveRewardSolVaultPda(campaign)[0])).toBe(true);
    const other = Keypair.generate().publicKey;
    const token = buildRewardReturnSurplusIx({ admin, campaign, amount: 7n, mint: other, tokenProgram: TOKEN_2022_PROGRAM_ID, recipient });
    expect(token.data).toEqual(Buffer.concat([disc("return_surplus_token"), u64(7n)]));
    expect(token.keys[4].pubkey.equals(deriveAta(campaign, other, TOKEN_2022_PROGRAM_ID))).toBe(true);
    expect(token.keys[6].pubkey.equals(deriveAta(recipient, other, TOKEN_2022_PROGRAM_ID))).toBe(true);
    expectKeysMatchIdl(token.keys, "return_surplus_token");
    // check_surplus raises InsufficientLiquidity for 0.
    expect(() => buildRewardReturnSurplusIx({ admin, campaign, amount: 0n, native: true, source: "vault", recipient })).toThrow(/6002/);
  });

  test("set_payout_limit, close, close_receipt", () => {
    const limit = buildRewardSetPayoutLimitIx({ admin, campaign, limit: 1_000_000n, windowSeconds: 86_400n });
    expect(limit.data).toEqual(Buffer.concat([disc("set_payout_limit"), u64(1_000_000n), u64(86_400n)]));
    expectKeysMatchIdl(limit.keys, "set_payout_limit");
    expect(buildRewardSetPayoutLimitIx({ admin, campaign, limit: 0n, windowSeconds: 0n }).data.subarray(8)).toEqual(Buffer.alloc(16));
    expect(() => buildRewardSetPayoutLimitIx({ admin, campaign, limit: 1n, windowSeconds: 0n })).toThrow(/6011/);

    const sol = buildRewardCloseIx({ admin, campaign, asset: { native: true } });
    expect(sol.data).toEqual(disc("close_native"));
    expect(sol.keys.map((k) => k.pubkey.toBase58())).toEqual([admin, campaign, deriveRewardSolVaultPda(campaign)[0], SystemProgram.programId].map((k) => k.toBase58()));
    expectKeysMatchIdl(sol.keys, "close_native");
    const token = buildRewardCloseIx({ admin, campaign, asset: usdc });
    expect(token.data).toEqual(disc("close_token"));
    expect(token.keys.map((k) => k.pubkey.toBase58())).toEqual([admin, campaign, deriveAta(campaign, USDC, TOKEN_PROGRAM_ID), TOKEN_PROGRAM_ID].map((k) => k.toBase58()));
    expectKeysMatchIdl(token.keys, "close_token");

    const user = Keypair.generate().publicKey;
    const receipt = buildRewardCloseReceiptIx({ user, campaign });
    expect(receipt.keys.map((k) => k.pubkey.toBase58())).toEqual([user, campaign, deriveRewardReceiptPda(campaign, user)[0]].map((k) => k.toBase58()));
    expectKeysMatchIdl(receipt.keys, "close_receipt");
  });
});

// ── Backend client ──

describe("CofferBackendClient rewards routes", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function mockFetch(status: number, body: unknown) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    return calls;
  }

  const client = new CofferBackendClient({ apiEndpoint: "https://api.example.test/" });

  test("GET routes", async () => {
    const calls = mockFetch(200, { asOf: "2026-12-03T10:15:31.112Z", pools: [] });
    const boosts = await client.getRewardBoosts();
    expect(boosts.ok && boosts.data.pools).toEqual([]);
    await client.getRewardCampaigns();
    await client.getWalletRewards("@alice");
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.example.test/api/rewards/boosts",
      "https://api.example.test/api/rewards/campaigns",
      "https://api.example.test/api/rewards/wallets/%40alice",
    ]);
  });

  test("requestRewardVoucher: both call forms post {wallet, campaign}", async () => {
    const calls = mockFetch(200, voucherOf(usdcVector));
    const a = await client.requestRewardVoucher({ wallet: usdcVector.beneficiary, campaign: usdcVector.campaign });
    const b = await client.requestRewardVoucher(usdcVector.beneficiary, usdcVector.campaign);
    expect(a.ok && b.ok).toBe(true);
    for (const call of calls) {
      expect(call.url).toBe("https://api.example.test/api/rewards/vouchers");
      expect(call.init.method).toBe("POST");
      expect(JSON.parse(String(call.init.body))).toEqual({ wallet: usdcVector.beneficiary, campaign: usdcVector.campaign });
    }
  });

  test("typed error codes; 429 and 503 are not re-sent", async () => {
    let calls = mockFetch(409, { statusCode: 409, code: "already_claimed", message: "everything accrued so far has been claimed" });
    const res = await client.requestRewardVoucher(usdcVector.beneficiary, usdcVector.campaign);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(getRewardsApiError(res.error)).toEqual({
      status: 409,
      code: "already_claimed",
      message: "everything accrued so far has been claimed",
      body: { statusCode: 409, code: "already_claimed", message: "everything accrued so far has been claimed" },
    });
    expect(res.error.humanMessage).toMatch(/HTTP 409/);
    for (const status of [429, 503]) {
      calls = mockFetch(status, { statusCode: status, message: "later" });
      const r = await client.requestRewardVoucher(usdcVector.beneficiary, usdcVector.campaign);
      expect(calls).toHaveLength(1);
      expect(!r.ok && getRewardsApiError(r.error)?.code).toBeNull();
    }
    mockFetch(400, { statusCode: 400, message: ["wallet must be a Solana address (base58)"], error: "Bad Request" });
    const bad = await client.requestRewardVoucher("x", "y");
    expect(!bad.ok && getRewardsApiError(bad.error)?.message).toBe("wallet must be a Solana address (base58)");
  });

  test("the { success: false, error } body of the global exception filter", async () => {
    mockFetch(404, { success: false, error: "nothing accrued for this wallet in this campaign yet" });
    const res = await client.requestRewardVoucher(usdcVector.beneficiary, usdcVector.campaign);
    if (res.ok) throw new Error("expected a failure");
    expect(getRewardsApiError(res.error)).toEqual({
      status: 404,
      code: null,
      message: "nothing accrued for this wallet in this campaign yet",
      body: { success: false, error: "nothing accrued for this wallet in this campaign yet" },
    });
  });
});

// ── Pool admin campaigns ──

describe("pool admin campaign setup", () => {
  const admin = Keypair.generate().publicKey;
  const signer = Keypair.generate().publicKey;
  const id = boostsCampaignId("devnet", "native", 2);
  const [campaign] = deriveRewardCampaignPda(admin, id);
  const params = {
    programId: COFFER_REWARDS_PROGRAM_ID.toBase58(),
    cluster: "devnet" as const,
    admin: admin.toBase58(),
    mint: "native",
    generation: 2,
    campaignIdHex: id.toString("hex"),
    address: campaign.toBase58(),
    bump: 255,
    state: "free" as const,
    campaign: null,
    backendSigner: signer.toBase58(),
    payoutWindowSec: 86_400,
    note: "",
  };

  test("suggestedPayoutLimit: 1.5 × the daily issuance per window, rounded up", () => {
    expect(suggestedPayoutLimit(1_000n)).toBe(1_500n);
    expect(suggestedPayoutLimit(1_000n, 3_600n)).toBe(63n); // ⌈1500/24⌉
    expect(suggestedPayoutLimit(0n)).toBe(0n);
  });

  test("[ComputeBudget, initialize, set_payout_limit, deposit] for the backend's id and address", () => {
    const { instructions, campaign: c } = buildPoolAdminCampaignSetup({ params, admin, asset: { native: true }, depositRaw: 5_000_000_000n, payoutLimitRaw: 1_000_000_000n });
    expect(c.equals(campaign)).toBe(true);
    const names = instructions.slice(1).map((ix) => ixSchema(idl.instructions.find((i: any) => Buffer.from(i.discriminator).equals(ix.data.subarray(0, 8))).name).name);
    expect(names).toEqual(["initialize_native", "set_payout_limit", "deposit_native"]);
    expect(instructions[1].data.subarray(8, 40)).toEqual(id);
    expect(instructions[1].data.subarray(40, 72)).toEqual(signer.toBuffer());
  });

  test("refuses a taken address, another admin, another generation and a missing payout limit", () => {
    expect(() => buildPoolAdminCampaignSetup({ params: { ...params, state: "registered" }, admin, asset: { native: true }, depositRaw: 0n, payoutLimitRaw: 1n })).toThrow(/registered/);
    expect(() => buildPoolAdminCampaignSetup({ params, admin: Keypair.generate().publicKey, asset: { native: true }, depositRaw: 0n, payoutLimitRaw: 1n })).toThrow(/not/);
    expect(() => buildPoolAdminCampaignSetup({ params: { ...params, generation: 3 }, admin, asset: { native: true }, depositRaw: 0n, payoutLimitRaw: 1n })).toThrow(/id/);
    expect(() => buildPoolAdminCampaignSetup({ params, admin, asset: { native: true }, depositRaw: 0n, payoutLimitRaw: 0n })).toThrow(/payout limit/);
    expect(() => buildPoolAdminCampaignSetup({ params, admin, asset: { mint: USDC, tokenProgram: TOKEN_PROGRAM_ID }, depositRaw: 0n, payoutLimitRaw: 1n })).toThrow(/native/);
  });

  test("CofferBackendClient pool admin routes", async () => {
    const realFetch = globalThis.fetch;
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method) });
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const c = new CofferBackendClient({ apiEndpoint: "https://api.example.test" });
      const pool = "PooL1111111111111111111111111111111111111111";
      await c.getPoolAdminCampaignParams(pool, "native");
      await c.createPoolAdminBoost(pool, { campaignId: 3, startAt: "2026-12-01T00:00:00Z", endAt: "2026-12-08T00:00:00Z", budgetRaw: "1" });
      await c.cancelPoolAdminBoost(pool, 9);
      expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
        `GET https://api.example.test/api/pools/admin/${pool}/boosts/campaign-params?mint=native`,
        `POST https://api.example.test/api/pools/admin/${pool}/boosts`,
        `DELETE https://api.example.test/api/pools/admin/${pool}/boosts/9`,
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
