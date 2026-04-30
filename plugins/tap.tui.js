const PLUGIN_NAME = 'tap';
const MAX_TRANSACTIONS = 500;

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

function matchesStatus(status, filter) {
  const f = filter.trim();
  if (!f) return true;
  if (/^\dxx$/i.test(f)) return Math.floor(status / 100) === Number(f[0]);
  if (/^\d{3}$/.test(f)) return status === Number(f);
  const range = f.match(/^(\d{3})\s*-\s*(\d{3})$/);
  if (range) return status >= Number(range[1]) && status <= Number(range[2]);
  const cmp = f.match(/^(>=|<=|>|<)\s*(\d{3})$/);
  if (cmp) {
    const n = Number(cmp[2]);
    if (cmp[1] === '>=') return status >= n;
    if (cmp[1] === '<=') return status <= n;
    if (cmp[1] === '>') return status > n;
    if (cmp[1] === '<') return status < n;
  }
  return String(status).includes(f);
}

function matchesUrl(url, filter) {
  const f = filter.trim().toLowerCase();
  return !f || String(url || '').toLowerCase().includes(f);
}

function headersPreview(headers) {
  const entries = Object.entries(headers || {});
  if (!entries.length) return '  (none)';
  return entries.map(([k, v]) => `  ${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n');
}

function writeOsc52(text) {
  if (!process.stdout?.write) return false;
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  process.stdout.write(`\x1b]52;c;${encoded}\x07`);
  return true;
}

export default {
  tabName: 'Tap',

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
    } = helpers;

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
      label: ' transactions ',
      top: 3, left: 0, bottom: 0, width: '58%',
      border: 'line',
      keys: false, mouse: true,
      tags: true,
      style: {
        selected: { bg: 'blue', fg: 'white', bold: true },
        item: { fg: 'white' },
        border: { fg: 'cyan' },
      },
    });

    const detail = blessed.box({
      parent: page,
      label: ' details ',
      top: 3, left: '58%', right: 0, bottom: 0,
      border: 'line',
      scrollable: true,
      alwaysScroll: true,
      keys: false,
      mouse: true,
      tags: true,
      style: { border: { fg: 'cyan' }, fg: 'white' },
    });

    let transactions = [];
    let pending = [];
    let visible = [];
    let selected = 0;
    let paused = false;
    let urlFilter = '';
    let statusFilter = '';

    function filtered() {
      return transactions.filter((t) =>
        matchesUrl(t.url, urlFilter) && matchesStatus(Number(t.status || 0), statusFilter));
    }

    function current() {
      return visible[selected] || null;
    }

    function renderBanner() {
      const state = paused ? '{yellow-fg}paused{/}' : '{green-fg}live{/}';
      const filters = [
        urlFilter ? `url="${tagSafe(urlFilter)}"` : 'url=*',
        statusFilter ? `status="${tagSafe(statusFilter)}"` : 'status=*',
      ].join('  ');
      banner.setContent(` ${state}  kept=${transactions.length}/${MAX_TRANSACTIONS}  pending=${pending.length}\n ${filters}`);
    }

    function rowFor(t) {
      const c = statusColor(Number(t.status || 0));
      const url = tagSafe(t.url || '/');
      const trimmedUrl = url.length > 70 ? `${url.slice(0, 67)}…` : url;
      return [
        `{cyan-fg}${fmtTs(t.ts)}{/}`,
        String(t.method || 'GET').padEnd(6),
        `{${c}-fg}${String(t.status || 0).padEnd(3)}{/}`,
        `${String(t.latencyMs ?? 0).padStart(4)}ms`,
        String(fmtSize(t.size || 0)).padStart(8),
        String(t.source || 'proxy').padEnd(8),
        trimmedUrl,
      ].join(' ');
    }

    function renderList() {
      visible = filtered();
      if (selected >= visible.length) selected = Math.max(0, visible.length - 1);
      list.setLabel(` transactions (${visible.length}) `);
      list.setItems(visible.length ? visible.map(rowFor) : [' (no matching transactions yet)']);
      list.select(Math.max(0, selected));
    }

    function renderDetail() {
      const t = current();
      if (!t) {
        detail.setContent('\n  No transaction selected.\n');
        return;
      }
      detail.setContent([
        `{bold}${tagSafe(t.method)} ${tagSafe(t.url)}{/bold}`,
        '',
        `status:     ${t.status}`,
        `latency:    ${t.latencyMs} ms`,
        `size:       ${fmtSize(t.size)}`,
        `source:     ${tagSafe(t.source)}`,
        `profile:    ${tagSafe(t.configName)} (:${tagSafe(t.port)})`,
        `timestamp:  ${tagSafe(t.ts)}`,
        '',
        '{bold}request headers{/bold}',
        tagSafe(headersPreview(t.requestHeaders)),
        '',
        '{bold}response headers{/bold}',
        tagSafe(headersPreview(t.responseHeaders)),
        '',
        '{bold}cURL{/bold}',
        tagSafe(t.curl),
      ].join('\n'));
      detail.setScroll(0);
    }

    function renderAll() {
      renderBanner();
      renderList();
      renderDetail();
      requestRender();
    }

    function addTransaction(t) {
      transactions.push(t);
      if (transactions.length > MAX_TRANSACTIONS) transactions = transactions.slice(-MAX_TRANSACTIONS);
      selected = Math.max(0, filtered().length - 1);
    }

    function flushPending() {
      if (!pending.length) return;
      for (const t of pending) addTransaction(t);
      pending = [];
    }

    function move(delta) {
      const next = selected + delta;
      if (next < 0) return false;
      if (next >= visible.length) return true;
      selected = next;
      renderList();
      renderDetail();
      requestRender();
      return true;
    }

    async function editUrlFilter() {
      const next = await promptValue({ label: 'tap URL filter (substring, empty = all)', initial: urlFilter });
      if (next === null) return;
      urlFilter = next.trim();
      selected = 0;
      renderAll();
    }

    async function editStatusFilter() {
      const next = await promptValue({ label: 'tap status filter (200, 2xx, 400-499, >=500, empty = all)', initial: statusFilter });
      if (next === null) return;
      statusFilter = next.trim();
      selected = 0;
      renderAll();
    }

    function copyCurl() {
      const t = current();
      if (!t?.curl) return;
      if (writeOsc52(t.curl)) logger.info('[tap] copied selected transaction as cURL');
      else logger.warn('[tap] clipboard copy is not available');
    }

    function bindLocalKeys() {
      const isOurPageVisible = () => !page.hidden;
      screen.key('/', () => {
        if (!isOurPageVisible()) return;
        editUrlFilter().catch((e) => logger.error(`[tap-tui] ${e.message}`));
      });
      screen.key('f', () => {
        if (!isOurPageVisible()) return;
        editStatusFilter().catch((e) => logger.error(`[tap-tui] ${e.message}`));
      });
      screen.key('p', () => {
        if (!isOurPageVisible()) return;
        paused = !paused;
        if (!paused) flushPending();
        renderAll();
      });
      screen.key('x', () => {
        if (!isOurPageVisible()) return;
        transactions = [];
        pending = [];
        selected = 0;
        renderAll();
      });
      screen.key('c', () => {
        if (!isOurPageVisible()) return;
        copyCurl();
      });
    }

    bindLocalKeys();

    logger.on('trace', (e) => {
      if (e.kind !== 'tap') return;
      if (paused) pending.push(e.data);
      else addTransaction(e.data);
      if (!page.hidden) renderAll();
    });

    renderAll();

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
        list.setLabel(isActive ? ` [ transactions (${visible.length}) ] ` : ` transactions (${visible.length}) `);
        list.style.border.fg = isActive ? 'white' : 'cyan';
        detail.setLabel(isActive ? ' [ details ] ' : ' details ');
        detail.style.border.fg = isActive ? 'white' : 'cyan';
        banner.style.border.fg = isActive ? 'white' : 'cyan';
      },

      help() {
        return '[↑/↓] pick   [/] URL filter   [f] status filter   [p] pause/resume   [c] copy cURL   [x] clear   [↑@top → tabs]   [q] quit';
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
        if (name === 'enter') {
          copyCurl();
          requestHelpRefresh();
          return true;
        }
        return false;
      },
    };
  },
};
