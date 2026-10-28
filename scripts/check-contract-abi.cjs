// Compare the shipped SDK ABI with an explicitly selected contracts checkout.
// Read-only: does not build contracts, write IDLs, connect to RPC, or send transactions.
const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const arg = process.argv.indexOf('--contracts-dir');
if (arg < 0 || !process.argv[arg + 1]) {
  process.stderr.write('Usage: node scripts/check-contract-abi.cjs --contracts-dir /path/to/contracts [--idl-dir idl|target/idl] [--ignore-address]\n');
  process.exit(2);
}
const contracts = path.resolve(process.argv[arg + 1]);
// v6.1: the contracts repo commits its IDLs under `idl/` (the SDK vendors
// those); `target/idl` is the raw `anchor build` output.
const idlDirArg = process.argv.indexOf('--idl-dir');
const idlDir = idlDirArg >= 0 && process.argv[idlDirArg + 1] ? process.argv[idlDirArg + 1] : 'target/idl';
// The SDK carries deployment ids in `address`, the contracts carry declare_ids.
const ignoreAddress = process.argv.includes('--ignore-address');
const sdk = path.resolve(__dirname, '..');
const names = ['coffer_pool', 'protocol_admin', 'single_token_liquidity'];
const result = [];
for (const name of names) {
  const actual = JSON.parse(fs.readFileSync(path.join(sdk, 'src/idl', `${name}.json`), 'utf8'));
  const expected = JSON.parse(fs.readFileSync(path.join(contracts, idlDir, `${name}.json`), 'utf8'));
  if (ignoreAddress) { delete actual.address; delete expected.address; }
  const matches = isDeepStrictEqual(actual, expected);
  result.push({ program: name, matches, instructions: actual.instructions.length, events: actual.events.length, accounts: actual.accounts.map(a => a.name) });
  if (!matches) process.exitCode = 1;
}
process.stdout.write(JSON.stringify({ contracts, programs: result }, null, 2) + '\n');
