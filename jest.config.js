/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/**/*.test.ts"],
  moduleFileExtensions: ["ts", "js"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.json" }],
  },
  // rpc-websockets (inside @solana/web3.js) nests an ESM-only uuid@14 that
  // Jest's CJS runtime cannot parse. Map every `uuid` import to the root
  // CJS uuid instead (API-compatible for the v4() calls involved).
  moduleNameMapper: {
    "^uuid$": "<rootDir>/node_modules/uuid",
  },
  // jest-worker serialises per-test results via JSON; BigInt values
  // anywhere in assertion payloads (or in thrown errors) break that.
  // Run everything in-band to avoid the worker serialiser.
  maxWorkers: 1,
};
