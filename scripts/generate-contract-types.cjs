const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const programs = { cubicPool: 'cubic_pool', protocolAdmin: 'protocol_admin', singleTokenLiquidity: 'single_token_liquidity' };
const idls = Object.fromEntries(Object.entries(programs).map(([key, name]) => [key, JSON.parse(fs.readFileSync(path.join(root, 'src/idl', name + '.json'), 'utf8'))]));
const prop = (name) => JSON.stringify(name);
function ts(type, program) {
  if (typeof type === 'string') {
    if (type === 'pubkey') return 'PublicKey';
    if (type === 'bool') return 'boolean';
    if (type === 'bytes') return 'Buffer';
    if (type === 'string') return 'string';
    if (/^[ui](64|128|256)$/.test(type)) return 'BN';
    if (/^[uif]\d+$/.test(type)) return 'number';
    throw new Error('Unsupported IDL primitive ' + type);
  }
  if (type.defined) return `ContractTypes[${prop(program)}][${prop(type.defined.name)}]`;
  if (type.vec) return `Array<${ts(type.vec, program)}>`;
  if (type.option) return `${ts(type.option, program)} | null`;
  if (type.array) return `Array<${ts(type.array[0], program)}>`;
  throw new Error('Unsupported IDL type ' + JSON.stringify(type));
}
const fields = (fields, program) => fields.length ? '{ ' + fields.map(f => `${prop(f.name)}: ${ts(f.type, program)}`).join('; ') + ' }' : 'Record<string, never>';
const lines = ['// Generated from src/idl/*.json by scripts/generate-contract-types.cjs. Do not edit.', 'import BN from "bn.js";', 'import { PublicKey } from "@solana/web3.js";', '', 'export interface ContractTypes {'];
for (const [program, idl] of Object.entries(idls)) {
  lines.push(`  ${prop(program)}: {`);
  for (const type of idl.types || []) {
    if (type.type.kind !== 'struct') throw new Error('Unsupported IDL kind ' + type.type.kind);
    lines.push(`    ${prop(type.name)}: ${fields(type.type.fields, program)};`);
  }
  lines.push('  };');
}
lines.push('}', '', 'export interface ContractInstructionMap {');
for (const [program, idl] of Object.entries(idls)) {
  lines.push(`  ${prop(program)}: {`);
  for (const ix of idl.instructions) {
    if (ix.accounts.some(a => a.accounts)) throw new Error('Nested accounts require generator support');
    lines.push(`    ${prop(ix.name)}: { args: ${fields(ix.args, program)}; accounts: { ${ix.accounts.map(a => `${prop(a.name)}: PublicKey`).join('; ')} } };`);
  }
  lines.push('  };');
}
lines.push('}', '', 'export interface ContractAccountMap {');
for (const [program, idl] of Object.entries(idls)) {
  lines.push(`  ${prop(program)}: {`);
  for (const a of idl.accounts || []) lines.push(`    ${prop(a.name)}: ContractTypes[${prop(program)}][${prop(a.name)}];`);
  lines.push('  };');
}
lines.push('}', '', 'export interface ContractEventMap {');
for (const [program, idl] of Object.entries(idls)) {
  lines.push(`  ${prop(program)}: {`);
  for (const e of idl.events || []) lines.push(`    ${prop(e.name)}: ContractTypes[${prop(program)}][${prop(e.name)}];`);
  lines.push('  };');
}
lines.push('}', '', 'export type ContractProgram = keyof ContractInstructionMap;', '');
const output = lines.join('\n');
const destination = path.join(root, 'src/types/contracts.ts');
if (process.argv.includes('--check')) {
  if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== output) {
    process.stderr.write('Contract types are stale. Run node scripts/generate-contract-types.cjs\n');
    process.exitCode = 1;
  }
} else fs.writeFileSync(destination, output);
