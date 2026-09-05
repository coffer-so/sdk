import { Commitment, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { CubeConfig } from "../config";
import { PoolInfo } from "../types/pool";
import { SdkResult, err, ok } from "../types/result";
import {
  BuiltTx,
  SingleTokenDepositParams,
  SingleTokenDepositQuote,
} from "../types/tx";
import { deriveHelperPda } from "../utils/pda";
import { buildSingleTokenDepositTx, buildSingleTokenDepositTxs } from "./tx-builders";
import { RpcClient } from "./RpcClient";
import { CubicPoolClient } from "./CubicPoolClient";

export interface SingleTokenDepositClientParams {
  config: CubeConfig;
  poolAddress: PublicKey;
  /** Optional — reuses an existing one if provided. */
  rpc?: RpcClient | {
    endpoint?: string;
    endpoints?: string[];
    fallbackEndpoints?: string[];
    apiKey?: string;
    commitment?: Commitment;
    timeoutMs?: number;
  };
  /**
   * Optional parent pool client — lets the deposit client reuse an already
   * synced PoolInfo instead of making a fresh RPC round-trip.
   */
  poolClient?: CubicPoolClient;
}

/**
 * Convenience class that wraps the single-token deposit flow end-to-end:
 * quoting, transaction building, and helper-PDA derivation.
 *
 * Most consumers don't need to instantiate this directly — they can call
 * `CubicPoolClient.singleTokenDeposit.*` which proxies here.
 */
export class SingleTokenDepositClient {
  readonly config: CubeConfig;
  readonly poolAddress: PublicKey;
  private readonly poolClient: CubicPoolClient;

  constructor(params: SingleTokenDepositClientParams) {
    this.config = params.config;
    this.poolAddress = params.poolAddress;
    this.poolClient =
      params.poolClient ??
      new CubicPoolClient({
        config: params.config,
        poolAddress: params.poolAddress,
        rpc:
          params.rpc ??
          {
            endpoints: params.config.defaults.rpcEndpoints,
            commitment: params.config.defaults.rpcCommitment,
            timeoutMs: params.config.defaults.rpcTimeoutMs,
          },
      });
  }

  /** Derived helper PDA for this pool. */
  helperPda(): PublicKey {
    return deriveHelperPda(this.config.programs.singleTokenLiquidity, this.poolAddress)[0];
  }

  /** Ensure pool state is loaded; populates the underlying CubicPoolClient cache. */
  async sync(): Promise<SdkResult<PoolInfo>> {
    return this.poolClient.sync();
  }

  /** Off-chain estimate of the deposit outcome. */
  quote(
    tokenInIndex: number,
    amountIn: BN,
    slippageHundredthsBps?: number
  ): SdkResult<SingleTokenDepositQuote> {
    return this.poolClient.quoteSingleTokenDeposit(tokenInIndex, amountIn, slippageHundredthsBps);
  }

  /**
   * Build a ready-to-sign transaction. Includes idempotent helper-ATA
   * creates.
   *
   * ⚠ Single-transaction form. It only fits for small pools — the ATA
   * creates cost 5 CPI frames each and the zap itself uses 52 of the
   * 64-frame budget at N=10. Use {@link buildTxs} for anything larger.
   */
  buildTx(params: SingleTokenDepositParams): SdkResult<BuiltTx> {
    const pool = this.poolClient.getCached();
    if (!pool) return err("invalid_input", "Call sync() first to populate pool state");
    if (params.tokenInIndex < 0 || params.tokenInIndex >= pool.tokenCount) {
      return err("invalid_input", "Invalid tokenInIndex");
    }
    if (params.amountIn.lten(0)) return err("invalid_input", "amountIn must be > 0");
    try {
      const tx = buildSingleTokenDepositTx(this.config, pool, params);
      return ok(tx);
    } catch (e) {
      return err("tx_build_failed", "Failed to build single-token deposit tx", e);
    }
  }

  /**
   * Build the deposit as two transactions: `setup` (idempotent ATA creates)
   * then `deposit`. Required for large pools; safe for all of them.
   *
   * Send `setup` and let it confirm before sending `deposit` — an ALT
   * cannot be referenced in the same slot it was extended, and the two
   * legs must not share an instruction-trace budget.
   */
  buildTxs(
    params: SingleTokenDepositParams
  ): SdkResult<{ setup: BuiltTx | null; deposit: BuiltTx }> {
    const pool = this.poolClient.getCached();
    if (!pool) return err("invalid_input", "Call sync() first to populate pool state");
    if (params.tokenInIndex < 0 || params.tokenInIndex >= pool.tokenCount) {
      return err("invalid_input", "Invalid tokenInIndex");
    }
    if (params.amountIn.lten(0)) return err("invalid_input", "amountIn must be > 0");
    try {
      return ok(buildSingleTokenDepositTxs(this.config, pool, params));
    } catch (e) {
      return err("tx_build_failed", "Failed to build single-token deposit txs", e);
    }
  }
}
