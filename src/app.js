/* Boostport page logic. Reads a folder in this tab, never sends anything. */
(function () {
  'use strict';
  const core = window.BoostportCore;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const DEPARTURE = new Date(2026, 11, 22); // 22 Dec 2026, local time
  // "site": the public page, where real folders are listed for free and the
  // archive is sold on Ko-fi. "full": the paid file, download always on.
  const EDITION = document.documentElement.getAttribute('data-edition') || 'site';
  const KOFI_URL = document.documentElement.getAttribute('data-kofi') || '';

  // ---------- countdown ----------
  function daysLeft() {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((DEPARTURE - today) / 86400000);
  }
  function paintCountdown() {
    const d = daysLeft();
    const text = d > 1 ? `Final departure Dec 22 · ${d} days left`
      : d === 1 ? 'Final departure tomorrow, Dec 22'
      : d === 0 ? 'Final departure is today'
      : 'Arc has sailed. Boosts on disk still convert';
    $$('.js-days').forEach((el) => { el.textContent = text; });
    const foot = $('.js-days-foot');
    if (foot && d > 0) foot.textContent = `${d} days to copy your folder.`;
  }

  // ---------- hero manifest crossfade ----------
  function startCrossfade() {
    const pages = $$('.manifest-page');
    if (pages.length < 2 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let i = 0;
    let timer = null;
    const tick = () => {
      pages[i].classList.remove('is-shown');
      pages[i].setAttribute('aria-hidden', 'true');
      i = (i + 1) % pages.length;
      pages[i].classList.add('is-shown');
      pages[i].removeAttribute('aria-hidden');
    };
    const start = () => { if (!timer) timer = setInterval(tick, 5600); };
    const stop = () => { clearInterval(timer); timer = null; };
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
    start();
  }

  // ---------- entrances ----------
  function setupEntrances() {
    const groups = [
      ['.hero', ['.manifest', '.hero-wordmark', '.hero-title', '.hero-lead', '.hero-row']],
      ['.dock', ['.dock-guide .h2', '.dock-guide > p', '.dock-guide .h3', '.dock-panel']],
      ['.crate-ink', ['.crate-heading', '.crate-object', '.crate-row']],
      ['.crate-paper', ['.crate-object', '.crate-row']],
      ['.flow', ['.flow-intro .h2', '.flow-intro p', '.flow-diagram', '.flow-steps > div']],
      ['.compare', ['.h2', '.ct-row']],
      ['.faq', ['.faq-title', '.band-q', '.band-a']],
      ['.foot', ['.foot-cols > div', '.foot-mark']],
    ];
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const items = $$('.rise', e.target);
        items.forEach((el, n) => setTimeout(() => el.classList.add('is-in'), Math.min(n, 8) * 75));
        io.unobserve(e.target);
      }
    }, { threshold: 0.12 });
    for (const [scope, parts] of groups) {
      $$(scope).forEach((root) => {
        parts.forEach((sel) => $$(sel, root).forEach((el) => el.classList.add('rise')));
        io.observe(root);
      });
    }
    // The first screen never waits for a frame callback, and a safety net
    // reveals anything still hidden after a few seconds (background tabs
    // can pause observers and animation frames).
    $$('.hero .rise').forEach((el, n) => setTimeout(() => el.classList.add('is-in'), 40 + n * 80));
    setTimeout(() => $$('.rise:not(.is-in)').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.top < innerHeight && r.bottom > 0) el.classList.add('is-in');
    }), 2500);
    addEventListener('hashchange', () => setTimeout(() => $$('.rise').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.top < innerHeight && r.bottom > 0) el.classList.add('is-in');
    }), 600));
  }

  // ---------- flow diagram: scatter, ribbon, rows ----------
  function drawFlow() {
    const svg = $('.js-flow');
    if (!svg) return;
    const NS = 'http://www.w3.org/2000/svg';
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const size = 12;
    const parts = [];
    // left third: loose scatter in two pale tones
    for (let k = 0; k < 54; k++) {
      parts.push({ x: rnd() * 370, y: 14 + rnd() * 240, fill: k % 3 ? '#ffffff' : '#ffc39b' });
    }
    // middle: tight ribbon three squares high
    for (let c = 0; c < 22; c++) {
      for (let r = 0; r < 3; r++) parts.push({ x: 430 + c * 15, y: 112 + r * 15, fill: '#050f16' });
    }
    // right: neat rows in ink
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 9; c++) parts.push({ x: 860 + c * 41, y: 26 + r * 40, fill: '#050f16' });
    }
    for (const p of parts) {
      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('x', p.x.toFixed(1));
      rect.setAttribute('y', p.y.toFixed(1));
      rect.setAttribute('width', size);
      rect.setAttribute('height', size);
      rect.setAttribute('fill', p.fill);
      rect.setAttribute('class', 'sq');
      svg.appendChild(rect);
    }
  }

  // ---------- comparison table labels for the phone layout ----------
  function labelCompareCells() {
    const heads = $$('.ct-head > span').map((s) => s.textContent.trim());
    $$('.compare-table .ct-row:not(.ct-head)').forEach((row) => {
      $$('span', row).forEach((cell, i) => { if (i > 0) cell.setAttribute('data-col', heads[i]); });
    });
  }

  // ---------- copy path ----------
  function setupCopy() {
    const btn = $('.js-copy');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const text = $('.js-path').textContent;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copied';
      } catch (e) {
        const range = document.createRange();
        range.selectNodeContents($('.js-path'));
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        btn.textContent = 'Selected, press Copy';
      }
      setTimeout(() => { btn.textContent = 'Copy path'; }, 1800);
    });
  }

  // ---------- reading folders ----------
  const status = (msg) => { const s = $('.js-status'); if (s) s.textContent = msg; };

  async function readFileList(fileList) {
    const all = Array.from(fileList).map((f) => ({ file: f, path: (f.webkitRelativePath || f.name).replace(/\\/g, '/') }));
    return readEntries(all);
  }

  // Only folders that hold a boost.config.json are read, so picking a large
  // folder (a whole Arc package) stays quick.
  async function readEntries(all) {
    status(`Looking through ${all.length.toLocaleString()} files…`);
    const boostDirs = new Set(
      all.filter((e) => /(^|\/)boost\.config\.json$/.test(e.path))
        .map((e) => e.path.slice(0, e.path.lastIndexOf('/')))
    );
    const wanted = all.filter((e) => {
      const dir = e.path.slice(0, e.path.lastIndexOf('/'));
      return boostDirs.has(dir) && core.isCandidateFile(e.path) && e.file.size < 2 * 1024 * 1024;
    });
    const files = [];
    for (const e of wanted) files.push({ path: e.path, text: await e.file.text() });
    return files;
  }

  async function walkEntry(entry, prefix, out) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: prefix + entry.name });
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await walkEntry(child, prefix + entry.name + '/', out);
      } while (batch.length);
    }
  }

  // ---------- state and rendering ----------
  let boosts = [];
  let cargoIsSample = false;
  const selected = new Set();
  const palette = {};

  const canDownload = () => EDITION === 'full' || cargoIsSample;

  function contentsLabel(b) {
    const bits = [];
    if (b.hasCss) bits.push('styles');
    if (b.hasJs) bits.push('script');
    for (const p of b.extraParts) bits.push(p.kind === 'popup' ? 'popup' : 'background');
    return bits.length ? bits.join(', ') : 'nothing usable';
  }

  function render() {
    const rows = $('.js-rows');
    rows.textContent = '';
    for (const b of boosts) {
      const tr = document.createElement('tr');
      if (!selected.has(b.id)) tr.classList.add('is-off');

      const tdBox = document.createElement('td');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = selected.has(b.id);
      box.disabled = !b.convertible;
      box.setAttribute('aria-label', `Ship ${b.name}`);
      box.addEventListener('change', () => {
        if (box.checked) selected.add(b.id); else selected.delete(b.id);
        render();
      });
      tdBox.appendChild(box);

      const tdName = document.createElement('td');
      const name = document.createElement('span');
      name.className = 'cargo-name';
      name.textContent = b.name;
      tdName.appendChild(name);
      for (const n of b.notes) {
        const s = document.createElement('span');
        s.className = 'cargo-note';
        s.textContent = n;
        tdName.appendChild(s);
      }
      for (const w of b.warnings) {
        const s = document.createElement('span');
        s.className = 'cargo-warn';
        s.textContent = w;
        tdName.appendChild(s);
      }

      const tdSites = document.createElement('td');
      tdSites.textContent = b.sites.length ? b.sites.join(', ') : 'Arc only';
      const tdLoad = document.createElement('td');
      tdLoad.textContent = contentsLabel(b);

      tr.append(tdBox, tdName, tdSites, tdLoad);
      rows.appendChild(tr);
    }
    renderPalette();
    const chosen = boosts.filter((b) => selected.has(b.id) && b.convertible);
    const total = boosts.length;
    $('.js-cargo-title').textContent = `Your manifest: ${total} Boost${total === 1 ? '' : 's'} found`;
    $('.js-summary').textContent = chosen.length
      ? `${chosen.length} ready to ship`
      : 'Tick at least one Boost';

    const dl = $('.js-download');
    const buy = $('.js-buy');
    const note = $('.js-buy-note');
    if (canDownload()) {
      dl.hidden = false;
      dl.disabled = !chosen.length;
      dl.textContent = cargoIsSample && EDITION !== 'full' ? 'Download sample archive' : 'Download archive';
      if (buy) buy.hidden = true;
      if (note) note.hidden = true;
    } else {
      dl.hidden = true;
      if (buy) {
        buy.hidden = !chosen.length;
        buy.textContent = `Ship ${chosen.length} Boost${chosen.length === 1 ? '' : 's'} for $5`;
        buy.href = KOFI_URL || '#price';
        if (!KOFI_URL) buy.removeAttribute('target');
      }
      if (note) note.hidden = false;
    }
  }

  function renderPalette() {
    const vars = Array.from(new Set(boosts.filter((b) => selected.has(b.id)).flatMap((b) => b.paletteVars))).sort();
    const wrap = $('.js-palette');
    const grid = $('.js-palette-grid');
    grid.textContent = '';
    wrap.hidden = !vars.length;
    for (const v of vars) {
      const value = palette[v] || core.DEFAULT_PALETTE[v] || '#888888';
      const label = document.createElement('label');
      const isHex = /^#[0-9a-f]{6}$/i.test(value);
      const input = document.createElement('input');
      input.type = isHex ? 'color' : 'text';
      input.value = value;
      input.addEventListener('input', () => { palette[v] = input.value; });
      const span = document.createElement('span');
      span.textContent = v.replace('--arc-palette-', '').replace('--arc-', '');
      label.append(input, span);
      grid.appendChild(label);
    }
  }

  function showCargo(result, sourceLabel, isSample) {
    boosts = result.boosts;
    cargoIsSample = !!isSample;
    selected.clear();
    for (const b of boosts) if (b.convertible && b.enabledInArc) selected.add(b.id);
    if (!boosts.length) {
      status(`No Boosts in ${sourceLabel}. Look for the folder named boosts, with folders inside that hold boost.config.json.`);
      return;
    }
    status(`${boosts.length} Boost${boosts.length === 1 ? '' : 's'} found in ${sourceLabel}.`);
    $('.js-cargo').hidden = false;
    $$('.dock .rise').forEach((el) => el.classList.add('is-in'));
    render();
    $('.js-cargo').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  async function handleFiles(files, label, isSample) {
    try {
      const parsed = core.parseBoosts(files);
      showCargo(parsed, label, isSample);
    } catch (err) {
      status('Something in that folder could not be read. Try picking the boosts folder itself.');
      console.error(err);
    }
  }

  function download() {
    const chosen = boosts.filter((b) => selected.has(b.id) && b.convertible);
    if (!chosen.length || !canDownload()) return;
    const files = core.buildExport(chosen, { palette });
    const zip = core.makeZip(files);
    const blob = new Blob([zip], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'arc-boosts.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    $('.js-summary').textContent = `Archive ready: ${chosen.length} Boost${chosen.length === 1 ? '' : 's'}. Install steps are in README.txt.`;
  }

  // Sample cargo, written for this page.
  const DEMO = [
    ['demo/1a2b/boost.config.json', JSON.stringify({ id: '1a2b', name: 'Quiet YouTube', scope: 'www.youtube.com', extensionEnabled: true, components: { contentStylesheet: { path: 'styles.css', enabled: true }, contentScript: { path: 'content.js', enabled: true } } })],
    ['demo/1a2b/manifest.json', JSON.stringify({ name: 'Quiet YouTube', version: '0.0.1', manifest_version: 3, content_scripts: [{ matches: ['*://*.www.youtube.com/*'], css: ['styles.css'], js: ['content.js'] }] })],
    ['demo/1a2b/styles.css', '#comments, #related { display: none !important; }\n'],
    ['demo/1a2b/content.js', "document.querySelectorAll('ytd-rich-shelf-renderer').forEach(function (n) { n.remove(); });\n"],
    ['demo/3c4d/boost.config.json', JSON.stringify({ id: '3c4d', name: 'Calm Hacker News', scope: 'news.ycombinator.com', extensionEnabled: true, components: { contentStylesheet: { path: 'styles.css', enabled: true } } })],
    ['demo/3c4d/manifest.json', JSON.stringify({ name: 'Calm Hacker News', version: '0.0.1', manifest_version: 3, content_scripts: [{ matches: ['*://*.news.ycombinator.com/*'], css: ['styles.css'] }] })],
    ['demo/3c4d/styles.css', 'body { background: var(--arc-palette-background); }\n.title a { color: var(--arc-palette-title); }\n'],
    ['demo/5e6f/boost.config.json', JSON.stringify({ id: '5e6f', name: 'Esc goes back', scope: 'twitter.com', extensionEnabled: true, components: { contentScript: { path: 'content.js', enabled: true } } })],
    ['demo/5e6f/manifest.json', JSON.stringify({ name: 'Esc goes back', version: '0.0.1', manifest_version: 3, content_scripts: [{ matches: ['*://*.twitter.com/*'], js: ['content.js'] }] })],
    ['demo/5e6f/content.js', "document.addEventListener('keydown', function (e) { if (e.key === 'Escape') history.back(); });\n"],
    ['demo/7a8b/boost.config.json', JSON.stringify({ id: '7a8b', name: 'My arc://extensions Boost', scope: 'extensions', extensionEnabled: true, components: { contentStylesheet: { path: 'styles.css', enabled: true } } })],
    ['demo/7a8b/manifest.json', JSON.stringify({ name: 'My arc://extensions Boost', version: '0.0.1', manifest_version: 3, content_scripts: [{ matches: ['*://*.extensions/*'], css: ['styles.css'] }] })],
    ['demo/7a8b/styles.css', 'body { zoom: 0.9; }\n'],
  ].map(([path, text]) => ({ path, text }));

  // ---------- wiring ----------
  function setupDock() {
    const pick = $('.js-pick');
    const drop = $('.js-drop');
    if (!pick || !drop) return;

    pick.addEventListener('change', async () => {
      if (!pick.files || !pick.files.length) return;
      const top = (pick.files[0].webkitRelativePath || '').split('/')[0] || 'that folder';
      const files = await readFileList(pick.files);
      await handleFiles(files, `“${top}”`);
      pick.value = '';
    });

    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => {
      e.preventDefault();
      drop.classList.add('is-over');
    }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('is-over')));
    drop.addEventListener('drop', async (e) => {
      e.preventDefault();
      const items = Array.from(e.dataTransfer.items || []);
      const entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
      if (!entries.length) { status('Drop the folder itself, not a file.'); return; }
      const all = [];
      try {
        for (const en of entries) await walkEntry(en, '', all);
      } catch (err) {
        status('That folder could not be opened. Try the Choose folder button.');
        return;
      }
      const files = await readEntries(all);
      await handleFiles(files, entries.length === 1 ? `“${entries[0].name}”` : 'the dropped folders');
    });

    $('.js-demo').addEventListener('click', () => handleFiles(DEMO, 'the sample cargo', true));
    $('.js-download').addEventListener('click', download);
    $('.js-reset').addEventListener('click', () => {
      boosts = [];
      selected.clear();
      $('.js-cargo').hidden = true;
      status('');
      drop.scrollIntoView({ block: 'center' });
    });
  }

  function init() {
    // Test hook for automated checks only (?selftest): load files as if picked.
    if (/[?&]selftest\b/.test(location.search)) {
      window.BoostportPage = { load: (files, label, isSample) => handleFiles(files, label || 'test', isSample), edition: EDITION };
    }
    paintCountdown();
    drawFlow();
    labelCompareCells();
    setupCopy();
    setupDock();
    setupEntrances();
    startCrossfade();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
