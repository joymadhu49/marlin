// The built-in agent behind the sidebar. Any OpenRouter model with tool
// calling can drive the browser through the same tools MCP clients get.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const OR = 'https://openrouter.ai/api/v1';

export function openRouterKey(config) {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  if (config.openrouterKey) return config.openrouterKey;
  // Shared env files (Hermes, home): read only this one variable.
  for (const f of [join(homedir(), '.hermes', '.env'), join(homedir(), '.env')]) {
    try {
      const m = readFileSync(f, 'utf8').match(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*["']?([^"'\s#]+)/m);
      if (m) return m[1];
    } catch {}
  }
  return null;
}

let modelCache = { at: 0, list: [] };
export async function listModels({ signal } = {}) {
  if (Date.now() - modelCache.at < 10 * 60_000 && modelCache.list.length) return modelCache.list;
  const res = await fetch(`${OR}/models`, { signal });
  const { data } = await res.json();
  const list = data
    .filter((m) => (m.supported_parameters || []).includes('tools') && !m.id.endsWith(':batch'))
    .map((m) => ({ id: m.id, name: m.name, vision: (m.architecture?.input_modalities || []).includes('image') }));
  modelCache = { at: Date.now(), list };
  return list;
}

const SYSTEM = `You are the agent built into Marlin, a Chromium browser made for AI agents.
You control the real browser with tools. Extensions are first class: you can install them from the Chrome Web Store, open their popups and full pages, click inside them, and handle wallet approval windows.

How to work:
- Call snapshot before clicking or typing. Refs like e12 come from the latest snapshot and go stale after the page changes.
- Prefer refs over coordinates. Use screenshot when layout or visuals matter.
- Wallets: use extensions to see what is installed, open_extension to open one, unlock_extension with a stored secret to unlock. Never ask the user to paste a password or seed phrase into chat; secrets are stored in Marlin and typed by fill_secret or unlock_extension.
- When a dapp triggers a wallet request, call wait_for_tab with the wallet name, then snapshot it.
- Confirm or sign buttons in wallets may require the human to approve in the sidebar. If declined, stop and report.
- Pay attention to "Browser events" at the end of tool results: new tabs, wallet windows and dialogs appear there.
- Be concise. When the task is done, reply with a short summary of what you did and what you saw.`;

export class Agent {
  constructor({ tools, config, emit }) {
    this.tools = tools;
    this.config = config;
    this.emit = emit;
    this.abort = null;
    this.history = [];
  }

  get busy() { return !!this.abort; }

  stop() { this.abort?.abort(); }

  reset() { this.history = []; }

  async run(task, model) {
    if (this.busy) throw new Error('Agent is already running');
    const key = openRouterKey(this.config);
    if (!key) throw new Error('No OpenRouter key. Set OPENROUTER_API_KEY or add it in sidebar settings.');
    model ||= this.config.model;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const toolDefs = Object.values(this.tools).map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.jsonSchema },
    }));
    const messages = [{ role: 'system', content: SYSTEM }, ...this.history, { role: 'user', content: task }];
    try {
      this.emit({ type: 'run_start', model });
      const models = await listModels({ signal }).catch((error) => {
        if (signal.aborted) throw error;
        return [];
      });
      signal.throwIfAborted();
      const vision = models.find((m) => m.id === model)?.vision ?? true;
      for (let step = 0; step < this.config.maxSteps; step++) {
        const res = await fetch(`${OR}/chat/completions`, {
          method: 'POST',
          signal,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Marlin Browser', 'HTTP-Referer': 'https://github.com/marlin-browser' },
          body: JSON.stringify({ model, messages: compact(messages), tools: toolDefs, max_tokens: 4096 }),
        });
        const body = await res.json();
        if (!res.ok || body.error) {
          const raw = body.error?.metadata?.raw;
          throw new Error(`${body.error?.message || `OpenRouter HTTP ${res.status}`}${raw ? `: ${String(raw).slice(0, 300)}` : ''}`);
        }
        const msg = body.choices?.[0]?.message;
        if (!msg) throw new Error('Empty response from model');
        messages.push({ role: 'assistant', content: msg.content || '', ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
        if (msg.content) this.emit({ type: 'assistant', text: msg.content });
        if (!msg.tool_calls?.length) break;

        const images = [];
        for (const call of msg.tool_calls) {
          if (signal.aborted) throw new Error('Stopped');
          const name = call.function.name;
          let args = {};
          try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
          this.emit({ type: 'tool_start', id: call.id, name, args });
          let out;
          try {
            const tool = this.tools[name];
            if (!tool) throw new Error(`Unknown tool ${name}`);
            out = await tool.run(args);
            this.emit({ type: 'tool_end', id: call.id, name, ok: true, text: out.text.slice(0, 600), image: out.image ? out.image.data : null });
          } catch (e) {
            out = { text: `Error: ${e.message}` };
            this.emit({ type: 'tool_end', id: call.id, name, ok: false, text: out.text });
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content: out.text });
          if (out.image && vision) images.push(out.image);
        }
        if (images.length) {
          messages.push({ role: 'user', content: [
            { type: 'text', text: 'Screenshot(s) from the tool call above:' },
            ...images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mimeType};base64,${im.data}` } })),
          ] });
        }
      }
      // Keep a light text only history so follow ups have context.
      this.history.push({ role: 'user', content: task });
      const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.content);
      if (last) this.history.push({ role: 'assistant', content: last.content });
      this.history = this.history.slice(-12);
      this.emit({ type: 'run_end' });
    } catch (e) {
      this.emit({ type: 'run_end', error: signal.aborted ? 'Stopped' : e.message });
    } finally {
      this.abort = null;
    }
  }
}

/** Keep only the two most recent screenshots so context does not balloon. */
function compact(messages) {
  let seen = 0;
  const out = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url')) {
      if (seen >= 2) { out.unshift({ role: 'user', content: '(older screenshot removed)' }); continue; }
      seen++;
    }
    out.unshift(m);
  }
  return out;
}
