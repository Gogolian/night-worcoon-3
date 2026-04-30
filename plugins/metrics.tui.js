/**
 * Metrics TUI tab.
 *
 * Shows a live per-route table: request count, error rate, p50/p95/p99
 * latency, and bytes in/out.  Updates on every metrics trace event.
 *
 * Keybindings (while tab is active):
 *   ↑ / ↓  scroll routes
 *   r       reset displayed counters (delta from the reset point)
 *   ↑@top   leave back to the tab bar
 *   q       quit
 */

const PLUGIN_NAME = 'metrics';

function fmtSize(bytes) {
  if (!Number.isFinite(bytes) || bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function tagSafe(value) {
  return String(value ?? '').replace(/[{}]/g, '');
}

// Column layout (fits ~100-char terminals):
//  METHOD(7)  PATH(34)  REQS(6)  ERR%(7)  p50(7)  p95(7)  p99(7)  IN(9)  OUT(9)
const COL_HDR =
  ' {bold}{cyan-fg}'
  + 'METHOD   '
  + 'PATH                               '
  + ' REQS'
  + '   ERR%'
  + '    p50'
  + '    p95'
  + '    p99'
  + '        IN'
  + '       OUT'
  + '{/}';

export default {
  tabName: 'Metrics',

  isEnabled(cfg) {
    return Array.isArray(cfg?.plugins) && cfg.plugins.includes(PLUGIN_NAME);
  },

  build({ screen, page, helpers }) {
    const {
      blessed,
      logger,
      leaveContentFocus,
      requestRender,
    } = helpers;

    // ── banner ────────────────────────────────────────────────────────────────
    const banner = blessed.box({
      parent: page,
      top: 0, left: 0, right: 0, height: 4,
      border: 'line',
      tags: true,
      style: { border: { fg: 'cyan' }, fg: 'white' },
      content: '',
    });

    // ── routes list ───────────────────────────────────────────────────────────
    const list = blessed.list({
      parent: page,
      label: ' routes ',
      top: 4, left: 0, right: 0, bottom: 0,
      border: 'line',
      keys: false,
      mouse: true,
      tags: true,
      style: {
        selected: { bg: 'blue', fg: 'white', bold: true },
        item: { fg: 'white' },
        border: { fg: 'cyan' },
      },
    });

    /**
     * Live view of each route (delta from the last reset).
     * @type {Map<string, { method:string, path:string, requests:number, errors:number, bytesIn:number, bytesOut:number, p50:number, p95:number, p99:number }>}
     */
    const routes = new Map();

    /**
     * Baseline snapshot captured at the last reset.
     * Keyed by `"METHOD /path"` → cumulative counters at reset time.
     * @type {Map<string, { requests:number, errors:number, bytesIn:number, bytesOut:number }>}
     */
    const baseline = new Map();

    let selected = 0; // 0-based index into routes.values()

    // ── helpers ───────────────────────────────────────────────────────────────

    function totalRequests() {
      let n = 0;
      for (const r of routes.values()) n += r.requests;
      return n;
    }

    function renderBanner() {
      const n = routes.size;
      const total = totalRequests();
      const resetHint = baseline.size ? '{yellow-fg}(delta from reset){/}  ' : '';
      banner.setContent(
        ` {green-fg}Metrics{/}  routes=${n}  total_requests=${total}  ${resetHint}\n`
        + ` {white-fg}[r] reset display  [↑/↓] scroll{/}\n`
        + COL_HDR,
      );
    }

    function rowFor(r) {
      const errColor = r.errors > 0 ? 'red' : 'green';
      const errPct = r.requests
        ? `${((r.errors / r.requests) * 100).toFixed(1)}%`
        : '—';

      const method = tagSafe(r.method).padEnd(7);
      const rawPath = tagSafe(r.path);
      const trimPath = rawPath.length > 34 ? `${rawPath.slice(0, 31)}…` : rawPath;
      const paddedPath = trimPath.padEnd(34);

      const reqs  = String(r.requests).padStart(5);
      const err   = `{${errColor}-fg}${errPct.padStart(6)}{/}`;
      const p50   = `${String(r.p50).padStart(4)}ms`;
      const p95   = `${String(r.p95).padStart(4)}ms`;
      const p99   = `${String(r.p99).padStart(4)}ms`;
      const bIn   = fmtSize(r.bytesIn).padStart(9);
      const bOut  = fmtSize(r.bytesOut).padStart(9);

      return ` ${method}  ${paddedPath}  ${reqs}  ${err}  ${p50}  ${p95}  ${p99}  ${bIn}  ${bOut}`;
    }

    function renderList() {
      const items = [...routes.values()];
      if (selected >= items.length) selected = Math.max(0, items.length - 1);
      list.setLabel(` routes (${items.length}) `);
      list.setItems(
        items.length
          ? items.map(rowFor)
          : [' (no requests yet)'],
      );
      list.select(selected);
    }

    function renderAll() {
      renderBanner();
      renderList();
      requestRender();
    }

    function reset() {
      // Snapshot the current cumulative counters so future deltas start at 0.
      baseline.clear();
      for (const [key, r] of routes.entries()) {
        baseline.set(key, {
          requests: r.requests,
          errors: r.errors,
          bytesIn: r.bytesIn,
          bytesOut: r.bytesOut,
        });
      }
      routes.clear();
      selected = 0;
      renderAll();
    }

    function zeroBaseline() {
      return { requests: 0, errors: 0, bytesIn: 0, bytesOut: 0 };
    }

    function move(delta) {
      const len = routes.size;
      const next = selected + delta;
      if (next < 0) return false;
      if (next >= len) return true;
      selected = next;
      renderList();
      requestRender();
      return true;
    }

    // ── key bindings ──────────────────────────────────────────────────────────

    screen.key('r', () => {
      if (!page.hidden) reset();
    });

    // ── logger listener ───────────────────────────────────────────────────────

    logger.on('trace', (e) => {
      if (e.kind !== 'metrics') return;
      const d = e.data;
      const key = `${d.method} ${d.path}`;
      const base = baseline.get(key) || zeroBaseline();

      routes.set(key, {
        method: d.method,
        path: d.path,
        requests: Math.max(0, d.requests - base.requests),
        errors: Math.max(0, d.errors - base.errors),
        bytesIn: Math.max(0, d.bytesIn - base.bytesIn),
        bytesOut: Math.max(0, d.bytesOut - base.bytesOut),
        // Percentiles come from the plugin's rolling window — they reflect
        // the full sample set, not just the delta since reset.
        p50: d.p50,
        p95: d.p95,
        p99: d.p99,
      });

      if (!page.hidden) renderAll();
    });

    renderAll();

    // ── instance API ──────────────────────────────────────────────────────────

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
            ? ` [ routes (${routes.size}) ] `
            : ` routes (${routes.size}) `,
        );
        list.style.border.fg = isActive ? 'white' : 'cyan';
        banner.style.border.fg = isActive ? 'white' : 'cyan';
      },

      help() {
        return '[↑/↓] scroll   [r] reset display   [↑@top → tabs]   [q] quit';
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
