// One tool registry shared by every front door: MCP, HTTP, the CLI and the
// built-in sidebar agent. Each tool returns { text, image? }.
import { z } from 'zod';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from './paths.js';
import { snapshotInPage, locateRef, focusRef, selectRef, annotateRefs } from './snapshot.js';
import { listSecrets, revealSecret, redact } from './vault.js';
import { settle, sleep } from './browser.js';

// Helper scripts run in an isolated world: same DOM, but immune to page side
// lockdowns such as MetaMask's LavaMoat scuttling of window globals.
const iso = (page) => page.mainFrame().isolatedRealm();

const tab = z.string().optional().describe('Tab id from `tabs`. Defaults to the active tab.');
const ref = z.string().describe('Element ref from the latest snapshot, e.g. "e12".');

// Wallet buttons that move funds or grant permissions.
const SIGN_WORDS = /^(confirm|sign|approve|send|swap|transfer|pay|bridge|stake|deposit|withdraw|accept|allow|submit|continue to sign)\b/i;

export function buildTools(mb, hooks = {}) {
  const t = {};
  const def = (name, description, shape, run) => { t[name] = { name, description, schema: z.object(shape), run }; };

  // Refs belong to the tab that produced them, even if another tab became active since.
  let refTab = null;
  const pageForRef = (id, r) => mb.pageFor(id || (r && refTab && mb.browser.targets().some((x) => x._targetId === refTab) ? refTab : undefined));

  async function snapshotText(page, opts = {}) {
    refTab = page.target()._targetId;
    const s = await withTimeout(iso(page).evaluate(snapshotInPage, { maxItems: opts.maxItems ?? 250, textChars: opts.text === false ? 0 : 1500 }), 15_000, 'snapshot');
    const tabId = page.target()._targetId.slice(0, 8);
    const ext = mb.extensionForUrl(s.url);
    const dlg = mb.dialogs.get(page.target()._targetId);
    const lines = [
      `Tab ${tabId}${ext ? ` (extension: ${ext.name})` : ''}`,
      `Title: ${s.title}`,
      `URL: ${s.url}`,
      `Viewport ${s.viewport}, scroll ${s.scroll}${s.focused ? `, focused ${s.focused}` : ''}`,
    ];
    if (dlg) lines.push(`OPEN DIALOG: ${dlg.type} "${dlg.message}". Call handle_dialog first.`);
    lines.push('', `Interactive elements (${Math.min(s.total, s.elements.length)} of ${s.total}):`, ...s.elements);
    if (s.text) lines.push('', 'Visible text:', s.text);
    return lines.join('\n');
  }

  async function act(page, fn) {
    if (mb.dialogs.has(page.target()._targetId)) throw new Error('A JavaScript dialog is open on this tab. Call handle_dialog first.');
    await fn();
    await settle(page, 2500);
    return page;
  }

  /**
   * Reads the wallet's request screen and decides whether it is low risk:
   * sign-in (SIWE), plain text messages and network switches. Anything with
   * a security warning, typed data, token approvals or a transaction is not.
   */
  async function classify(page) {
    const text = await iso(page).evaluate(() => document.body?.innerText || '').catch(() => '');
    const url = page.url();
    if (/high[- ]risk|malicious|deceptive|suspicious|flagged|review alert|scam|phishing/i.test(text)) return { safe: false, kind: 'request flagged by the wallet security check' };
    // Typed data and approvals first, so a typed payload that mentions "sign in" is never waved through.
    if (/primary type|typed data|spending cap|spender|permit|allowance|approval|approve|set approval/i.test(text)) return { safe: false, kind: 'typed data or token approval' };
    // MetaMask: "Sign-in request". Rabby: "Verify Address" + "wants you to sign in with your Ethereum account".
    if (/sign-in request|sign in request|sign in with ethereum|verify address|wants you to sign in with your ethereum account/i.test(text)) return { safe: true, kind: 'sign in message (SIWE)' };
    // MetaMask: "Signature request". Rabby: "Sign Text".
    if (/signature request|sign text|text signature|sign message/i.test(text) || /signature-request|personal_sign/i.test(url)) return { safe: true, kind: 'plain text message signature' };
    if (/(add|switch)(ing)? (a |the )?network|switch to|allow this site to (add|switch)/i.test(text) && !/network fee|gas fee|estimated fee/i.test(text)) return { safe: true, kind: 'network add or switch' };
    return { safe: false, kind: 'transaction' };
  }

  async function isRequestScreen(page) {
    const url = page.url();
    if (/notification\.html|confirm-transaction|signature-request|#\/approval|#\/connect|#\/sign|request/i.test(url)) return true;
    const text = await iso(page).evaluate(() => document.body?.innerText || '').catch(() => '');
    return /request from|signature request|sign-in request|sign text|sign typed|sign transaction|spending cap|network fee|gas fee|estimated changes|interacting with|dapp|send \d|transaction/i.test(text);
  }

  async function guard(page, label) {
    const policy = mb.config.signPolicy;
    if (policy === 'allow') return;
    const url = page.url();
    if (!url.startsWith('chrome-extension://') || url.startsWith(`chrome-extension://${mb.builtinId}/`)) return;
    if (!SIGN_WORDS.test((label || '').trim())) return;
    // Only real request screens are gated, not onboarding or settings that also say "Confirm".
    if (!(await isRequestScreen(page))) return;
    if (policy === 'smart') {
      const c = await classify(page);
      if (c.safe) { mb.note(`Signed without asking (signPolicy smart): ${c.kind}`); return; }
      label = `${label} (${c.kind})`;
    }
    const ext = mb.extensionForUrl(url);
    const shot = await page.screenshot({ type: 'jpeg', quality: 70, encoding: 'base64' }).catch(() => null);
    const ok = hooks.approve
      ? await hooks.approve({ extension: ext?.name || 'extension', action: label, url, screenshot: shot })
      : false;
    if (!ok) throw new Error(`The human declined (or did not answer) the "${label}" click in ${ext?.name || 'the wallet'}. Do not retry unless asked.`);
  }

  async function clickRef(page, r, opts = {}) {
    const loc = await iso(page).evaluate(locateRef, r);
    if (loc.error) throw new Error(loc.error);
    await guard(page, loc.label);
    await act(page, () => page.mouse.click(loc.x, loc.y, { button: opts.button || 'left', clickCount: opts.double ? 2 : 1 }));
    return loc;
  }

  async function typeInto(page, r, text, { clear = true, submit = false } = {}) {
    const loc = await iso(page).evaluate(locateRef, r);
    if (loc.error) throw new Error(loc.error);
    await page.mouse.click(loc.x, loc.y);
    await iso(page).evaluate(focusRef, r, clear);
    if (clear) await page.keyboard.press('Backspace');
    await page.keyboard.type(text, { delay: 8 });
    if (submit) await act(page, () => page.keyboard.press('Enter'));
    return loc;
  }

  // ----- browsing -----

  def('tabs', 'List open tabs, including extension pages and wallet popup windows. The active tab is marked.', {}, async () => {
    const tabs = await mb.listTabs();
    return { text: tabs.map((x) => `${x.active ? '*' : ' '} ${x.id}  [${x.kind}${x.extension ? `: ${x.extension}` : ''}]  ${x.title || '(untitled)'}  ${x.url}`).join('\n') || 'No tabs' };
  });

  def('new_tab', 'Open a new tab (optionally at a URL) and make it active.', { url: z.string().optional() }, async ({ url }) => {
    const page = await mb.newTab(url);
    return { text: url ? await snapshotText(page) : `Opened tab ${page.target()._targetId.slice(0, 8)}` };
  });

  def('switch_tab', 'Make a tab active and bring it to the front.', { tab: z.string() }, async ({ tab: id }) => {
    const page = await mb.pageFor(id);
    await page.bringToFront().catch(() => {});
    return { text: await snapshotText(page) };
  });

  def('close_tab', 'Close a tab.', { tab }, async ({ tab: id }) => {
    const page = await mb.pageFor(id);
    await page.close();
    return { text: 'Closed' };
  });

  def('navigate', 'Go to a URL (or search terms) in the active tab. Returns a snapshot.', { url: z.string(), tab }, async ({ url, tab: id }) => {
    const page = await mb.pageFor(id);
    await mb.goto(page, url);
    return { text: await snapshotText(page) };
  });

  def('history', 'Go back, forward, or reload.', { action: z.enum(['back', 'forward', 'reload']), tab }, async ({ action, tab: id }) => {
    const page = await mb.pageFor(id);
    const opt = { waitUntil: 'domcontentloaded', timeout: 20_000 };
    if (action === 'back') await page.goBack(opt).catch(() => {});
    else if (action === 'forward') await page.goForward(opt).catch(() => {});
    else await page.reload(opt).catch(() => {});
    await settle(page);
    return { text: await snapshotText(page) };
  });

  // ----- seeing -----

  def('snapshot', 'List interactive elements with refs (e1, e2, ...) plus visible text. Works on web pages AND extension pages/popups. Take one before clicking or typing.', {
    tab, text: z.boolean().optional().describe('Include visible page text (default true)'), maxItems: z.number().int().optional(),
  }, async ({ tab: id, text, maxItems }) => ({ text: await snapshotText(await mb.pageFor(id), { text, maxItems }) }));

  def('screenshot', 'Capture a screenshot of a tab, extension popup or wallet window. annotate=true draws the snapshot refs on the image.', {
    tab, fullPage: z.boolean().optional(), annotate: z.boolean().optional(),
  }, async ({ tab: id, fullPage, annotate }) => {
    const page = await mb.pageFor(id);
    if (!page.url().startsWith('chrome-extension://')) await page.bringToFront().catch(() => {});
    if (annotate) { await iso(page).evaluate(snapshotInPage, { textChars: 0 }); await iso(page).evaluate(annotateRefs, true); }
    const data = await withTimeout(page.screenshot({ type: 'png', fullPage: !!fullPage, encoding: 'base64', captureBeyondViewport: !!fullPage }), 20_000, 'screenshot');
    if (annotate) await iso(page).evaluate(annotateRefs, false).catch(() => {});
    const file = join(paths.shots, `shot-${Date.now()}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    return { text: `Screenshot of ${page.url()} saved to ${file}`, image: { data, mimeType: 'image/png' }, file };
  });

  def('read_text', 'Return the visible text of the page (good for balances, tables, articles).', {
    tab, maxChars: z.number().int().optional(),
  }, async ({ tab: id, maxChars = 8000 }) => {
    const page = await mb.pageFor(id);
    const text = await iso(page).evaluate(() => document.body?.innerText || '');
    return { text: text.replace(/\n{3,}/g, '\n\n').slice(0, maxChars) };
  });

  // ----- acting -----

  def('click', 'Click an element by ref, or at viewport coordinates x,y. Wallet confirm/sign buttons: sign in and plain message signatures go through; transactions, approvals and typed data may wait for human approval.', {
    ref: ref.optional(), x: z.number().optional(), y: z.number().optional(),
    button: z.enum(['left', 'right', 'middle']).optional(), double: z.boolean().optional(), tab,
  }, async ({ ref: r, x, y, button, double, tab: id }) => {
    const page = await pageForRef(id, r);
    if (r) {
      const loc = await clickRef(page, r, { button, double });
      return { text: `Clicked ${r} "${loc.label}"${loc.covered ? ` (note: it was covered by "${loc.coveredBy}")` : ''}\n\n${await snapshotText(page).catch(() => '(page closed after click)')}` };
    }
    if (x == null || y == null) throw new Error('Pass ref, or both x and y');
    const label = await iso(page).evaluate((x, y) => (document.elementFromPoint(x, y)?.innerText || '').trim().slice(0, 80), x, y).catch(() => '');
    await guard(page, label);
    await act(page, () => page.mouse.click(x, y, { button: button || 'left', clickCount: double ? 2 : 1 }));
    return { text: `Clicked at ${x},${y}${label ? ` on "${label}"` : ''}\n\n${await snapshotText(page).catch(() => '(page closed after click)')}` };
  });

  def('type', 'Type text into an input by ref. Clears it first unless clear=false. submit=true presses Enter.', {
    ref, text: z.string(), clear: z.boolean().optional(), submit: z.boolean().optional(), tab,
  }, async ({ ref: r, text, clear = true, submit, tab: id }) => {
    const page = await pageForRef(id, r);
    await typeInto(page, r, text, { clear, submit });
    return { text: `Typed into ${r}\n\n${await snapshotText(page).catch(() => '(page closed)')}` };
  });

  def('press', 'Press a key or chord, e.g. Enter, Escape, Tab, ArrowDown, Meta+A.', { key: z.string(), tab }, async ({ key, tab: id }) => {
    const page = await mb.pageFor(id);
    if (/enter|space|return/i.test(key)) {
      const label = await iso(page).evaluate(() => { const a = document.activeElement; return (a?.innerText || a?.value || a?.getAttribute?.('aria-label') || '').trim().slice(0, 80); }).catch(() => '');
      if (label && SIGN_WORDS.test(label)) await guard(page, label);
    }
    const parts = key.split('+');
    const main = parts.pop();
    await act(page, async () => {
      for (const m of parts) await page.keyboard.down(normKey(m));
      await page.keyboard.press(normKey(main));
      for (const m of parts.reverse()) await page.keyboard.up(normKey(m));
    });
    return { text: `Pressed ${key}\n\n${await snapshotText(page).catch(() => '(page closed)')}` };
  });

  def('scroll', 'Scroll the page (or scroll an element ref into view).', {
    direction: z.enum(['up', 'down', 'left', 'right']).optional(), amount: z.number().optional().describe('Pixels, default 600'), ref: ref.optional(), tab,
  }, async ({ direction = 'down', amount = 600, ref: r, tab: id }) => {
    const page = await pageForRef(id, r);
    if (r) { const loc = await iso(page).evaluate(locateRef, r); if (loc.error) throw new Error(loc.error); }
    else {
      const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
      const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
      const vp = await iso(page).evaluate(() => [innerWidth / 2, innerHeight / 2]);
      await page.mouse.move(vp[0], vp[1]);
      await page.mouse.wheel({ deltaX: dx, deltaY: dy });
      await sleep(400);
    }
    return { text: await snapshotText(page) };
  });

  def('hover', 'Hover the mouse over an element.', { ref, tab }, async ({ ref: r, tab: id }) => {
    const page = await pageForRef(id, r);
    const loc = await iso(page).evaluate(locateRef, r);
    if (loc.error) throw new Error(loc.error);
    await page.mouse.move(loc.x, loc.y);
    await sleep(500);
    return { text: await snapshotText(page) };
  });

  def('select_option', 'Choose an option in a <select> by value or visible text.', { ref, value: z.string(), tab }, async ({ ref: r, value, tab: id }) => {
    const page = await pageForRef(id, r);
    const res = await iso(page).evaluate(selectRef, r, value);
    if (res.error) throw new Error(res.error);
    return { text: `Selected "${res.selected}"\n\n${await snapshotText(page)}` };
  });

  def('handle_dialog', 'Accept or dismiss an open alert/confirm/prompt dialog.', {
    accept: z.boolean(), text: z.string().optional().describe('Reply for prompt() dialogs'), tab,
  }, async ({ accept, text, tab: id }) => {
    const page = await mb.pageFor(id);
    const d = mb.dialogs.get(page.target()._targetId);
    if (!d) return { text: 'No open dialog on this tab' };
    mb.dialogs.delete(page.target()._targetId);
    if (accept) await d.dialog.accept(text); else await d.dialog.dismiss();
    await settle(page, 1500);
    return { text: `${accept ? 'Accepted' : 'Dismissed'} ${d.type} "${d.message}"` };
  });

  def('wait', 'Wait for text to appear on the page, or just wait some milliseconds.', {
    text: z.string().optional(), ms: z.number().optional(), timeoutMs: z.number().optional(), tab,
  }, async ({ text, ms, timeoutMs = 15_000, tab: id }) => {
    const page = await mb.pageFor(id);
    if (text) {
      const ok = await iso(page).waitForFunction((s) => document.body && document.body.innerText.toLowerCase().includes(s.toLowerCase()), { timeout: timeoutMs, polling: 300 }, text).then(() => true, () => false);
      if (!ok) return { text: `Timed out waiting for "${text}"` };
    } else await sleep(Math.min(ms ?? 1000, 60_000));
    return { text: await snapshotText(page) };
  });

  def('evaluate', 'Run a JavaScript expression in the page and return the JSON result. Works in extension pages too.', {
    expression: z.string(), tab,
  }, async ({ expression, tab: id }) => {
    const page = await mb.pageFor(id);
    if (mb.config.signPolicy !== 'allow' && page.url().startsWith('chrome-extension://') && !page.url().startsWith(`chrome-extension://${mb.builtinId}/`)) {
      throw new Error('evaluate is disabled on extension pages unless signPolicy is "allow". Use snapshot, click and type instead.');
    }
    const out = await withTimeout(page.evaluate(`(async () => { const r = await (${expression}); try { return JSON.stringify(r, null, 2); } catch { return String(r); } })()`), 30_000, 'evaluate');
    return { text: String(out ?? 'undefined').slice(0, 20_000) };
  });

  // ----- extensions & wallets -----

  def('extensions', 'List installed extensions (wallets etc.) with ids, popup pages and enabled state.', {}, async () => {
    const list = await mb.listExtensions();
    return { text: list.map((e) => `${e.name}  id=${e.id}  v${e.version}${e.enabled ? '' : '  DISABLED'}${e.popup ? `  popup=${e.popup}` : ''}${e.home ? `  home=${e.home}` : ''}`).join('\n') || 'No extensions installed. Use install_extension.' };
  });

  def('install_extension', 'Install an extension from the Chrome Web Store (32 char id or store URL) or a local folder/.crx/.zip path. The extension keeps its real store id.', {
    source: z.string(),
  }, async ({ source }) => {
    const e = await mb.installExtension(source);
    await sleep(2500);
    return { text: `Installed ${e.name} v${e.version} id=${e.id}${e.popup ? ` popup=${e.popup}` : ''}\n\nRecent events:\n${mb.drainEvents().join('\n')}` };
  });

  def('enable_extension', 'Turn an installed extension on or off without uninstalling it. Turning off a wallet you are not using saves 300 to 600 MB and stops it competing for window.ethereum.', {
    extension: z.string(), enabled: z.boolean(),
  }, async ({ extension, enabled }) => {
    const ext = mb.resolveExtension(extension);
    if (!ext) throw new Error(`No installed extension matches "${extension}"`);
    await mb.setExtensionEnabled(ext.id, enabled);
    await sleep(800);
    return { text: `${ext.name} is now ${enabled ? 'on' : 'off'}${enabled ? '. Unlock it again if it is a wallet.' : ''}` };
  });

  def('uninstall_extension', 'Remove an installed extension and its files.', { id: z.string() }, async ({ id }) => {
    const ext = mb.resolveExtension(id) || { id };
    await mb.uninstallExtension(ext.id);
    return { text: `Uninstalled ${ext.name || ext.id}` };
  });

  def('open_extension', 'Open an extension UI and make it the active tab. mode "popup" clicks its real toolbar button; mode "tab" opens the popup page in a full tab (steadier). Use page to open a specific file like "home.html".', {
    extension: z.string().describe('Extension name or id, e.g. "MetaMask"'),
    mode: z.enum(['popup', 'tab']).optional(), page: z.string().optional(),
  }, async ({ extension, mode = 'popup', page: p }) => {
    const { page, ext, mode: used, note } = await mb.openExtension(extension, mode, p);
    let snap;
    try { snap = await snapshotText(page); }
    catch (e) {
      if (!/detached|closed|context/i.test(e.message)) throw e;
      await sleep(1500);
      snap = await snapshotText(await mb.pageFor());
    }
    return { text: `Opened ${ext.name} as ${used}${note ? `. ${note}` : ''}\n\n${snap}` };
  });

  def('wait_for_tab', 'Wait for a tab or wallet window whose URL or extension name matches, then make it active. Use after a dapp asks a wallet to connect or sign.', {
    match: z.string().describe('Substring of URL or extension name, e.g. "MetaMask" or "notification"'), timeoutMs: z.number().optional(),
  }, async ({ match, timeoutMs }) => {
    const target = await mb.waitForTab(match, timeoutMs);
    if (!target) return { text: `No tab matching "${match}" appeared` };
    const page = (await target.page().catch(() => null)) || (await target.asPage());
    await settle(page, 2500);
    return { text: await snapshotText(page) };
  });

  def('secrets', 'List the names of stored secrets (wallet passwords etc.). Values are never shown.', {}, async () => ({
    text: listSecrets().length ? `Stored secrets: ${listSecrets().join(', ')}` : 'No secrets stored. The human adds them with: marlin secret set <name>',
  }));

  def('fill_secret', 'Type a stored secret (e.g. a wallet password) into a field by ref without ever revealing it. submit=true presses Enter.', {
    ref, name: z.string(), submit: z.boolean().optional(), tab,
  }, async ({ ref: r, name, submit, tab: id }) => {
    const page = await pageForRef(id, r);
    const value = await revealSecret(name);
    await typeInto(page, r, value, { clear: true, submit });
    return { text: `Filled secret "${name}" into ${r}\n\n${await snapshotText(page).catch(() => '(page closed)')}` };
  });

  def('unlock_extension', 'Unlock a wallet/extension: opens it, types the stored password secret into its password field and submits.', {
    extension: z.string(), secret: z.string().describe('Name of the stored secret holding the password'),
    mode: z.enum(['popup', 'tab']).optional(),
  }, async (args) => {
    // Right after a browser start the wallet can still be booting; retry once.
    try { return await unlockOnce(args); }
    catch (e) {
      if (!/timed out|detached|closed|context/i.test(e.message)) throw e;
      await sleep(3000);
      return unlockOnce(args);
    }
  });

  async function unlockOnce({ extension, secret, mode = 'tab' }) {
    const value = await revealSecret(secret);
    const { page, ext } = await mb.openExtension(extension, mode);
    const field = await page.waitForSelector('input[type=password]', { timeout: 10_000, visible: true }).catch(() => null);
    if (!field) return { text: `No password field on ${ext.name} (it may already be unlocked or still onboarding)\n\n${await snapshotText(page)}` };
    const submit = async (f) => {
      await f.click();
      await page.keyboard.down('Meta'); await page.keyboard.press('KeyA'); await page.keyboard.up('Meta');
      await page.keyboard.type(value, { delay: 8 });
      await act(page, () => page.keyboard.press('Enter'));
      await sleep(1500);
      return page.waitForSelector('input[type=password]', { visible: true, timeout: 500 }).catch(() => null);
    };
    let stillLocked = await submit(field);
    // A wallet that just started may ignore the first submit. Retype once unless it said the password is wrong.
    if (stillLocked) {
      const said = await iso(page).evaluate(() => document.body?.innerText || '').catch(() => '');
      if (!/incorrect|wrong|invalid/i.test(said)) { await sleep(2500); stillLocked = await submit(stillLocked); }
    }
    return { text: `${stillLocked ? 'Password submitted but the field is still there (wrong password?)' : `${ext.name} unlocked`}\n\n${await snapshotText(page).catch(() => '')}` };
  }

  // Wrap every tool: validate args, redact secrets, append browser events.
  for (const tool of Object.values(t)) {
    const inner = tool.run;
    tool.run = async (args) => {
      const parsed = tool.schema.parse(args ?? {});
      const res = await inner(parsed);
      const events = mb.drainEvents();
      res.text = redact(res.text + (events.length ? `\n\nBrowser events:\n${events.map((e) => `- ${e}`).join('\n')}` : ''));
      return res;
    };
    tool.jsonSchema = z.toJSONSchema(tool.schema);
    delete tool.jsonSchema.$schema;
  }
  return t;
}

const KEY_ALIASES = { cmd: 'Meta', command: 'Meta', meta: 'Meta', ctrl: 'Control', control: 'Control', alt: 'Alt', option: 'Alt', shift: 'Shift', esc: 'Escape', return: 'Enter', enter: 'Enter', space: 'Space', del: 'Delete' };
function normKey(k) {
  const a = KEY_ALIASES[k.toLowerCase()];
  if (a) return a;
  return k.length === 1 ? k : k[0].toUpperCase() + k.slice(1);
}

function withTimeout(promise, ms, what) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s (a dialog or a busy page can cause this)`)), ms))]);
}
