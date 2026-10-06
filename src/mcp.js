// stdio MCP server. Any MCP client (Claude Code, Codex, Cursor, Hermes, ...)
// gets the full Marlin tool set. The browser is shared: start Marlin.app
// yourself to watch, or let this start it on first use.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ensureDaemon, runTool } from './client.js';
import { buildTools } from './tools.js';

// Schemas are static, so listing tools never launches the browser. Clients
// list tools at startup; Marlin only opens when a tool is actually used.
const TOOLS = Object.values(buildTools({ config: {} })).map((t) => ({ name: t.name, description: t.description, inputSchema: t.jsonSchema }));

export async function startMcp({ headless } = {}) {
  const server = new Server({ name: 'marlin', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ ...t, inputSchema: { type: 'object', ...t.inputSchema } })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      await ensureDaemon({ headless });
      const out = await runTool(req.params.name, req.params.arguments || {});
      const content = [{ type: 'text', text: out.text }];
      if (out.image) content.push({ type: 'image', data: out.image.data, mimeType: out.image.mimeType });
      return { content };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
}
