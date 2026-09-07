// Generated from src/idl/*.json by scripts/generate-contract-types.cjs. Do not edit.
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";

export interface ContractTypes {
  "cubicPool": {
    "AssetConfig": { "mint": PublicKey; "token_program": PublicKey; "normalized_weight": BN; "max_selloff_pct": number; "max_selloff_period_length": number; "variable_fee_threshold_pct": number; "variable_fee_slope_low_pct": number; "variable_fee_slope_high_pct": number; "is_active": boolean; "variable_fee_slope_mid_pct": number; "variable_fee_kink_pct": number };
    "AssetDynamics": { "virtual_balance": BN; "actual_balance": BN; "protocol_fees_owed": BN; "previous_selloff": BN; "current_selloff": BN; "window_start_timestamp": BN; "selloff_vb_snapshot": BN };
    "BannedExtensionsUpdated": { "config": PublicKey; "authority": PublicKey; "old_value": BN; "new_value": BN; "timestamp": BN; "old_hard_value": BN; "new_hard_value": BN };
    "ConfigInitialized": { "config": PublicKey; "protocol_admin": PublicKey; "default_protocol_fee_rate": number; "banned_extensions": BN; "payer": PublicKey; "timestamp": BN };
    "CubicPool": { "config": PublicKey; "bump": number; "token_count": number; "pool_id": BN; "swap_fee_rate": number; "protocol_fee_rate": number; "created_at": BN; "pool_enabled": boolean; "swaps_enabled": boolean; "pool_admin": PublicKey; "pending_pool_admin": PublicKey; "range_manager": PublicKey; "range_manager_enabled": boolean; "range_manager_max_vb_change_pct": number; "range_manager_max_weight_change_pct": number; "range_manager_min_update_interval_secs": number; "range_manager_last_updated": BN; "tokens": Array<ContractTypes["cubicPool"]["TokenSlot"]>; "lookup_table": PublicKey; "banned_extensions": BN; "range_manager_max_leverage_bps": number; "range_manager_min_leverage_bps": number; "reserved": Array<number> };
    "CubicPoolConfig": { "protocol_admin": PublicKey; "pending_protocol_admin": PublicKey; "default_protocol_fee_rate": number; "banned_extensions": BN; "hard_banned_extensions": BN; "reserved": Array<number> };
    "DebugLiquidityWithdrawn": { "pool": PublicKey; "authority": PublicKey; "token_amounts": Array<BN>; "timestamp": BN };
    "LiquidityAdded": { "pool": PublicKey; "user": PublicKey; "token_amounts": Array<BN>; "bpt_amount": BN; "timestamp": BN };
    "LiquidityRemoved": { "pool": PublicKey; "user": PublicKey; "bpt_amount": BN; "token_amounts": Array<BN>; "timestamp": BN };
    "MaxSelloffSet": { "pool": PublicKey; "authority": PublicKey; "max_selloff_pct": Array<number>; "max_selloff_period_length": Array<number>; "fee_threshold_pct": Array<number>; "fee_slope_low_pct": Array<number>; "fee_slope_high_pct": Array<number>; "timestamp": BN; "old_max_selloff_pct": Array<number>; "old_max_selloff_period_length": Array<number>; "old_fee_threshold_pct": Array<number>; "old_fee_slope_low_pct": Array<number>; "old_fee_slope_high_pct": Array<number> };
    "MaxSelloffWindowAdvanced": { "pool": PublicKey; "token_index": number; "effective_selloff": BN; "max_selloff_cap": BN; "vb_snapshot": BN; "previous_selloff": BN; "current_selloff": BN; "window_start_timestamp": BN; "timestamp": BN };
    "PoolAdminDisabled": { "pool": PublicKey; "old_admin": PublicKey; "timestamp": BN };
    "PoolAdminTransferCancelled": { "pool": PublicKey; "admin": PublicKey; "cancelled_pending": PublicKey; "timestamp": BN };
    "PoolAdminTransferInitiated": { "pool": PublicKey; "current_admin": PublicKey; "pending_admin": PublicKey; "timestamp": BN };
    "PoolAdminTransferred": { "pool": PublicKey; "old_admin": PublicKey; "new_admin": PublicKey; "timestamp": BN };
    "PoolAltInitialized": { "pool": PublicKey; "lookup_table": PublicKey; "authority": PublicKey; "address_count": number; "timestamp": BN };
    "PoolEnabledUpdated": { "pool": PublicKey; "authority": PublicKey; "old_value": boolean; "new_value": boolean; "timestamp": BN };
    "PoolInfo": { "pool": PublicKey; "config": PublicKey; "bpt_mint": PublicKey; "token_count": number; "pool_id": BN; "tokens": Array<PublicKey>; "token_vaults": Array<PublicKey>; "normalized_weights": Array<BN>; "virtual_balances": Array<BN>; "actual_balances": Array<BN>; "protocol_fees_owed": Array<BN>; "swap_fee_rate": number; "protocol_fee_rate": number; "pool_enabled": boolean; "swaps_enabled": boolean; "token_programs": Array<PublicKey>; "timestamp": BN };
    "PoolInitialized": { "pool": PublicKey; "config": PublicKey; "token_count": number; "bpt_mint": PublicKey; "timestamp": BN; "banned_extensions": BN };
    "PoolMigratedToV5": { "pool": PublicKey; "authority": PublicKey; "token_count": number; "reactivated": number; "timestamp": BN };
    "PoolSolWithdrawn": { "source": PublicKey; "authority": PublicKey; "recipient": PublicKey; "amount": BN; "timestamp": BN };
    "PoolStateLog": { "pool": PublicKey; "virtual_balances": Array<BN>; "actual_balances": Array<BN>; "protocol_fees_owed": Array<BN>; "timestamp": BN };
    "ProtocolAdminTransferCancelled": { "config": PublicKey; "admin": PublicKey; "cancelled_pending": PublicKey; "timestamp": BN };
    "ProtocolAdminTransferInitiated": { "config": PublicKey; "current_admin": PublicKey; "pending_admin": PublicKey; "timestamp": BN };
    "ProtocolAdminTransferred": { "config": PublicKey; "old_admin": PublicKey; "new_admin": PublicKey; "timestamp": BN };
    "ProtocolFeeRateUpdated": { "pool": PublicKey; "old_rate": number; "new_rate": number; "timestamp": BN; "authority": PublicKey };
    "ProtocolFeesCollected": { "pool": PublicKey; "authority": PublicKey; "token_amounts": Array<BN>; "timestamp": BN };
    "RangeManagerConfigSet": { "pool": PublicKey; "authority": PublicKey; "max_vb_change_pct": number; "max_weight_change_pct": number; "min_update_interval_secs": number; "timestamp": BN; "old_max_vb_change_pct": number; "old_max_weight_change_pct": number; "old_min_update_interval_secs": number; "old_max_leverage_bps": number; "new_max_leverage_bps": number };
    "RangeManagerSet": { "pool": PublicKey; "authority": PublicKey; "old_manager": PublicKey; "new_manager": PublicKey; "enabled": boolean; "timestamp": BN; "old_enabled": boolean; "new_enabled": boolean };
    "RangeManagerUpdated": { "pool": PublicKey; "manager": PublicKey; "vb_indices": Buffer; "vb_new_values": Array<BN>; "weight_indices": Buffer; "weight_new_values": Array<BN>; "timestamp": BN };
    "SelloffParams": { "max_selloff_pct": number; "period_length": number; "fee_threshold_pct": number; "fee_slope_low_pct": number; "fee_slope_high_pct": number; "fee_slope_mid_pct": number; "fee_kink_pct": number };
    "Swap": { "pool": PublicKey; "user": PublicKey; "token_in": PublicKey; "token_out": PublicKey; "amount_in": BN; "amount_out": BN; "fee_amount": BN; "protocol_fee_amount": BN; "timestamp": BN; "surge_fee_amount": BN };
    "SwapFeeRateUpdated": { "pool": PublicKey; "old_rate": number; "new_rate": number; "timestamp": BN; "authority": PublicKey };
    "SwapsEnabledUpdated": { "pool": PublicKey; "authority": PublicKey; "old_value": boolean; "new_value": boolean; "timestamp": BN };
    "TokenActiveSet": { "pool": PublicKey; "authority": PublicKey; "token_index": number; "old_value": boolean; "new_value": boolean; "timestamp": BN };
    "TokenChange": { "index": number; "expected_current": BN; "new_value": BN };
    "TokenSlot": { "config": ContractTypes["cubicPool"]["AssetConfig"]; "dynamics": ContractTypes["cubicPool"]["AssetDynamics"] };
  };
  "protocolAdmin": {
    "AdminTransferCancelled": { "treasury": PublicKey; "admin": PublicKey; "cancelled_pending": PublicKey; "timestamp": BN };
    "AdminTransferInitiated": { "treasury": PublicKey; "current_admin": PublicKey; "pending_admin": PublicKey; "timestamp": BN };
    "AdminTransferred": { "treasury": PublicKey; "old_admin": PublicKey; "new_admin": PublicKey; "timestamp": BN };
    "FundsWithdrawn": { "treasury": PublicKey; "admin": PublicKey; "mint": PublicKey; "recipient": PublicKey; "amount": BN; "timestamp": BN };
    "PoolAltInitializedByTreasury": { "treasury": PublicKey; "pool": PublicKey; "lookup_table": PublicKey; "admin": PublicKey; "timestamp": BN };
    "PoolBannedExtensionsSet": { "treasury": PublicKey; "config": PublicKey; "banned_extensions": BN; "timestamp": BN; "old_banned_extensions": BN; "new_banned_extensions": BN; "admin": PublicKey };
    "PoolConfigInitialized": { "treasury": PublicKey; "config": PublicKey; "default_protocol_fee_rate": number; "timestamp": BN };
    "PoolDebugWithdrawn": { "treasury": PublicKey; "pool": PublicKey; "timestamp": BN };
    "PoolEnabledSet": { "treasury": PublicKey; "pool": PublicKey; "enabled": boolean; "timestamp": BN; "old_enabled": boolean; "new_enabled": boolean; "admin": PublicKey };
    "PoolFeesCollected": { "treasury": PublicKey; "pool": PublicKey; "timestamp": BN };
    "PoolProtocolAdminTransferAccepted": { "treasury": PublicKey; "config": PublicKey; "timestamp": BN };
    "PoolProtocolAdminTransferCancelled": { "treasury": PublicKey; "config": PublicKey; "timestamp": BN };
    "PoolProtocolAdminTransferInitiated": { "treasury": PublicKey; "config": PublicKey; "new_admin": PublicKey; "timestamp": BN };
    "PoolProtocolFeeRateSet": { "treasury": PublicKey; "pool": PublicKey; "protocol_fee_rate": number; "timestamp": BN; "old_rate": number; "new_rate": number; "admin": PublicKey };
    "PoolSolWithdrawnViaTreasury": { "treasury": PublicKey; "admin": PublicKey; "source": PublicKey; "recipient": PublicKey; "amount": BN; "timestamp": BN };
    "PoolSwapsEnabledSet": { "treasury": PublicKey; "pool": PublicKey; "enabled": boolean; "timestamp": BN; "old_enabled": boolean; "new_enabled": boolean; "admin": PublicKey };
    "PoolTokenActiveSet": { "treasury": PublicKey; "pool": PublicKey; "authority": PublicKey; "token_index": number; "is_active": boolean; "timestamp": BN; "old_is_active": boolean; "new_is_active": boolean };
    "PoolsFrozen": { "treasury": PublicKey; "authority": PublicKey; "pool_count": number; "timestamp": BN; "pools": Array<PublicKey>; "old_enabled": Array<boolean> };
    "PoolsUnfrozen": { "treasury": PublicKey; "authority": PublicKey; "pool_count": number; "timestamp": BN; "pools": Array<PublicKey>; "old_enabled": Array<boolean> };
    "ProgramClosed": { "treasury": PublicKey; "program": PublicKey; "recipient": PublicKey; "timestamp": BN };
    "ProgramFrozen": { "treasury": PublicKey; "programdata": PublicKey; "timestamp": BN };
    "ProgramUpgraded": { "treasury": PublicKey; "program": PublicKey; "timestamp": BN };
    "SolWithdrawn": { "treasury": PublicKey; "admin": PublicKey; "recipient": PublicKey; "amount": BN; "timestamp": BN };
    "StldSolWithdrawnViaTreasury": { "treasury": PublicKey; "admin": PublicKey; "source": PublicKey; "recipient": PublicKey; "amount": BN; "timestamp": BN };
    "SupervisorSet": { "treasury": PublicKey; "admin": PublicKey; "old_supervisor": PublicKey; "new_supervisor": PublicKey; "timestamp": BN };
    "TokenRegistered": { "treasury": PublicKey; "mint": PublicKey; "vault": PublicKey; "token_index": number; "timestamp": BN };
    "Treasury": { "admin": PublicKey; "pending_admin": PublicKey; "bump": number; "token_count": number; "token_mints": Array<PublicKey>; "token_vaults": Array<PublicKey>; "created_at": BN; "reserved": Array<number>; "supervisor": PublicKey };
    "TreasuryInitialized": { "treasury": PublicKey; "admin": PublicKey; "timestamp": BN };
    "UpgradeAuthorityTransferred": { "treasury": PublicKey; "programdata": PublicKey; "new_authority": PublicKey; "timestamp": BN; "old_authority": PublicKey };
  };
  "singleTokenLiquidity": {
    "AssetConfig": { "mint": PublicKey; "token_program": PublicKey; "normalized_weight": BN; "max_selloff_pct": number; "max_selloff_period_length": number; "variable_fee_threshold_pct": number; "variable_fee_slope_low_pct": number; "variable_fee_slope_high_pct": number; "is_active": boolean; "variable_fee_slope_mid_pct": number; "variable_fee_kink_pct": number };
    "AssetDynamics": { "virtual_balance": BN; "actual_balance": BN; "protocol_fees_owed": BN; "previous_selloff": BN; "current_selloff": BN; "window_start_timestamp": BN; "selloff_vb_snapshot": BN };
    "CubicPool": { "config": PublicKey; "bump": number; "token_count": number; "pool_id": BN; "swap_fee_rate": number; "protocol_fee_rate": number; "created_at": BN; "pool_enabled": boolean; "swaps_enabled": boolean; "pool_admin": PublicKey; "pending_pool_admin": PublicKey; "range_manager": PublicKey; "range_manager_enabled": boolean; "range_manager_max_vb_change_pct": number; "range_manager_max_weight_change_pct": number; "range_manager_min_update_interval_secs": number; "range_manager_last_updated": BN; "tokens": Array<ContractTypes["singleTokenLiquidity"]["TokenSlot"]>; "lookup_table": PublicKey; "banned_extensions": BN; "range_manager_max_leverage_bps": number; "range_manager_min_leverage_bps": number; "reserved": Array<number> };
    "CubicPoolConfig": { "protocol_admin": PublicKey; "pending_protocol_admin": PublicKey; "default_protocol_fee_rate": number; "banned_extensions": BN; "hard_banned_extensions": BN; "reserved": Array<number> };
    "SingleTokenDeposit": { "helper": PublicKey; "pool": PublicKey; "user": PublicKey; "token_in_index": number; "amount_in": BN; "allocations": Array<BN>; "deposited_amounts": Array<BN>; "bpt_received": BN; "dust_refunded": Array<BN>; "timestamp": BN };
    "StldSolWithdrawn": { "source": PublicKey; "authority": PublicKey; "recipient": PublicKey; "amount": BN; "timestamp": BN };
    "TokenSlot": { "config": ContractTypes["singleTokenLiquidity"]["AssetConfig"]; "dynamics": ContractTypes["singleTokenLiquidity"]["AssetDynamics"] };
  };
}

export interface ContractInstructionMap {
  "cubicPool": {
    "accept_pool_admin_transfer": { args: Record<string, never>; accounts: { "pool": PublicKey; "new_admin": PublicKey } };
    "accept_protocol_admin_transfer": { args: Record<string, never>; accounts: { "config": PublicKey; "new_admin": PublicKey } };
    "add_liquidity": { args: { "token_amounts": Array<BN>; "minimum_bpt_amount": BN }; accounts: { "pool": PublicKey; "bpt_mint": PublicKey; "user_bpt_account": PublicKey; "user": PublicKey; "token_program": PublicKey } };
    "cancel_pool_admin_transfer": { args: Record<string, never>; accounts: { "pool": PublicKey; "authority": PublicKey } };
    "cancel_protocol_admin_transfer": { args: Record<string, never>; accounts: { "config": PublicKey; "authority": PublicKey } };
    "collect_protocol_fees": { args: Record<string, never>; accounts: { "config": PublicKey; "pool": PublicKey; "authority": PublicKey } };
    "debug_withdraw_liquidity": { args: { "token_amounts": Array<BN> }; accounts: { "config": PublicKey; "pool": PublicKey; "authority": PublicKey } };
    "disable_pool_admin": { args: Record<string, never>; accounts: { "pool": PublicKey; "authority": PublicKey } };
    "get_pool_info": { args: Record<string, never>; accounts: { "pool": PublicKey } };
    "initialize_config": { args: { "default_protocol_fee_rate": number }; accounts: { "config": PublicKey; "protocol_admin_treasury": PublicKey; "payer": PublicKey; "system_program": PublicKey } };
    "initialize_cubic_pool": { args: { "normalized_weights": Array<BN>; "initial_virtual_balances": Array<BN>; "swap_fee_rate": number; "pool_id": BN; "banned_extensions_override": BN | null }; accounts: { "config": PublicKey; "pool": PublicKey; "bpt_mint": PublicKey; "payer": PublicKey; "token_program": PublicKey; "associated_token_program": PublicKey; "system_program": PublicKey } };
    "initialize_pool_alt": { args: { "recent_slot": BN }; accounts: { "pool": PublicKey; "config": PublicKey; "authority": PublicKey; "payer": PublicKey; "lookup_table": PublicKey; "system_program": PublicKey; "alt_program": PublicKey } };
    "initiate_pool_admin_transfer": { args: { "new_admin": PublicKey }; accounts: { "pool": PublicKey; "authority": PublicKey } };
    "initiate_protocol_admin_transfer": { args: { "new_admin": PublicKey }; accounts: { "config": PublicKey; "authority": PublicKey } };
    "migrate_to_v5": { args: { "reactivate_tokens": boolean }; accounts: { "pool": PublicKey; "config": PublicKey; "authority": PublicKey; "system_program": PublicKey } };
    "range_manager_update": { args: { "vb_changes": Array<ContractTypes["cubicPool"]["TokenChange"]>; "weight_changes": Array<ContractTypes["cubicPool"]["TokenChange"]> }; accounts: { "pool": PublicKey; "authority": PublicKey } };
    "remove_liquidity": { args: { "bpt_amount": BN; "minimum_token_amounts": Array<BN> }; accounts: { "pool": PublicKey; "bpt_mint": PublicKey; "user_bpt_account": PublicKey; "user": PublicKey; "token_program": PublicKey } };
    "set_banned_extensions": { args: { "banned_extensions": BN; "hard_banned_extensions": BN }; accounts: { "config": PublicKey; "authority": PublicKey } };
    "set_max_selloff": { args: { "params": Array<ContractTypes["cubicPool"]["SelloffParams"]> }; accounts: { "pool": PublicKey; "authority": PublicKey } };
    "set_pool_enabled": { args: { "enabled": boolean }; accounts: { "config": PublicKey; "pool": PublicKey; "authority": PublicKey } };
    "set_protocol_fee_rate": { args: { "protocol_fee_rate": number }; accounts: { "config": PublicKey; "pool": PublicKey; "authority": PublicKey } };
    "set_range_manager": { args: { "new_manager": PublicKey; "enabled": boolean }; accounts: { "config": PublicKey; "pool": PublicKey; "authority": PublicKey } };
    "set_range_manager_config": { args: { "max_vb_change_pct": number; "max_weight_change_pct": number; "min_update_interval_secs": number; "max_leverage_bps": number; "min_leverage_bps": number }; accounts: { "pool": PublicKey; "authority": PublicKey } };
    "set_swap_fee_rate": { args: { "swap_fee_rate": number }; accounts: { "pool": PublicKey; "authority": PublicKey } };
    "set_swaps_enabled": { args: { "enabled": boolean }; accounts: { "config": PublicKey; "pool": PublicKey; "authority": PublicKey } };
    "set_token_active": { args: { "token_index": number; "is_active": boolean }; accounts: { "config": PublicKey; "pool": PublicKey; "authority": PublicKey } };
    "swap": { args: { "amount_in": BN; "minimum_amount_out": BN; "token_in_index": number; "token_out_index": number }; accounts: { "pool": PublicKey; "token_mint_in": PublicKey; "token_mint_out": PublicKey; "user_token_account_in": PublicKey; "user_token_account_out": PublicKey; "vault_in": PublicKey; "vault_out": PublicKey; "user": PublicKey; "token_program_in": PublicKey; "token_program_out": PublicKey } };
    "withdraw_sol": { args: { "amount": BN }; accounts: { "config": PublicKey; "source": PublicKey; "recipient": PublicKey; "authority": PublicKey } };
  };
  "protocolAdmin": {
    "accept_admin_transfer": { args: Record<string, never>; accounts: { "treasury": PublicKey; "new_admin": PublicKey } };
    "cancel_admin_transfer": { args: Record<string, never>; accounts: { "treasury": PublicKey; "admin": PublicKey } };
    "close_pool_program": { args: Record<string, never>; accounts: { "treasury": PublicKey; "admin": PublicKey; "programdata": PublicKey; "program_to_close": PublicKey; "recipient": PublicKey; "bpf_loader_upgradeable": PublicKey } };
    "freeze_pool_program": { args: Record<string, never>; accounts: { "treasury": PublicKey; "admin": PublicKey; "program": PublicKey; "programdata": PublicKey; "bpf_loader_upgradeable": PublicKey } };
    "freeze_pools": { args: Record<string, never>; accounts: { "treasury": PublicKey; "authority": PublicKey; "cubic_pool_program": PublicKey } };
    "initialize": { args: { "admin": PublicKey }; accounts: { "treasury": PublicKey; "payer": PublicKey; "program_data": PublicKey; "system_program": PublicKey } };
    "initiate_admin_transfer": { args: { "new_admin": PublicKey }; accounts: { "treasury": PublicKey; "admin": PublicKey } };
    "pool_accept_protocol_admin_transfer": { args: Record<string, never>; accounts: { "treasury": PublicKey; "admin": PublicKey; "config": PublicKey; "cubic_pool_program": PublicKey } };
    "pool_cancel_protocol_admin_transfer": { args: Record<string, never>; accounts: { "treasury": PublicKey; "admin": PublicKey; "config": PublicKey; "cubic_pool_program": PublicKey } };
    "pool_collect_protocol_fees": { args: Record<string, never>; accounts: { "treasury": PublicKey; "admin": PublicKey; "config": PublicKey; "pool": PublicKey; "cubic_pool_program": PublicKey } };
    "pool_debug_withdraw_liquidity": { args: { "token_amounts": Array<BN> }; accounts: { "treasury": PublicKey; "admin": PublicKey; "config": PublicKey; "pool": PublicKey; "cubic_pool_program": PublicKey } };
    "pool_initialize_alt": { args: { "recent_slot": BN }; accounts: { "treasury": PublicKey; "admin": PublicKey; "pool": PublicKey; "config": PublicKey; "lookup_table": PublicKey; "system_program": PublicKey; "alt_program": PublicKey; "cubic_pool_program": PublicKey } };
    "pool_initialize_config": { args: { "default_protocol_fee_rate": number }; accounts: { "treasury": PublicKey; "admin": PublicKey; "config": PublicKey; "cubic_pool_program": PublicKey; "system_program": PublicKey } };
    "pool_initiate_protocol_admin_transfer": { args: { "new_admin": PublicKey }; accounts: { "treasury": PublicKey; "admin": PublicKey; "config": PublicKey; "cubic_pool_program": PublicKey } };
    "pool_migrate_to_v5": { args: { "reactivate_tokens": boolean }; accounts: { "treasury": PublicKey; "admin": PublicKey; "pool": PublicKey; "config": PublicKey; "system_program": PublicKey; "cubic_pool_program": PublicKey } };
    "pool_set_banned_extensions": { args: { "banned_extensions": BN; "hard_banned_extensions": BN }; accounts: { "treasury": PublicKey; "admin": PublicKey; "config": PublicKey; "cubic_pool_program": PublicKey } };
    "pool_set_pool_enabled": { args: { "enabled": boolean }; accounts: { "treasury": PublicKey; "admin": PublicKey; "config": PublicKey; "pool": PublicKey; "cubic_pool_program": PublicKey } };
    "pool_set_protocol_fee_rate": { args: { "protocol_fee_rate": number }; accounts: { "treasury": PublicKey; "admin": PublicKey; "config": PublicKey; "pool": PublicKey; "cubic_pool_program": PublicKey } };
    "pool_set_swaps_enabled": { args: { "enabled": boolean }; accounts: { "treasury": PublicKey; "admin": PublicKey; "config": PublicKey; "pool": PublicKey; "cubic_pool_program": PublicKey } };
    "pool_set_token_active": { args: { "token_index": number; "is_active": boolean }; accounts: { "treasury": PublicKey; "authority": PublicKey; "config": PublicKey; "pool": PublicKey; "cubic_pool_program": PublicKey } };
    "pool_withdraw_sol": { args: { "amount": BN }; accounts: { "treasury": PublicKey; "admin": PublicKey; "config": PublicKey; "source": PublicKey; "recipient": PublicKey; "cubic_pool_program": PublicKey } };
    "register_token": { args: Record<string, never>; accounts: { "treasury": PublicKey; "mint": PublicKey; "vault": PublicKey; "admin": PublicKey; "token_program": PublicKey; "system_program": PublicKey } };
    "set_supervisor": { args: { "new_supervisor": PublicKey }; accounts: { "treasury": PublicKey; "admin": PublicKey; "system_program": PublicKey } };
    "stld_withdraw_sol": { args: { "amount": BN }; accounts: { "treasury": PublicKey; "admin": PublicKey; "config": PublicKey; "pool": PublicKey; "source": PublicKey; "recipient": PublicKey; "system_program": PublicKey; "stld_program": PublicKey } };
    "transfer_upgrade_authority": { args: Record<string, never>; accounts: { "treasury": PublicKey; "admin": PublicKey; "program": PublicKey; "programdata": PublicKey; "new_authority": PublicKey; "bpf_loader_upgradeable": PublicKey } };
    "unfreeze_pools": { args: Record<string, never>; accounts: { "treasury": PublicKey; "authority": PublicKey; "cubic_pool_program": PublicKey } };
    "upgrade_pool_program": { args: Record<string, never>; accounts: { "treasury": PublicKey; "admin": PublicKey; "programdata": PublicKey; "program_to_upgrade": PublicKey; "buffer": PublicKey; "spill": PublicKey; "rent": PublicKey; "clock": PublicKey; "bpf_loader_upgradeable": PublicKey } };
    "withdraw": { args: { "amount": BN }; accounts: { "treasury": PublicKey; "vault": PublicKey; "recipient": PublicKey; "admin": PublicKey; "token_program": PublicKey } };
    "withdraw_sol": { args: { "amount": BN }; accounts: { "treasury": PublicKey; "admin": PublicKey; "recipient": PublicKey } };
  };
  "singleTokenLiquidity": {
    "deposit_single_token": { args: { "amount_in": BN; "token_in_index": number; "minimum_bpt_amount": BN }; accounts: { "pool": PublicKey; "helper": PublicKey; "bpt_mint": PublicKey; "helper_bpt_account": PublicKey; "user_bpt_account": PublicKey; "user": PublicKey; "cubic_pool_program": PublicKey; "bpt_token_program": PublicKey } };
    "withdraw_sol": { args: { "amount": BN }; accounts: { "config": PublicKey; "pool": PublicKey; "source": PublicKey; "recipient": PublicKey; "authority": PublicKey; "system_program": PublicKey } };
  };
}

export interface ContractAccountMap {
  "cubicPool": {
    "CubicPool": ContractTypes["cubicPool"]["CubicPool"];
    "CubicPoolConfig": ContractTypes["cubicPool"]["CubicPoolConfig"];
  };
  "protocolAdmin": {
    "Treasury": ContractTypes["protocolAdmin"]["Treasury"];
  };
  "singleTokenLiquidity": {
    "CubicPool": ContractTypes["singleTokenLiquidity"]["CubicPool"];
    "CubicPoolConfig": ContractTypes["singleTokenLiquidity"]["CubicPoolConfig"];
  };
}

export interface ContractEventMap {
  "cubicPool": {
    "BannedExtensionsUpdated": ContractTypes["cubicPool"]["BannedExtensionsUpdated"];
    "ConfigInitialized": ContractTypes["cubicPool"]["ConfigInitialized"];
    "DebugLiquidityWithdrawn": ContractTypes["cubicPool"]["DebugLiquidityWithdrawn"];
    "LiquidityAdded": ContractTypes["cubicPool"]["LiquidityAdded"];
    "LiquidityRemoved": ContractTypes["cubicPool"]["LiquidityRemoved"];
    "MaxSelloffSet": ContractTypes["cubicPool"]["MaxSelloffSet"];
    "MaxSelloffWindowAdvanced": ContractTypes["cubicPool"]["MaxSelloffWindowAdvanced"];
    "PoolAdminDisabled": ContractTypes["cubicPool"]["PoolAdminDisabled"];
    "PoolAdminTransferCancelled": ContractTypes["cubicPool"]["PoolAdminTransferCancelled"];
    "PoolAdminTransferInitiated": ContractTypes["cubicPool"]["PoolAdminTransferInitiated"];
    "PoolAdminTransferred": ContractTypes["cubicPool"]["PoolAdminTransferred"];
    "PoolAltInitialized": ContractTypes["cubicPool"]["PoolAltInitialized"];
    "PoolEnabledUpdated": ContractTypes["cubicPool"]["PoolEnabledUpdated"];
    "PoolInfo": ContractTypes["cubicPool"]["PoolInfo"];
    "PoolInitialized": ContractTypes["cubicPool"]["PoolInitialized"];
    "PoolMigratedToV5": ContractTypes["cubicPool"]["PoolMigratedToV5"];
    "PoolSolWithdrawn": ContractTypes["cubicPool"]["PoolSolWithdrawn"];
    "PoolStateLog": ContractTypes["cubicPool"]["PoolStateLog"];
    "ProtocolAdminTransferCancelled": ContractTypes["cubicPool"]["ProtocolAdminTransferCancelled"];
    "ProtocolAdminTransferInitiated": ContractTypes["cubicPool"]["ProtocolAdminTransferInitiated"];
    "ProtocolAdminTransferred": ContractTypes["cubicPool"]["ProtocolAdminTransferred"];
    "ProtocolFeeRateUpdated": ContractTypes["cubicPool"]["ProtocolFeeRateUpdated"];
    "ProtocolFeesCollected": ContractTypes["cubicPool"]["ProtocolFeesCollected"];
    "RangeManagerConfigSet": ContractTypes["cubicPool"]["RangeManagerConfigSet"];
    "RangeManagerSet": ContractTypes["cubicPool"]["RangeManagerSet"];
    "RangeManagerUpdated": ContractTypes["cubicPool"]["RangeManagerUpdated"];
    "Swap": ContractTypes["cubicPool"]["Swap"];
    "SwapFeeRateUpdated": ContractTypes["cubicPool"]["SwapFeeRateUpdated"];
    "SwapsEnabledUpdated": ContractTypes["cubicPool"]["SwapsEnabledUpdated"];
    "TokenActiveSet": ContractTypes["cubicPool"]["TokenActiveSet"];
  };
  "protocolAdmin": {
    "AdminTransferCancelled": ContractTypes["protocolAdmin"]["AdminTransferCancelled"];
    "AdminTransferInitiated": ContractTypes["protocolAdmin"]["AdminTransferInitiated"];
    "AdminTransferred": ContractTypes["protocolAdmin"]["AdminTransferred"];
    "FundsWithdrawn": ContractTypes["protocolAdmin"]["FundsWithdrawn"];
    "PoolAltInitializedByTreasury": ContractTypes["protocolAdmin"]["PoolAltInitializedByTreasury"];
    "PoolBannedExtensionsSet": ContractTypes["protocolAdmin"]["PoolBannedExtensionsSet"];
    "PoolConfigInitialized": ContractTypes["protocolAdmin"]["PoolConfigInitialized"];
    "PoolDebugWithdrawn": ContractTypes["protocolAdmin"]["PoolDebugWithdrawn"];
    "PoolEnabledSet": ContractTypes["protocolAdmin"]["PoolEnabledSet"];
    "PoolFeesCollected": ContractTypes["protocolAdmin"]["PoolFeesCollected"];
    "PoolProtocolAdminTransferAccepted": ContractTypes["protocolAdmin"]["PoolProtocolAdminTransferAccepted"];
    "PoolProtocolAdminTransferCancelled": ContractTypes["protocolAdmin"]["PoolProtocolAdminTransferCancelled"];
    "PoolProtocolAdminTransferInitiated": ContractTypes["protocolAdmin"]["PoolProtocolAdminTransferInitiated"];
    "PoolProtocolFeeRateSet": ContractTypes["protocolAdmin"]["PoolProtocolFeeRateSet"];
    "PoolSolWithdrawnViaTreasury": ContractTypes["protocolAdmin"]["PoolSolWithdrawnViaTreasury"];
    "PoolSwapsEnabledSet": ContractTypes["protocolAdmin"]["PoolSwapsEnabledSet"];
    "PoolTokenActiveSet": ContractTypes["protocolAdmin"]["PoolTokenActiveSet"];
    "PoolsFrozen": ContractTypes["protocolAdmin"]["PoolsFrozen"];
    "PoolsUnfrozen": ContractTypes["protocolAdmin"]["PoolsUnfrozen"];
    "ProgramClosed": ContractTypes["protocolAdmin"]["ProgramClosed"];
    "ProgramFrozen": ContractTypes["protocolAdmin"]["ProgramFrozen"];
    "ProgramUpgraded": ContractTypes["protocolAdmin"]["ProgramUpgraded"];
    "SolWithdrawn": ContractTypes["protocolAdmin"]["SolWithdrawn"];
    "StldSolWithdrawnViaTreasury": ContractTypes["protocolAdmin"]["StldSolWithdrawnViaTreasury"];
    "SupervisorSet": ContractTypes["protocolAdmin"]["SupervisorSet"];
    "TokenRegistered": ContractTypes["protocolAdmin"]["TokenRegistered"];
    "TreasuryInitialized": ContractTypes["protocolAdmin"]["TreasuryInitialized"];
    "UpgradeAuthorityTransferred": ContractTypes["protocolAdmin"]["UpgradeAuthorityTransferred"];
  };
  "singleTokenLiquidity": {
    "SingleTokenDeposit": ContractTypes["singleTokenLiquidity"]["SingleTokenDeposit"];
    "StldSolWithdrawn": ContractTypes["singleTokenLiquidity"]["StldSolWithdrawn"];
  };
}

export type ContractProgram = keyof ContractInstructionMap;
