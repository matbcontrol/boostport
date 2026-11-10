/*
 * Boostport core: finds Arc Boosts in a list of files and converts them into
 * a Chromium extension, userscripts and UserCSS styles. No DOM, no network.
 * Works in the browser (window.BoostportCore) and in Node (module.exports).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BoostportCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '1.0.0';

  // Arc paints Boosts with its own palette variables. Other browsers don't
  // define them, so we ship editable defaults.
  const DEFAULT_PALETTE = {
    '--arc-palette-background': '#ffffff',
    '--arc-palette-backgroundExtra': '#f4f4f5',
    '--arc-palette-foregroundPrimary': '#18181b',
    '--arc-palette-foregroundSecondary': '#52525b',
    '--arc-palette-foregroundTertiary': '#a1a1aa',
    '--arc-palette-title': '#18181b',
    '--arc-palette-subtitle': '#52525b',
    '--arc-palette-hover': 'rgba(0, 0, 0, 0.06)',
    '--arc-palette-focus': '#3b82f6',
    '--arc-palette-cutoutColor': '#000000',
    '--arc-palette-maxContrastColor': '#000000',
    '--arc-palette-minContrastColor': '#ffffff',
    '--arc-background-gradient-color0': '#ffffff',
    '--arc-background-gradient-color1': '#f4f4f5',
  };
  const UNKNOWN_VAR_DEFAULT = '#888888';

  // ---------- small helpers ----------

  function basename(p) {
    const parts = p.split('/');
    return parts[parts.length - 1];
  }

  function dirname(p) {
    const i = p.lastIndexOf('/');
    return i === -1 ? '' : p.slice(0, i);
  }

  function normPath(p) {
    return String(p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '');
  }

  function isJunk(p) {
    return p.split('/').some((seg) => seg === '__MACOSX' || seg.startsWith('._') || seg === '.DS_Store');
  }

  function safeJson(text) {
    if (typeof text !== 'string') return null;
    try {
      return JSON.parse(text.replace(/^﻿/, ''));
    } catch (e) {
      return null;
    }
  }

  function slugify(name) {
    const s = String(name || 'boost')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    return s || 'boost';
  }

  function uniqueSlug(base, used) {
    let slug = base;
    let n = 2;
    while (used.has(slug)) slug = `${base}-${n++}`;
    used.add(slug);
    return slug;
  }

  // Files that may belong to a Boost. Everything else is skipped before
  // reading, so picking a big folder stays fast.
  function isCandidateFile(path) {
    const p = normPath(path);
    if (isJunk(p)) return false;
    const name = basename(p).toLowerCase();
    return /\.(css|js|json|html)$/.test(name) && !/\.min\.js$/.test(name) ? true : false;
  }

  // ---------- match patterns ----------

  function hostFromPattern(pattern) {
    if (pattern === '<all_urls>') return null;
    const m = /^([^:]+):\/\/([^/]*)(\/.*)?$/.exec(pattern);
    return m ? m[2] : undefined;
  }

  // Arc writes "*://*.<scope>/*". A host without a dot (e.g. "*.extensions")
  // means an arc:// page, which no other browser has.
  function isArcInternalPattern(pattern) {
    const host = hostFromPattern(pattern);
    if (host === null || host === undefined) return false;
    const bare = host.replace(/^\*\./, '');
    if (bare === '*' || bare === '') return false;
    return !bare.includes('.') && bare !== 'localhost';
  }

  function patternBareHost(pattern) {
    const host = hostFromPattern(pattern);
    if (!host) return null;
    return host.replace(/^\*\./, '');
  }

  function patternPath(pattern) {
    const m = /^[^:]+:\/\/[^/]*(\/.*)?$/.exec(pattern);
    return m && m[1] ? m[1] : '/*';
  }

  // twitter.com Boosts stopped matching when Twitter moved to x.com.
  const HOST_ALIASES = {
    'twitter.com': ['x.com'],
    'www.twitter.com': ['x.com'],
    'mobile.twitter.com': ['x.com'],
  };

  function withAliases(patterns) {
    const out = [];
    const notes = [];
    for (const p of patterns) {
      out.push(p);
      const host = patternBareHost(p);
      const aliases = host && HOST_ALIASES[host];
      if (aliases) {
        for (const a of aliases) {
          const ap = p.replace(host, a);
          if (!out.includes(ap) && !patterns.includes(ap)) {
            out.push(ap);
            notes.push(`Also runs on ${a} (Twitter moved there).`);
          }
        }
      }
    }
    return { patterns: out, notes };
  }

  // ---------- parsing ----------

  /**
   * files: [{ path: 'any/prefix/<boost-id>/boost.config.json', text: '...' }]
   * Returns { boosts: [...], skipped: [{ dir, reason }] }
   */
  function parseBoosts(files) {
    const byDir = new Map();
    for (const f of files) {
      const p = normPath(f.path);
      if (isJunk(p)) continue;
      const dir = dirname(p);
      if (!byDir.has(dir)) byDir.set(dir, new Map());
      byDir.get(dir).set(basename(p), typeof f.text === 'string' ? f.text : '');
    }

    const boosts = [];
    const skipped = [];
    const usedSlugs = new Set();

    for (const [dir, dirFiles] of byDir) {
      const hasConfig = dirFiles.has('boost.config.json');
      const hasManifest = dirFiles.has('manifest.json');
      if (!hasConfig) continue; // only folders Arc marks as Boosts
      const config = safeJson(dirFiles.get('boost.config.json'));
      const manifest = hasManifest ? safeJson(dirFiles.get('manifest.json')) : null;
      if (!config) {
        skipped.push({ dir, reason: 'boost.config.json could not be read' });
        continue;
      }
      const boost = buildBoost(dir, dirFiles, config, manifest, usedSlugs);
      if (boost) boosts.push(boost);
      else skipped.push({ dir, reason: 'no styles or scripts inside' });
    }

    boosts.sort((a, b) => a.name.localeCompare(b.name));
    return { boosts, skipped };
  }

  function buildBoost(dir, dirFiles, config, manifest, usedSlugs) {
    const components = config.components || {};
    const enabledPath = (key) => {
      const c = components[key];
      if (!c || !c.path) return null;
      return c.enabled === false ? null : c.path;
    };
    const disabledParts = [];
    const KNOWN_PARTS = new Set(['contentStylesheet', 'contentScript', 'backgroundScript', 'popup']);
    const unknownParts = [];
    for (const [key, c] of Object.entries(components)) {
      if (c && c.enabled === false) disabledParts.push(key);
      if (!KNOWN_PARTS.has(key) && !(c && c.enabled === false)) unknownParts.push(key);
    }
    for (const key of Object.keys(config)) {
      if (/zap/i.test(key) && !unknownParts.includes(key)) unknownParts.push(key);
    }

    const name = String((manifest && manifest.name) || config.name || basename(dir)).trim() || 'Untitled Boost';
    const description = String((manifest && manifest.description) || config.description || '').trim();
    const scope = typeof config.scope === 'string' ? config.scope.trim() : '';

    // Content scripts: the manifest is the source of truth, Arc's config
    // says which parts are switched on.
    const allowed = new Set(
      ['contentStylesheet', 'contentScript'].map(enabledPath).filter(Boolean)
    );
    const hasComponentInfo = Object.keys(components).length > 0;

    let entries = [];
    if (manifest && Array.isArray(manifest.content_scripts) && manifest.content_scripts.length) {
      entries = manifest.content_scripts.map((cs) => ({
        matches: Array.isArray(cs.matches) ? cs.matches.slice() : [],
        excludeMatches: Array.isArray(cs.exclude_matches) ? cs.exclude_matches.slice() : [],
        css: (cs.css || []).filter((p) => !hasComponentInfo || allowed.has(p)),
        js: (cs.js || []).filter((p) => !hasComponentInfo || allowed.has(p)),
        runAt: cs.run_at || 'document_idle',
        allFrames: !!cs.all_frames,
        world: cs.world || null,
      }));
    } else {
      const css = enabledPath('contentStylesheet');
      const js = enabledPath('contentScript');
      entries = [{
        matches: scope ? [`*://*.${scope}/*`] : ['<all_urls>'],
        excludeMatches: [],
        css: css ? [css] : [],
        js: js ? [js] : [],
        runAt: 'document_idle',
        allFrames: false,
        world: null,
      }];
    }

    const notes = [];
    const warnings = [];
    const missing = [];
    const read = (p) => {
      const key = basename(normPath(p));
      if (!dirFiles.has(key)) {
        missing.push(p);
        return null;
      }
      return dirFiles.get(key);
    };

    const outEntries = [];
    for (const e of entries) {
      const internal = e.matches.filter(isArcInternalPattern);
      const usable = e.matches.filter((m) => !isArcInternalPattern(m));
      if (internal.length) {
        warnings.push(`Targets an Arc-only page (${internal.map(patternBareHost).join(', ')}), so it can't run elsewhere.`);
      }
      if (!usable.length) continue;
      const aliased = withAliases(usable);
      notes.push(...aliased.notes);
      const css = e.css.map((p) => ({ file: basename(p), text: read(p) })).filter((f) => f.text !== null);
      const js = e.js.map((p) => ({ file: basename(p), text: read(p) })).filter((f) => f.text !== null);
      if (!css.length && !js.length) continue;
      outEntries.push({ ...e, matches: aliased.patterns, css, js });
    }
    for (const m of missing) warnings.push(`File ${m} is listed but missing.`);

    if (!outEntries.length && !warnings.length && !unknownParts.length) return null;

    const extraParts = [];
    const bg = enabledPath('backgroundScript') || (manifest && manifest.background && (manifest.background.service_worker || null));
    const popup = enabledPath('popup') || (manifest && manifest.action && manifest.action.default_popup) || null;
    if (bg && dirFiles.has(basename(bg))) extraParts.push({ kind: 'background', file: basename(bg) });
    if (popup && dirFiles.has(basename(popup))) extraParts.push({ kind: 'popup', file: basename(popup) });

    const cssText = outEntries.flatMap((e) => e.css.map((f) => f.text)).join('\n');
    const jsText = outEntries.flatMap((e) => e.js.map((f) => f.text)).join('\n');

    const paletteVars = Array.from(
      new Set((cssText + '\n' + jsText).match(/--arc-[A-Za-z0-9-]+/g) || [])
    ).sort();
    if (paletteVars.length) {
      notes.push('Uses Arc colors; we fill them with the palette you pick.');
    }
    if (/\bchrome\.[a-zA-Z]+/.test(jsText)) {
      warnings.push('Script calls chrome.* APIs; the userscript version may not work. Use the Chromium extension.');
    }
    if (extraParts.length) {
      notes.push(`Has a ${extraParts.map((p) => p.kind).join(' and ')} page, so it ships as its own extension.`);
    }
    if (disabledParts.length) {
      notes.push(`Parts you had switched off in Arc stay off: ${disabledParts.join(', ')}.`);
    }
    if (unknownParts.length) {
      warnings.push(`Has parts Boostport can't read yet (${unknownParts.join(', ')}); they are left out.`);
    }

    const allMatches = Array.from(new Set(outEntries.flatMap((e) => e.matches)));
    const sites = allMatches.map((m) => (m === '<all_urls>' ? 'All sites' : patternBareHost(m) || m));

    return {
      id: String(config.id || basename(dir)),
      dir,
      slug: uniqueSlug(slugify(name), usedSlugs),
      name,
      description,
      scope,
      enabledInArc: config.extensionEnabled !== false,
      entries: outEntries,
      sites: Array.from(new Set(sites)),
      hasCss: outEntries.some((e) => e.css.some((f) => f.text.trim())),
      hasJs: outEntries.some((e) => e.js.some((f) => f.text.trim())),
      extraParts,
      extraFiles: extraParts.map((p) => ({ file: p.file, text: dirFiles.get(p.file) })),
      paletteVars,
      notes: Array.from(new Set(notes)),
      warnings: Array.from(new Set(warnings)),
      convertible: outEntries.length > 0,
    };
  }

  // ---------- palette ----------

  function paletteFor(vars, overrides) {
    const out = {};
    for (const v of vars) {
      out[v] = (overrides && overrides[v]) || DEFAULT_PALETTE[v] || UNKNOWN_VAR_DEFAULT;
    }
    return out;
  }

  function paletteCss(vars, overrides) {
    if (!vars.length) return '';
    const pal = paletteFor(vars, overrides);
    const lines = Object.entries(pal).map(([k, v]) => `  ${k}: ${v};`);
    return `/* Arc palette colors, filled in by Boostport */\n:root {\n${lines.join('\n')}\n}\n`;
  }

  // ---------- userscripts ----------

  function userscriptMatches(patterns) {
    return patterns.map((p) => (p === '<all_urls>' ? '*://*/*' : p));
  }

  function headerLine(key, value) {
    return `// @${key.padEnd(12)} ${String(value).replace(/[\r\n]+/g, ' ')}`;
  }

  // Embedded matcher for the combined userscript, which runs on every
  // Boost's sites and picks the right ones at runtime.
  const MATCHER_SRC = `
  function bpMatch(pattern, href) {
    if (pattern === '<all_urls>') return /^https?:/.test(href);
    var m = /^([^:]+):\\/\\/([^/]*)(\\/.*)?$/.exec(pattern);
    if (!m) return false;
    var u;
    try { u = new URL(href); } catch (e) { return false; }
    var scheme = m[1], host = m[2], path = m[3] || '/*';
    if (scheme === '*') { if (u.protocol !== 'http:' && u.protocol !== 'https:') return false; }
    else if (u.protocol !== scheme + ':') return false;
    if (host !== '*') {
      if (host.indexOf('*.') === 0) {
        var bare = host.slice(2);
        if (u.hostname !== bare && u.hostname.slice(-(bare.length + 1)) !== '.' + bare) return false;
      } else if (u.hostname !== host) return false;
    }
    var re = new RegExp('^' + path.replace(/[.+?^\${}()|[\\]\\\\]/g, '\\\\$&').replace(/\\*/g, '.*') + '$');
    return re.test(u.pathname + u.search);
  }`;

  function cssInjectorSrc(cssExpr) {
    return `var s = document.createElement('style');
      s.setAttribute('data-boostport', '');
      s.textContent = ${cssExpr};
      (document.head || document.documentElement).appendChild(s);`;
  }

  function jsRunnerSrc(code, label) {
    // Each Boost's code runs in its own function so names don't clash.
    return `function () {
      try {
${code}
      } catch (err) { console.error('[Boostport] ${label.replace(/'/g, "\\'")}', err); }
    }`;
  }

  const RUN_LATER = `
  function bpWhenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }`;

  function boostScriptBody(boost, palette) {
    const parts = [];
    for (const e of boost.entries) {
      const css = (palette ? palette : '') + e.css.map((f) => f.text).join('\n');
      const js = e.js.map((f) => f.text).join('\n;\n');
      parts.push({ matches: e.matches, css: e.css.length ? css : '', js });
    }
    return parts;
  }

  function buildUserscript(boost, overrides) {
    const pal = paletteCss(boost.paletteVars, overrides);
    const parts = boostScriptBody(boost, pal);
    const matches = Array.from(new Set(parts.flatMap((p) => userscriptMatches(p.matches))));
    const header = [
      '// ==UserScript==',
      headerLine('name', `${boost.name} (Arc Boost)`),
      headerLine('namespace', 'boostport'),
      headerLine('version', VERSION),
      headerLine('description', boost.description || `Converted from an Arc Boost by Boostport`),
      ...matches.map((m) => headerLine('match', m)),
      headerLine('run-at', 'document-start'),
      headerLine('grant', 'none'),
      '// ==/UserScript==',
    ];
    const needsMatcher = parts.length > 1;
    const body = [];
    body.push('(function () {');
    body.push("  'use strict';");
    if (needsMatcher) body.push(MATCHER_SRC);
    body.push(RUN_LATER);
    parts.forEach((p, i) => {
      const guard = needsMatcher
        ? `if (${JSON.stringify(p.matches)}.some(function (m) { return bpMatch(m, location.href); }))`
        : '';
      body.push(`  ${guard} {`);
      if (p.css) body.push(`    ${cssInjectorSrc(JSON.stringify(p.css))}`);
      if (p.js.trim()) body.push(`    bpWhenReady(${jsRunnerSrc(p.js, boost.name + (parts.length > 1 ? ' #' + (i + 1) : ''))});`);
      body.push('  }');
    });
    body.push('})();');
    return header.join('\n') + '\n\n' + body.join('\n') + '\n';
  }

  function buildCombinedUserscript(boosts, overrides) {
    const all = [];
    for (const b of boosts) {
      const pal = paletteCss(b.paletteVars, overrides);
      for (const p of boostScriptBody(b, pal)) all.push({ boost: b, ...p });
    }
    const matches = Array.from(new Set(all.flatMap((p) => userscriptMatches(p.matches))));
    const header = [
      '// ==UserScript==',
      headerLine('name', 'All my Arc Boosts'),
      headerLine('namespace', 'boostport'),
      headerLine('version', VERSION),
      headerLine('description', `${boosts.length} Boosts converted from Arc by Boostport`),
      ...matches.map((m) => headerLine('match', m)),
      headerLine('run-at', 'document-start'),
      headerLine('grant', 'none'),
      '// ==/UserScript==',
    ];
    const body = ['(function () {', "  'use strict';", MATCHER_SRC, RUN_LATER];
    for (const p of all) {
      body.push(`  // ${p.boost.name}`);
      body.push(`  if (${JSON.stringify(p.matches)}.some(function (m) { return bpMatch(m, location.href); })) {`);
      if (p.css) body.push(`    ${cssInjectorSrc(JSON.stringify(p.css))}`);
      if (p.js.trim()) body.push(`    bpWhenReady(${jsRunnerSrc(p.js, p.boost.name)});`);
      body.push('  }');
    }
    body.push('})();');
    return header.join('\n') + '\n\n' + body.join('\n') + '\n';
  }

  // ---------- UserCSS for Stylus ----------

  function mozDocumentRule(patterns) {
    if (patterns.includes('<all_urls>')) return null;
    const rules = [];
    for (const p of patterns) {
      const host = patternBareHost(p);
      const path = patternPath(p);
      if (!host || host === '*') return null;
      if (path === '/*' || path === '/') rules.push(`domain("${host}")`);
      else rules.push(`url-prefix("https://${host}${path.replace(/\*.*$/, '')}")`);
    }
    return Array.from(new Set(rules)).join(', ');
  }

  function buildUserCss(boost, overrides) {
    const cssEntries = boost.entries.filter((e) => e.css.some((f) => f.text.trim()));
    if (!cssEntries.length) return null;
    const pal = paletteCss(boost.paletteVars, overrides);
    const blocks = cssEntries.map((e) => {
      const css = pal + e.css.map((f) => f.text).join('\n');
      const rule = mozDocumentRule(e.matches);
      return rule ? `@-moz-document ${rule} {\n${css}\n}` : css;
    });
    const header = [
      '/* ==UserStyle==',
      `@name         ${boost.name.replace(/\*\//g, '')} (Arc Boost)`,
      '@namespace    boostport',
      `@version      ${VERSION}`,
      `@description  ${(boost.description || 'Converted from an Arc Boost by Boostport').replace(/\*\//g, '')}`,
      '==/UserStyle== */',
    ];
    return header.join('\n') + '\n\n' + blocks.join('\n\n') + '\n';
  }

  // ---------- Chromium extension ----------

  function contentScriptEntry(e, prefix, extraCss) {
    const entry = { matches: e.matches };
    if (e.excludeMatches && e.excludeMatches.length) entry.exclude_matches = e.excludeMatches;
    const css = [];
    if (extraCss) css.push(extraCss);
    css.push(...e.css.map((f) => `${prefix}${f.file}`));
    if (e.css.length) entry.css = css;
    if (e.js.length) entry.js = e.js.map((f) => `${prefix}${f.file}`);
    if (e.runAt && e.runAt !== 'document_idle') entry.run_at = e.runAt;
    if (e.allFrames) entry.all_frames = true;
    if (e.world === 'MAIN') entry.world = 'MAIN';
    return entry;
  }

  function buildCombinedExtension(boosts, overrides) {
    const files = [];
    const contentScripts = [];
    for (const b of boosts) {
      const prefix = `boosts/${b.slug}/`;
      const pal = paletteCss(b.paletteVars, overrides);
      let palFile = null;
      if (pal) {
        palFile = `${prefix}arc-palette.css`;
        files.push({ path: palFile, content: pal });
      }
      const written = new Set();
      for (const e of b.entries) {
        for (const f of [...e.css, ...e.js]) {
          if (written.has(f.file)) continue;
          written.add(f.file);
          files.push({ path: prefix + f.file, content: f.text });
        }
        contentScripts.push(contentScriptEntry(e, prefix, palFile));
      }
    }
    const manifest = {
      manifest_version: 3,
      name: 'My Arc Boosts',
      version: VERSION,
      description: `${boosts.length} Boosts moved from Arc with Boostport.`,
      content_scripts: contentScripts,
    };
    files.unshift({ path: 'manifest.json', content: JSON.stringify(manifest, null, 2) + '\n' });
    return files;
  }

  function buildSeparateExtension(boost, overrides) {
    const files = [];
    const pal = paletteCss(boost.paletteVars, overrides);
    const palFile = pal ? 'arc-palette.css' : null;
    if (pal) files.push({ path: palFile, content: pal });
    const written = new Set();
    for (const e of boost.entries) {
      for (const f of [...e.css, ...e.js]) {
        if (written.has(f.file)) continue;
        written.add(f.file);
        files.push({ path: f.file, content: f.text });
      }
    }
    for (const f of boost.extraFiles) {
      if (!written.has(f.file)) files.push({ path: f.file, content: f.text });
    }
    const manifest = {
      manifest_version: 3,
      name: `${boost.name} (Arc Boost)`,
      version: VERSION,
      description: boost.description || 'Moved from Arc with Boostport.',
      content_scripts: boost.entries.map((e) => contentScriptEntry(e, '', palFile)),
    };
    const bg = boost.extraParts.find((p) => p.kind === 'background');
    const popup = boost.extraParts.find((p) => p.kind === 'popup');
    if (bg) manifest.background = { service_worker: bg.file };
    if (popup) manifest.action = { default_popup: popup.file };
    files.unshift({ path: 'manifest.json', content: JSON.stringify(manifest, null, 2) + '\n' });
    return files;
  }

  // ---------- README ----------

  function buildReadme(selected, separate, combinedCount) {
    const lines = [];
    lines.push('YOUR ARC BOOSTS, READY TO MOVE');
    lines.push('Made with Boostport. Nothing left your computer.');
    lines.push('');
    lines.push(`Boosts in this archive: ${selected.length}`);
    lines.push('');
    lines.push('CHROME, DIA, EDGE, BRAVE, OPERA, VIVALDI');
    lines.push('  1. Unzip this archive somewhere you will keep it (the browser loads the folder from disk).');
    lines.push('  2. Open chrome://extensions (Dia, Edge and Brave use their own name for the same page).');
    lines.push('  3. Turn on Developer mode.');
    lines.push('  4. Click "Load unpacked" and pick the folder chromium/my-arc-boosts.');
    if (separate.length) {
      lines.push('  5. Repeat "Load unpacked" for each folder in chromium/separate/');
      lines.push('     (these Boosts have a background or popup page, so they need their own extension).');
    }
    lines.push('');
    lines.push('ZEN, FIREFOX, SAFARI (and Chromium too, if you prefer userscripts)');
    lines.push('  1. Install a userscript manager: Violentmonkey or Tampermonkey (Zen, Firefox, Chromium),');
    lines.push('     or the Userscripts app (Safari).');
    lines.push('  2. Open userscripts/all-boosts.user.js in the browser, or drag it into the manager, and confirm.');
    lines.push('     Prefer them one by one? Use the files in userscripts/single/ instead. Do not install both.');
    lines.push('');
    lines.push('STYLE-ONLY BOOSTS IN STYLUS (optional)');
    lines.push('  Stylus users can open any file in stylus/ and install it as a UserCSS style.');
    lines.push('  Skip this if you already installed the userscripts, or the styles will apply twice.');
    lines.push('');
    lines.push('WHAT WAS CONVERTED');
    for (const b of selected) {
      const kinds = [b.hasCss ? 'styles' : null, b.hasJs ? 'script' : null, ...b.extraParts.map((p) => p.kind)].filter(Boolean);
      lines.push(`  - ${b.name} [${b.sites.join(', ')}] ${kinds.join(' + ')}`);
      for (const n of b.notes) lines.push(`      note: ${n}`);
      for (const w of b.warnings) lines.push(`      warning: ${w}`);
    }
    lines.push('');
    lines.push(`Combined extension holds ${combinedCount} Boost(s); ${separate.length} ship separately.`);
    lines.push('Boostport is independent and not affiliated with The Browser Company.');
    return lines.join('\n') + '\n';
  }

  // ---------- full export ----------

  /**
   * Returns [{ path, content }] for the archive.
   * options: { palette: { '--arc-palette-title': '#000', ... } }
   */
  function buildExport(boosts, options) {
    const overrides = (options && options.palette) || {};
    const selected = boosts.filter((b) => b.convertible);
    const separate = selected.filter((b) => b.extraParts.length);
    const combined = selected.filter((b) => !b.extraParts.length);
    const out = [];
    const root = 'arc-boosts/';

    if (combined.length) {
      for (const f of buildCombinedExtension(combined, overrides)) {
        out.push({ path: `${root}chromium/my-arc-boosts/${f.path}`, content: f.content });
      }
    }
    for (const b of separate) {
      for (const f of buildSeparateExtension(b, overrides)) {
        out.push({ path: `${root}chromium/separate/${b.slug}/${f.path}`, content: f.content });
      }
    }
    if (selected.length) {
      out.push({ path: `${root}userscripts/all-boosts.user.js`, content: buildCombinedUserscript(selected, overrides) });
      for (const b of selected) {
        out.push({ path: `${root}userscripts/single/${b.slug}.user.js`, content: buildUserscript(b, overrides) });
      }
      for (const b of selected) {
        const css = buildUserCss(b, overrides);
        if (css) out.push({ path: `${root}stylus/${b.slug}.user.css`, content: css });
      }
    }
    out.unshift({ path: `${root}README.txt`, content: buildReadme(selected, separate, combined.length) });
    return out;
  }

  // ---------- ZIP (store, no compression) ----------

  let CRC_TABLE = null;
  function crc32(bytes) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        CRC_TABLE[n] = c >>> 0;
      }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function toBytes(content) {
    if (content instanceof Uint8Array) return content;
    return new TextEncoder().encode(String(content));
  }

  function dosDateTime(d) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time: time & 0xffff, date: date & 0xffff };
  }

  function makeZip(entries, when) {
    const enc = new TextEncoder();
    const { time, date } = dosDateTime(when || new Date());
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const e of entries) {
      const name = enc.encode(e.path);
      const data = toBytes(e.content);
      const crc = crc32(data);
      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); // UTF-8 names
      lv.setUint16(8, 0, true); // store
      lv.setUint16(10, time, true);
      lv.setUint16(12, date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);
      local.set(name, 30);
      chunks.push(local, data);

      const cen = new Uint8Array(46 + name.length);
      const cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, time, true);
      cv.setUint16(14, date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      cen.set(name, 46);
      central.push(cen);
      offset += local.length + data.length;
    }

    const cenSize = central.reduce((s, c) => s + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cenSize, true);
    ev.setUint32(16, offset, true);

    const total = offset + cenSize + end.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) { out.set(c, pos); pos += c.length; }
    for (const c of central) { out.set(c, pos); pos += c.length; }
    out.set(end, pos);
    return out;
  }

  return {
    VERSION,
    DEFAULT_PALETTE,
    isCandidateFile,
    parseBoosts,
    buildExport,
    buildUserscript,
    buildCombinedUserscript,
    buildUserCss,
    buildCombinedExtension,
    paletteCss,
    makeZip,
    crc32,
    _internal: { isArcInternalPattern, mozDocumentRule, withAliases, slugify },
  };
});
