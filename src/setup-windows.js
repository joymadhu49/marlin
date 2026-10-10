import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { ROOT, paths } from './paths.js';

export function windowsMcpConfig(executable = process.execPath, root = ROOT) {
  return { mcpServers: { marlin: { command: executable, args: [join(root, 'src', 'cli.js'), 'mcp'] } } };
}

export function setupWindows() {
  const config = windowsMcpConfig();
  const file = join(paths.home, 'mcp-config.json');
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  console.log(`MCP configuration saved to ${file}`);
  console.log('Add the marlin entry to your MCP client configuration. Restart the client afterward.');
  console.log(JSON.stringify(config, null, 2));
  console.log(`Browser skill: ${join(ROOT, 'skills', 'marlin-browser', 'SKILL.md')}`);
}
