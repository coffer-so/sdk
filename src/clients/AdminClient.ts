import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  AccountMeta,
  Connection,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import { CubeConfig } from "../config";
import { PROTOCOL_ADMIN_IDL } from "../idl";
import { deriveTreasuryPda } from "../utils/pda";

/** Upstream BPF upgradeable loader; ProgramData PDA = findPda([programId]). */
export const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

/**
 * AdminClient — wraps `protocol_admin` with treasury-routed admin
 * operations.
 *
 * The cubic_pool program enforces that every admin instruction must be
 * signed by the Treasury PDA (`seeds = [b"treasury"]`, owned by
 * protocol_admin). This client builds the canonical flow:
 *
 *     admin wallet
 *       → protocol_admin.<wrapper>     (treasury.admin == signer)
 *       → CPI cubic_pool.<admin_ix>             (signer == TREASURY_PDA)
 *
 * Direct calls into cubic_pool admin instructions will fail on-chain.
 *
 * Note: every method returns a `TransactionInstruction`. Compose into a tx
 * with `@solana/web3.js` and sign with the admin wallet.
 *
 * ## Roles (v5.1, audit SF-1)
 *
 * `treasury.admin` can call everything here. `treasury.supervisor` is a
 * **freeze-only circuit-breaker key**: it may only ever restrict, never
 * relax. Concretely it can call `freezePoolsIx` and
 * `setTokenActiveIx(..., isActive = false)` — nothing else. Reversing
 * either (`unfreezePoolsIx`, `setTokenActiveIx(..., true)`) is admin-only
 * and reverts with `Unauthorized` for a supervisor.
 *
 * An admin UI driving this client must gate on the connected key's role and
 * hide the relaxing controls from a supervisor rather than showing them and
 * letting the transaction fail.
 */
export class AdminClient {
  readonly program: Program;
  readonly cubicPoolProgramId: PublicKey;
  readonly stldProgramId: PublicKey;
  readonly treasuryPda: PublicKey;

  constructor(opts: { config: CubeConfig; provider: anchor.AnchorProvider }) {
    const { config, provider } = opts;
    const idl = JSON.parse(JSON.stringify(PROTOCOL_ADMIN_IDL)) as any;
    idl.address = config.programs.protocolAdmin.toString();
    this.program = new Program(idl, provider) as any;
    this.cubicPoolProgramId = config.programs.cubicPool;
    this.stldProgramId = config.programs.singleTokenLiquidity;
    [this.treasuryPda] = deriveTreasuryPda(config.programs.protocolAdmin);
  }

  /**
   * ProgramData PDA of the protocol-admin program itself, under the
   * upgradeable BPF loader. `initialize` is gated on it (audit L-5): only
   * the key that can upgrade the program may bootstrap its Treasury.
   */
  programDataPda(): PublicKey {
    const [programData] = PublicKey.findProgramAddressSync(
      [this.program.programId.toBuffer()],
      BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
    );
    return programData;
  }

  /**
   * Idempotent treasury init. Returns true if a new treasury was created.
   * `admin` becomes the initial `treasury.admin`.
   *
   * ⚠ v5.1 (audit L-5) added the `program_data` account: the signer must be
   * the protocol-admin program's current upgrade authority, otherwise this
   * reverts. `admin` may not be the all-zero pubkey (`InvalidAdmin`, 6009).
   */
  async initializeTreasuryIfMissing(connection: Connection, admin: PublicKey): Promise<boolean> {
    const info = await connection.getAccountInfo(this.treasuryPda);
    if (info) return false;
    if (admin.equals(PublicKey.default)) {
      throw new Error("AdminClient: admin cannot be the default (all-zero) pubkey");
    }
    await (this.program.methods as any)
      .initialize(admin)
      .accounts({
        treasury: this.treasuryPda,
        payer: admin,
        programData: this.programDataPda(),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return true;
  }

  // ── Admin lifecycle ──────────────────────────────────────────────────────

  initiateAdminTransferIx(admin: PublicKey, newAdmin: PublicKey) {
    return (this.program.methods as any)
      .initiateAdminTransfer(newAdmin)
      .accounts({ treasury: this.treasuryPda, admin })
      .instruction();
  }

  acceptAdminTransferIx(newAdmin: PublicKey) {
    return (this.program.methods as any)
      .acceptAdminTransfer()
      .accounts({ treasury: this.treasuryPda, newAdmin })
      .instruction();
  }

  cancelAdminTransferIx(admin: PublicKey) {
    return (this.program.methods as any)
      .cancelAdminTransfer()
      .accounts({ treasury: this.treasuryPda, admin })
      .instruction();
  }

  // ── Treasury vault management ────────────────────────────────────────────

  registerTokenIx(admin: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM_ID) {
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), mint.toBuffer()],
      this.program.programId,
    );
    return (this.program.methods as any)
      .registerToken()
      .accounts({
        treasury: this.treasuryPda,
        mint,
        vault,
        admin,
        tokenProgram,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /**
   * Withdraw from a registered treasury vault.
   *
   * ⚠ v5.1 PREPENDED a `mint` account before `vault` — the transfer moved
   * to `transfer_checked`, which needs the mint's decimals. Anchor resolves
   * the account by name here, so passing it is all that is required.
   */
  withdrawIx(
    admin: PublicKey,
    mint: PublicKey,
    recipient: PublicKey,
    amount: BN,
    tokenProgram = TOKEN_PROGRAM_ID,
  ) {
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), mint.toBuffer()],
      this.program.programId,
    );
    return (this.program.methods as any)
      .withdraw(amount)
      .accounts({
        treasury: this.treasuryPda,
        mint,
        vault,
        recipient,
        admin,
        tokenProgram,
      })
      .instruction();
  }

  // ── Program upgrade authority ────────────────────────────────────────────

  /**
   * Hand the upgrade authority for `program` to `newAuthority`.
   *
   * ⚠ v5.1 (audit M-3) removed the `new_authority` ARGUMENT and made it an
   * ACCOUNT that must **co-sign**: the loader's `SetAuthorityChecked` is
   * used so a mistyped destination cannot take the authority
   * irrecoverably. The returned instruction therefore has two required
   * signers — the current `admin` and `newAuthority`. Both must sign the
   * transaction or it fails signature verification before it ever reaches
   * the program.
   */
  transferUpgradeAuthorityIx(
    admin: PublicKey,
    program: PublicKey,
    newAuthority: PublicKey,
  ) {
    const [programdata] = PublicKey.findProgramAddressSync(
      [program.toBuffer()],
      BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
    );
    return (this.program.methods as any)
      .transferUpgradeAuthority()
      .accounts({
        treasury: this.treasuryPda,
        admin,
        program,
        programdata,
        newAuthority,
        bpfLoaderUpgradeable: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
      })
      .instruction();
  }

  /**
   * Make `program` permanently non-upgradeable.
   *
   * ⚠ v5.1 (audit M-3) dropped `new_authority_info` and added `program`:
   * the account list is `[treasury, admin, program, programdata,
   * bpf_loader_upgradeable]`. This is irreversible.
   */
  freezePoolProgramIx(admin: PublicKey, program: PublicKey) {
    const [programdata] = PublicKey.findProgramAddressSync(
      [program.toBuffer()],
      BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
    );
    return (this.program.methods as any)
      .freezePoolProgram()
      .accounts({
        treasury: this.treasuryPda,
        admin,
        program,
        programdata,
        bpfLoaderUpgradeable: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
      })
      .instruction();
  }

  // ── Pool config / pool admin (treasury-routed) ───────────────────────────

  poolInitializeConfigIx(admin: PublicKey, config: PublicKey, defaultProtocolFeeRate: number) {
    return (this.program.methods as any)
      .poolInitializeConfig(defaultProtocolFeeRate)
      .accounts({
        treasury: this.treasuryPda,
        admin,
        config,
        cubicPoolProgram: this.cubicPoolProgramId,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  // setSwapFeeRate has been removed from the protocol-admin wrapper —
  // it's a level-1 (pool-admin) instruction, signed directly by the
  // wallet stored in `pool.pool_admin`. Use `CubicPoolClient` for that
  // call instead.

  setProtocolFeeRateIx(admin: PublicKey, config: PublicKey, pool: PublicKey, protocolFeeRate: number) {
    return (this.program.methods as any)
      .poolSetProtocolFeeRate(protocolFeeRate)
      .accounts({ ...this.poolAdminAccounts(admin, config, pool) })
      .instruction();
  }

  setPoolEnabledIx(admin: PublicKey, config: PublicKey, pool: PublicKey, enabled: boolean) {
    return (this.program.methods as any)
      .poolSetPoolEnabled(enabled)
      .accounts({ ...this.poolAdminAccounts(admin, config, pool) })
      .instruction();
  }

  setSwapsEnabledIx(admin: PublicKey, config: PublicKey, pool: PublicKey, enabled: boolean) {
    return (this.program.methods as any)
      .poolSetSwapsEnabled(enabled)
      .accounts({ ...this.poolAdminAccounts(admin, config, pool) })
      .instruction();
  }

  /**
   * Update a config's Token-2022 extension policy.
   *
   * ⚠ v5.1 (audit H-5) added a second REQUIRED argument,
   * `hardBannedExtensions`. Two distinct bitmaps:
   *
   *  - `banned` — the config's default policy, inherited by new pools that
   *    do not pass their own override. A pool creator may override it in
   *    either direction.
   *  - `hardBanned` — the protocol floor. It is OR-ed into every pool's
   *    effective bitmap at creation and a creator override can never clear
   *    it. This is what keeps `PermanentDelegate` / `TransferHook` mints out
   *    of vault custody regardless of what a pool creator chooses.
   *
   * Loosening `hardBanned` is a protocol-wide safety decision, not a
   * routine config tweak.
   */
  setBannedExtensionsIx(
    admin: PublicKey,
    config: PublicKey,
    banned: BN,
    hardBanned: BN,
  ) {
    if (hardBanned === undefined) {
      throw new Error(
        "AdminClient.setBannedExtensionsIx: hardBanned is required as of v5.1. " +
          "Pass the config's current hard_banned_extensions to leave the floor unchanged.",
      );
    }
    return (this.program.methods as any)
      .poolSetBannedExtensions(banned, hardBanned)
      .accounts({
        treasury: this.treasuryPda,
        admin,
        config,
        cubicPoolProgram: this.cubicPoolProgramId,
      })
      .instruction();
  }

  /**
   * Migrate a pool account from the v4 storage layout to v5.
   *
   * ⚠ v5.1 (audit H-7) added `reactivateTokens` and this instruction is no
   * longer a no-op — it mutates pool state.
   *
   * @param reactivateTokens Pass `true` ONLY on the one-shot v4 → v5 pass.
   *   On any later call `true` silently re-opens every token that was
   *   deliberately disabled via `set_token_active`, undoing a circuit
   *   breaker. Default is `false` for that reason.
   */
  migratePoolToV5Ix(
    admin: PublicKey,
    config: PublicKey,
    pool: PublicKey,
    reactivateTokens = false,
  ) {
    return (this.program.methods as any)
      .poolMigrateToV5(reactivateTokens)
      .accounts({
        treasury: this.treasuryPda,
        admin,
        pool,
        config,
        systemProgram: SystemProgram.programId,
        cubicPoolProgram: this.cubicPoolProgramId,
      })
      .instruction();
  }

  /**
   * Drain lamports from a single-token-liquidity helper PDA.
   *
   * ⚠ v5.1 (audit L-8 / SF-12) added the `pool` and `system_program`
   * accounts. `pool` is not merely a seed source: the program checks it
   * belongs to `config`, closing the hole where the admin of one config
   * could drain a helper governed by another.
   */
  stldWithdrawSolIx(
    admin: PublicKey,
    config: PublicKey,
    pool: PublicKey,
    source: PublicKey,
    recipient: PublicKey,
    amount: BN,
  ) {
    return (this.program.methods as any)
      .stldWithdrawSol(amount)
      .accounts({
        treasury: this.treasuryPda,
        admin,
        config,
        pool,
        source,
        recipient,
        systemProgram: SystemProgram.programId,
        stldProgram: this.stldProgramId,
      })
      .instruction();
  }

  // ── Circuit breaker (admin OR supervisor) ────────────────────────────────

  /**
   * Batch-freeze pools. `pairs` are `[config, pool]` tuples passed via
   * remaining_accounts.
   *
   * Authority: `treasury.admin` **or** `treasury.supervisor`. This is the
   * one direction a supervisor may move — see {@link unfreezePoolsIx}.
   */
  freezePoolsIx(authority: PublicKey, pairs: Array<{ config: PublicKey; pool: PublicKey }>) {
    return (this.program.methods as any)
      .freezePools()
      .accounts({
        treasury: this.treasuryPda,
        authority,
        cubicPoolProgram: this.cubicPoolProgramId,
      })
      .remainingAccounts(this.configPoolRemaining(pairs, /* poolWritable */ true))
      .instruction();
  }

  /**
   * Batch-unfreeze pools — mirror of {@link freezePoolsIx}.
   *
   * ⚠ **ADMIN ONLY.** v5.1 (audit SF-1) made the supervisor role
   * freeze-only: it may restrict, never relax. A supervisor calling this
   * reverts with `Unauthorized`. Admin UIs must HIDE the unfreeze control
   * for supervisor keys rather than surfacing it and letting the call fail —
   * the same applies to `pool_set_token_active` with `is_active = true`,
   * which is likewise admin-only (deactivating is open to the supervisor).
   */
  unfreezePoolsIx(admin: PublicKey, pairs: Array<{ config: PublicKey; pool: PublicKey }>) {
    return (this.program.methods as any)
      .unfreezePools()
      .accounts({
        treasury: this.treasuryPda,
        authority: admin,
        cubicPoolProgram: this.cubicPoolProgramId,
      })
      .remainingAccounts(this.configPoolRemaining(pairs, /* poolWritable */ true))
      .instruction();
  }

  /**
   * Flip a token's input kill switch on a pool.
   *
   * Authority is direction-dependent (SF-1): `isActive = false` is open to
   * admin OR supervisor; `isActive = true` is **admin only**.
   */
  setTokenActiveIx(
    authority: PublicKey,
    config: PublicKey,
    pool: PublicKey,
    tokenIndex: number,
    isActive: boolean,
  ) {
    return (this.program.methods as any)
      .poolSetTokenActive(tokenIndex, isActive)
      .accounts({
        treasury: this.treasuryPda,
        authority,
        config,
        pool,
        cubicPoolProgram: this.cubicPoolProgramId,
      })
      .instruction();
  }

  /**
   * Set or revoke the supervisor pubkey. Admin only. Pass
   * `PublicKey.default` to revoke.
   *
   * The supervisor may call `freeze_pools` and `pool_set_token_active(false)`
   * and nothing else.
   */
  setSupervisorIx(admin: PublicKey, newSupervisor: PublicKey) {
    return (this.program.methods as any)
      .setSupervisor(newSupervisor)
      .accounts({
        treasury: this.treasuryPda,
        admin,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /**
   * Collects protocol fees from a pool to the supplied recipient ATAs.
   *
   * `vaults` / `recipients` / `tokenPrograms` must be aligned with
   * `pool.token_mints` (one entry per token in pool order).
   */
  collectProtocolFeesIx(
    admin: PublicKey,
    config: PublicKey,
    pool: PublicKey,
    vaults: PublicKey[],
    recipients: PublicKey[],
    tokenPrograms: PublicKey[] = vaults.map(() => TOKEN_PROGRAM_ID),
  ) {
    const remaining: AccountMeta[] = this.tripleRemaining(vaults, recipients, tokenPrograms);
    return (this.program.methods as any)
      .poolCollectProtocolFees()
      .accounts({ ...this.poolAdminAccounts(admin, config, pool) })
      .remainingAccounts(remaining)
      .instruction();
  }

  /**
   * Emergency drain. Pool must be paused first. `amounts.length` must equal
   * the pool's token_count; pass 0 to skip a token.
   */
  debugWithdrawLiquidityIx(
    admin: PublicKey,
    config: PublicKey,
    pool: PublicKey,
    amounts: BN[],
    vaults: PublicKey[],
    recipients: PublicKey[],
    tokenPrograms: PublicKey[] = vaults.map(() => TOKEN_PROGRAM_ID),
  ) {
    const remaining: AccountMeta[] = this.tripleRemaining(vaults, recipients, tokenPrograms);
    return (this.program.methods as any)
      .poolDebugWithdrawLiquidity(amounts)
      .accounts({ ...this.poolAdminAccounts(admin, config, pool) })
      .remainingAccounts(remaining)
      .instruction();
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private poolAdminAccounts(admin: PublicKey, config: PublicKey, pool: PublicKey) {
    return {
      treasury: this.treasuryPda,
      admin,
      config,
      pool,
      cubicPoolProgram: this.cubicPoolProgramId,
    };
  }

  private configPoolRemaining(
    pairs: Array<{ config: PublicKey; pool: PublicKey }>,
    poolWritable: boolean,
  ): AccountMeta[] {
    const acc: AccountMeta[] = [];
    for (const { config, pool } of pairs) {
      acc.push({ pubkey: config, isSigner: false, isWritable: false });
      acc.push({ pubkey: pool, isSigner: false, isWritable: poolWritable });
    }
    return acc;
  }

  private tripleRemaining(
    vaults: PublicKey[],
    recipients: PublicKey[],
    tokenPrograms: PublicKey[],
  ): AccountMeta[] {
    if (vaults.length !== recipients.length || vaults.length !== tokenPrograms.length) {
      throw new Error("AdminClient: vaults/recipients/tokenPrograms must be the same length");
    }
    const acc: AccountMeta[] = [];
    for (let i = 0; i < vaults.length; i++) {
      acc.push({ pubkey: vaults[i], isSigner: false, isWritable: true });
      acc.push({ pubkey: recipients[i], isSigner: false, isWritable: true });
      acc.push({ pubkey: tokenPrograms[i], isSigner: false, isWritable: false });
    }
    return acc;
  }
}
