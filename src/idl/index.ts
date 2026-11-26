import cofferPoolIdl from "./coffer_pool.json";
import protocolAdminIdl from "./protocol_admin.json";
import singleTokenLiquidityIdl from "./single_token_liquidity.json";
// Copy of contracts idl/coffer_rewards.json (v6.1, 55d9b13); sha256 pinned in tests/rewards.test.ts.
import cofferRewardsIdl from "./coffer_rewards.json";

export const COFFER_POOL_IDL = cofferPoolIdl;
export const PROTOCOL_ADMIN_IDL = protocolAdminIdl;
export const SINGLE_TOKEN_LIQUIDITY_IDL = singleTokenLiquidityIdl;
export const COFFER_REWARDS_IDL = cofferRewardsIdl;

export const IDLS = {
  cofferPool: COFFER_POOL_IDL,
  protocolAdmin: PROTOCOL_ADMIN_IDL,
  singleTokenLiquidity: SINGLE_TOKEN_LIQUIDITY_IDL,
  cofferRewards: COFFER_REWARDS_IDL,
} as const;
