// Spawns `marlin mcp` like Claude Code would and calls a few tools.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: process.execPath, args: ['src/cli.js', 'mcp'], env: { ...process.env } });
const client = new Client({ name: 'smoke', version: '1' });
await client.connect(transport);
const { tools } = await client.listTools();
console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);
const nav = await client.callTool({ name: 'navigate', arguments: { url: 'https://example.com' } });
console.log(nav.content[0].text.split('\n').slice(0, 3).join(' | '));
const shot = await client.callTool({ name: 'screenshot', arguments: {} });
console.log('screenshot content types:', shot.content.map((c) => c.type).join(','), shot.content[1]?.data?.length);
const ext = await client.callTool({ name: 'extensions', arguments: {} });
console.log(ext.content[0].text);
await client.close();
