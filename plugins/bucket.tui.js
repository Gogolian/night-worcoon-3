// plugins/bucket.tui.js
//
// TUI extension for the Bucket plugin. When the "bucket" plugin is enabled
// in the currently-selected config, the TUI exposes a dedicated "Bucket" tab
// that lets the user:
//   • inspect each configured collection (and its items),
//   • edit collection settings (path, idPattern, responseTemplate),
//   • add or remove collections,
//   • view, add, edit and delete individual records,
//   • see exactly where state is persisted on disk (and surface a clear
//     warning when persistence is not configured).
//
// Edits go through the same `bucket.persistPath` JSON file the runtime
// plugin reads/writes — when the proxy is currently running, the host TUI
// restarts it after every change so the in-memory state is reloaded.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PLUGIN_NAME = 'bucket';

// ---------- pure helpers ----------

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function pretty(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

function previewItem(rec) {
  const s = pretty(rec);
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

function compileIdPattern(pattern) {
  if (pattern === 'uuid') {
    return { kind: 'uuid', regex: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/ };
  }
  if (pattern === 'numeric') {
    return { kind: 'numeric', regex: /^\d+$/ };
  }
  if (pattern === 'alphanumeric') {
    return { kind: 'alphanumeric', regex: /^[A-Za-z0-9]+$/ };
  }
  if (typeof pattern === 'string' && pattern.startsWith('regex:')) {
    return { kind: 'regex', regex: new RegExp(`^${pattern.slice(6)}$`) };
  }
  throw new Error(`unknown idPattern "${pattern}"`);
}

function generateId(col, items) {
  if (col.kind === 'uuid') return crypto.randomUUID();
  if (col.kind === 'numeric') {
    let max = 0;
    for (const k of Object.keys(items)) {
      const n = parseInt(k, 10);
      if (!Number.isNaN(n) && n > max) max = n;
    }
    return String(max + 1);
  }
  // alphanumeric / regex: try a few random ids that match the pattern.
  for (let i = 0; i < 20; i++) {
    const candidate = crypto.randomBytes(6).toString('base64url')
      .replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
    if (candidate && col.regex.test(candidate)) return candidate;
  }
  return null;
}

function readState(persistPath) {
  if (!persistPath || !fs.existsSync(persistPath)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(persistPath, 'utf8'));
    return isObject(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeState(persistPath, state) {
  fs.mkdirSync(path.dirname(persistPath), { recursive: true });
  fs.writeFileSync(persistPath, JSON.stringify(state, null, 2));
}

// ---------- module export ----------

export default {
  tabName: 'Bucket',

  isEnabled(cfg) {
    return Array.isArray(cfg?.plugins) && cfg.plugins.includes(PLUGIN_NAME);
  },

  build({ screen, page, helpers }) {
    const {
      blessed,
      logger,
      configsDir,
      getConfigEntry,
      saveConfigEntry,
      restartIfActive,
      promptValue,
      promptChoice,
      popupBox,
      pushPopup,
      popPopup,
      leaveContentFocus,
      requestRender,
      requestHelpRefresh,
      POPUP_BG, INPUT_BG, INPUT_FG,
    } = helpers;

    // Resolve a user-supplied persistPath the same way the runtime plugin
    // does — relative to the project root (configsDir's parent).
    const projectRoot = path.resolve(configsDir, '..');
    function resolvePersistPath(p) {
      if (!p) return null;
      return path.isAbsolute(p) ? p : path.resolve(projectRoot, p);
    }

    // ---------- widgets ----------

    // Top banner: persistPath info / warnings.
    const banner = blessed.box({
      parent: page,
      top: 0, left: 0, right: 0, height: 3,
      border: 'line',
      tags: true,
      style: { border: { fg: 'cyan' }, fg: 'white' },
      content: '',
    });

    // Left pane: collections list.
    const collectionsList = blessed.list({
      parent: page,
      label: ' collections ',
      top: 3, left: 0, bottom: 0, width: '38%',
      border: 'line',
      keys: false, mouse: true,
      tags: true,
      style: {
        selected: { bg: 'blue', fg: 'white', bold: true },
        item: { fg: 'white' },
        border: { fg: 'cyan' },
      },
    });

    // Right side container.
    const right = blessed.box({
      parent: page,
      top: 3, left: '38%', right: 0, bottom: 0,
    });

    // Right top: collection details.
    const detailsList = blessed.list({
      parent: right,
      label: ' collection details ',
      top: 0, left: 0, right: 0, height: 9,
      border: 'line',
      keys: false, mouse: true,
      tags: true,
      style: {
        selected: { bg: 'blue', fg: 'white', bold: true },
        item: { fg: 'white' },
        border: { fg: 'cyan' },
      },
    });

    // Right bottom: items list.
    const itemsList = blessed.list({
      parent: right,
      label: ' items ',
      top: 9, left: 0, right: 0, bottom: 0,
      border: 'line',
      keys: false, mouse: true,
      tags: true,
      style: {
        selected: { bg: 'blue', fg: 'white', bold: true },
        item: { fg: 'white' },
        border: { fg: 'cyan' },
      },
    });

    // ---------- state ----------

    /** which sub-pane has logical focus: 'collections' | 'details' | 'items' */
    let pane = 'collections';
    /** index into the rendered collections list (last virtual row = "+ add") */
    let colIdx = 0;
    /** index into details rows (see buildDetailRows) */
    let detailIdx = 0;
    /** index into items rows (last virtual row = "+ add item") */
    let itemIdx = 0;

    // Cache of current config + state file contents, refreshed on show/refresh.
    let cache = {
      cfg: null,                 // full config object
      bucketCfg: null,           // cfg.bucket || {}
      collections: [],           // [{ path, idPattern, kind, regex, responseTemplate, items }]
      persistPath: null,         // resolved absolute path
      stateExists: false,        // whether persistPath file currently exists
    };

    function getEntryConfig() {
      const entry = getConfigEntry();
      return entry?.config || null;
    }

    function refresh() {
      const cfg = getEntryConfig();
      const bc = cfg?.bucket && isObject(cfg.bucket) ? cfg.bucket : {};
      const persistPath = resolvePersistPath(bc.persistPath);
      const state = persistPath ? readState(persistPath) : {};
      const stateExists = !!(persistPath && fs.existsSync(persistPath));

      const collections = (Array.isArray(bc.collections) ? bc.collections : []).map((c) => {
        const colPath = (c.path || '').replace(/\/+$/, '');
        const pattern = c.idPattern || 'alphanumeric';
        let compiled;
        try { compiled = compileIdPattern(pattern); }
        catch { compiled = { kind: 'invalid', regex: /^$/ }; }
        const items = state[colPath]?.items && isObject(state[colPath].items)
          ? state[colPath].items
          : {};
        return {
          path: colPath,
          idPattern: pattern,
          kind: compiled.kind,
          regex: compiled.regex,
          responseTemplate: c.responseTemplate ?? null,
          items,
        };
      });

      cache = { cfg, bucketCfg: bc, collections, persistPath, stateExists };

      // Clamp indices.
      if (colIdx > collections.length) colIdx = collections.length; // collections.length = "[+ add]"
      if (colIdx < 0) colIdx = 0;
      const detailRowCount = buildDetailRows().length;
      if (detailIdx >= detailRowCount) detailIdx = Math.max(0, detailRowCount - 1);
      const itemRowCount = buildItemRows().length;
      if (itemIdx >= itemRowCount) itemIdx = Math.max(0, itemRowCount - 1);

      renderAll();
    }

    function renderBanner() {
      const lines = [];
      if (!cache.cfg) {
        lines.push(' {red-fg}no config selected{/}');
      } else if (!cache.persistPath) {
        lines.push(' {yellow-fg}⚠  bucket.persistPath is not set — items cannot be inspected from the TUI.{/}');
        lines.push(' Press [P] to set a persist path (recommended:  ./recordings/<name>-bucket.json )');
      } else if (!cache.stateExists) {
        lines.push(` persist file: {cyan-fg}${cache.persistPath}{/}  {yellow-fg}(not yet created — will be written on first change){/}`);
      } else {
        const total = cache.collections.reduce((s, c) => s + Object.keys(c.items).length, 0);
        lines.push(` persist file: {cyan-fg}${cache.persistPath}{/}  {green-fg}(${total} item(s) across ${cache.collections.length} collection(s)){/}`);
      }
      banner.setContent(lines.join('\n'));
    }

    function renderCollections() {
      const items = [];
      if (!cache.collections.length) {
        items.push(' {yellow-fg}(no collections defined){/}');
      } else {
        for (const c of cache.collections) {
          const count = Object.keys(c.items).length;
          const invalid = c.kind === 'invalid' ? ' {red-fg}!{/}' : '';
          items.push(` {cyan-fg}${c.path || '(?)'}{/}${invalid}  {white-fg}(${count}){/}`);
        }
      }
      items.push(' {green-fg}[+ add collection]{/}');
      collectionsList.setItems(items);
      // colIdx == cache.collections.length when "[+ add]" is selected.
      // When list shows the "(no collections defined)" placeholder there is
      // an extra header line; account for it.
      const offset = cache.collections.length ? 0 : 1;
      let sel = colIdx + offset;
      if (sel >= items.length) sel = items.length - 1;
      collectionsList.select(sel);
    }

    function currentCollection() {
      if (colIdx < 0 || colIdx >= cache.collections.length) return null;
      return cache.collections[colIdx];
    }

    // Detail rows for the currently-selected collection.
    // Each row: { kind: 'path'|'idPattern'|'responseTemplate'|'delete', label }
    function buildDetailRows() {
      const col = currentCollection();
      if (!col) return [{ kind: 'placeholder', label: ' (select a collection or press [+ add collection]) ' }];
      const tplPreview = col.responseTemplate
        ? pretty(col.responseTemplate).slice(0, 60)
        : '(none)';
      return [
        { kind: 'path', label: ` path             :  {cyan-fg}${col.path}{/}` },
        { kind: 'idPattern', label: ` idPattern        :  {magenta-fg}${col.idPattern}{/}` },
        { kind: 'responseTemplate', label: ` responseTemplate :  ${tplPreview}` },
        { kind: 'delete', label: ` {red-fg}[delete this collection]{/}` },
      ];
    }

    function renderDetails() {
      const rows = buildDetailRows();
      detailsList.setItems(rows.map((r) => r.label));
      const sel = Math.min(detailIdx, rows.length - 1);
      detailsList.select(Math.max(0, sel));
    }

    // Item rows for the currently-selected collection.
    // Each row: { kind: 'item', id } or { kind: 'add' } or { kind: 'placeholder' }
    function buildItemRows() {
      const col = currentCollection();
      if (!col) return [{ kind: 'placeholder', label: '' }];
      const ids = Object.keys(col.items);
      const rows = ids.map((id) => ({
        kind: 'item',
        id,
        label: ` {yellow-fg}${String(id).padEnd(20)}{/}  ${previewItem(col.items[id])}`,
      }));
      if (cache.persistPath) {
        rows.push({ kind: 'add', label: ' {green-fg}[+ add item]{/}' });
      } else {
        rows.push({ kind: 'placeholder', label: ' {yellow-fg}(set persistPath in the banner to add items){/}' });
      }
      return rows;
    }

    function renderItems() {
      const rows = buildItemRows();
      const col = currentCollection();
      const count = col ? Object.keys(col.items).length : 0;
      itemsList.setLabel(col
        ? ` items (${count}) — ${col.path} `
        : ' items ');
      itemsList.setItems(rows.length ? rows.map((r) => r.label) : ['']);
      const sel = Math.min(itemIdx, rows.length - 1);
      itemsList.select(Math.max(0, sel));
    }

    function renderFrames(isActive) {
      // Tab is active and our content has focus → highlight the focused pane.
      const colsActive = isActive && pane === 'collections';
      const detActive = isActive && pane === 'details';
      const itmActive = isActive && pane === 'items';

      collectionsList.setLabel(colsActive ? ' [ collections ] ' : ' collections ');
      collectionsList.style.border.fg = colsActive ? 'white' : 'cyan';

      detailsList.setLabel(detActive ? ' [ collection details ] ' : ' collection details ');
      detailsList.style.border.fg = detActive ? 'white' : 'cyan';

      const col = currentCollection();
      const count = col ? Object.keys(col.items).length : 0;
      const itemsLabelBase = col ? `items (${count}) — ${col.path}` : 'items';
      itemsList.setLabel(itmActive ? ` [ ${itemsLabelBase} ] ` : ` ${itemsLabelBase} `);
      itemsList.style.border.fg = itmActive ? 'white' : 'cyan';

      banner.style.border.fg = isActive ? 'cyan' : 'cyan';
    }

    function renderAll() {
      renderBanner();
      renderCollections();
      renderDetails();
      renderItems();
      renderFrames(true);
      requestRender();
    }

    // ---------- mutation helpers ----------

    function saveBucketConfig() {
      // Save updated cfg.bucket back through the host saver.
      const entry = getConfigEntry();
      if (!entry?.config) return;
      saveConfigEntry();
      // Restart only after successful disk write.
    }

    async function persistAndReload() {
      // Write current cache.collections.items to the persist file, then
      // restart the proxy if it is running so the bucket plugin reloads
      // its in-memory state from disk.
      if (!cache.persistPath) return;
      const out = {};
      for (const c of cache.collections) {
        out[c.path] = { items: { ...c.items } };
      }
      try {
        writeState(cache.persistPath, out);
        cache.stateExists = true;
      } catch (e) {
        logger.error(`[bucket-tui] failed to write persist file: ${e.message}`);
        return;
      }
      try { await restartIfActive(); } catch {}
    }

    // ---------- popups specific to bucket ----------

    async function promptIdPattern(initial = 'alphanumeric') {
      const builtins = ['uuid', 'numeric', 'alphanumeric', 'regex:…'];
      const pickInitial = initial?.startsWith('regex:') ? 3
        : Math.max(0, builtins.indexOf(initial));
      const picked = await promptChoice({
        label: 'pick idPattern',
        options: builtins.map((b) => ({ label: b, value: b })),
        initialIdx: pickInitial,
      });
      if (picked === null) return null;
      if (picked === 'regex:…') {
        const initialRegex = initial?.startsWith('regex:') ? initial.slice(6) : '';
        const re = await promptValue({
          label: 'regex pattern (without surrounding ^…$)',
          initial: initialRegex,
        });
        if (re === null) return null;
        try { new RegExp(re); }
        catch (e) {
          logger.warn(`[bucket-tui] invalid regex: ${e.message}`);
          return null;
        }
        return `regex:${re}`;
      }
      return picked;
    }

    // Two-field popup for adding a collection (path + idPattern).
    async function promptNewCollection() {
      const p = await promptValue({
        label: 'new collection path (e.g. /api/users)',
        initial: '/api/',
      });
      if (p === null) return null;
      const trimmed = p.trim().replace(/\/+$/, '');
      if (!trimmed || !trimmed.startsWith('/')) {
        logger.warn('[bucket-tui] collection path must start with "/"');
        return null;
      }
      if (cache.collections.some((c) => c.path === trimmed)) {
        logger.warn(`[bucket-tui] collection ${trimmed} already exists`);
        return null;
      }
      const pattern = await promptIdPattern();
      if (pattern === null) return null;
      return { path: trimmed, idPattern: pattern };
    }

    async function confirm(label) {
      const v = await promptChoice({
        label,
        options: [
          { label: 'no',  value: false },
          { label: 'yes', value: true  },
        ],
        initialIdx: 0,
      });
      return v === true;
    }

    // ---------- collection actions ----------

    async function addCollection() {
      const cfg = getEntryConfig();
      if (!cfg) return;
      cfg.bucket ||= {};
      cfg.bucket.collections ||= [];
      const nc = await promptNewCollection();
      if (!nc) return;
      cfg.bucket.collections.push(nc);
      saveBucketConfig();
      refresh();
      // Move selection to the freshly-added collection.
      colIdx = cache.collections.findIndex((c) => c.path === nc.path);
      if (colIdx < 0) colIdx = 0;
      renderCollections();
      renderDetails();
      renderItems();
      requestRender();
      try { await restartIfActive(); } catch {}
    }

    async function deleteCurrentCollection() {
      const col = currentCollection();
      if (!col) return;
      const cfg = getEntryConfig();
      if (!cfg?.bucket?.collections) return;
      const ok = await confirm(`delete collection ${col.path}?`);
      if (!ok) return;
      cfg.bucket.collections = cfg.bucket.collections.filter(
        (c) => (c.path || '').replace(/\/+$/, '') !== col.path,
      );
      saveBucketConfig();
      // Also drop the collection's items from the persist file.
      if (cache.persistPath && cache.stateExists) {
        const state = readState(cache.persistPath);
        delete state[col.path];
        try { writeState(cache.persistPath, state); } catch (e) {
          logger.warn(`[bucket-tui] could not update persist file: ${e.message}`);
        }
      }
      refresh();
      pane = 'collections';
      try { await restartIfActive(); } catch {}
    }

    async function editCollectionPath() {
      const col = currentCollection();
      if (!col) return;
      const v = await promptValue({ label: 'collection path', initial: col.path });
      if (v === null) return;
      const trimmed = v.trim().replace(/\/+$/, '');
      if (!trimmed || !trimmed.startsWith('/')) {
        logger.warn('[bucket-tui] path must start with "/"');
        return;
      }
      if (trimmed === col.path) return;
      if (cache.collections.some((c) => c.path === trimmed)) {
        logger.warn(`[bucket-tui] collection ${trimmed} already exists`);
        return;
      }
      const cfg = getEntryConfig();
      const cc = cfg.bucket.collections.find(
        (c) => (c.path || '').replace(/\/+$/, '') === col.path,
      );
      if (cc) cc.path = trimmed;
      // Move existing items to the new key in the persist file.
      if (cache.persistPath) {
        const state = readState(cache.persistPath);
        if (state[col.path]) {
          state[trimmed] = state[col.path];
          delete state[col.path];
          try { writeState(cache.persistPath, state); } catch (e) {
            logger.warn(`[bucket-tui] could not rename persist key: ${e.message}`);
          }
        }
      }
      saveBucketConfig();
      refresh();
      try { await restartIfActive(); } catch {}
    }

    async function editCollectionIdPattern() {
      const col = currentCollection();
      if (!col) return;
      const next = await promptIdPattern(col.idPattern);
      if (next === null || next === col.idPattern) return;
      // Validate that all existing item ids still match the new pattern.
      let compiled;
      try { compiled = compileIdPattern(next); }
      catch (e) { logger.warn(`[bucket-tui] ${e.message}`); return; }
      const bad = Object.keys(col.items).find((k) => !compiled.regex.test(k));
      if (bad) {
        const ok = await confirm(`existing id "${bad}" does not match new pattern — change anyway?`);
        if (!ok) return;
      }
      const cfg = getEntryConfig();
      const cc = cfg.bucket.collections.find(
        (c) => (c.path || '').replace(/\/+$/, '') === col.path,
      );
      if (cc) cc.idPattern = next;
      saveBucketConfig();
      refresh();
      try { await restartIfActive(); } catch {}
    }

    async function editResponseTemplate() {
      const col = currentCollection();
      if (!col) return;
      const initial = col.responseTemplate
        ? JSON.stringify(col.responseTemplate, null, 2)
        : '';
      const v = await promptValue({
        label: `responseTemplate for ${col.path} (empty = none)`,
        initial,
        multiline: true,
      });
      if (v === null) return;
      const cfg = getEntryConfig();
      const cc = cfg.bucket.collections.find(
        (c) => (c.path || '').replace(/\/+$/, '') === col.path,
      );
      if (!cc) return;
      const trimmed = v.trim();
      if (!trimmed) {
        delete cc.responseTemplate;
      } else {
        try { cc.responseTemplate = JSON.parse(trimmed); }
        catch (e) {
          logger.warn(`[bucket-tui] invalid JSON: ${e.message}`);
          return;
        }
      }
      saveBucketConfig();
      refresh();
      try { await restartIfActive(); } catch {}
    }

    // ---------- persistPath actions ----------

    async function configurePersistPath() {
      const cfg = getEntryConfig();
      if (!cfg) return;
      cfg.bucket ||= {};
      const suggested = cfg.bucket.persistPath
        ?? `./recordings/${(cfg.name ?? 'bucket').replace(/\s+/g, '-')}-bucket.json`;
      const v = await promptValue({
        label: 'bucket.persistPath (relative to project root)',
        initial: suggested,
      });
      if (v === null) return;
      const trimmed = v.trim();
      if (!trimmed) { delete cfg.bucket.persistPath; }
      else { cfg.bucket.persistPath = trimmed; }
      saveBucketConfig();
      refresh();
      try { await restartIfActive(); } catch {}
    }

    // ---------- item actions ----------

    async function addItem() {
      const col = currentCollection();
      if (!col || !cache.persistPath) return;
      const v = await promptValue({
        label: `new item in ${col.path} (JSON object — id auto-assigned if missing)`,
        initial: '{\n  \n}',
        multiline: true,
      });
      if (v === null) return;
      let parsed;
      try { parsed = JSON.parse(v); }
      catch (e) { logger.warn(`[bucket-tui] invalid JSON: ${e.message}`); return; }
      if (!isObject(parsed)) {
        logger.warn('[bucket-tui] item must be a JSON object');
        return;
      }
      let id = parsed.id != null ? String(parsed.id) : null;
      if (id != null && !col.regex.test(id)) {
        logger.warn(`[bucket-tui] supplied id "${id}" does not match pattern ${col.idPattern}`);
        return;
      }
      if (id != null && col.items[id]) {
        logger.warn(`[bucket-tui] id "${id}" already exists`);
        return;
      }
      if (id == null) {
        id = generateId(col, col.items);
        if (id == null) {
          logger.warn(`[bucket-tui] could not auto-generate id for pattern ${col.idPattern}`);
          return;
        }
      }
      col.items[id] = { ...parsed, id };
      await persistAndReload();
      refresh();
      // Select the freshly-added item.
      const rows = buildItemRows();
      const newIdx = rows.findIndex((r) => r.kind === 'item' && r.id === id);
      if (newIdx >= 0) itemIdx = newIdx;
      renderItems();
      requestRender();
    }

    async function editItemAtCursor() {
      const col = currentCollection();
      if (!col) return;
      const rows = buildItemRows();
      const row = rows[itemIdx];
      if (!row || row.kind !== 'item') return;
      const initial = JSON.stringify(col.items[row.id], null, 2);
      const v = await promptValue({
        label: `edit ${col.path}/${row.id} (JSON object — id is preserved)`,
        initial,
        multiline: true,
      });
      if (v === null) return;
      let parsed;
      try { parsed = JSON.parse(v); }
      catch (e) { logger.warn(`[bucket-tui] invalid JSON: ${e.message}`); return; }
      if (!isObject(parsed)) { logger.warn('[bucket-tui] item must be a JSON object'); return; }
      col.items[row.id] = { ...parsed, id: row.id };
      await persistAndReload();
      refresh();
    }

    async function deleteItemAtCursor() {
      const col = currentCollection();
      if (!col) return;
      const rows = buildItemRows();
      const row = rows[itemIdx];
      if (!row || row.kind !== 'item') return;
      const ok = await confirm(`delete ${col.path}/${row.id}?`);
      if (!ok) return;
      delete col.items[row.id];
      await persistAndReload();
      refresh();
    }

    // ---------- key handler ----------

    // Move selection within a sub-pane; returns true if movement happened,
    // false if the caller should "escape" (e.g. up at top of leftmost list).
    function moveCollections(delta) {
      const max = cache.collections.length; // last index = "[+ add]"
      const next = colIdx + delta;
      if (next < 0) return false;
      if (next > max) return true; // can't go further down, but stay in pane
      colIdx = next;
      renderCollections();
      renderDetails();
      renderItems();
      requestRender();
      return true;
    }

    function moveDetails(delta) {
      const rows = buildDetailRows();
      const next = detailIdx + delta;
      if (next < 0) return false;
      if (next >= rows.length) return false;
      detailIdx = next;
      renderDetails();
      requestRender();
      return true;
    }

    function moveItems(delta) {
      const rows = buildItemRows();
      const next = itemIdx + delta;
      if (next < 0) return false;
      if (next >= rows.length) return false;
      itemIdx = next;
      renderItems();
      requestRender();
      return true;
    }

    async function activateAtCursor() {
      // Enter pressed. What should happen depends on the pane.
      if (pane === 'collections') {
        if (colIdx === cache.collections.length) {
          await addCollection();
          return;
        }
        if (currentCollection()) {
          // Move focus to details.
          pane = 'details';
          detailIdx = 0;
          renderFrames(true);
          requestHelpRefresh();
          requestRender();
        }
        return;
      }
      if (pane === 'details') {
        const rows = buildDetailRows();
        const row = rows[detailIdx];
        if (!row) return;
        if (row.kind === 'path') return editCollectionPath();
        if (row.kind === 'idPattern') return editCollectionIdPattern();
        if (row.kind === 'responseTemplate') return editResponseTemplate();
        if (row.kind === 'delete') return deleteCurrentCollection();
        return;
      }
      if (pane === 'items') {
        const rows = buildItemRows();
        const row = rows[itemIdx];
        if (!row) return;
        if (row.kind === 'add') return addItem();
        if (row.kind === 'item') return editItemAtCursor();
      }
    }

    // 'P' — configure persistPath, 'd' — delete in items, 'D' — delete collection,
    // 'r' — refresh from disk
    function bindLocalKeys() {
      // We register screen-level listeners but gate them on (a) tab being
      // active, (b) content focus, (c) no popup open. The host's
      // `dispatchPluginKey` doesn't cover free-form letter keys, so we wire
      // these directly — but only react when our page is visible.
      const isOurPageVisible = () => !page.hidden;

      screen.key('P', async () => {
        if (!isOurPageVisible()) return;
        await configurePersistPath();
      });
      screen.key('d', async () => {
        if (!isOurPageVisible() || pane !== 'items') return;
        await deleteItemAtCursor();
      });
      screen.key('D', async () => {
        if (!isOurPageVisible() || pane !== 'details') return;
        await deleteCurrentCollection();
      });
      screen.key('r', () => {
        if (!isOurPageVisible()) return;
        refresh();
      });
    }
    bindLocalKeys();

    // ---------- public API ----------

    return {
      isEnabled(cfg) {
        return Array.isArray(cfg?.plugins) && cfg.plugins.includes(PLUGIN_NAME);
      },

      onShow() {
        pane = 'collections';
        refresh();
      },

      onHide() {
        // Nothing to tear down; widgets are simply hidden along with the page.
      },

      onEnterFromTabs() {
        pane = 'collections';
        renderFrames(true);
        requestRender();
      },

      renderFrames,

      help() {
        if (pane === 'collections') {
          return '[↑/↓] pick   [enter] open   [P] persistPath   [r] refresh   [↑@top → tabs]   [q] quit';
        }
        if (pane === 'details') {
          return '[↑/↓] field   [enter] edit   [D] delete collection   [←] back to list   [q] quit';
        }
        return '[↑/↓] item   [enter] view/edit   [d] delete   [←] back to list   [q] quit';
      },

      handleKey(name) {
        if (page.hidden) return false;
        if (name === 'left') {
          if (pane === 'details' || pane === 'items') {
            pane = 'collections';
            renderFrames(true);
            requestHelpRefresh();
            requestRender();
            return true;
          }
          return false;
        }
        if (name === 'right') {
          if (pane === 'collections' && currentCollection()) {
            pane = 'details';
            renderFrames(true);
            requestHelpRefresh();
            requestRender();
            return true;
          }
          if (pane === 'details') {
            pane = 'items';
            renderFrames(true);
            requestHelpRefresh();
            requestRender();
            return true;
          }
          return true;
        }
        if (name === 'up') {
          if (pane === 'collections') {
            if (!moveCollections(-1)) {
              // At top → escape to the tab bar.
              leaveContentFocus();
            }
            return true;
          }
          if (pane === 'details') {
            if (!moveDetails(-1)) {
              // At top of details → jump back to button-equivalent (the
              // collection itself is selected on the left).
              pane = 'collections';
              renderFrames(true);
              requestHelpRefresh();
              requestRender();
            }
            return true;
          }
          if (pane === 'items') {
            if (!moveItems(-1)) {
              // At top of items → jump up to details.
              pane = 'details';
              const rows = buildDetailRows();
              detailIdx = Math.max(0, rows.length - 1);
              renderDetails();
              renderFrames(true);
              requestHelpRefresh();
              requestRender();
            }
            return true;
          }
        }
        if (name === 'down') {
          if (pane === 'collections') { moveCollections(1); return true; }
          if (pane === 'details') {
            if (!moveDetails(1)) {
              // Walked off the bottom of details → enter items pane.
              pane = 'items';
              itemIdx = 0;
              renderFrames(true);
              requestHelpRefresh();
              requestRender();
            }
            return true;
          }
          if (pane === 'items') { moveItems(1); return true; }
        }
        if (name === 'enter') {
          // Fire and forget; errors are surfaced via logger inside actions.
          activateAtCursor().catch((e) => logger.error(`[bucket-tui] ${e.message}`));
          return true;
        }
        return false;
      },
    };
  },
};
