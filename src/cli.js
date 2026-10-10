#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { paths, loadConfig, saveConfig } from './paths.js';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (f) => rest.includes(f);
const args = rest.filter((a) => !a.startsWith('--'));

const HELP = `marlin, a Chromium browser built for AI agents

  marlin start [--headless]       launch the browser + agent daemon (foreground)
  marlin open [url]               start in the background if needed, open a tab
  marlin stop                     close the browser
  marlin status
  marlin mcp [--headless]         MCP server on stdio (Claude Code, Codex, Cursor, Hermes)
  marlin tools                    list tools
  marlin tool <name> [json]       run one tool, e.g. marlin tool navigate '{"url":"example.com"}'
  marlin install <id|url|path>    install an extension (Chrome Web Store id/URL or local folder/.crx)
  marlin extensions
  marlin secret set <name>        store a secret (wallet password) in the OS-protected store
  marlin secret list | rm <name>
  marlin config [key] [value]     e.g. marlin config signPolicy allow
  marlin setup                    connect Claude Code, Codex and Hermes (MCP + skill)
  marlin update [--install]       check for (or install) a new Marlin release
  marlin version
  marlin fetch-chromium           download the latest Chromium snapshot

Data: ${paths.home}`;

async function main() {
  switch (cmd) {
    case 'start': {
      const { daemonUp } = await import('./client.js');
      if (await daemonUp()) { console.log('Marlin is already running'); return; }
      const { startDaemon } = await import('./server.js');
      await startDaemon({ headless: flag('--headless') ? true : undefined });
      return;
    }
    case 'open': {
      const { ensureDaemon, runTool } = await import('./client.js');
      await ensureDaemon();
      await runTool('new_tab', args[0] ? { url: args[0] } : {});
      return;
    }
    case 'mcp': {
      const { startMcp } = await import('./mcp.js');
      await startMcp({ headless: flag('--headless') });
      return;
    }
    case 'stop': {
      const { daemonUp, shutdownDaemon } = await import('./client.js');
      if (await daemonUp()) await shutdownDaemon();
      console.log('Stopped');
      return;
    }
    case 'status': {
      const { daemonUp } = await import('./client.js');
      const c = loadConfig();
      console.log(await daemonUp() ? `Running. API http://127.0.0.1:${c.port}  CDP http://127.0.0.1:${c.cdpPort}` : 'Not running');
      console.log(`signPolicy=${c.signPolicy} model=${c.model}`);
      return;
    }
    case 'tools': {
      const { ensureDaemon, listTools } = await import('./client.js');
      await ensureDaemon();
      for (const t of await listTools()) console.log(`${t.name.padEnd(20)} ${t.description}`);
      return;
    }
    case 'tool': {
      const { ensureDaemon, runTool } = await import('./client.js');
      await ensureDaemon();
      const out = await runTool(args[0], args[1] ? JSON.parse(args[1]) : {});
      console.log(out.text);
      if (out.file) console.log(`(image: ${out.file})`);
      return;
    }
    case 'install':
    case 'extensions': {
      const { ensureDaemon, runTool } = await import('./client.js');
      await ensureDaemon();
      const out = cmd === 'install' ? await runTool('install_extension', { source: args[0] }) : await runTool('extensions');
      console.log(out.text);
      return;
    }
    case 'secret': {
      const vault = await import('./vault.js');
      const [sub, name] = args;
      if (sub === 'list') console.log(vault.listSecrets().join('\n') || '(none)');
      else if (sub === 'rm') { await vault.removeSecret(name); console.log(`Removed ${name}`); }
      else if (sub === 'set' && name) {
        const value = process.env.MARLIN_SECRET_VALUE || await askHidden(`Value for "${name}": `);
        await vault.setSecret(name, value);
        console.log(`Saved "${name}" to the protected secret store. Restart Marlin or it is picked up on first use.`);
      } else console.log('Usage: marlin secret set <name> | list | rm <name>');
      return;
    }
    case 'config': {
      const [k, v] = args;
      if (k && v !== undefined) {
        const val = v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v;
        saveConfig({ [k]: val });
      }
      const c = loadConfig();
      delete c.openrouterKey;
      console.log(k && v === undefined ? c[k] : JSON.stringify(c, null, 2));
      return;
    }
    case 'setup': {
      if (process.platform === 'win32') {
        const { setupWindows } = await import('./setup-windows.js');
        setupWindows();
        return;
      }
      // Wire Marlin into Claude Code, Codex and Hermes (MCP + skill).
      const { spawnSync } = await import('node:child_process');
      const { join } = await import('node:path');
      const { ROOT } = await import('./paths.js');
      process.exit(spawnSync('bash', [join(ROOT, 'install.sh'), '--agents'], { stdio: 'inherit' }).status ?? 1);
    }
    case 'update': {
      // Same flow as the About page: check, or install with --install.
      const { daemonUp } = await import('./client.js');
      const { runUpdater, canUpdate } = await import('./updates.js');
      if (!canUpdate()) {
        if (process.platform === 'win32') {
          console.log('In-browser Windows updates require the packaged x64 release and its bundled runtime. Start it with marlin.cmd.');
          console.log('Download the Windows release from https://github.com/joymadhu49/marlin/releases. Development checkouts update with git pull.');
          return;
        }
        console.log('This copy is a dev checkout. Update with: git pull && bash install.sh');
        console.log('Or install the release: curl -fsSL https://raw.githubusercontent.com/joymadhu49/marlin/main/scripts/get-marlin.sh | bash');
        return;
      }
      const install = flag('--install');
      const show = (e) => {
        if (e.event === 'available') console.log(`Marlin ${e.version} is available.${install ? '' : ' Install with: marlin update --install'}`);
        else if (e.event === 'none') console.log('Marlin is up to date.');
        else if (e.event === 'progress') process.stdout.write(`\rDownloading ${e.percent}%`);
        else if (e.event === 'restarting') console.log('\nInstalling. Marlin will close and reopen.');
        else if (e.event === 'error') console.log(`Update error: ${e.message}`);
      };
      if (install && await daemonUp()) {
        // Let the running daemon drive it so the browser UI shows progress too.
        const { readJson, paths } = await import('./paths.js');
        const { port, token } = readJson(paths.state, {});
        await fetch(`http://127.0.0.1:${port}/update`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{"install":true}' });
        console.log('Installing in Marlin. It will close and reopen when ready.');
        return;
      }
      const result = await runUpdater(install ? 'install' : 'check', show);
      if (result?.event === 'error') process.exitCode = 1;
      return;
    }
    case 'version': {
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { ROOT } = await import('./paths.js');
      console.log(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
      return;
    }
    case 'fetch-chromium': {
      const { fetchChromium } = await import('./fetch-chromium.js');
      await fetchChromium();
      return;
    }
    default:
      console.log(HELP);
  }
}

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) rl.output.write(prompt); };
    rl.question(prompt, (v) => { rl.close(); process.stdout.write('\n'); resolve(v); });
  });
}

main().catch((e) => { console.error(e.message); process.exit(1); });
