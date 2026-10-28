/**
 * T5 / T14 fee claims: Treasury vault PDA recipients, v5 (3n) vs v6.1
 * (4n + tail) blocks, placeholders for zero-owed slots, creator claims, and
 * the legacy / v0 transaction-form decision.
 */
import { AddressLookupTableAccount, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import {
  treasuryVaultPda, buildClaimAccounts, buildCreatorClaimAccounts, buildCollectProtocolFeesIx, buildClaimCreatorFeesIx,
  buildRegisterTokenIx, buildTreasuryWithdrawIx, legacyTxSize, v0TxSize, chooseTxForm, MAX_TX_BYTES, CLAIM_ERROR_NAMES, CLAIM_ACCOUNTS_PER_TOKEN, uniqueKeys,
} from "../src/clients/feeClaim";
import { deriveAta, deriveTreasuryPda } from "../src/utils/pda";
import { TREASURY_VAULT_SEED } from "../src/config";
import protocolAdminIdl from "../src/idl/protocol_admin.json";
import cofferPoolIdl from "../src/idl/coffer_pool.json";
import { mockPool, cfg } from "./helpers/poolFixture";

const pk = (): PublicKey => Keypair.generate().publicKey;
const ixName = (idl: any, data: Buffer) => (idl.instructions as any[]).find((i) => Buffer.from(i.discriminator).equals(data.subarray(0, 8)))?.name;

describe("Treasury vault PDA", () => {
  test("[P01] [b\"vault\", mint] under protocol_admin, deterministic", () => {
    const mint = pk();
    const expected = PublicKey.findProgramAddressSync([TREASURY_VAULT_SEED, mint.toBuffer()], cfg.programs.protocolAdmin)[0];
    expect(treasuryVaultPda(mint, cfg.programs.protocolAdmin).equals(expected)).toBe(true);
    expect(treasuryVaultPda(mint, cfg.programs.protocolAdmin).equals(treasuryVaultPda(mint, cfg.programs.protocolAdmin))).toBe(true);
    expect(treasuryVaultPda(mint, cfg.programs.protocolAdmin).equals(treasuryVaultPda(pk(), cfg.programs.protocolAdmin))).toBe(false);
  });
});

describe("collect_protocol_fees blocks", () => {
  test("[P02] v61: [vault w, treasury_vault w, mint, program] × n, recipients forced to the vault PDAs", () => {
    const pool = mockPool({ protocolOwed: [5n, 7n] });
    const { remaining, claims } = buildClaimAccounts(cfg, "v61", pool);
    expect(remaining.length).toBe(8); expect(claims.length).toBe(2);
    pool.tokens.forEach((t, i) => {
      const blk = remaining.slice(4 * i, 4 * i + 4);
      expect(blk.map((m) => m.pubkey.toBase58())).toEqual([t.vault, treasuryVaultPda(t.mint, cfg.programs.protocolAdmin), t.mint, t.tokenProgram].map((k) => k.toBase58()));
      expect(blk.map((m) => m.isWritable)).toEqual([true, true, false, false]);
      expect(claims[i].recipient.equals(treasuryVaultPda(t.mint, cfg.programs.protocolAdmin))).toBe(true);
      expect(claims[i].owed.toString()).toBe(t.protocolFeesOwed.toString());
    });
  });
  test("[P03] v5: [vault w, treasury_vault w, program] × n, exactly 3n", () => {
    const pool = mockPool({ tokenCount: 3, protocolOwed: [5n, 7n, 9n] });
    const { remaining } = buildClaimAccounts(cfg, "v5", pool);
    expect(remaining.length).toBe(9);
    expect(remaining[2].pubkey.equals(pool.tokens[0].tokenProgram)).toBe(true);
    expect(CLAIM_ACCOUNTS_PER_TOKEN).toEqual({ v5: 3, v61: 4 });
  });
  test("[P04] zero-owed slots become read-only placeholders (pool key by default, custom when given)", () => {
    const pool = mockPool({ protocolOwed: [0n, 7n] });
    const { remaining, claims } = buildClaimAccounts(cfg, "v61", pool);
    expect(remaining.slice(0, 4).every((m) => m.pubkey.equals(pool.address) && !m.isWritable)).toBe(true);
    expect(claims.map((c) => c.index)).toEqual([1]);
    const ph = pk();
    expect(buildClaimAccounts(cfg, "v61", pool, [], ph).remaining[0].pubkey.equals(ph)).toBe(true);
    expect(buildClaimAccounts(cfg, "v5", pool).remaining.slice(0, 3).every((m) => m.pubkey.equals(pool.address))).toBe(true);
  });
  test("[P05] the v61 tail is appended verbatim (non-signer)", () => {
    const pool = mockPool({ protocolOwed: [1n, 1n] }); const memo = pk();
    const { remaining } = buildClaimAccounts(cfg, "v61", pool, [{ pubkey: memo, isSigner: false, isWritable: false }]);
    expect(remaining.length).toBe(9); expect(remaining[8].pubkey.equals(memo)).toBe(true);
  });
  test("[P06] the instruction: [treasury, admin s, config, pool w, coffer_pool_program] + block; carries `claims`", () => {
    const pool = mockPool({ protocolOwed: [1n, 0n] }); const admin = pk();
    const ix = buildCollectProtocolFeesIx({ cfg, abi: "v61", pool, admin });
    expect(ixName(protocolAdminIdl, ix.data)).toBe("pool_collect_protocol_fees"); expect(ix.data.length).toBe(8);
    expect(ix.programId.equals(cfg.programs.protocolAdmin)).toBe(true);
    const [treasury] = deriveTreasuryPda(cfg.programs.protocolAdmin);
    expect(ix.keys.slice(0, 5).map((k) => k.pubkey.toBase58())).toEqual([treasury, admin, pool.config, pool.address, cfg.programs.cofferPool].map((k) => k.toBase58()));
    expect(ix.keys[1].isSigner).toBe(true); expect(ix.keys[3].isWritable).toBe(true);
    expect(ix.keys.length).toBe(5 + 8); expect(ix.claims.length).toBe(1);
  });
  test("[P07] Token-2022 slots are accepted", () => {
    const pool = mockPool({ protocolOwed: [1n, 1n], tokenPrograms: [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID] });
    expect(buildClaimAccounts(cfg, "v61", pool).remaining[7].pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });
  test("[N01] a tail on the v5 ABI is refused (exactly 3n accounts)", () => {
    expect(() => buildClaimAccounts(cfg, "v5", mockPool({ protocolOwed: [1n, 1n] }), [{ pubkey: pk(), isSigner: false, isWritable: false }])).toThrow(/exactly 3 accounts/);
  });
  test("[N02] unknown ABI, signer tails, foreign token program", () => {
    expect(() => buildClaimAccounts(cfg, "v7" as any, mockPool())).toThrow(/unknown ABI/);
    expect(() => buildClaimAccounts(cfg, "v61", mockPool({ protocolOwed: [1n, 1n] }), [{ pubkey: pk(), isSigner: true, isWritable: false }])).toThrow(/signers/);
    expect(() => buildClaimAccounts(cfg, "v61", mockPool({ protocolOwed: [1n, 1n], tokenPrograms: [pk(), TOKEN_PROGRAM_ID] }))).toThrow(/neither SPL Token nor Token-2022/);
  });
  test("[N03] nothing owed → the instruction is refused (would be a paid no-op)", () => {
    expect(() => buildCollectProtocolFeesIx({ cfg, abi: "v61", pool: mockPool(), admin: pk() })).toThrow(/owes no protocol fees/);
  });
});

describe("claim_creator_fees (T14)", () => {
  test("[P08] [pool w, authority s] + [vault w, ata w, mint, program] × n; recipients default to the admin's ATAs", () => {
    const admin = pk(); const pool = mockPool({ creatorOwed: [3n, 4n], poolAdmin: admin });
    const ix = buildClaimCreatorFeesIx(cfg, pool, admin);
    expect(ixName(cofferPoolIdl, ix.data)).toBe("claim_creator_fees"); expect(ix.programId.equals(cfg.programs.cofferPool)).toBe(true);
    expect(ix.keys[0].pubkey.equals(pool.address) && ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[1].pubkey.equals(admin) && ix.keys[1].isSigner).toBe(true);
    pool.tokens.forEach((t, i) => {
      const blk = ix.keys.slice(2 + 4 * i, 6 + 4 * i);
      expect(blk.map((m) => m.pubkey.toBase58())).toEqual([t.vault, deriveAta(admin, t.mint, t.tokenProgram), t.mint, t.tokenProgram].map((k) => k.toBase58()));
    });
    expect(ix.claims.map((c) => c.owed.toString())).toEqual(["3", "4"]);
  });
  test("[P09] explicit recipients per slot, placeholders for zero-owed slots, tail appended", () => {
    const admin = pk(); const pool = mockPool({ creatorOwed: [0n, 4n], poolAdmin: admin }); const rcpt = pk(); const memo = pk();
    const { remaining, claims } = buildCreatorClaimAccounts(pool, admin, [{ pubkey: memo, isSigner: false, isWritable: false }], [pk(), rcpt]);
    expect(remaining.slice(0, 4).every((m) => m.pubkey.equals(pool.address))).toBe(true);
    expect(remaining[5].pubkey.equals(rcpt)).toBe(true); expect(remaining[8].pubkey.equals(memo)).toBe(true);
    expect(claims.map((c) => c.index)).toEqual([1]);
  });
  test("[P10] falls back to pool.creatorFeesOwed when the token slot lacks the field", () => {
    const admin = pk(); const pool = mockPool({ creatorOwed: [9n, 0n], poolAdmin: admin });
    for (const t of pool.tokens) delete (t as any).creatorFeesOwed;
    expect(buildCreatorClaimAccounts(pool, admin).claims.map((c) => c.owed.toString())).toEqual(["9"]);
  });
  test("[N04] not the admin / nothing owed / recipients length", () => {
    const admin = pk();
    expect(() => buildClaimCreatorFeesIx(cfg, mockPool({ creatorOwed: [1n, 1n], poolAdmin: admin }), pk())).toThrow(/Unauthorized/);
    expect(() => buildClaimCreatorFeesIx(cfg, mockPool({ poolAdmin: admin }), admin)).toThrow(/owes no creator fees/);
    expect(() => buildCreatorClaimAccounts(mockPool({ creatorOwed: [1n, 1n] }), admin, [], [pk()])).toThrow(/recipients length/);
  });
});

describe("register_token / withdraw", () => {
  test("[P11] register_token: [treasury w, mint, vault w, admin w s, token_program, system]", () => {
    const admin = pk(), mint = pk();
    const ix = buildRegisterTokenIx(cfg, admin, mint, TOKEN_2022_PROGRAM_ID);
    expect(ixName(protocolAdminIdl, ix.data)).toBe("register_token");
    const [treasury] = deriveTreasuryPda(cfg.programs.protocolAdmin);
    expect(ix.keys[0].pubkey.equals(treasury) && ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[1].pubkey.equals(mint)).toBe(true);
    expect(ix.keys[2].pubkey.equals(treasuryVaultPda(mint, cfg.programs.protocolAdmin)) && ix.keys[2].isWritable).toBe(true);
    expect(ix.keys[3].pubkey.equals(admin) && ix.keys[3].isSigner).toBe(true);
    expect(ix.keys[4].pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });
  test("[P12] withdraw v61 carries the amount and the Treasury vault as source; v5 has no tail", () => {
    const admin = pk(), mint = pk(), rcpt = pk();
    const ix = buildTreasuryWithdrawIx(cfg, "v61", admin, mint, TOKEN_PROGRAM_ID, rcpt, new BN(12_345), [{ pubkey: pk(), isSigner: false, isWritable: false }]);
    expect(ixName(protocolAdminIdl, ix.data)).toBe("withdraw"); expect(ix.data.readBigUInt64LE(8)).toBe(12_345n);
    expect(ix.keys.some((k) => k.pubkey.equals(treasuryVaultPda(mint, cfg.programs.protocolAdmin)) && k.isWritable)).toBe(true);
    expect(ix.keys.some((k) => k.pubkey.equals(rcpt) && k.isWritable)).toBe(true);
    const v5 = buildTreasuryWithdrawIx(cfg, "v5", admin, mint, TOKEN_PROGRAM_ID, rcpt, new BN(1));
    expect(v5.keys.length).toBeLessThan(ix.keys.length);
  });
  test("[N05] register_token / withdraw refuse a foreign token program; withdraw refuses a v5 tail and zero", () => {
    expect(() => buildRegisterTokenIx(cfg, pk(), pk(), pk())).toThrow(/neither SPL Token nor Token-2022/);
    expect(() => buildTreasuryWithdrawIx(cfg, "v5", pk(), pk(), TOKEN_PROGRAM_ID, pk(), new BN(1), [{ pubkey: pk(), isSigner: false, isWritable: false }])).toThrow();
    expect(() => buildTreasuryWithdrawIx(cfg, "v61", pk(), pk(), TOKEN_PROGRAM_ID, pk(), new BN(0))).toThrow();
  });
});

describe("transaction form", () => {
  const payer = pk();
  const bigIx = (n: number) => new TransactionInstruction({ programId: pk(), keys: Array.from({ length: n }, () => ({ pubkey: pk(), isSigner: false, isWritable: true })), data: Buffer.alloc(8) });
  test("[P13] a 2-token v61 claim fits a legacy transaction", () => {
    const ix = buildCollectProtocolFeesIx({ cfg, abi: "v61", pool: mockPool({ protocolOwed: [1n, 1n] }), admin: payer });
    const form = chooseTxForm([ix], payer);
    expect(form.kind).toBe("legacy"); expect(form.size).toBe(legacyTxSize([ix], payer)); expect(form.size).toBeLessThanOrEqual(MAX_TX_BYTES);
    expect(uniqueKeys([ix], payer)).toBe(new Set([payer.toBase58(), ix.programId.toBase58(), ...ix.keys.map((k) => k.pubkey.toBase58())]).size);
  });
  test("[P14] a 10-token v61 claim needs v0 + an aux table (no pool ALT); with a covering pool ALT no aux", () => {
    const pool = mockPool({ tokenCount: 10, protocolOwed: Array(10).fill(1n) });
    const ix = buildCollectProtocolFeesIx({ cfg, abi: "v61", pool, admin: payer });
    expect(legacyTxSize([ix], payer)).toBeGreaterThan(MAX_TX_BYTES);
    const form = chooseTxForm([ix], payer);
    expect(form.kind).toBe("v0"); if (form.kind !== "v0") return;
    expect(form.needsAuxAlt).toBe(true); if (!form.needsAuxAlt) return;
    expect(form.auxAddresses.length).toBeGreaterThan(0);
    expect(form.auxAddresses.some((a) => a.equals(payer))).toBe(false);
    expect(form.auxAddresses.some((a) => a.equals(ix.programId))).toBe(false);
    const alt = new AddressLookupTableAccount({ key: pk(), state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: payer, addresses: form.auxAddresses } });
    const withAlt = chooseTxForm([ix], payer, { poolAlt: alt });
    expect(withAlt.kind).toBe("v0"); if (withAlt.kind !== "v0") return;
    expect(withAlt.needsAuxAlt).toBe(false); expect(withAlt.size).toBe(v0TxSize([ix], payer, [alt])); expect(withAlt.size).toBeLessThanOrEqual(MAX_TX_BYTES);
  });
  test("[P15] sizes are monotone in the account count and a lookup table shrinks them", () => {
    const a = legacyTxSize([bigIx(5)], payer), b = legacyTxSize([bigIx(10)], payer);
    expect(b).toBeGreaterThan(a);
    const ix = bigIx(20);
    const alt = new AddressLookupTableAccount({ key: pk(), state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: payer, addresses: ix.keys.map((k) => k.pubkey) } });
    expect(v0TxSize([ix], payer, [alt])).toBeLessThan(legacyTxSize([ix], payer));
  });
  test("[P16] CLAIM_ERROR_NAMES pins the v6.1 claim errors", () => {
    expect(CLAIM_ERROR_NAMES.protocolAdmin[6010]).toMatch(/CooldownRequired/);
    expect(CLAIM_ERROR_NAMES.protocolAdmin[6002]).toMatch(/InvalidVault/);
    expect(CLAIM_ERROR_NAMES.cofferPool[6070]).toMatch(/LayoutVersionMismatch/);
    expect(CLAIM_ERROR_NAMES.cofferPool[6080]).toBe("CreatorFeesUnclaimed");
    expect(CLAIM_ERROR_NAMES.cofferPool[6064]).toMatch(/InvalidArrayLength/);
  });
  test("[N06] legacyOnly refuses a too-large transaction with a reason", () => {
    const pool = mockPool({ tokenCount: 10, protocolOwed: Array(10).fill(1n) });
    const ix = buildCollectProtocolFeesIx({ cfg, abi: "v61", pool, admin: payer });
    const form = chooseTxForm([ix], payer, { legacyOnly: true });
    expect(form.kind).toBe("too-large"); if (form.kind !== "too-large") return; expect(form.reason).toMatch(/legacyOnly/);
  });
  test("[N07] a transaction no table can save is too-large", () => {
    const ixs = Array.from({ length: 18 }, () => bigIx(12));
    expect(chooseTxForm(ixs, payer).kind).toBe("too-large");
  });
});
