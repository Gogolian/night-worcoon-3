/**
 * har-export TUI tab
 *
 * Provides a "HAR" tab in the TUI when the har-export plugin is enabled.
 *
 * Listens to logger trace events emitted by har-export.js and keeps a live
 * list of captured entries. Keys:
 *   [e]        prompt for a file path (default from config) then write HAR
 *   [x]        clear the local entry list
 *   [p]        pause / resume incoming entries
 *   [↑/↓]     navigate the entry list
 *   [↑ @ top → tabs]
 */

const PLUGIN_NAME = 'har-export';
const MAX_ENTRIES = 2000;

function fmtTs(value) {
  const d = value ? new Date(value) : new Date();
  return Number.isNaN(d.getTime()) ? '--:--:--.---' : d.toISOString().slice(11, 23);
}

function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function tagSafe(value) {
  return String(value ?? '').replace(/[{}]/g, '');
}

function statusColor(status) {
  if (status >= 500) return 'red';
  if (status >= 400) return 'yellow';
  if (status >= 300) return 'cyan';
  return 'green';
}

function defaultOutputPath(cfg) {
  const name = cfg?.name || 'proxy';
  return `./recordings/${name}-capture.har`;
}

export default {
  tabName: 'HAR',

  isEnabled(cfg) {
    return Array.isArray(cfg?.plugins) && cfg.plugins.includes(PLUGIN_NAME);
  },

  build({ screen, page, helpers }) {
    const {
      blessed,
      logger,
      promptValue,
      requestRender,
      requestHelpRefresh,
      leaveContentFocus,
      getConfigEntry,
    } = helpers;

    // -------- widgets --------

    const banner = blessed.box({
      parent: page,
      top: 0, left: 0, right: 0, height: 3,
      border: 'line',
      tags: true,
      style: { border: { fg: 'cyan' }, fg: 'white' },
      content: '',
    });

    const list = blessed.list({
      parent: page,
      label: ' captured entries ',
      top: 3, left: 0, bottom: 0,
      border: 'line',
      keys: false, mouse: true,
      tags: true,
      style: {
        selected: { bg: 'blue', fg: 'white', bold: true },
        item: { fg: 'white' },
        border: { fg: 'cyan' },
      },
    });

    // -------- state --------

    let entries = [];
    let pending = [];
    let selected = 0;
    let paused = false;
    let lastExportPath = null;
    let lastExportTs = null;

    // -------- render --------

    function renderBanner() {
      const state = paused ? '{yellow-fg}paused{/}' : '{green-fg}live{/}';
      const exportInfo = lastExportPath
        ? `last export: {cyan-fg}${tagSafe(lastExportPath)}{/} @ ${fmtTs(lastExportTs)}`
        : 'no export yet — press {bold}e{/bold} to write HAR';
      banner.setContent(
        ` ${state}  captured=${entries.length}/${MAX_ENTRIES}  pending=${pending.length}\n ${exportInfo}`,
      );
    }

    function rowFor(e) {
      const c = statusColor(Number(e.status || 0));
      const url = tagSafe(e.url || '/');
      const trimmedUrl = url.length > 80 ? `${url.slice(0, 77)}…` : url;
      return [
        `{cyan-fg}${fmtTs(e.startedDateTime)}{/}`,
        String(e.method || 'GET').padEnd(6),
        `{${c}-fg}${String(e.status || 0).padEnd(3)}{/}`,
        `${String(e.timeMs ?? 0).padStart(5)}ms`,
        String(fmtSize(e.size || 0)).padStart(8),
        String(e.source || 'proxy').padEnd(10),
        trimmedUrl,
      ].join(' ');
    }

    function renderList() {
      if (selected >= entries.length) selected = Math.max(0, entries.length - 1);
      list.setLabel(` captured entries (${entries.length}) `);
      list.setItems(
        entries.length ? entries.map(rowFor) : [' (no captured entries yet)'],
      );
      list.select(Math.max(0, selected));
    }

    function renderAll() {
      renderBanner();
      renderList();
      requestRender();
    }

    // -------- helpers --------

    function addEntry(e) {
      entries.push(e);
      if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
      selected = Math.max(0, entries.length - 1);
    }

    function flushPending() {
      if (!pending.length) return;
      for (const e of pending) addEntry(e);
      pending = [];
    }

    function move(delta) {
      const next = selected + delta;
      if (next < 0) return false;
      if (next >= entries.length) return true;
      selected = next;
      renderList();
      requestRender();
      return true;
    }

    // -------- HAR builder (mirrors har-export.js logic for TUI-side write) --------

    function buildHarFromEntries() {
      const cfg = getConfigEntry()?.config || {};
      // Re-assemble a minimal HAR with the summary data the TUI tracks.
      // Full request/response bodies come from the plugin's HTTP endpoint;
      // the TUI writes a "summary" HAR that is enough for timeline views.
      const harEntries = entries.map((e) => ({
        startedDateTime: e.startedDateTime,
        time: e.timeMs ?? 0,
        request: {
          method: e.method || 'GET',
          url: e.url || '/',
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: [],
          queryString: [],
          headersSize: -1,
          bodySize: -1,
        },
        response: {
          status: e.status || 200,
          statusText: '',
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: [],
          content: { size: e.size ?? 0, mimeType: 'application/octet-stream', text: '' },
          redirectURL: '',
          headersSize: -1,
          bodySize: e.size ?? 0,
        },
        cache: {},
        timings: { send: 0, wait: e.timeMs ?? 0, receive: 0 },
        _source: e.source || 'proxy',
      }));
      return {
        log: {
          version: '1.2',
          creator: { name: 'night-worcoon-3', version: '0.1.0', comment: `profile: ${cfg.name || 'proxy'} (TUI summary)` },
          pages: [],
          entries: harEntries,
        },
      };
    }

    // -------- actions --------

    async function exportHar() {
      const cfg = getConfigEntry()?.config || {};
      const defaultPath = defaultOutputPath(cfg);
      const filePath = await promptValue({
        label: 'write HAR to file (path)',
        initial: lastExportPath || defaultPath,
      });
      if (filePath === null) return;
      const resolved = filePath.trim() || defaultPath;
      try {
        const { default: fs } = await import('node:fs');
        const { default: path } = await import('node:path');
        const abs = path.resolve(resolved);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, JSON.stringify(buildHarFromEntries(), null, 2));
        lastExportPath = resolved;
        lastExportTs = new Date().toISOString();
        logger.info(`[har-export] TUI wrote ${entries.length} entries to ${abs}`);
      } catch (err) {
        logger.error(`[har-export] write failed: ${err.message}`);
      }
      renderAll();
    }

    function clearEntries() {
      entries = [];
      pending = [];
      selected = 0;
      renderAll();
    }

    // -------- key bindings --------

    function bindLocalKeys() {
      const visible = () => !page.hidden;

      screen.key('e', () => {
        if (!visible()) return;
        exportHar().catch((err) => logger.error(`[har-export-tui] ${err.message}`));
      });

      screen.key('x', () => {
        if (!visible()) return;
        clearEntries();
      });

      screen.key('p', () => {
        if (!visible()) return;
        paused = !paused;
        if (!paused) flushPending();
        renderAll();
      });
    }

    bindLocalKeys();

    // -------- subscribe to plugin trace events --------

    logger.on('trace', (ev) => {
      if (ev.kind !== 'har-export') return;
      const e = ev.data;
      if (paused) {
        pending.push(e);
      } else {
        addEntry(e);
      }
      if (!page.hidden) renderAll();
    });

    renderAll();

    // -------- returned instance --------

    return {
      isEnabled(cfg) {
        return Array.isArray(cfg?.plugins) && cfg.plugins.includes(PLUGIN_NAME);
      },

      onShow() {
        renderAll();
      },

      onEnterFromTabs() {
        list.focus();
        renderAll();
      },

      renderFrames(isActive) {
        list.setLabel(
          isActive
            ? ` [ captured entries (${entries.length}) ] `
            : ` captured entries (${entries.length}) `,
        );
        list.style.border.fg = isActive ? 'white' : 'cyan';
        banner.style.border.fg = isActive ? 'white' : 'cyan';
      },

      help() {
        return '[↑/↓] scroll   [e] export HAR   [x] clear   [p] pause/resume   [↑@top → tabs]   [q] quit';
      },

      handleKey(name) {
        if (page.hidden) return false;
        if (name === 'up') {
          if (!move(-1)) leaveContentFocus();
          return true;
        }
        if (name === 'down') {
          move(1);
          return true;
        }
        return false;
      },
    };
  },
};
