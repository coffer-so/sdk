# Owner devnet test preparation — concentration-factor-20261102

Status: INCOMPLETE until owner deployment and confirmed observations exist.
No program is claimed installed by this SDK checkout. Local tests use mocks;
October 30 evidence remains historical. This document adds no automatic runner.

1. Parent closes stable contracts/SDK integration using exact source, IDL and
   binary hashes, with the contracts HANDOFF/READY receipt. Owner supplies public
   deployment receipts (program IDs, ProgramData/authority observations, source
   hashes, binary hashes, successful deployment signatures and confirmed slots),
   verified devnet genesis/RPC and Treasury/config addresses. Do not substitute
   historical network defaults. Keep the SDK package version independent
   (`0.4.0` targets `v6.1-rc2`).
2. Owner uses the existing authorized devnet harness after reviewing its concrete
   unsigned instructions and limits. Configure SDK program/Treasury/config
   overrides from those receipts. Run local `types:check`, `fixtures:events:check`,
   `abi:check` and offline Jest with `--maxWorkers=2` first. No
   SDK environment swap, global toolchain install or automatic deploy is required.
3. Execute the cases below in the owner's devnet test scope. Capture each exact
   epoch, Clock slot, pool/mint bytes, transfer-hook registry and native data
   inputs, transaction signature, confirmed status/meta, before/after balances,
   decoded events and resulting SDK quote/build comparison. A timeout or missing
   observation is INCOMPLETE; an expected rejection needs its actual error receipt.

| Case | Positive observation | Required rejection/control |
| --- | --- | --- |
| LP metadata planned zap | Plain legacy LP and Token-2022 MetadataPointer-to-self + TokenMetadata LP; unchanged signed state commitment | Wrong authority/owner, foreign pointer, forbidden extension, duplicate/truncated TLV |
| Exact exits | Reserve + surge payout, separate withdrawal-fee ceilings, floor-capped burn, below-floor redemption, surge-only slot, amount-seeded hook on combined debit | Gross-positive/all-net-zero `WithdrawFeeConsumesAll`; dust-zero transfer omitted; malformed registry rejected |
| Atomic seed | Fee-bearing gross >= virtual but epoch-selected net < virtual; exact native slice then Token-2022 amount-seeded tail; all transactions one approval | Old epoch selecting net >= virtual; wrong mint order/owner/decimals; missing/signer/duplicate tail; fully fee-consumed seed |
| Planned mixed tails | Native caller slice plus every amount-seeded Token-2022 swap/join extra; custom hook data owned by native hook | Missing/short native slice; ambiguous array; wrong program/caller/privilege; duplicate across slices |
| Native bypass | Remove bypass and fund-sidelined skip native callbacks; Token-2022 callbacks/memo remain enforced | Do not infer a planned-zap bypass or seed exemption from funding behavior |
| Governance/state | Pool and Treasury cooldown create/replace/cancel/execute; latest payload/eta and epochs visible; supervisor veto; restrictive-only supervisor; manager-lock/enable queue | Unauthorized relaxations; old epoch/expired queue; pending replacement must update displayed payload, not just kind |
| Fee/repair | Protocol/creator/LP cascade and buckets; custom pool seed; sidelined funding; repair with exact selloff snapshot and pressure rescaling | Under-floor or overflowing rescale; verify zero native callbacks where the source bypasses them |
| N=10 / hardware | Packet <=1232 B, account/ALT count and warmup, measured CU/CPI trace/stack depth within runtime limits | No claim from a size estimate that arbitrary hooks fit; retain any resource/runtime rejection |

Raw IDL builders cover encoding and fixed account flags; authority and remaining
account semantics still require the source-specific layout and these observations.
Backend indexing/API contracts have a separate deployment cycle; the local
historical backend pin in `BACKEND_COMPATIBILITY.md` is not live verification.

Retain skipped online tests and negative controls in the final release receipt.
Finite successful devnet cases establish only those observed cases; they do not
prove all 109 instruction state spaces, compiler/SBF equivalence or production readiness.
