import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = readFileSync(`${root}contracts/MetricQuoteBatch.sol`, 'utf8');
const input = JSON.stringify({ language: 'Solidity', sources: { 'MetricQuoteBatch.sol': { content: source } }, settings: {
  optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['evm.bytecode.object'] } },
} });
const compiled = spawnSync('npm', ['exec', '--yes', '--package=solc@0.8.28', '--', 'solcjs', '--standard-json'], { input, encoding: 'utf8' });
if (compiled.status !== 0) throw new Error(compiled.stderr);
const result = JSON.parse(compiled.stdout.slice(compiled.stdout.indexOf('{')));
if (result.errors?.some((error) => error.severity === 'error')) throw new Error(JSON.stringify(result.errors));
const bytecode = result.contracts['MetricQuoteBatch.sol'].MetricQuoteBatch.evm.bytecode.object;
const text = '// Constructor bytecode from server/contracts/MetricQuoteBatch.sol.\n// solc 0.8.28, optimizer 200 runs, EVM paris; see scripts/compile-metric-helper.mjs.\n'
  + `export const METRIC_QUOTE_BYTECODE = "0x${bytecode}" as const;\n`;
const path = `${root}src/venues/metric-quote-bytecode.ts`;
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== text) throw new Error('Metric helper bytecode does not match source');
} else writeFileSync(path, text);
