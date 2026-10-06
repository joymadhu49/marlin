// Functions injected into pages (web pages and extension pages alike).
// They must be self-contained: puppeteer serializes them with toString().

export function snapshotInPage(opts) {
  const { maxItems = 250, textChars = 1500 } = opts || {};
  const SEL = 'a[href],button,input,select,textarea,summary,label[for],[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=option],[role=combobox],[role=textbox],[role=searchbox],[role=slider],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"]),[onclick]';
  const refs = new Map();
  window.__marlinRefs = refs;
  const all = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      all.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  const vw = innerWidth, vh = innerHeight;
  const clean = (s, n = 80) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const nameOf = (el) => {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText).filter(Boolean).join(' ');
      if (t) return clean(t);
    }
    if (el.labels && el.labels[0] && el.labels[0].innerText) return clean(el.labels[0].innerText);
    return clean(
      el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') ||
      el.querySelector?.('img[alt]')?.getAttribute('alt') || el.getAttribute('alt') ||
      (el.tagName === 'INPUT' && /^(submit|button|reset)$/.test(el.type) ? el.value : '') ||
      el.getAttribute('name') || el.getAttribute('data-testid') || ''
    );
  };
  // Page text without <select> option lists, scripts or hidden nodes.
  const visibleText = () => {
    const out = [];
    const tw = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const p = n.parentElement;
        if (!p || !n.nodeValue.trim() || p.closest('select,script,style,noscript,template,#__marlin_marks')) return NodeFilter.FILTER_REJECT;
        return p.checkVisibility ? (p.checkVisibility({ visibilityProperty: true, opacityProperty: true }) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) : NodeFilter.FILTER_ACCEPT;
      },
    });
    let len = 0;
    while (tw.nextNode() && len < textChars * 2) { out.push(tw.currentNode.nodeValue); len += tw.currentNode.nodeValue.length; }
    return out.join(' ');
  };
  const items = [];
  const seen = new Set();
  for (const el of all) {
    let interactive = el.matches(SEL);
    if (!interactive) {
      // Div based buttons: pointer cursor where the parent is not already a pointer target.
      const cs = getComputedStyle(el);
      if (cs.cursor === 'pointer' && el.parentElement && getComputedStyle(el.parentElement).cursor !== 'pointer') interactive = true;
      else continue;
    }
    // Skip children of an already listed link or button (avoids duplicate entries).
    if (!el.matches('input,select,textarea')) {
      let p = el.parentElement, nested = false;
      for (let d = 0; p && d < 8; d++, p = p.parentElement) if (seen.has(p)) { nested = true; break; }
      if (nested) continue;
    }
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (!el.matches(SEL) && el.querySelector('select,input,textarea') && !el.innerText.replace(el.querySelector('select')?.innerText || '', '').trim()) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    if (el.matches('a,button,[role=button],[role=link],[role=menuitem],[role=tab],[role=option]') || cs.cursor === 'pointer') seen.add(el);
    const inView = r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    items.push({ el, r, inView });
  }
  items.sort((a, b) => (b.inView - a.inView) || (a.r.top - b.r.top));
  const lines = [];
  items.slice(0, maxItems).forEach(({ el, r, inView }, i) => {
    const ref = 'e' + (i + 1);
    refs.set(ref, el);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? (el.type || 'text') : tag);
    let desc = `[${ref}] ${role} "${nameOf(el)}"`;
    if (tag === 'input' || tag === 'textarea') {
      if (el.type === 'password') desc += el.value ? ' value=(hidden, filled)' : ' value=(empty)';
      else if (el.type === 'checkbox' || el.type === 'radio') desc += el.checked ? ' checked' : ' unchecked';
      else if (el.value) desc += ` value="${clean(el.value, 60)}"`;
      if (el.placeholder) desc += ` placeholder="${clean(el.placeholder, 40)}"`;
    }
    if (tag === 'select') desc += ` selected="${clean(el.selectedOptions[0]?.text, 40)}" options=[${[...el.options].slice(0, 12).map((o) => clean(o.text, 24)).join('|')}]`;
    if (el.getAttribute('aria-checked')) desc += ` aria-checked=${el.getAttribute('aria-checked')}`;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') desc += ' disabled';
    if (tag === 'a' && el.href && !el.href.startsWith('javascript:')) desc += ` -> ${el.href.slice(0, 80)}`;
    if (!inView) desc += ' (offscreen)';
    lines.push(desc);
  });
  const active = document.activeElement;
  const focusedRef = [...refs].find(([, el]) => el === active)?.[0];
  return {
    title: document.title,
    url: location.href,
    viewport: `${vw}x${vh}`,
    scroll: `${Math.round(scrollY)}/${Math.max(0, document.documentElement.scrollHeight - vh)}`,
    focused: focusedRef || null,
    elements: lines,
    total: items.length,
    text: textChars ? clean(visibleText(), textChars) : '',
  };
}

export function locateRef(ref) {
  const el = window.__marlinRefs && window.__marlinRefs.get(ref);
  if (!el) return { error: `Unknown ref ${ref}. Take a new snapshot first.` };
  if (!el.isConnected) return { error: `Ref ${ref} is stale (the page changed). Take a new snapshot.` };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  // Aim at the centre of the part that is actually inside the viewport (drawers
  // and wide rows often hang past the edge).
  const r = el.getBoundingClientRect();
  const left = Math.max(r.left, 0), right = Math.min(r.right, innerWidth);
  const topE = Math.max(r.top, 0), bottom = Math.min(r.bottom, innerHeight);
  const x = right > left ? (left + right) / 2 : r.left + r.width / 2;
  const y = bottom > topE ? (topE + bottom) / 2 : r.top + r.height / 2;
  let top = document.elementFromPoint(x, y);
  while (top && top.shadowRoot && top.shadowRoot.elementFromPoint(x, y) && top.shadowRoot.elementFromPoint(x, y) !== top) top = top.shadowRoot.elementFromPoint(x, y);
  const covered = top && top !== el && !el.contains(top) && !top.contains(el);
  const label = (el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText ||
    (/^(checkbox|radio|password)$/.test(el.type) ? '' : el.value) || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return { x, y, covered, coveredBy: covered ? (top.innerText || top.tagName).slice(0, 60) : null, label, tag: el.tagName.toLowerCase(), type: el.type || null };
}

export function focusRef(ref, clear) {
  const el = window.__marlinRefs && window.__marlinRefs.get(ref);
  if (!el || !el.isConnected) return false;
  el.focus();
  if (clear) {
    if ('value' in el && typeof el.select === 'function') el.select();
    else if (el.isContentEditable) document.getSelection().selectAllChildren(el);
  }
  return true;
}

export function selectRef(ref, value) {
  const el = window.__marlinRefs && window.__marlinRefs.get(ref);
  if (!el || el.tagName !== 'SELECT') return { error: 'Ref is not a <select>' };
  const opt = [...el.options].find((o) => o.value === value || o.text.trim() === value) ||
    [...el.options].find((o) => o.text.toLowerCase().includes(String(value).toLowerCase()));
  if (!opt) return { error: `No option matching "${value}"` };
  el.value = opt.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { selected: opt.text.trim() };
}

export function annotateRefs(on) {
  document.getElementById('__marlin_marks')?.remove();
  if (!on || !window.__marlinRefs) return 0;
  const host = document.createElement('div');
  host.id = '__marlin_marks';
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  let n = 0;
  for (const [ref, el] of window.__marlinRefs) {
    if (!el.isConnected) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    const box = document.createElement('div');
    box.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;outline:1.5px solid #f5a524;border-radius:3px`;
    const tag = document.createElement('div');
    tag.textContent = ref;
    tag.style.cssText = `position:fixed;left:${Math.max(0, r.left)}px;top:${Math.max(0, r.top - 14)}px;font:600 10px/14px ui-monospace,Menlo,monospace;background:#f5a524;color:#000;padding:0 3px;border-radius:2px`;
    host.append(box, tag);
    n++;
  }
  document.documentElement.appendChild(host);
  return n;
}
