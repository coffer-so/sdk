/**
 * Token-2022 transfer-fee math (`util/transfer_fee.rs`, planner
 * `FeeSchedule`). The inverse must round-trip against SPL's own
 * `calculateFee`/`calculateEpochFee` on the planner's grid, and the
 * schedule must flip exactly on the activation epoch.
 */
import { calculateEpochFee, calculateFee } from "@solana/spl-token";
import type { TransferFee, TransferFeeConfig } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import {
  grossOfTransferFee,
  inverseTransferFee,
  netOfTransferFee,
  selectEpochFee,
  transferFeeOf,
  MAX_FEE_BASIS_POINTS,
} from "../../src/math/transferFee";
import { MathError } from "../../src/math/fixedPoint";

const U64_MAX = (1n << 64n) - 1n;
const fee = (bps: number, maximumFee: bigint, epoch = 0n): TransferFee => ({ epoch, maximumFee, transferFeeBasisPoints: bps });

describe("transferFeeOf / netOfTransferFee", () => {
  test("no schedule means no fee", () => {
    expect(transferFeeOf(null, 123n)).toBe(0n);
    expect(netOfTransferFee(undefined, 123n)).toBe(123n);
  });

  test("ceil then cap, exactly SPL calculateFee", () => {
    const s = fee(100, 1_000n);
    expect(transferFeeOf(s, 1n)).toBe(1n); // ceil(0.01)
    expect(transferFeeOf(s, 10_000n)).toBe(100n);
    expect(transferFeeOf(s, 1_000_000n)).toBe(1_000n); // capped
    expect(transferFeeOf(s, 0n)).toBe(0n);
    for (const gross of [1n, 99n, 10_000n, 1_000_000n, U64_MAX]) {
      expect(transferFeeOf(s, gross)).toBe(calculateFee(s, gross));
    }
  });

  test("100 % takes the maximum of every non-zero transfer", () => {
    const s = fee(MAX_FEE_BASIS_POINTS, 100n);
    expect(transferFeeOf(s, 1n)).toBe(1n);
    expect(transferFeeOf(s, 101n)).toBe(100n);
    expect(netOfTransferFee(s, 101n)).toBe(1n);
  });
});

describe("inverse (planner.rs::fee_inverse_caps_and_full_fee_are_round_trip_safe)", () => {
  test("round-trips on the grid and is the smallest such gross", () => {
    for (const bps of [0, 1, 100, 9_999, 10_000]) {
      for (const cap of [0n, 1n, 100n, 1_000_000n]) {
        const s = fee(bps, cap);
        for (const net of [0n, 1n, 2n, 99n, 10_000n, 1_000_000n]) {
          const gross = grossOfTransferFee(s, net);
          expect(netOfTransferFee(s, gross)).toBe(net);
          if (gross > 0n && net > 0n) expect(netOfTransferFee(s, gross - 1n)).toBeLessThan(net);
        }
      }
    }
  });

  test("100 % with an unbounded maximum cannot be grossed up", () => {
    expect(() => grossOfTransferFee(fee(10_000, U64_MAX), 1n)).toThrow(MathError);
  });

  test("zero net or zero bps costs nothing", () => {
    expect(inverseTransferFee(fee(100, 1_000n), 0n)).toBe(0n);
    expect(inverseTransferFee(fee(0, 1_000n), 10n)).toBe(0n);
    expect(inverseTransferFee(null, 10n)).toBe(0n);
  });

  test("hits the cap when the proportional fee would exceed it", () => {
    // 1 % of 1_000_000 net is 10_101 pre-fee → cap 1_000 applies instead.
    expect(inverseTransferFee(fee(100, 1_000n), 1_000_000n)).toBe(1_000n);
    expect(inverseTransferFee(fee(100, 1_000_000n), 1_000_000n)).toBe(10_102n);
  });
});

describe("selectEpochFee (planner.rs::epoch_schedule_selection_changes_exactly_on_the_activation_epoch)", () => {
  const config: TransferFeeConfig = {
    transferFeeConfigAuthority: PublicKey.default,
    withdrawWithheldAuthority: PublicKey.default,
    withheldAmount: 0n,
    olderTransferFee: fee(100, 1_000n, 0n),
    newerTransferFee: fee(10_000, 100n, 4n),
  };
  const netAt = (epoch: bigint, gross: bigint) => netOfTransferFee(selectEpochFee(config, epoch), gross);

  test("newer schedule applies from its epoch onwards", () => {
    expect(netAt(3n, 10_000n)).toBe(9_900n);
    expect(netAt(4n, 10_000n)).toBe(9_900n);
    expect(netAt(3n, 100n)).toBe(99n);
    expect(netAt(4n, 100n)).toBe(0n);
    expect(netAt(5n, 101n)).toBe(1n);
  });

  test("agrees with SPL calculateEpochFee", () => {
    for (const epoch of [0n, 3n, 4n, 5n, 1_000n]) {
      for (const gross of [0n, 1n, 100n, 101n, 10_000n, U64_MAX]) {
        expect(transferFeeOf(selectEpochFee(config, epoch), gross)).toBe(calculateEpochFee(config, epoch, gross));
      }
    }
  });
});
