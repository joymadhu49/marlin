import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const home = mkdtempSync(join(tmpdir(), 'marlin-setup-test-'));
process.env.MARLIN_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));
const { windowsMcpConfig } = await import('../src/setup-windows.js');
test('MCP configuration keeps executable and arguments separate for paths with spaces', () => {
  const config = windowsMcpConfig('C:\\Program Files\\Marlin\\node\\node.exe', 'C:\\Program Files\\Marlin');
  const restored = JSON.parse(JSON.stringify(config)).mcpServers.marlin;
  assert.equal(restored.command, 'C:\\Program Files\\Marlin\\node\\node.exe');
  assert.deepEqual(restored.args, [join('C:\\Program Files\\Marlin', 'src', 'cli.js'), 'mcp']);
});
