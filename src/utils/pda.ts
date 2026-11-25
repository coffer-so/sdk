import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  LP_MINT_SEED,
  POOL_SEED,
  STLD_HELPER_SEED,
  TREASURY_SEED,
} from "../config";

export function derivePoolPda(
  programId: PublicKey,
  config: PublicKey,
  poolId: BN
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POOL_SEED, config.toBuffer(), poolId.toArrayLike(Buffer, "le", 8)],
    programId
  );
}

export function deriveLpMint(
  cofferPoolProgramId: PublicKey,
  pool: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [LP_MINT_SEED, pool.toBuffer()],
    cofferPoolProgramId
  );
}

export function deriveHelperPda(
  stldProgramId: PublicKey,
  pool: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [STLD_HELPER_SEED, pool.toBuffer()],
    stldProgramId
  );
}

export function deriveTreasuryPda(
  protocolFeesProgramId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([TREASURY_SEED], protocolFeesProgramId);
}

export function deriveAta(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey
): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}
