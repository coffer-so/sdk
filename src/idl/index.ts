import cofferPoolIdl from "./coffer_pool.json";
import protocolAdminIdl from "./protocol_admin.json";
import singleTokenLiquidityIdl from "./single_token_liquidity.json";

export const COFFER_POOL_IDL = cofferPoolIdl;
export const PROTOCOL_ADMIN_IDL = protocolAdminIdl;
export const SINGLE_TOKEN_LIQUIDITY_IDL = singleTokenLiquidityIdl;

export const IDLS = {
  cofferPool: COFFER_POOL_IDL,
  protocolAdmin: PROTOCOL_ADMIN_IDL,
  singleTokenLiquidity: SINGLE_TOKEN_LIQUIDITY_IDL,
} as const;
