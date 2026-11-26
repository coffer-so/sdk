import { Commitment, Connection, PublicKey } from "@solana/web3.js";
import { SdkResult } from "../types/result";
import { RetryOptions } from "../utils/retry";
import { err, ok } from "../types/result";
import { toSdkError } from "../utils/errors";

export interface RpcClientParams {
  endpoint?: string;
  /** Ordered endpoint list. If provided, it is used as-is. */
  endpoints?: string[];
  /** Extra endpoints appended after `endpoint`. Ignored when `endpoints` is set. */
  fallbackEndpoints?: string[];
  apiKey?: string;
  commitment?: Commitment;
  /** Optional headers (e.g. for Helius/Triton auth). */
  headers?: Record<string, string>;
  /** Per-endpoint timeout before the next RPC endpoint is tried. */
  timeoutMs?: number;
  /** Backoff schedule between endpoint attempts. Defaults to no delay. */
  backoffMs?: number[];
  /** Test hook for injecting lightweight fake connections. */
  connectionFactory?: (endpoint: string) => Pick<
    Connection,
    "getAccountInfo" | "getMultipleAccountsInfo" | "getSlot"
  >;
}

/**
 * Thin wrapper around `@solana/web3.js` Connection with built-in retry +
 * human-readable error mapping. Every public method returns a SdkResult<T>.
 */
export class RpcClient {
  readonly endpoints: string[];
  private readonly connections: Array<Pick<
    Connection,
    "getAccountInfo" | "getMultipleAccountsInfo" | "getSlot"
  >>;
  private readonly defaultCommitment: Commitment;
  private readonly timeoutMs: number;
  private readonly backoffMs: number[];
  private activeEndpointIndex = 0;

  constructor(params: RpcClientParams) {
    this.defaultCommitment = params.commitment ?? "confirmed";
    this.timeoutMs = params.timeoutMs ?? 2_000;
    this.backoffMs = params.backoffMs ?? [];
    this.endpoints = normalizeEndpoints(params);
    if (this.endpoints.length === 0) {
      throw new Error("RpcClient requires at least one endpoint");
    }
    this.connections = this.endpoints.map((endpoint) =>
      params.connectionFactory
        ? params.connectionFactory(endpoint)
        : new Connection(endpoint, {
            commitment: this.defaultCommitment,
            httpHeaders: params.headers,
          })
    );
  }

  get connection(): Connection {
    return this.connections[this.activeEndpointIndex] as Connection;
  }

  call<T>(
    fn: (conn: Connection) => Promise<T>,
    retry: RetryOptions = {}
  ): Promise<SdkResult<T>> {
    return this.callWithFallback((conn) => fn(conn as Connection), retry);
  }

  getAccountInfo(
    pk: PublicKey,
    retry: RetryOptions = {}
  ): Promise<SdkResult<{ data: Buffer; owner: PublicKey; lamports: number } | null>> {
    return this.callWithFallback(async (conn) => {
      const info = await conn.getAccountInfo(pk, this.defaultCommitment);
      if (!info) return null;
      return {
        data: info.data,
        owner: info.owner,
        lamports: info.lamports,
      };
    }, retry);
  }

  getMultipleAccountsInfo(
    pks: PublicKey[],
    retry: RetryOptions = {}
  ): Promise<SdkResult<(Buffer | null)[]>> {
    return this.callWithFallback(async (conn) => {
      const infos = await conn.getMultipleAccountsInfo(pks, this.defaultCommitment);
      return infos.map((i) => (i ? i.data : null));
    }, retry);
  }

  getMultipleAccountsWithInfo(
    pks: PublicKey[],
    retry: RetryOptions = {}
  ): Promise<SdkResult<({ data: Buffer; owner: PublicKey; lamports: number } | null)[]>> {
    return this.callWithFallback(async (conn) => {
      const infos = await conn.getMultipleAccountsInfo(pks, this.defaultCommitment);
      return infos.map((i) => i ? { data: i.data, owner: i.owner, lamports: i.lamports } : null);
    }, retry);
  }

  getSlot(retry: RetryOptions = {}): Promise<SdkResult<number>> {
    return this.callWithFallback((conn) => conn.getSlot(this.defaultCommitment), retry);
  }

  private async callWithFallback<T>(
    operation: (conn: Pick<Connection, "getAccountInfo" | "getMultipleAccountsInfo" | "getSlot">) => Promise<T>,
    retry: RetryOptions = {}
  ): Promise<SdkResult<T>> {
    const attempts = Math.max(1, retry.attempts ?? this.connections.length);
    const timeoutMs = retry.timeoutMs ?? this.timeoutMs;
    const shouldRetry = retry.shouldRetry ?? defaultShouldRetry;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const endpointIndex = (this.activeEndpointIndex + attempt) % this.connections.length;
      try {
        const data = await withTimeout(operation(this.connections[endpointIndex]), timeoutMs);
        this.activeEndpointIndex = endpointIndex;
        return ok(data);
      } catch (e) {
        lastError = e;
        if (!shouldRetry(e)) break;
        if (attempt < attempts - 1) {
          const delay = this.backoffMs[Math.min(attempt, this.backoffMs.length - 1)] ?? 0;
          if (delay > 0) await sleep(delay);
        }
      }
    }

    const sdkError = toSdkError(lastError);
    return err(sdkError.code, sdkError.humanMessage, lastError);
  }
}

function normalizeEndpoints(params: RpcClientParams): string[] {
  if (params.endpoints && params.endpoints.length > 0) {
    return dedupe(params.endpoints);
  }
  const primary = params.endpoint
    ? params.apiKey
      ? appendApiKey(params.endpoint, params.apiKey)
      : params.endpoint
    : undefined;
  return dedupe([primary, ...(params.fallbackEndpoints ?? [])].filter(Boolean) as string[]);
}

function dedupe(endpoints: string[]): string[] {
  return Array.from(new Set(endpoints));
}

function defaultShouldRetry(e: unknown): boolean {
  const sdkError = toSdkError(e);
  return (
    sdkError.code === "rpc_timeout" ||
    sdkError.code === "rpc_unavailable" ||
    sdkError.code === "rpc_rate_limited"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const h = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(h);
        resolve(v);
      },
      (e) => {
        clearTimeout(h);
        reject(e);
      }
    );
  });
}

function appendApiKey(endpoint: string, apiKey: string): string {
  try {
    const u = new URL(endpoint);
    u.searchParams.set("api-key", apiKey);
    return u.toString();
  } catch {
    const sep = endpoint.includes("?") ? "&" : "?";
    return `${endpoint}${sep}api-key=${encodeURIComponent(apiKey)}`;
  }
}
