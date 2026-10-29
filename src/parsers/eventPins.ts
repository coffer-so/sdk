/**
 * v6.1 (T11) event pins, copied from contracts `idl/abi-pins.json`
 * (`recutEvents` / `retiredEvents`, commit 409067d).
 *
 * Discriminator = `sha256("event:<Name>")[..8]`. A payload change since the
 * v6 wire is a RE-CUT (new name, new discriminator); the legacy
 * discriminator is pinned so nothing can reuse it and so a v6 log can be
 * told apart from garbage. RETIRED events have no successor (their content
 * was folded into `SwapV2` / `LiquidityAddedV2` / `LiquidityRemovedV2`).
 * None of these decode on the v6.1 IDL — v6 history needs the v6 SDK.
 */
import type { ContractProgram } from "../types/contracts";

export interface LegacyEventPin {
  program: ContractProgram;
  /** The pre-T11 event name. */
  legacyName: string;
  /** The event that replaced it, or `null` when retired. */
  replacedBy: string | null;
}

/** Re-cut events: new name → `{ legacyName, legacyDiscriminator, discriminator }` (hex). */
export const RECUT_EVENTS: Record<ContractProgram, Record<string, { legacyName: string; legacyDiscriminator: string; discriminator: string }>> = {
  cofferPool: {
    ConfigInitializedV2: { legacyName: "ConfigInitialized", legacyDiscriminator: "b531c89c13a7b25b", discriminator: "7a25e24c0c7c5b38" },
    DebugLiquidityWithdrawnV2: { legacyName: "DebugLiquidityWithdrawn", legacyDiscriminator: "ae3b951687818153", discriminator: "6afd9703e02e0e55" },
    LiquidityAddedV2: { legacyName: "LiquidityAdded", legacyDiscriminator: "9a1add6cee40d9a1", discriminator: "32430f2490367820" },
    LiquidityRemovedV2: { legacyName: "LiquidityRemoved", legacyDiscriminator: "e169d8277c74a9bd", discriminator: "e67f3f261c2e9d07" },
    MaxSelloffSetV2: { legacyName: "MaxSelloffSet", legacyDiscriminator: "86b73186528a55ea", discriminator: "c5cd4f2ba8b07dca" },
    PoolAdminDisabledV2: { legacyName: "PoolAdminDisabled", legacyDiscriminator: "9e62ca25f339f757", discriminator: "f1fc6934d01b19e5" },
    PoolAdminTransferInitiatedV2: { legacyName: "PoolAdminTransferInitiated", legacyDiscriminator: "21c3ca85d12a9d4e", discriminator: "bd05e73e573e5b27" },
    PoolAdminTransferredV2: { legacyName: "PoolAdminTransferred", legacyDiscriminator: "7b30e7ba35439cfe", discriminator: "3dc416f376a01a4c" },
    PoolInfoV2: { legacyName: "PoolInfo", legacyDiscriminator: "cf145761fbd4ea2d", discriminator: "dc53525432ea5787" },
    PoolInitializedV2: { legacyName: "PoolInitialized", legacyDiscriminator: "6476ad570cc6fee5", discriminator: "a5d9f342e388a1f3" },
    PoolMigrationV5Applied: { legacyName: "PoolMigratedToV5", legacyDiscriminator: "5f379d3d5c064f69", discriminator: "616a221fe1d0ea87" },
    PoolSolWithdrawnV2: { legacyName: "PoolSolWithdrawn", legacyDiscriminator: "52dcadaf18a5ace9", discriminator: "ef1ee5f879dd9a06" },
    ProtocolFeesCollectedV2: { legacyName: "ProtocolFeesCollected", legacyDiscriminator: "a5227d9b0f5663bf", discriminator: "e0745cf7453e5e47" },
    RangeManagerSetV2: { legacyName: "RangeManagerSet", legacyDiscriminator: "3e98eb5bc3ee53ca", discriminator: "2c67ccdbb0b9379a" },
    RangeManagerUpdatedV2: { legacyName: "RangeManagerUpdated", legacyDiscriminator: "8490649095cdd418", discriminator: "efdb2e54f5c1cc52" },
    SwapV2: { legacyName: "Swap", legacyDiscriminator: "516ce3becdd00ac4", discriminator: "b95be92f6be69593" },
    SwapsEnabledUpdatedV2: { legacyName: "SwapsEnabledUpdated", legacyDiscriminator: "3774768a661ae3df", discriminator: "e131c88a976d2462" },
    TokenActiveSetV2: { legacyName: "TokenActiveSet", legacyDiscriminator: "a8dd1992eae6e864", discriminator: "7170a050aca1c632" },
    CreatorFeesClaimedV2: { legacyName: "CreatorFeesClaimed", legacyDiscriminator: "bdb215b5abb38301", discriminator: "a5115bb91caeb282" },
  },
  protocolAdmin: {
    AdminTransferInitiatedV2: { legacyName: "AdminTransferInitiated", legacyDiscriminator: "9dff005c346a109c", discriminator: "36e8ea0efc7b78c1" },
    AdminTransferredV2: { legacyName: "AdminTransferred", legacyDiscriminator: "ff93b605c7d926b3", discriminator: "0ebbc71611ee4f3b" },
    FundsWithdrawnV2: { legacyName: "FundsWithdrawn", legacyDiscriminator: "3882e69a235c0b76", discriminator: "60792ae30ae8b3b4" },
    PoolConfigInitializedV2: { legacyName: "PoolConfigInitialized", legacyDiscriminator: "e5dc57f1afa5c61c", discriminator: "49e6c422c8c17e8d" },
    PoolDebugWithdrawnV2: { legacyName: "PoolDebugWithdrawn", legacyDiscriminator: "f8ef428dcfa0947b", discriminator: "46c9da264da7c02f" },
    PoolEnabledSetV2: { legacyName: "PoolEnabledSet", legacyDiscriminator: "b0645e8ac4891297", discriminator: "372fa0ba7fc89b27" },
    PoolFeesCollectedV2: { legacyName: "PoolFeesCollected", legacyDiscriminator: "da4aa32a089839f2", discriminator: "ed836963bc4a07cd" },
    PoolProtocolAdminTransferAcceptedV2: { legacyName: "PoolProtocolAdminTransferAccepted", legacyDiscriminator: "eb5b3f41ae2a3781", discriminator: "bffa74688e2ae97c" },
    PoolProtocolAdminTransferCancelledV2: { legacyName: "PoolProtocolAdminTransferCancelled", legacyDiscriminator: "cea57071cb402597", discriminator: "a576a19ff72986da" },
    PoolProtocolAdminTransferInitiatedV2: { legacyName: "PoolProtocolAdminTransferInitiated", legacyDiscriminator: "258ef8847b875e16", discriminator: "deb671a6afacd3c5" },
    PoolProtocolFeeRateSetV2: { legacyName: "PoolProtocolFeeRateSet", legacyDiscriminator: "bd65f12631ae3117", discriminator: "991e80aca9002d63" },
    PoolSwapsEnabledSetV2: { legacyName: "PoolSwapsEnabledSet", legacyDiscriminator: "736fee98eb1ac6a8", discriminator: "5fd6d165e677c7be" },
    PoolTokenActiveSetV2: { legacyName: "PoolTokenActiveSet", legacyDiscriminator: "5adf18e5f954852b", discriminator: "c9f3a87bc8440740" },
    PoolsFrozenV2: { legacyName: "PoolsFrozen", legacyDiscriminator: "71780f5fdf17aca2", discriminator: "37f2c493bdb4ad51" },
    PoolsUnfrozenV2: { legacyName: "PoolsUnfrozen", legacyDiscriminator: "7c23672d012a3e54", discriminator: "2a92aaa325c7245c" },
    ProgramClosedV2: { legacyName: "ProgramClosed", legacyDiscriminator: "0369c3bb7a018e08", discriminator: "aef4e71a73ff65d2" },
    ProgramFrozenV2: { legacyName: "ProgramFrozen", legacyDiscriminator: "ad8035ef0f26ebcb", discriminator: "f37ab83b592214ef" },
    ProgramUpgradedV2: { legacyName: "ProgramUpgraded", legacyDiscriminator: "7466dc04dcfad10d", discriminator: "97d1edae571fb199" },
    SolWithdrawnV2: { legacyName: "SolWithdrawn", legacyDiscriminator: "91f94530ce565b42", discriminator: "74411417dbc6532c" },
    TokenRegisteredV2: { legacyName: "TokenRegistered", legacyDiscriminator: "d226f9b64f70f0e1", discriminator: "1807c4960b2bb7b7" },
    TreasuryInitializedV2: { legacyName: "TreasuryInitialized", legacyDiscriminator: "c749aecd3b9137b3", discriminator: "3295647c322d47a5" },
    UpgradeAuthorityTransferredV2: { legacyName: "UpgradeAuthorityTransferred", legacyDiscriminator: "85c66b5a32b6c040", discriminator: "1a1129b7d74a8cc0" },
    PoolRangeManagerDisabledV2: { legacyName: "PoolRangeManagerDisabled", legacyDiscriminator: "931705931347901b", discriminator: "0970d99927925ef2" },
    ActionCancelledV2: { legacyName: "ActionCancelled", legacyDiscriminator: "79d5cd1de2b5e60d", discriminator: "d8dad35b7bb6e398" },
  },
  singleTokenLiquidity: {
    SingleTokenDepositDirectV2: { legacyName: "SingleTokenDepositDirect", legacyDiscriminator: "4e80765d94b3d870", discriminator: "f113f8998ecacbf2" },
    StldSolWithdrawnV2: { legacyName: "StldSolWithdrawn", legacyDiscriminator: "18f61b27dec4873d", discriminator: "5d915d7e510d02a6" },
  },
};

/** Retired events (no successor): legacy name → discriminator (hex). */
export const RETIRED_EVENTS: Record<ContractProgram, Record<string, string>> = {
  cofferPool: { PoolStateLog: "3bfeed6fa30a8ce0", MaxSelloffWindowAdvanced: "e5e3a31e16b74e39" },
  protocolAdmin: {},
  singleTokenLiquidity: { SingleTokenDeposit: "d7368968db27a4eb" },
};

/** Every pre-T11 discriminator the v6.1 IDL no longer decodes: hex → pin. */
export const LEGACY_EVENT_DISCRIMINATORS: ReadonlyMap<string, LegacyEventPin> = (() => {
  const map = new Map<string, LegacyEventPin>();
  for (const program of Object.keys(RECUT_EVENTS) as ContractProgram[]) {
    for (const [name, pin] of Object.entries(RECUT_EVENTS[program])) {
      map.set(pin.legacyDiscriminator, { program, legacyName: pin.legacyName, replacedBy: name });
    }
    for (const [legacyName, hex] of Object.entries(RETIRED_EVENTS[program])) {
      map.set(hex, { program, legacyName, replacedBy: null });
    }
  }
  return map;
})();
