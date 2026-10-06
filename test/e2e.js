// End to end test against a throwaway profile. Run: node test/e2e.js [--headed]
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'marlin-e2e-'));
process.env.MARLIN_HOME = home;
const headed = process.argv.includes('--headed');
writeFileSync(join(home, 'config.json'), JSON.stringify({ port: 47715, cdpPort: 47716, headless: !headed, signPolicy: 'ask' }));

const { loadConfig } = await import('../src/paths.js');
const { MarlinBrowser } = await import('../src/browser.js');
const { buildTools } = await import('../src/tools.js');
const vault = await import('../src/vault.js');

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'lockbox');
let approvals = [];
let approveAnswer = false;
const mb = await new MarlinBrowser(loadConfig()).start();
const t = buildTools(mb, { approve: async (req) => { approvals.push(req.action); return approveAnswer; } });

let pass = 0, fail = 0;
async function step(name, fn) {
  const t0 = Date.now();
  try { const note = await fn(); pass++; console.log(`ok   ${name} (${Date.now() - t0}ms)${note ? `  ${note}` : ''}`); }
  catch (e) { fail++; console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`); }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const refFor = (text, re) => (text.split('\n').find((l) => re.test(l)) || '').match(/\[(e\d+)\]/)?.[1];

await step('navigate + snapshot', async () => {
  const r = await t.navigate.run({ url: 'https://example.com' });
  must(/Example Domain/.test(r.text) && /\[e1\]/.test(r.text), r.text.slice(0, 300));
});
await step('screenshot web page', async () => {
  const r = await t.screenshot.run({ annotate: true });
  must(r.image?.data?.length > 1000, 'no image');
  return r.file;
});
await step('install local extension', async () => {
  const r = await t.install_extension.run({ source: fixture });
  must(/Installed Lockbox/.test(r.text), r.text);
});
await step('install MetaMask from Chrome Web Store', async () => {
  const r = await t.install_extension.run({ source: 'https://chromewebstore.google.com/detail/metamask/nkbihfbeogaeaoehlefnkodbefgpgknn' });
  must(/id=nkbihfbeogaeaoehlefnkodbefgpgknn/.test(r.text), r.text);
  return r.text.split('\n')[0];
});
await step('extensions list', async () => {
  const r = await t.extensions.run({});
  must(/MetaMask/.test(r.text) && /Lockbox/.test(r.text), r.text);
});
await step('open MetaMask and read its UI', async () => {
  const r = await t.open_extension.run({ extension: 'MetaMask', mode: 'tab' });
  must(/extension: MetaMask/.test(r.text), r.text.slice(0, 400));
  must(/\[e\d+\]/.test(r.text), 'no interactive elements found in MetaMask');
  console.log(r.text.split('\n').slice(0, 16).map((l) => `       ${l}`).join('\n'));
  const s = await t.screenshot.run({});
  must(s.image, 'no screenshot');
  return s.file;
});
await step('open real toolbar popup', async () => {
  const r = await t.open_extension.run({ extension: 'Lockbox', mode: 'popup' });
  must(/Opened Lockbox/.test(r.text) && /password/i.test(r.text), r.text.slice(0, 400));
  return r.text.split('\n')[0];
});
await step('screenshot extension popup', async () => {
  const r = await t.screenshot.run({});
  must(r.image, 'no image');
  return r.file;
});
await vault.setSecret('marlin-e2e-test', 'hunter2-test');
await step('unlock_extension with stored secret (value never in output)', async () => {
  const r = await t.unlock_extension.run({ extension: 'Lockbox', secret: 'marlin-e2e-test', mode: 'tab' });
  must(/Lockbox Test Wallet unlocked/.test(r.text), r.text.slice(0, 400));
  must(!r.text.includes('hunter2-test'), 'secret leaked');
  must(/Balance 1\.234 ETH/.test(r.text), 'balance not visible');
});
await step('evaluate is blocked on wallet pages under ask policy', async () => {
  let blocked = false;
  try { await t.evaluate.run({ expression: 'document.title' }); } catch (e) { blocked = /disabled on extension pages/.test(e.message); }
  must(blocked, 'evaluate was not blocked');
});
await step('sign guard: declined Confirm is not clicked', async () => {
  const s = await t.snapshot.run({});
  const ref = refFor(s.text, /"Confirm"/);
  must(ref, 'no Confirm ref');
  approveAnswer = false;
  let threw = false;
  try { await t.click.run({ ref }); } catch { threw = true; }
  const after = await t.read_text.run({});
  must(threw && !/Signed/.test(after.text) && approvals.includes('Confirm'), 'guard did not stop the click');
});
await step('sign guard: approved Confirm goes through', async () => {
  const s = await t.snapshot.run({});
  approveAnswer = true;
  const r = await t.click.run({ ref: refFor(s.text, /"Confirm"/) });
  must(/Signed/.test(r.text), r.text.slice(0, 300));
});
await step('tabs lists extension pages', async () => {
  const r = await t.tabs.run({});
  must(/extension page: MetaMask/.test(r.text), r.text);
});
await step('redaction backstop', async () => {
  await t.switch_tab.run({ tab: (await mb.listTabs()).find((x) => x.url.startsWith('https://example.com')).id });
  const r = await t.evaluate.run({ expression: '"pw is hunter2-test"' });
  must(r.text.includes('[secret:marlin-e2e-test]') && !r.text.includes('hunter2-test'), r.text);
});
await step('external CDP port is open for Playwright and friends', async () => {
  const v = await (await fetch('http://127.0.0.1:47716/json/version')).json();
  return v.Browser;
});

await vault.removeSecret('marlin-e2e-test');
await mb.stop();
rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
