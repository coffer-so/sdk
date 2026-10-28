import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  PROTOCOL_ACTION_KINDS,
  ProtocolActionKindName,
  TREASURY_DECODABLE_LENS,
  TREASURY_LAYOUT as T,
  TREASURY_LEN_V1,
  TREASURY_LEN_V2,
  TREASURY_LEN_V3,
  TREASURY_MAX_TOKENS,
} from "./layout";

/** `sha256("account:Treasury")[..8]` (unchanged since v1). */
export const TREASURY_DISCRIMINATOR = Buffer.from("eeef7bee5901a8fd", "hex");

/** One decoded protocol-admin pending slot (v6.1 T3). `eta` is 0 when empty. */
export interface RawPendingProtocolAction {
  kind: number;
  name: ProtocolActionKindName;
  /** Unix seconds; `0` ⇔ empty. */
  eta: BN;
  /** Absolute payload as stored on chain (hashes as hex strings). */
  payload: Record<string, string | number | boolean | PublicKey | BN>;
}

/**
 * `protocol_admin::Treasury`, decoded by raw offsets. Three sizes decode:
 * v1 (786, no supervisor), v2 (818, supervisor) and v3 (1624, v6.1 T3
 * cooldown block). On v1/v2 readings the cooldown fields are their
 * defaults (`delaySecs = 0`, nothing pending): the v6.1 program refuses
 * every typed Treasury instruction until the admin runs
 * `migrate_treasury_layout_v61`.
 */
export interface RawTreasuryAccount {
  dataLen: number;
  layout: "v1" | "v2" | "v3";
  admin: PublicKey;
  pendingAdmin: PublicKey;
  bump: number;
  tokenCount: number;
  /** First `tokenCount` registered mints / vault PDAs (compat-only since v6.1 T5). */
  tokenMints: PublicKey[];
  tokenVaults: PublicKey[];
  createdAt: BN;
  /** `null` on a v1 account. */
  supervisor: PublicKey | null;
  /** v6.1 (T3): protocol-admin cooldown in force (0 = direct wrappers work). */
  delaySecs: number;
  /** v6.1 (T3): bumped on every accepted admin transfer (every slot voided). */
  adminEpoch: number;
  /** v6.1 (T3): eta of the pending admin transfer (kind 0; nominee = `pendingAdmin`); 0 = none. */
  pendingAdminEta: BN;
  /** v6.1 (T3): the thirteen typed slots in kind order (empty array on v1/v2). */
  pendingActions: RawPendingProtocolAction[];
  /** v6.1 (T3): bit `kind` set ⇔ that slot is live. */
  pendingActionsMask: number;
  /** `reserved_v61` @1499 not all zero (drift) — v3 only. */
  reservedV61NonZero: boolean;
}

export function isDecodableTreasuryLen(len: number): boolean {
  return TREASURY_DECODABLE_LENS.includes(len);
}

/** `true` iff the account still needs `migrate_treasury_layout_v61` (786 / 818 bytes). */
export function treasuryNeedsLayoutMigration(data: Buffer | { length: number }): boolean {
  return data.length === TREASURY_LEN_V1 || data.length === TREASURY_LEN_V2;
}

export function decodeTreasuryAccount(data: Buffer): RawTreasuryAccount {
  if (data.length < 8 || !data.subarray(0, 8).equals(TREASURY_DISCRIMINATOR)) {
    throw new Error("decodeTreasuryAccount: invalid Treasury discriminator");
  }
  if (!isDecodableTreasuryLen(data.length)) {
    throw new Error(`decodeTreasuryAccount: unexpected data length ${data.length} (expected ${TREASURY_LEN_V1}, ${TREASURY_LEN_V2} or ${TREASURY_LEN_V3})`);
  }
  const tokenCount = data.readUInt8(T.TOKEN_COUNT.offset);
  if (tokenCount > TREASURY_MAX_TOKENS) throw new Error(`decodeTreasuryAccount: token_count ${tokenCount} exceeds ${TREASURY_MAX_TOKENS}`);
  const tokenMints: PublicKey[] = [];
  const tokenVaults: PublicKey[] = [];
  for (let i = 0; i < tokenCount; i++) {
    tokenMints.push(pk(data, T.TOKEN_MINTS.offset + 32 * i));
    tokenVaults.push(pk(data, T.TOKEN_VAULTS.offset + 32 * i));
  }
  const isV3 = data.length === TREASURY_LEN_V3;
  const hasSupervisor = data.length >= TREASURY_LEN_V2;
  const cooldown = isV3
    ? decodeTreasuryCooldownBlock(data)
    : { delaySecs: 0, adminEpoch: 0, pendingAdminEta: new BN(0), pendingActions: [] as RawPendingProtocolAction[], pendingActionsMask: 0, reservedV61NonZero: false };
  return {
    dataLen: data.length,
    layout: isV3 ? "v3" : hasSupervisor ? "v2" : "v1",
    admin: pk(data, T.ADMIN.offset),
    pendingAdmin: pk(data, T.PENDING_ADMIN.offset),
    bump: data.readUInt8(T.BUMP.offset),
    tokenCount,
    tokenMints,
    tokenVaults,
    createdAt: i64(data, T.CREATED_AT.offset),
    supervisor: hasSupervisor ? pk(data, T.SUPERVISOR.offset) : null,
    ...cooldown,
  };
}

/** v6.1 (T3): decode the Treasury cooldown block @818..1499 of a 1624-byte account. */
export function decodeTreasuryCooldownBlock(data: Buffer): Pick<RawTreasuryAccount, "delaySecs" | "adminEpoch" | "pendingAdminEta" | "pendingActions" | "pendingActionsMask" | "reservedV61NonZero"> {
  if (data.length !== TREASURY_LEN_V3) throw new Error(`decodeTreasuryCooldownBlock: needs a ${TREASURY_LEN_V3}-byte account`);
  const slot = (kind: number, off: number, payload: RawPendingProtocolAction["payload"]): RawPendingProtocolAction =>
    ({ kind, name: PROTOCOL_ACTION_KINDS[kind], eta: i64(data, off), payload });
  const o = T;
  const pendingActions: RawPendingProtocolAction[] = [
    slot(0, o.PENDING_ADMIN_ETA.offset, { newAdmin: pk(data, o.PENDING_ADMIN.offset) }),
    slot(1, o.PENDING_SET_DELAY.offset, { secs: data.readUInt32LE(o.PENDING_SET_DELAY.offset + 8) }),
    slot(2, o.PENDING_SET_SUPERVISOR.offset, { key: pk(data, o.PENDING_SET_SUPERVISOR.offset + 8) }),
    slot(3, o.PENDING_WITHDRAW.offset, {
      mint: pk(data, o.PENDING_WITHDRAW.offset + 8), recipient: pk(data, o.PENDING_WITHDRAW.offset + 40),
      amount: u64(data, o.PENDING_WITHDRAW.offset + 72),
    }),
    slot(4, o.PENDING_WITHDRAW_SOL.offset, {
      route: data.readUInt8(o.PENDING_WITHDRAW_SOL.offset + 8), source: pk(data, o.PENDING_WITHDRAW_SOL.offset + 9),
      recipient: pk(data, o.PENDING_WITHDRAW_SOL.offset + 41), amount: u64(data, o.PENDING_WITHDRAW_SOL.offset + 73),
    }),
    slot(5, o.PENDING_POOL_DEBUG_WITHDRAW.offset, {
      pool: pk(data, o.PENDING_POOL_DEBUG_WITHDRAW.offset + 8),
      paramsHash: data.subarray(o.PENDING_POOL_DEBUG_WITHDRAW.offset + 40, o.PENDING_POOL_DEBUG_WITHDRAW.offset + 72).toString("hex"),
    }),
    slot(6, o.PENDING_POOL_SET_PROTOCOL_FEE_RATE.offset, {
      pool: pk(data, o.PENDING_POOL_SET_PROTOCOL_FEE_RATE.offset + 8), rate: data.readUInt16LE(o.PENDING_POOL_SET_PROTOCOL_FEE_RATE.offset + 40),
    }),
    slot(7, o.PENDING_POOL_SET_POOL_ENABLED.offset, { pool: pk(data, o.PENDING_POOL_SET_POOL_ENABLED.offset + 8) }),
    slot(8, o.PENDING_POOL_SET_TOKEN_ACTIVE.offset, {
      pool: pk(data, o.PENDING_POOL_SET_TOKEN_ACTIVE.offset + 8), tokenIndex: data.readUInt8(o.PENDING_POOL_SET_TOKEN_ACTIVE.offset + 40),
    }),
    slot(9, o.PENDING_UNFREEZE_POOLS.offset, { poolsHash: data.subarray(o.PENDING_UNFREEZE_POOLS.offset + 8, o.PENDING_UNFREEZE_POOLS.offset + 40).toString("hex") }),
    slot(10, o.PENDING_POOL_PROTOCOL_ADMIN_TRANSFER.offset, {
      config: pk(data, o.PENDING_POOL_PROTOCOL_ADMIN_TRANSFER.offset + 8), newAdmin: pk(data, o.PENDING_POOL_PROTOCOL_ADMIN_TRANSFER.offset + 40),
    }),
    slot(11, o.PENDING_UPGRADE_PROGRAM.offset, {
      program: pk(data, o.PENDING_UPGRADE_PROGRAM.offset + 8), buffer: pk(data, o.PENDING_UPGRADE_PROGRAM.offset + 40),
    }),
    slot(12, o.PENDING_PROGRAM_OP.offset, {
      op: data.readUInt8(o.PENDING_PROGRAM_OP.offset + 8), program: pk(data, o.PENDING_PROGRAM_OP.offset + 9), target: pk(data, o.PENDING_PROGRAM_OP.offset + 41),
    }),
  ];
  const reserved = data.subarray(o.RESERVED_V61.offset, o.RESERVED_V61.offset + o.RESERVED_V61.size);
  return {
    delaySecs: data.readUInt32LE(o.DELAY_SECS.offset),
    adminEpoch: data.readUInt32LE(o.ADMIN_EPOCH.offset),
    pendingAdminEta: i64(data, o.PENDING_ADMIN_ETA.offset),
    pendingActions,
    pendingActionsMask: pendingActions.reduce((m, s) => (s.eta.isZero() ? m : m | (1 << s.kind)), 0),
    reservedV61NonZero: reserved.some((b) => b !== 0),
  };
}

const pk = (d: Buffer, off: number): PublicKey => new PublicKey(d.subarray(off, off + 32));
const u64 = (d: Buffer, off: number): BN => new BN(d.subarray(off, off + 8), "le");
const i64 = (d: Buffer, off: number): BN => new BN(d.subarray(off, off + 8), "le").fromTwos(64);
