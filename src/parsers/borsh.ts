import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";

/**
 * Minimal Borsh-compatible reader. Enough to decode the Cube contract
 * event structs (Pubkey × N, u8/u16/u32/u64/i64, bool, Vec<u64>,
 * Vec<Pubkey>). Avoids pulling a borsh dep into the SDK's hot path.
 */
export class BorshReader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}

  remaining(): number {
    return this.buf.length - this.offset;
  }

  skip(n: number): void {
    this.requireBytes(n);
    this.offset += n;
  }

  u8(): number {
    this.requireBytes(1);
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }

  u16(): number {
    this.requireBytes(2);
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  u32(): number {
    this.requireBytes(4);
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  u64(): BN {
    this.requireBytes(8);
    const slice = this.buf.slice(this.offset, this.offset + 8);
    this.offset += 8;
    return new BN(slice, "le");
  }

  i64(): BN {
    this.requireBytes(8);
    const slice = this.buf.slice(this.offset, this.offset + 8);
    this.offset += 8;
    // i64 is two's complement little-endian — treat as signed.
    const bn = new BN(slice, "le");
    if (slice[7] & 0x80) {
      // top bit set → negative: subtract 2^64
      return bn.sub(new BN(2).pow(new BN(64)));
    }
    return bn;
  }

  bool(): boolean {
    const value = this.u8();
    if (value > 1) throw new Error(`BorshReader: invalid bool ${value}`);
    return value === 1;
  }

  pubkey(): PublicKey {
    this.requireBytes(32);
    const slice = this.buf.slice(this.offset, this.offset + 32);
    this.offset += 32;
    return new PublicKey(slice);
  }

  vecU64(): BN[] {
    const len = this.u32();
    this.requireBytes(len * 8);
    const out: BN[] = [];
    for (let i = 0; i < len; i++) out.push(this.u64());
    return out;
  }

  vecPubkey(): PublicKey[] {
    const len = this.u32();
    this.requireBytes(len * 32);
    const out: PublicKey[] = [];
    for (let i = 0; i < len; i++) out.push(this.pubkey());
    return out;
  }

  private requireBytes(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining()) {
      throw new Error(`BorshReader: expected ${length} bytes at offset ${this.offset}, ${this.remaining()} remain`);
    }
  }
}
