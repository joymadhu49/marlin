// Owns the Chromium process. Talks CDP over a pipe (needed for the Extensions
// domain) and also opens a loopback debugging port so Playwright, browser-use
// and friends can attach to the same browser.
import puppeteer from 'puppeteer-core';
import { EventEmitter } from 'node:events';
import { readFileSync, existsSync, cpSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths, chromiumPath, readJson, writeJson } from './paths.js';
import { downloadFromStore, installFromPath, parseExtensionRef, idFromPublicKey } from './crx.js';

const short = (targetId) => targetId.slice(0, 8);

// Memory: no spare pre-started renderer, no background ML/translate/cast
// services, and a soft cap on renderer processes. Site isolation stays on.
const LOW_MEMORY_FLAGS = [
  '--renderer-process-limit=8',
  '--disable-features=SpareRendererForSitePerProcess,OptimizationHints,OptimizationHintsFetching,OptimizationGuideModelDownloading,OptimizationTargetPrediction,OptimizationGuideOnDeviceModel,Translate,MediaRouter,DialMediaRouteProvider,GlobalMediaControls,InterestFeedContentSuggestions,AutofillServerCommunication,LensOverlay,HistoryEmbeddings',
  '--disable-background-networking',
  '--disable-breakpad',
  '--metrics-recording-only',
];

// Real tabs, windows and extension popups. Excludes iframes, offscreen documents,
// browser UI and workers, which puppeteer lumps together as "other".
const VISIBLE = new Set(['page', 'app', 'webview']);
const isVisible = (t) => VISIBLE.has(t._getTargetInfo?.().type ?? t.type()) && !/^(chrome:\/\/omnibox|devtools:)/.test(t.url());

export class MarlinBrowser extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.browser = null;
    this.activeId = null;
    this.events = [];
    this.dialogs = new Map(); // targetId -> {type, message, dialog}
    this.builtinId = null;
    this.touched = new Map(); // targetId -> last time it opened or changed route
    this.lastUrl = new Map();
  }

  // ---------- lifecycle ----------

  async start() {
    const builtinDir = this.#prepareBuiltin();
    this.#pinToolbarIcon();
    if (this.config.lowMemory) this.#tunePrefs();
    const headless = this.config.headless;
    this.browser = await puppeteer.launch({
      executablePath: chromiumPath(),
      pipe: true,
      ignoreDefaultArgs: true,
      defaultViewport: null,
      headless,
      protocolTimeout: 60_000,
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
      // Silences Chromium's "Google API keys are missing" bar.
      env: { ...process.env, GOOGLE_API_KEY: 'no', GOOGLE_DEFAULT_CLIENT_ID: 'no', GOOGLE_DEFAULT_CLIENT_SECRET: 'no' },
      args: [
        '--remote-debugging-pipe',
        `--remote-debugging-port=${this.config.cdpPort}`,
        '--remote-debugging-address=127.0.0.1',
        '--remote-allow-origins=http://127.0.0.1',
        `--user-data-dir=${paths.profile}`,
        '--enable-unsafe-extension-debugging',
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-crash-restore-bubble',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1440,900',
        ...(this.config.lowMemory ? LOW_MEMORY_FLAGS : []),
        ...(this.config.chromiumFlags || []),
        ...(headless ? ['--headless=new'] : ['about:blank']),
      ],
    });
    this.cdp = this.browser._connection;
    this.builtinId = (await this.cdp.send('Extensions.loadUnpacked', { path: builtinDir })).id;
    for (const ext of this.registry()) {
      if (!existsSync(ext.dir)) continue;
      try { await this.cdp.send('Extensions.loadUnpacked', { path: ext.dir }); }
      catch (e) { this.#event(`Could not load extension ${ext.name}: ${e.message}`); }
    }
    // Loading always enables; switch the disabled ones back off once the agent extension is up.
    const off = this.registry().filter((e) => e.enabled === false);
    if (off.length) {
      setTimeout(async () => {
        for (const e of off) await this.setExtensionEnabled(e.id, false).catch(() => {});
      }, 1500);
    }
    await this.cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: paths.downloads, eventsEnabled: true }).catch(() => {});

    for (const t of this.browser.targets()) this.lastUrl.set(t._targetId, t.url());
    this.browser.on('targetcreated', (t) => this.#onTarget(t, 'opened'));
    this.browser.on('targetdestroyed', (t) => this.#onTarget(t, 'closed'));
    this.browser.on('targetchanged', (t) => this.#onChanged(t));
    this.browser.on('disconnected', () => this.emit('exit'));
    for (const p of await this.browser.pages()) this.#watchPage(p);
    const first = (await this.browser.pages()).find((p) => !p.url().startsWith('chrome-extension://'));
    if (first) this.activeId = first.target()._targetId;
    return this;
  }

  async stop() {
    try { await this.browser?.close(); } catch {}
  }

  /** Copy the built-in agent extension to a writable spot and give it its connection config. */
  #prepareBuiltin() {
    rmSync(paths.builtin, { recursive: true, force: true });
    mkdirSync(paths.builtin, { recursive: true });
    cpSync(paths.extensionSrc, paths.builtin, { recursive: true });
    const { port, token } = readJson(paths.state, {});
    writeFileSync(join(paths.builtin, 'config.js'),
      `self.MARLIN = ${JSON.stringify({ port: port || this.config.port, token: token || '' })};\n`);
    return paths.builtin;
  }

  /** Turns on Memory Saver (background tab discarding) before launch. */
  #tunePrefs() {
    const prefsFile = join(paths.profile, 'Default', 'Preferences');
    let prefs = {};
    try { prefs = JSON.parse(readFileSync(prefsFile, 'utf8')); } catch {}
    prefs.performance_tuning ??= {};
    prefs.performance_tuning.high_efficiency_mode = { ...(prefs.performance_tuning.high_efficiency_mode || {}), state: 2, aggressiveness: 1 };
    try { mkdirSync(join(paths.profile, 'Default'), { recursive: true }); writeFileSync(prefsFile, JSON.stringify(prefs)); } catch {}
  }

  #pinToolbarIcon() {
    const manifest = JSON.parse(readFileSync(join(paths.extensionSrc, 'manifest.json'), 'utf8'));
    if (!manifest.key) return;
    const prefsFile = join(paths.profile, 'Default', 'Preferences');
    if (!existsSync(prefsFile)) return;
    try {
      const prefs = JSON.parse(readFileSync(prefsFile, 'utf8'));
      prefs.extensions ??= {};
      const id = idFromKey(manifest.key);
      const pinned = new Set(prefs.extensions.pinned_extensions || []);
      if (pinned.has(id)) return;
      prefs.extensions.pinned_extensions = [id, ...pinned];
      writeFileSync(prefsFile, JSON.stringify(prefs));
    } catch {}
  }

  // ---------- events & dialogs ----------

  #event(text) {
    this.events.push(text);
    if (this.events.length > 30) this.events.shift();
    this.emit('event', text);
  }

  note(text) { this.#event(text); }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  async #onTarget(t, verb) {
    if (verb === 'opened') this.#redirectAbout(t);
    const type = t.type();
    if (!isVisible(t)) return;
    if (type !== 'page' && type !== 'other') return;
    const key = `${verb}:${t._targetId}`;
    if (this.announced?.has(key)) return;
    (this.announced ??= new Set()).add(key);
    if (this.announced.size > 500) this.announced = new Set([key]);
    // New targets often report an empty URL for a moment.
    for (let i = 0; verb === 'opened' && i < 20 && (!t.url() || t.url() === 'about:blank'); i++) await sleep(100);
    const url = t.url();
    if (url.startsWith('chrome://omnibox') || url.startsWith('devtools://')) return;
    if (this.builtinId && url.startsWith(`chrome-extension://${this.builtinId}/`)) return;
    const id = short(t._targetId);
    const ext = this.extensionForUrl(url);
    if (verb === 'opened') {
      this.touched.set(t._targetId, Date.now());
      this.lastUrl.set(t._targetId, url);
      if (type === 'page') {
        const page = await t.page().catch(() => null);
        if (page) this.#watchPage(page);
      }
      // A wallet approval window is almost always what the agent wants next.
      const steal = ext && !/sidepanel/i.test(url);
      if (steal) this.activeId = t._targetId;
      this.#event(`Tab ${id} opened${ext ? ` by extension ${ext.name}` : ''}: ${url || '(loading)'}${steal ? '. It is now the active tab.' : ''}`);
    } else {
      this.dialogs.delete(t._targetId);
      if (this.activeId === t._targetId) this.activeId = null;
      this.#event(`Tab ${id} closed${ext ? ` (${ext.name})` : ''}`);
    }
  }

  /** Chromium's About page has no updater; show Marlin's, which checks through Sparkle. */
  async #redirectAbout(t) {
    if (!/^chrome:\/\/(settings\/help|help)\b/.test(t.url()) || !this.builtinId) return;
    const page = await t.page().catch(() => null);
    await page?.goto(`chrome-extension://${this.builtinId}/about.html`).catch(() => {});
  }

  /** Wallets reuse open windows: a dapp request often shows up as a new route in an existing page. */
  #onChanged(t) {
    this.#redirectAbout(t);
    if (!isVisible(t)) return;
    const url = t.url();
    const ext = this.extensionForUrl(url);
    if (!ext || ext.id === this.builtinId) return;
    const prev = this.lastUrl.get(t._targetId);
    this.lastUrl.set(t._targetId, url);
    if (!prev || prev === url) return;
    this.touched.set(t._targetId, Date.now());
    const route = url.split('#')[1] || url.split('/').pop();
    if (/connect|confirm|approv|sign|request|transaction|permission|notification/i.test(route)) {
      // Side panels mirror the popup; only take focus for the primary window.
      const steal = !/sidepanel/i.test(url) && !this.extensionForUrl(this.activeUrl())?.id?.includes(ext.id);
      if (steal) this.activeId = t._targetId;
      this.#event(`${ext.name} ${/sidepanel/i.test(url) ? 'side panel' : 'tab'} ${short(t._targetId)} now shows a request: ${url}${steal ? '. It is now the active tab.' : ''}`);
    }
  }

  #watchPage(page) {
    if (page.__marlin) return;
    page.__marlin = true;
    page.on('dialog', (dialog) => {
      const tid = page.target()._targetId;
      this.dialogs.set(tid, { type: dialog.type(), message: dialog.message(), dialog });
      this.#event(`Dialog in tab ${short(tid)}: ${dialog.type()} "${dialog.message().slice(0, 200)}". Use handle_dialog.`);
    });
  }

  // ---------- tabs ----------

  activeUrl() {
    return this.browser.targets().find((t) => t._targetId === this.activeId)?.url() || '';
  }

  async listTabs() {
    const targets = this.browser.targets().filter(isVisible);
    const out = [];
    for (const t of targets) {
      const url = t.url();
      if (url.startsWith('chrome://omnibox') || url.startsWith('devtools://') || url.includes('/offscreen.html')) continue;
      if (this.builtinId && url.startsWith(`chrome-extension://${this.builtinId}/`)) continue;
      if (t.type() === 'other' && !url.startsWith('chrome-extension://')) continue;
      const page = await t.page().catch(() => null) || (t.type() === 'other' ? await t.asPage().catch(() => null) : null);
      const title = page ? await page.title().catch(() => '') : '';
      const ext = this.extensionForUrl(url);
      out.push({
        id: short(t._targetId),
        targetId: t._targetId,
        title,
        url,
        extension: ext ? ext.name : null,
        kind: ext ? (/sidepanel|side_panel|side-panel/i.test(url) ? 'extension side panel' : /popup|notification|confirm|approval/i.test(url) ? 'extension window' : 'extension page') : 'tab',
        active: t._targetId === this.activeId,
      });
    }
    return out;
  }

  async pageFor(tabRef) {
    let target;
    const pick = (id) => this.browser.targets().find((t) => t._targetId === id || t._targetId.startsWith(String(id).toUpperCase()));
    if (tabRef) {
      target = pick(tabRef);
      if (!target) throw new Error(`No tab ${tabRef}. Call tabs to see open tabs.`);
    } else if (this.activeId) {
      target = pick(this.activeId);
    }
    if (!target) {
      const pages = (await this.browser.pages()).filter((p) => !p.url().startsWith(`chrome-extension://${this.builtinId}/`));
      const page = pages.at(-1) || await this.browser.newPage();
      this.activeId = page.target()._targetId;
      this.#watchPage(page);
      return page;
    }
    const page = (await target.page().catch(() => null)) || (await target.asPage());
    this.#watchPage(page);
    if (tabRef) this.activeId = target._targetId;
    await this.#wake(page);
    return page;
  }

  /** Memory Saver may have discarded or frozen a background tab; activate it so tools can run. */
  async #wake(page) {
    const alive = await Promise.race([
      page.mainFrame().isolatedRealm().evaluate(() => 1).then(() => true, () => false),
      sleep(1500).then(() => false),
    ]);
    if (alive) return;
    await page.bringToFront().catch(() => {});
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
  }

  async newTab(url) {
    const page = await this.browser.newPage();
    this.#watchPage(page);
    this.activeId = page.target()._targetId;
    if (url) await this.goto(page, url);
    return page;
  }

  async goto(page, url) {
    let u = url.trim();
    // A numeric port on a bare host is not a URL scheme (localhost:3000).
    const hostPort = /^(\[[a-f0-9:]+\]|[a-z0-9.-]+):\d+(?:[/?#]|$)/i.exec(u);
    if (hostPort) {
      const host = hostPort[1].toLowerCase();
      const local = !host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host);
      u = `${local ? 'http' : 'https'}://${u}`;
    } else if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = /\s/.test(u) || !u.includes('.') ? `https://duckduckgo.com/?q=${encodeURIComponent(u)}` : `https://${u}`;
    try {
      await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (e) {
      if (!/timeout/i.test(e.message)) throw e;
    }
    await settle(page);
  }

  // ---------- extensions ----------

  registry() {
    return readJson(paths.registry, []);
  }

  #saveRegistry(list) {
    writeJson(paths.registry, list);
  }

  extensionForUrl(url) {
    const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(url || '');
    if (!m) return null;
    return this.registry().find((e) => e.id === m[1]) || { id: m[1], name: m[1] };
  }

  async listExtensions() {
    const { extensions } = await this.cdp.send('Extensions.getExtensions');
    const reg = this.registry();
    return extensions.filter((e) => e.id !== this.builtinId).map((e) => {
      const r = reg.find((x) => x.id === e.id) || {};
      return {
        id: e.id, name: r.name || e.name, version: e.version, enabled: e.enabled,
        popup: r.popup || null, home: r.home || null, source: r.source || 'unknown',
      };
    });
  }

  async installExtension(source) {
    const prodversion = (await this.browser.version()).split('/')[1];
    const local = !parseExtensionRef(source) || source.startsWith('/') || source.startsWith('~');
    const result = local
      ? await installFromPath(source.replace(/^~/, process.env.HOME), paths.extensions)
      : await downloadFromStore(source, paths.extensions, prodversion);
    const { id: loadedId } = await this.cdp.send('Extensions.loadUnpacked', { path: result.dir });
    const m = result.manifest;
    const entry = {
      id: loadedId,
      name: localizedName(result.dir, m),
      version: m.version,
      dir: result.dir,
      popup: m.action?.default_popup || m.browser_action?.default_popup || null,
      home: guessHome(result.dir, m),
      source: local ? source : `webstore:${result.id}`,
      enabled: true,
      installedAt: new Date().toISOString(),
    };
    const reg = this.registry().filter((e) => e.id !== loadedId);
    reg.push(entry);
    this.#saveRegistry(reg);
    this.#event(`Installed extension ${entry.name} (${loadedId})`);
    return entry;
  }

  /** Turns an extension on or off through the built in agent extension (chrome.management). */
  async setExtensionEnabled(id, enabled) {
    // The MV3 worker sleeps when idle, so use a hidden background page of the agent extension.
    const url = `chrome-extension://${this.builtinId}/blank.html`;
    const { targetId } = await this.cdp.send('Target.createTarget', { url, background: true });
    try {
      const t = await this.browser.waitForTarget((x) => x._targetId === targetId, { timeout: 5000 });
      const page = await t.page();
      await page.waitForFunction(() => !!(globalThis.chrome && chrome.management), { timeout: 5000 });
      await page.evaluate((id, on) => chrome.management.setEnabled(id, on), id, enabled);
    } finally {
      await this.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    }
    this.#saveRegistry(this.registry().map((e) => (e.id === id ? { ...e, enabled } : e)));
  }

  async uninstallExtension(id) {
    await this.cdp.send('Extensions.uninstall', { id }).catch(() => {});
    const reg = this.registry();
    const entry = reg.find((e) => e.id === id);
    this.#saveRegistry(reg.filter((e) => e.id !== id));
    if (entry?.dir?.startsWith(paths.extensions)) rmSync(entry.dir, { recursive: true, force: true });
    return entry || { id };
  }

  resolveExtension(ref) {
    const reg = this.registry();
    const q = String(ref).toLowerCase();
    return reg.find((e) => e.id === q) || reg.find((e) => e.name.toLowerCase() === q) ||
      reg.find((e) => e.name.toLowerCase().includes(q)) || null;
  }

  /**
   * Opens an extension's UI. mode "popup" clicks the real toolbar button (the
   * popup is a separate window attached to the toolbar); mode "tab" loads the
   * popup document in a normal tab, which is steadier for long flows.
   */
  async openExtension(ref, mode = 'popup', pagePath) {
    const ext = this.resolveExtension(ref);
    if (!ext) throw new Error(`No installed extension matches "${ref}". Call extensions to list them.`);
    const before = new Set(this.browser.targets().map((t) => t._targetId));
    if (mode === 'popup' && !pagePath) {
      const anchor = await this.#anchorTab();
      try {
        await this.cdp.send('Extensions.triggerAction', { id: ext.id, targetId: anchor._tabId });
      } catch (e) {
        mode = 'tab';
        this.#event(`Toolbar popup unavailable (${e.message}), opened as a tab instead`);
      }
      if (mode === 'popup') {
        const t = await this.#waitNewTarget(before, ext.id, 6000);
        if (t) {
          this.activeId = t._targetId;
          const page = (await t.page().catch(() => null)) || (await t.asPage());
          this.#watchPage(page);
          await settle(page);
          const followed = await this.#followBounce(page, ext, before);
          if (followed) return { page: followed, ext, mode: 'tab', note: 'The popup closed itself and reopened as a tab (normal for wallets that are not set up yet).' };
          return { page, ext, mode: /popup|notification/.test(t.url()) ? 'popup' : 'tab' };
        }
        mode = 'tab';
      }
    }
    const file = pagePath || ext.popup || ext.home;
    if (!file) throw new Error(`${ext.name} has no popup or home page. Pass page explicitly.`);
    // Reuse a tab already showing this extension instead of piling up new ones.
    const existing = this.browser.targets().find((t) => isVisible(t) && t.url().startsWith(`chrome-extension://${ext.id}/`) &&
      !/sidepanel|offscreen|notification|connect|confirm|approval|signature/i.test(t.url()));
    const page = existing ? await this.pageFor(existing._targetId) : await this.newTab();
    const opened = new Set(this.browser.targets().map((t) => t._targetId));
    try {
      await this.goto(page, `chrome-extension://${ext.id}/${file.replace(/^\//, '')}`);
    } catch (e) {
      if (!/detached|closed|Target/i.test(e.message)) throw e;
    }
    const followed = await this.#followBounce(page, ext, opened);
    return { page: followed || page, ext, mode: 'tab' };
  }

  /** Wallets (MetaMask, Rabby) often close their popup document and reopen it as a full tab. */
  async #followBounce(page, ext, before) {
    await sleep(800);
    if (!page.isClosed() && !page.mainFrame().detached) return null;
    const known = new Set(before);
    known.add(page.target()._targetId);
    const t = await this.#waitNewTarget(known, ext.id, 5000) ||
      this.browser.targets().filter((x) => isVisible(x) && x.url().startsWith(`chrome-extension://${ext.id}/`)).at(-1);
    if (!t) throw new Error(`${ext.name} closed its page right after opening`);
    const p2 = (await t.page().catch(() => null)) || (await t.asPage());
    this.#watchPage(p2);
    this.activeId = t._targetId;
    await settle(p2);
    return p2;
  }

  async #anchorTab() {
    let page = this.activeId ? await this.pageFor().catch(() => null) : null;
    if (!page || page.url().startsWith('chrome-extension://')) {
      page = (await this.browser.pages()).find((p) => !p.url().startsWith('chrome-extension://')) || await this.newTab();
    }
    return page;
  }

  async #waitNewTarget(before, extId, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const t = this.browser.targets().find((x) => !before.has(x._targetId) && isVisible(x) &&
        x.url().startsWith(`chrome-extension://${extId}/`) && !x.url().includes('offscreen'));
      if (t) return t;
      await sleep(150);
    }
    return null;
  }

  /** Most recently opened or re-routed tab matching URL or extension name; waits for a fresh one first. */
  async waitForTab(match, timeout = 20_000) {
    const started = Date.now();
    const re = new RegExp(match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    // A wallet name means that wallet's own windows, not sites whose URL contains it.
    const wanted = this.resolveExtension(match);
    const best = () => {
      let pick = null, at = -1;
      for (const t of this.browser.targets()) {
        if (!isVisible(t)) continue;
        const ext = this.extensionForUrl(t.url());
        if (wanted ? ext?.id !== wanted.id : !re.test(t.url()) && !(ext && re.test(ext.name))) continue;
        const ts = this.touched.get(t._targetId) ?? 0;
        if (ts > at) { pick = t; at = ts; }
      }
      return { pick, at };
    };
    while (Date.now() - started < timeout) {
      const { pick, at } = best();
      if (pick && at >= started - 10_000) { this.activeId = pick._targetId; return pick; }
      await sleep(250);
    }
    const { pick } = best();
    if (pick) this.activeId = pick._targetId;
    return pick;
  }

}

export const idFromKey = (b64) => idFromPublicKey(Buffer.from(b64, 'base64'));

function localizedName(dir, manifest) {
  const raw = manifest.name || 'Extension';
  const m = /^__MSG_(\w+)__$/.exec(raw);
  if (!m) return raw;
  const locale = manifest.default_locale || 'en';
  for (const loc of [locale, 'en', 'en_US']) {
    const msgs = readJson(join(dir, '_locales', loc, 'messages.json'), null);
    if (!msgs) continue;
    const key = Object.keys(msgs).find((k) => k.toLowerCase() === m[1].toLowerCase());
    if (key) return msgs[key].message;
  }
  return raw;
}

function guessHome(dir, manifest) {
  for (const f of ['home.html', 'index.html', 'popup.html', 'notification.html']) {
    if (existsSync(join(dir, f))) return f;
  }
  return manifest.options_page || manifest.options_ui?.page || null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait briefly for network and DOM to calm down without hard failing. */
export async function settle(page, ms = 4000) {
  await Promise.race([
    page.waitForNetworkIdle({ idleTime: 400, timeout: ms }).catch(() => {}),
    sleep(ms),
  ]);
}
