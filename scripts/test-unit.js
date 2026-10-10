import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const files = readdirSync(new URL('../test/', import.meta.url))
  .filter((name) => name.endsWith('.test.js')).sort()
  .map((name) => new URL(`../test/${name}`, import.meta.url));
import { fileURLToPath } from 'node:url';
try { execFileSync(process.execPath, ['--experimental-test-module-mocks', '--test', ...files.map(fileURLToPath)], { stdio: 'inherit' }); }
catch (error) { process.exit(error.status || 1); }
