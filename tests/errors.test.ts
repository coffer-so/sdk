import cofferPoolIdl from "../src/idl/coffer_pool.json";
import { contractErrorMapForTests, toSdkError } from "../src/utils/errors";

describe("CONTRACT_ERROR_MAP", () => {
  test("covers every coffer-pool IDL error code", () => {
    const map = contractErrorMapForTests();
    // v6.1 (T22): 6104–6106 carry an SDK user-facing message instead of the terse IDL `msg`.
    const userFacing = new Set(["VirtualBalanceNotAboveActual", "VirtualBalanceBelowFloor", "InvalidVirtualRescale"]);
    for (const anchorError of cofferPoolIdl.errors) {
      expect(map[anchorError.code]).toBeDefined();
      expect(map[anchorError.code].name).toBe(anchorError.name);
      if (userFacing.has(anchorError.name)) expect(map[anchorError.code].message.length).toBeGreaterThan(anchorError.msg.length);
      else expect(map[anchorError.code].message).toBe(anchorError.msg);
    }
  });

  test("maps pool disabled and swaps disabled to stable sdk codes", () => {
    const map = contractErrorMapForTests();
    expect(map[6020].code).toBe("pool_disabled");
    expect(map[6021].code).toBe("swaps_disabled");
  });

  test("maps banned token-2022 extension correctly", () => {
    const map = contractErrorMapForTests();
    expect(map[6025].code).toBe("invalid_input");
    expect(map[6025].message).toMatch(/BannedExtension|banned/i);
  });
});

describe("toSdkError", () => {
  test("recognises anchor error number format", () => {
    const res = toSdkError(new Error("Error Number: 6021"));
    expect(res.code).toBe("swaps_disabled");
    expect(res.humanMessage).toMatch(/Swaps are disabled/i);
  });
});
