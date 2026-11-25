import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { CofferConfig } from "../config";
import { SdkResult, err, ok } from "../types/result";
import { BuiltTx } from "../types/tx";
import { DeployPoolParamsV61 } from "../types/tx-v61";
import {
  buildDeployPoolTx,
  buildInitializePoolIx,
  buildPoolInitializeConfigIx,
} from "./tx-builders";
import { deriveLpMint, derivePoolPda } from "../utils/pda";
import { buildAtomicDeploy, DeployBuildConnection } from "./atomicDeploy";
import type { AtomicDeployParams, AtomicDeployResult } from "../types/tx-v61";

export interface PoolFactoryClientParams {
  config: CofferConfig;
}

export interface InitializeConfigParams {
  payer: PublicKey;
  defaultProtocolFeeRate: number;
}

/**
 * Builds transactions for protocol governance / pool deployment. Consumed
 * by the deploy-pool UI flow and by the backend's admin tools.
 */
export class PoolFactoryClient {
  readonly config: CofferConfig;

  constructor(params: PoolFactoryClientParams) {
    this.config = params.config;
  }

  /**
   * Deploy a new pool atop an existing `CofferPoolConfig`. Caller is
   * responsible for funding `params.payer` with enough SOL to cover rent
   * for the pool account and the LP mint PDA.
   *
   * Returns the `pool` and `lpMint` pubkeys it WILL create (derived PDAs)
   * plus the signable tx.
   */
  buildDeployPoolTx(params: DeployPoolParamsV61): SdkResult<BuiltTx & { pool: PublicKey; lpMint: PublicKey }> {
    if (params.tokens.length < 2 || params.tokens.length > 10) {
      return err("invalid_input", "tokens.length must be in [2, 10]");
    }
    if (params.tokens.length !== params.weightsBps.length) {
      return err("invalid_input", "tokens/weightsBps length mismatch");
    }
    if (params.tokens.length !== params.virtualBalances.length) {
      return err("invalid_input", "tokens/virtualBalances length mismatch");
    }
    const sum = params.weightsBps.reduce((a, b) => a + b, 0);
    if (sum !== 10_000) return err("invalid_input", `weights must sum to 10000 (got ${sum})`);
    for (const vb of params.virtualBalances) {
      if (vb.isZero()) return err("invalid_input", "virtualBalances must all be > 0");
    }

    const [pool] = derivePoolPda(this.config.programs.cofferPool, params.configKey, params.poolId);
    const [lpMint] = deriveLpMint(this.config.programs.cofferPool, pool);
    try {
      const tx = buildDeployPoolTx(this.config, params);
      return ok({ ...tx, pool, lpMint });
    } catch (e) {
      return err("tx_build_failed", "Failed to build deploy-pool tx", e);
    }
  }

  /**
   * Initialize a new `CofferPoolConfig`, through the protocol-admin wrapper.
   *
   * Routed via `protocol_admin::pool_initialize_config` rather than
   * `coffer_pool::initialize_config` directly: post-audit the latter requires
   * the Treasury PDA to SIGN (H-01), and a PDA signature can only come from
   * the owning program's `invoke_signed`. Building the direct instruction
   * yields a transaction no wallet can ever satisfy.
   *
   * `params.payer` must be the current `Treasury.admin` — it is the human
   * signer the wrapper authenticates. The returned `configKeypair` is the
   * second required signer (the config account is `init`, not a PDA).
   */
  buildInitializeConfigTx(params: InitializeConfigParams): SdkResult<
    BuiltTx & { configKeypair: Keypair }
  > {
    try {
      const configKeypair = Keypair.generate();
      const ix = buildPoolInitializeConfigIx(this.config, {
        config: configKeypair.publicKey,
        admin: params.payer,
        defaultProtocolFeeRate: params.defaultProtocolFeeRate,
      });
      return ok({
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ix],
        suggestedCuLimit: 200_000,
        configKeypair,
      });
    } catch (e) {
      return err("tx_build_failed", "Failed to build initialize_config tx", e);
    }
  }

  /**
   * v6.1 (T8): the one-approval deploy — `initialize_pool` + ATAs +
   * `seed_liquidity` [+ `set_swaps_enabled(false)`] in 1..3 transactions
   * sharing one blockhash; hand `transactions` to `signAllTransactions` and
   * land them with `sendAtomicDeploy`. See `clients/atomicDeploy.ts`.
   */
  async buildAtomicDeploy(connection: DeployBuildConnection, params: AtomicDeployParams): Promise<SdkResult<AtomicDeployResult>> {
    try {
      return ok(await buildAtomicDeploy(this.config, connection, params));
    } catch (e) {
      return err("tx_build_failed", `Failed to build the atomic deploy: ${e instanceof Error ? e.message : String(e)}`, e);
    }
  }

  /**
   * Low-level: return the raw `initialize_pool` ix without a CU
   * budget or wrapping. Useful for combining with other ixs in the same tx.
   */
  initializePoolIx(params: DeployPoolParamsV61): TransactionInstruction {
    return buildInitializePoolIx(this.config, params);
  }
}
