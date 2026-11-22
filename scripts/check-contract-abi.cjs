// Compare the shipped SDK ABI with an explicitly selected contracts checkout.
// Read-only: does not build contracts, write IDLs, connect to RPC, or send transactions.
const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const arg = process.argv.indexOf('--contracts-dir');
if (arg < 0 || !process.argv[arg + 1]) {
  process.stderr.write('Usage: node scripts/check-contract-abi.cjs --contracts-dir /path/to/contracts\n');
  process.exit(2);
}
const contracts = path.resolve(process.argv[arg + 1]);
const sdk = path.resolve(__dirname, '..');
const names = ['cubic_pool', 'protocol_admin', 'single_token_liquidity', 'coffer_rewards'];
// A fresh build lands in target/idl; the committed IDLs (coffer_rewards since v6.1) are in idl/.
const locate = (name) => ['target/idl', 'idl'].map(dir => path.join(contracts, dir, `${name}.json`)).find(file => fs.existsSync(file));
const result = [];
for (const name of names) {
  const actual = JSON.parse(fs.readFileSync(path.join(sdk, 'src/idl', `${name}.json`), 'utf8'));
  const source = locate(name);
  if (!source) {
    result.push({ program: name, matches: false, error: 'not found in target/idl or idl' });
    process.exitCode = 1;
    continue;
  }
  const expected = JSON.parse(fs.readFileSync(source, 'utf8'));
  const matches = isDeepStrictEqual(actual, expected);
  result.push({ program: name, source: path.relative(contracts, source), matches, instructions: actual.instructions.length, events: actual.events.length, accounts: actual.accounts.map(a => a.name) });
  if (!matches) process.exitCode = 1;
}
process.stdout.write(JSON.stringify({ contracts, programs: result }, null, 2) + '\n');
