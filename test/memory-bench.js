// Memory benchmark on the real profile: fresh start, a fixed workload, then RSS.
// Usage: node test/memory-bench.js [label]
import { execFileSync } from 'node:child_process';
import { ensureDaemon, runTool, shutdownDaemon, daemonUp } from '../src/client.js';
import { paths } from '../src/paths.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const label = process.argv[2] || 'run';

// macOS physical footprint (what Activity Monitor shows), summed without double counting shared pages.
function footprint() {
  const pids = execFileSync('pgrep', ['-f', paths.profile]).toString().trim().split('\n').filter(Boolean);
  const out = execFileSync('footprint', pids.flatMap((p) => ['-p', p]), { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  return Number((out.match(/Summary Footprint:\s*([\d.]+)\s*MB/) || [])[1] || 0);
}

function rss() {
  const out = execFileSync('ps', ['-axo', 'rss=,command=']).toString().split('\n');
  const mine = out.filter((l) => l.includes(paths.profile) || /Marlin\.app\/Contents\/(MacOS|Frameworks|Resources\/node)/.test(l) || /marlin\/chromium\//.test(l));
  return { procs: mine.length, mb: Math.round(mine.reduce((s, l) => s + Number(l.trim().split(/\s+/)[0] || 0), 0) / 1024) };
}

if (await daemonUp()) { await shutdownDaemon().catch(() => {}); await sleep(3000); }
await ensureDaemon();
await sleep(4000);
const t = async (name, args) => (await runTool(name, args)).text;
await t('unlock_extension', { extension: 'MetaMask', secret: 'metamask' });
await t('unlock_extension', { extension: 'Rabby', secret: 'rabby' });
await t('navigate', { url: 'https://example.com' });
await t('new_tab', { url: 'https://en.wikipedia.org/wiki/Ethereum' });
await t('new_tab', { url: 'https://github.com/trending' });
for (let i = 0; i < 2; i++) {
  await t('open_extension', { extension: 'MetaMask', mode: 'tab' });
  await t('open_extension', { extension: 'Rabby', mode: 'tab' });
}
await sleep(20_000);
const tabs = (await t('tabs', {})).split('\n').filter((l) => /^[ *] [0-9A-F]{8}/.test(l)).length;
const m = rss();
console.log(`${label}: ${tabs} tabs, ${m.procs} processes, footprint ${footprint()} MB (RSS ${m.mb} MB)`);
