import blessed from 'blessed';
import fs from 'node:fs';
import path from 'node:path';

// ---------- small helpers ----------
function fmtTs(d) {
  return d.toISOString().slice(11, 23);
}

function levelColor(l) {
  switch (l) {
    case 'error': return 'red';
    case 'warn': return 'yellow';
    case 'info': return 'cyan';
    case 'debug': return 'white';
    default: return 'white';
  }
}

function prettyValue(v) {
  if (v === null) return 'null';
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

// ---------- main ----------
export function createTui({ configsDir, pluginsDir, logger, onStart, onStop }) {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'night-worcoon-3',
    fullUnicode: true,
  });

  // ---------- top title ----------
  blessed.box({
    parent: screen,
    top: 0, left: 0, right: 0, height: 1,
    style: { bg: 'blue', fg: 'white', bold: true },
    content: ' night-worcoon-3 · middleware proxy ',
  });

  // ---------- tab bar ----------
  const TABS = ['Configs', 'Logs', 'Mocks', 'Plugins', 'Help'];
  let tabIdx = 0;
  let focusZone = 'tabs'; // 'tabs' | 'content'

  const tabBar = blessed.box({
    parent: screen,
    top: 1, left: 0, right: 0, height: 3,
    border: 'line',
    tags: true,
    style: { border: { fg: 'cyan' } },
  });

  function renderTabBar() {
    const zoneActive = focusZone === 'tabs';
    tabBar.style.border.fg = zoneActive ? 'white' : 'cyan';
    renderPageFrames();
    const segs = TABS.map((name, i) => {
      if (i === tabIdx && zoneActive)
        return `{blue-bg}{white-fg}{bold} ${name} {/}`;
      if (i === tabIdx)
        return `{white-fg}{bold}[${name}]{/}`;
      return `{white-fg} ${name} {/}`;
    });
    tabBar.setContent(' ' + segs.join('  '));
    screen.render();
  }

  // ---------- content area (one box per tab) ----------
  const contentTop = 4;
  const contentBottom = 3;

  const pages = {};
  for (const name of TABS) {
    pages[name] = blessed.box({
      parent: screen,
      top: contentTop, left: 0, right: 0, bottom: contentBottom,
      hidden: true,
    });
  }

  // ---------- status + help ----------
  const status = blessed.box({
    parent: screen,
    bottom: 1, left: 0, right: 0, height: 1,
    style: { bg: 'black', fg: 'white' },
    content: ' no active proxy ',
  });

  const help = blessed.box({
    parent: screen,
    bottom: 0, left: 0, right: 0, height: 1,
    style: { bg: 'white', fg: 'black' },
    content: '',
  });

  function setHelp(text) {
    help.setContent(' ' + text);
    screen.render();
  }

  function setStatus(text, color = 'white') {
    status.style.fg = color;
    status.setContent(` ${text} `);
    screen.render();
  }

  // =====================================================
  //                      CONFIGS TAB
  // =====================================================
  const cfgPage = pages['Configs'];

  const cfgList = blessed.list({
    parent: cfgPage,
    label: ' configs ',
    top: 0, left: 0, bottom: 0, width: '35%',
    border: 'line',
    keys: false, mouse: true,
    tags: true,
    style: {
      selected: { bg: 'blue', fg: 'white', bold: true },
      item: { fg: 'white' },
      border: { fg: 'cyan' },
    },
  });

  const cfgRight = blessed.box({
    parent: cfgPage,
    top: 0, left: '35%', right: 0, bottom: 0,
  });

  const startBtn = blessed.box({
    parent: cfgRight,
    top: 0, left: 0, right: 0, height: 3,
    border: 'line',
    tags: true,
    style: { border: { fg: 'cyan' } },
    content: '',
  });

  const optionsList = blessed.list({
    parent: cfgRight,
    label: ' options ',
    top: 3, left: 0, right: 0, bottom: 0,
    border: 'line',
    keys: false, mouse: true,
    tags: true,
    style: {
      selected: { bg: 'blue', fg: 'white', bold: true },
      item: { fg: 'white' },
      border: { fg: 'cyan' },
    },
  });

  let configs = [];
  let selectedCfgIdx = 0;
  let active = null;
  let activeFile = null;

  // right pane sub-focus: 'btn' | 'opts'
  let cfgRightFocus = 'btn';
  // current pane within Configs tab: 'left' | 'right'
  let cfgPane = 'left';

  function labelForConfig(idx) {
    const entry = configs[idx];
    const prefix = (active && entry.file === activeFile) ? '● ' : '  ';
    return prefix + entry.label;
  }

  function loadConfigs() {
    if (!fs.existsSync(configsDir)) fs.mkdirSync(configsDir, { recursive: true });
    const files = fs.readdirSync(configsDir).filter((f) => f.endsWith('.json'));
    configs = files.map((f) => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(configsDir, f), 'utf8'));
        return { file: f, config: j, label: `${j.name || f}  :${j.port}  → ${j.target}` };
      } catch {
        return { file: f, config: null, label: `${f}  (invalid JSON)` };
      }
    });
    if (selectedCfgIdx >= configs.length) selectedCfgIdx = Math.max(0, configs.length - 1);
    cfgList.setItems(configs.map((_, i) => labelForConfig(i)));
    cfgList.select(selectedCfgIdx);
    renderRight();
  }

  function currentConfig() {
    return configs[selectedCfgIdx];
  }

  function saveCurrentConfig() {
    const entry = currentConfig();
    if (!entry?.config) return;
    const p = path.join(configsDir, entry.file);
    fs.writeFileSync(p, JSON.stringify(entry.config, null, 2) + '\n', 'utf8');
    const j = entry.config;
    entry.label = `${j.name || entry.file}  :${j.port}  → ${j.target}`;
    cfgList.setItem(selectedCfgIdx, labelForConfig(selectedCfgIdx));
  }

  // Each row: { key, kind } kind: 'scalar' | 'json' | 'headers' | 'plugins'
  function buildOptionRows(cfg) {
    if (!cfg) return [];
    const rows = [];
    const preferredOrder = ['name', 'port', 'target', 'changeOrigin', 'followRedirects', 'secure'];
    const seen = new Set();

    const pushRow = (k, v) => {
      if (k === 'requestHeaders') {
        rows.push({ key: k, value: v || {}, kind: 'headers' });
      } else if (k === 'plugins') {
        rows.push({ key: k, value: v || [], kind: 'plugins' });
      } else if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
        rows.push({ key: k, value: v, kind: 'scalar' });
      } else {
        rows.push({ key: k, value: v, kind: 'json' });
      }
      seen.add(k);
    };

    for (const k of preferredOrder) {
      if (k in cfg) pushRow(k, cfg[k]);
    }
    if (!seen.has('requestHeaders')) pushRow('requestHeaders', cfg.requestHeaders || {});
    if (!seen.has('plugins')) pushRow('plugins', cfg.plugins || []);
    for (const k of Object.keys(cfg)) {
      if (seen.has(k)) continue;
      pushRow(k, cfg[k]);
    }
    return rows;
  }

  let optionRows = [];

  function renderRight() {
    const entry = currentConfig();
    const running = !!(active && entry && entry.file === activeFile);
    const btnActive = cfgPane === 'right' && cfgRightFocus === 'btn' && focusZone === 'content';

    // Bracket labels for the focused section.
    const leftActive = focusZone === 'content' && cfgPane === 'left';
    const optsActive = focusZone === 'content' && cfgPane === 'right' && cfgRightFocus === 'opts';
    cfgList.setLabel(leftActive ? ' [ configs ] ' : ' configs ');
    optionsList.setLabel(optsActive ? ' [ options ] ' : ' options ');
    cfgList.style.border.fg = leftActive ? 'white' : 'cyan';
    optionsList.style.border.fg = optsActive ? 'white' : 'cyan';
    startBtn.style.border.fg = btnActive ? 'white' : 'cyan';
    const label = running ? ' ■ Stop ' : ' ▶ Start ';
    const color = running ? 'red' : 'green';
    const marker = btnActive
      ? `{${color}-bg}{white-fg}{bold}${label}{/}`
      : `{${color}-fg}{bold}${label}{/}`;
    const sub = entry?.config
      ? `  {white-fg}${entry.config.name || entry.file}  :${entry.config.port} → ${entry.config.target}{/}`
      : '  {white-fg}(no valid config){/}';
    startBtn.setContent(' ' + marker + sub);

    optionRows = buildOptionRows(entry?.config);
    const items = optionRows.map((r) => {
      if (r.kind === 'headers') {
        const count = Object.keys(r.value || {}).length;
        return ` {yellow-fg}${r.key}{/}  →  ${count} header(s) …`;
      }
      if (r.kind === 'plugins') {
        const count = (r.value || []).length;
        return ` {magenta-fg}${r.key}{/}  →  ${count} enabled …`;
      }
      if (r.kind === 'json') {
        return ` {cyan-fg}${r.key}{/}  =  ${prettyValue(r.value).slice(0, 80)}`;
      }
      if (typeof r.value === 'boolean') {
        const c = r.value ? 'green' : 'red';
        return ` ${r.key}  =  {${c}-fg}{bold}${r.value}{/}`;
      }
      return ` ${r.key}  =  {white-fg}${prettyValue(r.value)}{/}`;
    });
    optionsList.setItems(items);
    if ((optionsList.selected || 0) >= items.length) optionsList.select(Math.max(0, items.length - 1));
    screen.render();
  }

  // =====================================================
  //                      LOGS TAB
  // =====================================================
  const logBox = blessed.log({
    parent: pages['Logs'],
    label: ' live log ',
    top: 0, left: 0, right: 0, bottom: 0,
    border: 'line',
    tags: true,
    scrollback: 5000,
    scrollbar: { ch: ' ', style: { bg: 'cyan' } },
    mouse: true, keys: false,
    style: { border: { fg: 'cyan' } },
  });

  // =====================================================
  //                      MOCKS TAB
  // =====================================================
  const mocksList = blessed.list({
    parent: pages['Mocks'],
    label: ' mock rules ',
    top: 0, left: 0, bottom: 0, width: '45%',
    border: 'line',
    keys: false, mouse: true,
    tags: true,
    style: {
      selected: { bg: 'blue', fg: 'white', bold: true },
      item: { fg: 'white' },
      border: { fg: 'cyan' },
    },
  });

  const mocksDetail = blessed.box({
    parent: pages['Mocks'],
    label: ' rule details ',
    top: 0, left: '45%', right: 0, bottom: 0,
    border: 'line',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: ' ', style: { bg: 'cyan' } },
    mouse: true, keys: false,
    style: { border: { fg: 'cyan' } },
  });

  function ruleMatchKind(r) {
    if (r.urlContains != null) return 'contains';
    if (typeof r.url === 'string' && r.url.includes(':')) return 'pattern';
    return 'exact';
  }

  function ruleTargetText(r) {
    if (r.urlContains != null) return r.urlContains;
    if (r.url != null) return r.url;
    return '';
  }

  function formatRuleRow(r, i) {
    const method = (r.method || '*').toUpperCase();
    const target = ruleTargetText(r) || '?';
    const kind = ruleMatchKind(r);
    const sigil = kind === 'contains' ? '~' : kind === 'pattern' ? ':' : '=';
    const action = (r.action || 'PASS').toUpperCase();
    const color =
      action === 'MOCK' ? 'green' :
      action === 'PASS' ? 'cyan' :
      action.startsWith('RET') || action.startsWith('REC') ? 'yellow' : 'white';
    return ` ${String(i + 1).padStart(2)}  {magenta-fg}${method.padEnd(6)}{/} {gray-fg}${sigil}{/} ${String(target).padEnd(24).slice(0, 24)}  {${color}-fg}${action}{/}`;
  }

  function renderMocksDetail() {
    const entry = currentConfig();
    if (!entry?.config) {
      mocksDetail.setContent('\n  (no valid config selected)\n');
      return;
    }
    const rules = entry.config.mock?.rules || [];
    if (!rules.length) {
      mocksDetail.setContent(
        '\n  {bold}No rules defined yet.{/bold}\n\n' +
        '  Press {yellow-fg}{bold}a{/}{/} to add a new mock rule.\n\n' +
        '  {gray-fg}Rules are evaluated top-to-bottom; first match wins.{/}\n',
      );
      return;
    }
    const idx = Math.min(Math.max(0, mocksList.selected || 0), rules.length - 1);
    const r = rules[idx];
    const lines = [];
    lines.push('');
    lines.push(`  {bold}Rule #${idx + 1}{/bold} of ${rules.length}`);
    lines.push('');
    lines.push(`  {white-fg}method      :{/} {magenta-fg}${(r.method || '*').toUpperCase()}{/}`);
    const kind = ruleMatchKind(r);
    const kindHint =
      kind === 'contains' ? 'contains  {gray-fg}(substring of path){/}' :
      kind === 'pattern' ? 'pattern   {gray-fg}(/foo/:id style){/}' :
      'exact     {gray-fg}(full path equals){/}';
    lines.push(`  {white-fg}match type  :{/} ${kindHint}`);
    lines.push(`  {white-fg}url         :{/} {cyan-fg}${ruleTargetText(r) || '(none)'}{/}`);
    const action = (r.action || 'PASS').toUpperCase();
    const aColor = action === 'MOCK' ? 'green' : action === 'PASS' ? 'cyan' : 'yellow';
    lines.push(`  {white-fg}action      :{/} {${aColor}-fg}{bold}${action}{/}`);
    if (action === 'RET_REC') {
      lines.push(`  {white-fg}fallback    :{/} ${r.fallback || '500'}   {gray-fg}(500 | empty200 | PASS){/}`);
    } else if (action === 'MOCK') {
      const resp = r.response || {};
      lines.push('');
      lines.push('  {bold}response{/bold}');
      lines.push(`  {white-fg}  status    :{/} ${resp.status ?? 200}`);
      const headers = resp.headers || {};
      const hCount = Object.keys(headers).length;
      lines.push(`  {white-fg}  headers   :{/} ${hCount} header(s)`);
      for (const [k, v] of Object.entries(headers)) {
        lines.push(`               {cyan-fg}${k}{/}: ${prettyValue(v).slice(0, 60)}`);
      }
      const body = resp.body;
      const bodyStr = body == null ? ''
        : typeof body === 'string' ? body
        : (() => { try { return JSON.stringify(body, null, 2); } catch { return String(body); } })();
      const bodyLines = bodyStr === '' ? ['(empty)'] : bodyStr.split('\n');
      lines.push(`  {white-fg}  body      :{/}`);
      for (const ln of bodyLines.slice(0, 24)) {
        lines.push(`    {gray-fg}│{/} ${ln}`);
      }
      if (bodyLines.length > 24) lines.push(`    {gray-fg}│ … (${bodyLines.length - 24} more lines){/}`);
    }
    lines.push('');
    lines.push('  {gray-fg}[enter/e] edit · [a] add · [d] delete · [J/K] reorder{/}');
    mocksDetail.setContent(lines.join('\n'));
  }

  function renderMocks() {
    const entry = currentConfig();
    const rules = entry?.config?.mock?.rules || [];
    if (!rules.length) {
      mocksList.setItems([' {gray-fg}(no rules — press [a] to add){/}']);
    } else {
      mocksList.setItems(rules.map((r, i) => formatRuleRow(r, i)));
      const cur = mocksList.selected || 0;
      if (cur >= rules.length) mocksList.select(Math.max(0, rules.length - 1));
      else if (cur < 0) mocksList.select(0);
    }
    renderMocksDetail();
    screen.render();
  }

  // =====================================================
  //                      PLUGINS TAB
  // =====================================================
  const pluginsBox = blessed.list({
    parent: pages['Plugins'],
    label: ' plugins ',
    top: 0, left: 0, right: 0, bottom: 0,
    border: 'line',
    keys: false, mouse: true,
    tags: true,
    style: {
      selected: { bg: 'blue', fg: 'white', bold: true },
      item: { fg: 'white' },
      border: { fg: 'cyan' },
    },
  });

  function renderPlugins() {
    let files = [];
    try {
      files = fs.readdirSync(pluginsDir).filter((f) => f.endsWith('.js'));
    } catch {}
    const entry = currentConfig();
    const enabled = new Set(entry?.config?.plugins || []);
    if (!files.length) {
      pluginsBox.setItems([' (no plugins found)']);
      return;
    }
    pluginsBox.setItems(files.map((f) => {
      const name = f.replace(/\.js$/, '');
      const on = enabled.has(name);
      return ` ${on ? '{green-fg}●{/}' : '{white-fg}○{/}'}  ${name}${on ? '  {cyan-fg}(enabled){/}' : ''}`;
    }));
  }

  // =====================================================
  //                       HELP TAB
  // =====================================================
  const helpPage = pages['Help'];

  const helpBox = blessed.box({
    parent: helpPage,
    label: ' help ',
    top: 0, left: 0, right: 0, bottom: 0,
    border: 'line',
    tags: true,
    mouse: true,
    keys: false,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: ' ', style: { bg: 'cyan' } },
    style: {
      border: { fg: 'cyan' },
      fg: 'white',
    },
  });

  function buildHelpContent() {
    const colors = [
      { label: 'black', bg: 'black', fg: 'white', code: 'black', ansi: 'ANSI 0' },
      { label: 'red', bg: 'red', fg: 'white', code: 'red', ansi: 'ANSI 1' },
      { label: 'green', bg: 'green', fg: 'black', code: 'green', ansi: 'ANSI 2' },
      { label: 'yellow', bg: 'yellow', fg: 'black', code: 'yellow', ansi: 'ANSI 3' },
      { label: 'blue', bg: 'blue', fg: 'white', code: 'blue', ansi: 'ANSI 4' },
      { label: 'magenta', bg: 'magenta', fg: 'white', code: 'magenta', ansi: 'ANSI 5' },
      { label: 'cyan', bg: 'cyan', fg: 'black', code: 'cyan', ansi: 'ANSI 6' },
      { label: 'white', bg: 'white', fg: 'black', code: 'white', ansi: 'ANSI 7' },
      { label: 'bright black / gray', bg: 'gray', fg: 'white', code: 'gray', ansi: 'ANSI 8' },
      { label: 'bright red', bg: '#ff5555', fg: 'black', code: '#ff5555', ansi: 'ANSI 9' },
      { label: 'bright green', bg: '#55ff55', fg: 'black', code: '#55ff55', ansi: 'ANSI 10' },
      { label: 'bright yellow', bg: '#ffff55', fg: 'black', code: '#ffff55', ansi: 'ANSI 11' },
      { label: 'bright blue', bg: '#5555ff', fg: 'white', code: '#5555ff', ansi: 'ANSI 12' },
      { label: 'bright magenta', bg: '#ff55ff', fg: 'black', code: '#ff55ff', ansi: 'ANSI 13' },
      { label: 'bright cyan', bg: '#55ffff', fg: 'black', code: '#55ffff', ansi: 'ANSI 14' },
      { label: 'bright white', bg: '#ffffff', fg: 'black', code: '#ffffff', ansi: 'ANSI 15' },
    ];

    const colorLines = colors.map(({ label, bg, fg, code, ansi }) => {
      const swatch = label.padEnd(20);
      return ` {${bg}-bg}{${fg}-fg} ${swatch} {/}  ${ansi.padEnd(8)}  use: ${code}`;
    });

    return [
      '{bold}night-worcoon-3{/bold}',
      'TUI-driven middleware proxy for HTTP and WebSocket traffic.',
      '',
      '{bold}What it does{/bold}',
      ' Start a local proxy from a saved config profile.',
      ' Edit request headers and runtime options directly in the TUI.',
      ' Toggle plugins, inspect mock rules, and watch live traffic.',
      '',
      '{bold}Quick map{/bold}',
      ' Configs  - choose a profile, edit settings, start or stop the proxy.',
      ' Logs     - live request, response, and proxy events.',
      ' Mocks    - mock rules for the selected profile (add / edit / reorder).',
      ' Plugins  - available plugins and which ones are enabled.',
      ' Help     - this reference page.',
      '',
      '{bold}Terminal color legend{/bold}',
      'Swatches below show the common 16-color ANSI palette.',
      'Named colors can be reused directly in Blessed tags. Bright variants use hex here',
      'so you can see them clearly even when you are not using a named alias.',
      '',
      ...colorLines,
      '',
      '{bold}Current app color names{/bold}',
      'black, white, gray, red, green, yellow, blue, magenta, cyan',
      '',
      '{bold}Hex colors{/bold}',
      'Blessed also accepts hex colors directly, for example {#ff8800-fg}#ff8800{/}.',
    ].join('\n');
  }

  helpBox.setContent(buildHelpContent());

  function renderPageFrames() {
    const activeContentTab = focusZone === 'content' ? TABS[tabIdx] : null;

    logBox.setLabel(activeContentTab === 'Logs' ? ' [ live log ] ' : ' live log ');
    logBox.style.border.fg = activeContentTab === 'Logs' ? 'white' : 'cyan';

    mocksList.setLabel(
      activeContentTab === 'Mocks'
        ? ' [ mock rules ] '
        : ' mock rules ',
    );
    mocksList.style.border.fg = activeContentTab === 'Mocks' ? 'white' : 'cyan';
    mocksDetail.setLabel(
      activeContentTab === 'Mocks'
        ? ' [ rule details ] '
        : ' rule details ',
    );
    mocksDetail.style.border.fg = activeContentTab === 'Mocks' ? 'white' : 'cyan';

    pluginsBox.setLabel(activeContentTab === 'Plugins' ? ' [ plugins ] ' : ' plugins ');
    pluginsBox.style.border.fg = activeContentTab === 'Plugins' ? 'white' : 'cyan';

    helpBox.setLabel(activeContentTab === 'Help' ? ' [ help ] ' : ' help ');
    helpBox.style.border.fg = activeContentTab === 'Help' ? 'white' : 'cyan';
  }

  // =====================================================
  //                   TAB SWITCHING
  // =====================================================
  function showTab(idx) {
    tabIdx = ((idx % TABS.length) + TABS.length) % TABS.length;
    for (const name of TABS) pages[name].hide();
    pages[TABS[tabIdx]].show();
    if (TABS[tabIdx] === 'Mocks') renderMocks();
    if (TABS[tabIdx] === 'Plugins') renderPlugins();
    updateHelp();
    renderTabBar();
  }

  function updateHelp() {
    const tab = TABS[tabIdx];
    if (focusZone === 'tabs') {
      setHelp('[←/→] tab   [↓/enter] enter tab   [q] quit');
      return;
    }
    if (tab === 'Configs') {
      if (cfgPane === 'left') {
        setHelp('[↑/↓] pick config   [→] options   [enter] open   [s] stop   [↑@top → tabs]   [q] quit');
      } else if (cfgRightFocus === 'btn') {
        setHelp('[enter] start/stop   [↓] options   [←] configs   [↑] tabs   [q] quit');
      } else {
        setHelp('[↑/↓] pick option   [enter] edit   [←] configs   [↑@top → button]   [q] quit');
      }
    } else if (tab === 'Logs') {
      setHelp('[↑/↓] scroll   [↑@top → tabs]   [c] clear   [q] quit');
    } else if (tab === 'Mocks') {
      setHelp('[↑/↓] pick   [enter/e] edit   [a] add   [d] delete   [J/K] reorder   [↑@top → tabs]   [q] quit');
    } else if (tab === 'Plugins') {
      setHelp('[↑/↓] browse   [↑@top → tabs]   [q] quit');
    } else if (tab === 'Help') {
      setHelp('[↑/↓] scroll   [↑@top → tabs]   [q] quit');
    }
  }

  // =====================================================
  //                   NAV KEY HELPERS
  // =====================================================
  function atTopOfList(list) {
    return (list.selected || 0) === 0;
  }

  // Only act on nav keys when no popup is open (popups have their own focus).
  let popupCount = 0;
  let headersEditorOpen = false;
  let pluginsEditorOpen = false;
  function navActive() { return popupCount === 0; }

  screen.key('left', () => {
    if (!navActive()) return;
    if (focusZone === 'tabs') { showTab(tabIdx - 1); return; }
    if (TABS[tabIdx] === 'Configs' && cfgPane === 'right') {
      cfgPane = 'left';
      cfgList.focus();
      renderRight(); updateHelp();
    }
  });

  screen.key('right', () => {
    if (!navActive()) return;
    if (focusZone === 'tabs') { showTab(tabIdx + 1); return; }
    if (TABS[tabIdx] === 'Configs' && cfgPane === 'left') {
      cfgPane = 'right';
      cfgRightFocus = 'btn';
      renderRight(); updateHelp();
    }
  });

  screen.key('down', () => {
    if (!navActive()) return;
    if (focusZone === 'tabs') {
      focusZone = 'content';
      const tab = TABS[tabIdx];
      if (tab === 'Configs') {
        cfgPane = 'left';
        cfgList.focus();
      } else if (tab === 'Logs') {
        logBox.focus();
      } else if (tab === 'Mocks') {
        mocksList.focus();
        if ((mocksList.selected || 0) < 0) mocksList.select(0);
      } else if (tab === 'Plugins') {
        pluginsBox.focus();
        if ((pluginsBox.selected || 0) < 0) pluginsBox.select(0);
      } else if (tab === 'Help') {
        helpBox.focus();
      }
      renderTabBar(); renderRight(); updateHelp();
      return;
    }
    const tab = TABS[tabIdx];
    if (tab === 'Configs') {
      if (cfgPane === 'left') {
        if (selectedCfgIdx < configs.length - 1) {
          selectedCfgIdx++;
          cfgList.select(selectedCfgIdx);
          renderRight();
        }
      } else if (cfgRightFocus === 'btn') {
        cfgRightFocus = 'opts';
        optionsList.focus();
        optionsList.select(0);
        renderRight(); updateHelp();
      } else {
        const cur = optionsList.selected || 0;
        if (cur < optionRows.length - 1) {
          optionsList.select(cur + 1);
          screen.render();
        }
      }
    } else if (tab === 'Logs') {
      logBox.scroll(1); screen.render();
    } else if (tab === 'Mocks') {
      const rules = currentConfig()?.config?.mock?.rules || [];
      const cur = mocksList.selected || 0;
      if (cur < rules.length - 1) {
        mocksList.select(cur + 1);
        renderMocksDetail();
        screen.render();
      }
    } else if (tab === 'Plugins') {
      pluginsBox.select((pluginsBox.selected || 0) + 1); screen.render();
    } else if (tab === 'Help') {
      helpBox.scroll(1); screen.render();
    }
  });

  screen.key('up', () => {
    if (!navActive()) return;
    if (focusZone === 'tabs') return;
    const tab = TABS[tabIdx];
    if (tab === 'Configs') {
      if (cfgPane === 'left') {
        if (atTopOfList(cfgList)) {
          focusZone = 'tabs'; renderTabBar(); renderRight(); updateHelp();
        } else {
          selectedCfgIdx--;
          cfgList.select(selectedCfgIdx);
          renderRight();
        }
      } else {
        if (cfgRightFocus === 'btn') {
          focusZone = 'tabs'; renderTabBar(); renderRight(); updateHelp();
        } else {
          const cur = optionsList.selected || 0;
          if (cur === 0) {
            cfgRightFocus = 'btn';
            renderRight(); updateHelp();
          } else {
            optionsList.select(cur - 1);
            screen.render();
          }
        }
      }
    } else if (tab === 'Logs') {
      const y = logBox.getScroll?.() ?? 0;
      if (y <= 0) { focusZone = 'tabs'; renderTabBar(); updateHelp(); }
      else { logBox.scroll(-1); screen.render(); }
    } else if (tab === 'Mocks') {
      const cur = mocksList.selected || 0;
      if (cur === 0) { focusZone = 'tabs'; renderTabBar(); updateHelp(); }
      else { mocksList.select(cur - 1); renderMocksDetail(); screen.render(); }
    } else if (tab === 'Plugins') {
      const cur = pluginsBox.selected || 0;
      if (cur === 0) { focusZone = 'tabs'; renderTabBar(); updateHelp(); }
      else { pluginsBox.select(cur - 1); screen.render(); }
    } else if (tab === 'Help') {
      const y = helpBox.getScroll?.() ?? 0;
      if (y <= 0) { focusZone = 'tabs'; renderTabBar(); updateHelp(); }
      else { helpBox.scroll(-1); screen.render(); }
    }
  });

  screen.key('enter', async () => {
    if (!navActive()) return;
    if (focusZone === 'tabs') {
      focusZone = 'content';
      const tab = TABS[tabIdx];
      if (tab === 'Configs') { cfgPane = 'left'; cfgList.focus(); }
      else if (tab === 'Logs') logBox.focus();
      else if (tab === 'Mocks') mocksList.focus();
      else if (tab === 'Plugins') pluginsBox.focus();
      else if (tab === 'Help') helpBox.focus();
      renderTabBar(); renderRight(); updateHelp();
      return;
    }
    if (TABS[tabIdx] === 'Configs') {
      if (cfgPane === 'left') {
        cfgPane = 'right';
        cfgRightFocus = 'btn';
        renderRight(); updateHelp();
      } else if (cfgRightFocus === 'btn') {
        await toggleStartStop();
      } else {
        const row = optionRows[optionsList.selected || 0];
        if (row) await openOptionEditor(row);
      }
    } else if (TABS[tabIdx] === 'Mocks') {
      await openRuleEditor();
    }
  });

  screen.key(['q', 'C-c'], async () => {
    if (active) { try { await onStop(active); } catch {} }
    return process.exit(0);
  });

  screen.key(['s'], async () => {
    if (!active) return;
    setStatus('stopping …', 'yellow');
    try {
      await onStop(active);
      active = null; activeFile = null;
      setStatus('no active proxy', 'white');
      loadConfigs();
    } catch (e) {
      logBox.log(`{red-fg}stop failed: ${e.message}{/}`);
    }
  });

  screen.key(['C-r'], loadConfigs);

  screen.key(['c'], () => {
    if (!navActive()) return;
    if (TABS[tabIdx] !== 'Logs') return;
    logBox.setContent(''); screen.render();
  });

  // ---------- Mocks tab keys ----------
  function onMocksTab() {
    return navActive() && focusZone === 'content' && TABS[tabIdx] === 'Mocks';
  }
  screen.key(['a'], async () => {
    if (!onMocksTab()) return;
    await addNewRule();
  });
  screen.key(['e'], async () => {
    if (!onMocksTab()) return;
    await openRuleEditor();
  });
  screen.key(['d'], async () => {
    if (!onMocksTab()) return;
    await deleteCurrentRule();
  });
  screen.key(['J', 'S-down'], () => {
    if (!onMocksTab()) return;
    moveCurrentRule(1);
  });
  screen.key(['K', 'S-up'], () => {
    if (!onMocksTab()) return;
    moveCurrentRule(-1);
  });

  // =====================================================
  //                   START / STOP
  // =====================================================
  async function toggleStartStop() {
    const entry = currentConfig();
    if (!entry?.config) { logBox.log('{red-fg}invalid config{/}'); return; }
    if (active && entry.file === activeFile) {
      setStatus('stopping …', 'yellow');
      try {
        await onStop(active);
        active = null; activeFile = null;
        setStatus('no active proxy', 'white');
      } catch (e) {
        logBox.log(`{red-fg}stop failed: ${e.message}{/}`);
      }
      loadConfigs();
      return;
    }
    if (active) {
      const activeEntry = configs.find((c) => c.file === activeFile);
      const pick = await promptChoice({
        label: 'another proxy is running',
        options: [
          { label: 'close', value: 'close' },
          { label: 'switch to this config', value: 'switch' },
        ],
        initialIdx: 0,
      });
      if (pick === 'switch') {
        // Stop the current one, then start the newly selected one.
        setStatus('stopping …', 'yellow');
        try {
          await onStop(active);
          active = null; activeFile = null;
        } catch (e) {
          logBox.log(`{red-fg}stop failed: ${e.message}{/}`);
          setStatus('stop failed', 'red');
          loadConfigs();
          return;
        }
        setStatus(`starting ${entry.config.name} …`, 'yellow');
        try {
          active = await onStart(entry.config, entry.file);
          activeFile = entry.file;
          setStatus(
            `running · ${entry.config.name} · :${entry.config.port} → ${entry.config.target}`,
            'green',
          );
        } catch (e) {
          logBox.log(`{red-fg}start failed: ${e.message}{/}`);
          setStatus('failed to start', 'red');
        }
        loadConfigs();
      } else {
        // user chose close or dismissed – just log and bail.
        const name = activeEntry?.config?.name || activeFile || '(unknown)';
        logBox.log(`{yellow-fg}"${name}" is already running – stop it first (s) or pick "switch"{/}`);
      }
      return;
    }
    setStatus(`starting ${entry.config.name} …`, 'yellow');
    try {
      active = await onStart(entry.config, entry.file);
      activeFile = entry.file;
      setStatus(
        `running · ${entry.config.name} · :${entry.config.port} → ${entry.config.target}`,
        'green',
      );
    } catch (e) {
      logBox.log(`{red-fg}start failed: ${e.message}{/}`);
      setStatus('failed to start', 'red');
    }
    loadConfigs();
  }

  // =====================================================
  //                   POPUP EDITORS
  // =====================================================
  // Popup background: bright black (gray); border yellow.
  const POPUP_BG = 'gray';
  const INPUT_BG = 'yellow';
  const INPUT_FG = 'black';

  function popupBox(opts) {
    return blessed.box({
      parent: screen,
      top: 'center', left: 'center',
      width: opts.width || '60%',
      height: opts.height || '50%',
      border: 'line',
      label: opts.label,
      tags: true,
      style: { border: { fg: 'yellow' }, bg: POPUP_BG, fg: 'white' },
      keys: false, mouse: true,
    });
  }

  // Decrement popupCount on next tick so any trailing key event
  // (e.g. Enter that submitted a textbox) does not propagate to the
  // screen-level handler and trigger an action in the underlying view.
  function deferReleasePopup() {
    setImmediate(() => { popupCount = Math.max(0, popupCount - 1); });
  }

  function restorePopupFocus(previousFocus) {
    if (
      previousFocus
      && previousFocus.screen === screen
      && !previousFocus.detached
      && typeof previousFocus.focus === 'function'
    ) {
      previousFocus.focus();
      return;
    }
    screen.rewindFocus();
  }

  function promptValue({ label, initial, multiline = false }) {
    return new Promise((resolve) => {
      popupCount++;
      const box = popupBox({
        label: ` ${label} `,
        width: multiline ? '80%' : '60%',
        height: multiline ? '70%' : 7,
      });
      blessed.box({
        parent: box,
        top: 0, left: 1, right: 1, height: 1,
        content: multiline ? 'edit JSON · [Ctrl-S] save  [Esc] cancel' : '[Enter] save   [Esc] cancel',
        style: { fg: 'white', bg: POPUP_BG },
      });
      const input = (multiline ? blessed.textarea : blessed.textbox)({
        parent: box,
        top: 2, left: 1, right: 1, bottom: 1,
        inputOnFocus: true,
        keys: true,
        mouse: true,
        style: { fg: INPUT_FG, bg: INPUT_BG },
      });
      input.setValue(initial ?? '');
      let done = false;
      const cleanup = (val) => {
        if (done) return;
        done = true;
        deferReleasePopup();
        box.destroy();
        screen.render();
        resolve(val);
      };
      input.key('escape', () => cleanup(null));
      if (multiline) {
        input.key(['C-s'], () => cleanup(input.getValue()));
      } else {
        input.on('submit', () => cleanup(input.getValue()));
        input.on('cancel', () => cleanup(null));
      }
      setImmediate(() => { if (!done) input.focus(); });
      screen.render();
    });
  }

  // Norton-Commander style choice popup. All buttons visible at once;
  // the active one is highlighted. Use ←/→ (or ↑/↓) to move, Enter to pick.
  function promptChoice({ label, options, initialIdx = 0 }) {
    return new Promise((resolve) => {
      popupCount++;
      const labels = options.map((o) => ` ${o.label} `);
      const btnPaddedW = labels.reduce((m, l) => Math.max(m, l.length + 4), 10);
      const totalBtnW = btnPaddedW * options.length + (options.length - 1);
      const width = Math.max(40, Math.min(totalBtnW + 6, 100));
      const height = 8;
      const box = popupBox({ label: ` ${label} `, width, height });
      blessed.box({
        parent: box,
        top: 0, left: 1, right: 1, height: 1,
        content: '[←/→] pick  [enter] confirm  [esc] cancel',
        style: { fg: 'white', bg: POPUP_BG },
      });

      let cursor = Math.max(0, Math.min(initialIdx, options.length - 1));
      const buttons = [];
      let done = false;
      let keyHandler = null;

      const cleanup = (val) => {
        if (done) return;
        done = true;
        if (keyHandler) screen.removeListener('keypress', keyHandler);
        deferReleasePopup();
        box.destroy();
        screen.render();
        resolve(val);
      };

      function renderButtons() {
        for (let i = 0; i < options.length; i++) {
          const active = i === cursor;
          const bg = active ? 'yellow' : 'black';
          const fg = active ? 'black' : 'white';
          const text = labels[i];
          const padLeft = Math.floor((btnPaddedW - text.length) / 2);
          const padRight = btnPaddedW - text.length - padLeft;
          const inner = ' '.repeat(padLeft) + text + ' '.repeat(padRight);
          buttons[i].style.bg = bg;
          buttons[i].style.fg = fg;
          buttons[i].setContent(`{${active ? 'bold' : 'normal'}}${inner}{/}`);
        }
        screen.render();
      }

      const startCol = Math.max(2, Math.floor((width - totalBtnW) / 2));
      for (let i = 0; i < options.length; i++) {
        const btn = blessed.box({
          parent: box,
          top: 3,
          left: startCol + i * (btnPaddedW + 1),
          width: btnPaddedW,
          height: 3,
          border: 'line',
          tags: true,
          mouse: true,
          style: { border: { fg: 'white' }, bg: 'black', fg: 'white' },
          content: '',
        });
        btn.on('click', () => { cursor = i; renderButtons(); cleanup(options[i].value ?? null); });
        buttons.push(btn);
      }

      keyHandler = (_ch, key) => {
        if (done) return;
        const n = key && key.name;
        if (n === 'escape') return cleanup(null);
        if (n === 'enter' || n === 'return') return cleanup(options[cursor]?.value ?? null);
        if (n === 'left' || n === 'up' || n === 'h') {
          cursor = (cursor - 1 + options.length) % options.length;
          renderButtons(); return;
        }
        if (n === 'right' || n === 'down' || n === 'l' || n === 'tab') {
          cursor = (cursor + 1) % options.length;
          renderButtons(); return;
        }
      };
      // Defer listener attachment so the Enter keypress that opened this
      // popup doesn't immediately trigger its own confirm handler.
      setImmediate(() => {
        if (done) return;
        screen.on('keypress', keyHandler);
      });

      renderButtons();
      screen.render();
    });
  }

  // Restart active proxy after a config change (only if the edited entry
  // is currently running).
  async function restartIfActive(entry) {
    if (!active || !entry || entry.file !== activeFile) return;
    try {
      await onStop(active);
      active = null;
      active = await onStart(entry.config, entry.file);
      activeFile = entry.file;
      setStatus(
        `running · ${entry.config.name} · :${entry.config.port} → ${entry.config.target}`,
        'green',
      );
    } catch (e) {
      active = null; activeFile = null;
      setStatus('restart failed', 'red');
      logBox.log(`{red-fg}restart after config change failed: ${e.message}{/}`);
    }
    loadConfigs();
  }

  async function openOptionEditor(row) {
    const entry = currentConfig();
    if (!entry?.config) return;

    if (row.kind === 'headers') {
      await openHeadersEditor(entry);
      renderRight();
      await restartIfActive(entry);
      return;
    }

    if (row.kind === 'scalar') {
      const current = entry.config[row.key];
      const kind = typeof current;

      if (kind === 'boolean') {
        const picked = await promptChoice({
          label: `edit ${row.key} (boolean)`,
          options: [
            { label: 'true', value: true },
            { label: 'false', value: false },
          ],
          initialIdx: current ? 0 : 1,
        });
        if (picked === null) return;
        entry.config[row.key] = picked;
        saveCurrentConfig();
        renderRight();
        await restartIfActive(entry);
        return;
      }

      const val = await promptValue({
        label: `edit ${row.key} (${kind})`,
        initial: prettyValue(current),
      });
      if (val === null) return;
      let parsed = val;
      if (kind === 'number') {
        const n = Number(val);
        if (Number.isNaN(n)) {
          logBox.log(`{red-fg}invalid number for ${row.key}{/}`);
          return;
        }
        parsed = n;
      }
      entry.config[row.key] = parsed;
      saveCurrentConfig();
      renderRight();
      await restartIfActive(entry);
      return;
    }

    if (row.kind === 'plugins') {
      await openPluginsEditor(entry);
      renderRight();
      await restartIfActive(entry);
      return;
    }

    if (row.kind === 'json') {
      const current = entry.config[row.key];
      const val = await promptValue({
        label: `edit ${row.key} (JSON)`,
        initial: JSON.stringify(current ?? null, null, 2),
        multiline: true,
      });
      if (val === null) return;
      try {
        entry.config[row.key] = JSON.parse(val);
        saveCurrentConfig();
        renderRight();
        await restartIfActive(entry);
      } catch (e) {
        logBox.log(`{red-fg}invalid JSON for ${row.key}: ${e.message}{/}`);
      }
    }
  }

  // Combined "name + value" form for adding a header. A single popup with
  // two textboxes; submitting either jumps to next, Tab/Shift-Tab toggles
  // focus, Esc cancels at any time. Avoids the previous nested-popup bug.
  function promptHeaderForm({ initialName = '', initialValue = '' } = {}) {
    return new Promise((resolve) => {
      popupCount++;
      const box = popupBox({ label: ' add header ', width: '60%', height: 11 });
      blessed.box({
        parent: box,
        top: 0, left: 1, right: 1, height: 1,
        content: '[Tab] switch  [Enter] next/save  [Esc] cancel',
        style: { fg: 'white', bg: POPUP_BG },
      });
      blessed.box({
        parent: box, top: 2, left: 1, width: 8, height: 1,
        content: 'name :', style: { fg: 'white', bg: POPUP_BG },
      });
      const nameInput = blessed.textbox({
        parent: box, top: 2, left: 9, right: 1, height: 1,
        inputOnFocus: true, keys: true, mouse: true,
        style: { fg: INPUT_FG, bg: INPUT_BG },
      });
      blessed.box({
        parent: box, top: 4, left: 1, width: 8, height: 1,
        content: 'value:', style: { fg: 'white', bg: POPUP_BG },
      });
      const valueInput = blessed.textbox({
        parent: box, top: 4, left: 9, right: 1, height: 1,
        inputOnFocus: true, keys: true, mouse: true,
        style: { fg: INPUT_FG, bg: INPUT_BG },
      });
      blessed.box({
        parent: box, top: 6, left: 1, right: 1, height: 1,
        content: '{white-fg}Press Enter on value to save.{/}',
        tags: true, style: { fg: 'white', bg: POPUP_BG },
      });

      nameInput.setValue(initialName);
      valueInput.setValue(initialValue);

      let done = false;
      const cleanup = (val) => {
        if (done) return;
        done = true;
        deferReleasePopup();
        box.destroy();
        screen.render();
        resolve(val);
      };

      const finish = () => {
        const n = nameInput.getValue().trim();
        const v = valueInput.getValue();
        if (!n) { nameInput.focus(); return; }
        cleanup({ name: n, value: v });
      };

      nameInput.key('escape', () => cleanup(null));
      valueInput.key('escape', () => cleanup(null));
      nameInput.key('tab', () => valueInput.focus());
      valueInput.key('S-tab', () => nameInput.focus());
      nameInput.on('submit', () => valueInput.focus());
      valueInput.on('submit', finish);
      nameInput.on('cancel', () => cleanup(null));
      valueInput.on('cancel', () => cleanup(null));

      // Defer focus so the Enter that opened the form isn't captured
      // by nameInput's readInput (which would submit it immediately).
      setImmediate(() => { if (!done) nameInput.focus(); });
      screen.render();
    });
  }

  async function openHeadersEditor(entry) {
    if (headersEditorOpen) return;
    headersEditorOpen = true;
    return new Promise((resolve) => {
      popupCount++;
      const previousFocus = screen.focused;
      const cfg = entry.config;
      cfg.requestHeaders ||= {};

      const box = popupBox({
        label: ' requestHeaders ',
        width: '70%', height: '70%',
      });
      blessed.box({
        parent: box,
        top: 0, left: 1, right: 1, height: 1,
        content: '[↑/↓] pick  [enter] edit  [a] add  [d] delete  [Esc] close',
        style: { fg: 'white', bg: POPUP_BG },
      });
      const list = blessed.list({
        parent: box,
        top: 2, left: 1, right: 1, bottom: 1,
        keys: true, mouse: true,
        tags: true,
        style: {
          selected: { bg: 'blue', fg: 'white', bold: true },
          item: { fg: 'white' },
          bg: POPUP_BG,
        },
      });

      function rebuild() {
        const entries = Object.entries(cfg.requestHeaders);
        if (!entries.length) {
          list.setItems([' (no headers — press [a] to add)']);
        } else {
          list.setItems(entries.map(([k, v]) => ` {cyan-fg}${k}{/}  :  ${prettyValue(v)}`));
        }
        screen.render();
      }

      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        armed = false;
        headersEditorOpen = false;
        deferReleasePopup();
        saveCurrentConfig();
        box.destroy();
        restorePopupFocus(previousFocus);
        screen.render();
        resolve();
      };

      let armed = false;

      // Disarm the list while a sub-popup is open, and re-arm on next tick
      // after it closes so the Enter that submitted the sub-popup doesn't
      // re-trigger this list's enter/action handlers.
      const withSubPopup = async (fn) => {
        armed = false;
        try {
          return await fn();
        } finally {
          setImmediate(() => { armed = true; });
        }
      };

      list.key('escape', cleanup);

      list.key('enter', async () => {
        if (!armed) return;
        const entries = Object.entries(cfg.requestHeaders);
        if (!entries.length) return;
        const idx = list.selected || 0;
        const [k, v] = entries[idx];
        const nv = await withSubPopup(() => promptValue({
          label: `edit header ${k}`,
          initial: String(v ?? ''),
        }));
        if (nv === null) { list.focus(); return; }
        cfg.requestHeaders[k] = nv;
        rebuild();
        list.focus();
      });

      list.key('a', async () => {
        if (!armed) return;
        const result = await withSubPopup(() => promptHeaderForm());
        if (result === null) { list.focus(); return; }
        cfg.requestHeaders[result.name] = result.value;
        rebuild();
        list.focus();
      });

      list.key('d', () => {
        if (!armed) return;
        const entries = Object.entries(cfg.requestHeaders);
        if (!entries.length) return;
        const idx = list.selected || 0;
        const [k] = entries[idx];
        delete cfg.requestHeaders[k];
        rebuild();
      });

      rebuild();
      // Defer focus so the Enter that opened the editor cannot also
      // trigger an immediate edit on the first selected header.
      setImmediate(() => {
        if (cleanedUp) return;
        armed = true;
        list.focus();
        screen.render();
      });
    });
  }

  async function openPluginsEditor(entry) {
    if (pluginsEditorOpen) return;
    pluginsEditorOpen = true;
    return new Promise((resolve) => {
      popupCount++;
      const previousFocus = screen.focused;
      const cfg = entry.config;
      cfg.plugins ||= [];

      let files = [];
      try {
        files = fs.readdirSync(pluginsDir).filter((f) => f.endsWith('.js'));
      } catch {}
      const names = files.map((f) => f.replace(/\.js$/, ''));
      // Preserve any enabled plugin name even if its file is missing.
      for (const n of cfg.plugins) {
        if (!names.includes(n)) names.push(n);
      }

      const box = popupBox({
        label: ' plugins ',
        width: '60%',
        height: Math.min(names.length + 6, 24),
      });
      blessed.box({
        parent: box,
        top: 0, left: 1, right: 1, height: 1,
        content: '[↑/↓] pick  [space/enter] toggle  [Esc] close',
        style: { fg: 'white', bg: POPUP_BG },
      });

      const list = blessed.list({
        parent: box,
        top: 2, left: 1, right: 1, bottom: 1,
        keys: false, mouse: true,
        tags: true,
        style: {
          selected: { bg: 'blue', fg: 'white', bold: true },
          item: { fg: 'white' },
          bg: POPUP_BG,
        },
      });

      function rebuild() {
        if (!names.length) {
          list.setItems([' (no plugin files in plugins/)']);
          screen.render();
          return;
        }
        const enabled = new Set(cfg.plugins);
        list.setItems(names.map((n) => {
          const on = enabled.has(n);
          const box = on ? '{green-fg}[x]{/}' : '{white-fg}[ ]{/}';
          const tag = on ? '  {cyan-fg}(enabled){/}' : '';
          return ` ${box}  ${n}${tag}`;
        }));
        if ((list.selected ?? -1) < 0) list.select(0);
        else if ((list.selected || 0) >= names.length) list.select(Math.max(0, names.length - 1));
        screen.render();
      }

      function toggle() {
        if (!names.length) return;
        const idx = list.selected || 0;
        const name = names[idx];
        const i = cfg.plugins.indexOf(name);
        if (i === -1) cfg.plugins.push(name);
        else cfg.plugins.splice(i, 1);
        rebuild();
      }

      let done = false;
      let armed = false;

      function moveSelection(offset) {
        if (!names.length) return;
        const cur = list.selected || 0;
        const next = Math.max(0, Math.min(names.length - 1, cur + offset));
        if (next === cur) return;
        list.select(next);
        screen.render();
      }

      const cleanup = () => {
        if (done) return;
        done = true;
        armed = false;
        pluginsEditorOpen = false;
        deferReleasePopup();
        saveCurrentConfig();
        box.destroy();
        restorePopupFocus(previousFocus);
        screen.render();
        resolve();
      };

      list.key('escape', cleanup);
      list.key('up', () => { if (armed) moveSelection(-1); });
      list.key('down', () => { if (armed) moveSelection(1); });
      list.key(['space', 'enter'], () => { if (armed) toggle(); });

      rebuild();
      screen.render();
      setImmediate(() => {
        if (done) return;
        armed = true;
        list.focus();
        screen.render();
      });
    });
  }

  // =====================================================
  //                   MOCK RULE EDITORS
  // =====================================================
  const METHOD_CHOICES = [
    { label: 'GET', value: 'GET' },
    { label: 'POST', value: 'POST' },
    { label: 'PUT', value: 'PUT' },
    { label: 'PATCH', value: 'PATCH' },
    { label: 'DELETE', value: 'DELETE' },
    { label: 'HEAD', value: 'HEAD' },
    { label: 'ANY (*)', value: '*' },
  ];

  const ACTION_CHOICES = [
    { label: 'MOCK (return inline response)', value: 'MOCK' },
    { label: 'RET_REC (replay recording)', value: 'RET_REC' },
    { label: 'PASS (forward upstream)', value: 'PASS' },
  ];

  const FALLBACK_CHOICES = [
    { label: '500 error', value: '500' },
    { label: 'empty 200', value: 'empty200' },
    { label: 'PASS upstream', value: 'PASS' },
  ];

  const MATCH_KIND_CHOICES = [
    { label: 'exact path', value: 'exact' },
    { label: 'pattern (with :params)', value: 'pattern' },
    { label: 'contains (substring)', value: 'contains' },
  ];

  function applyMatchKind(rule, kind, urlText) {
    delete rule.url;
    delete rule.urlContains;
    if (kind === 'contains') rule.urlContains = urlText;
    else rule.url = urlText;
  }

  // Parse user-typed body. If it parses as JSON, store as object/array/etc;
  // otherwise keep as plain string. Empty string → empty body.
  function parseBodyInput(text) {
    if (text === '') return '';
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[') ||
        trimmed === 'null' || trimmed === 'true' || trimmed === 'false' ||
        /^-?\d/.test(trimmed) || trimmed.startsWith('"')) {
      try { return JSON.parse(trimmed); } catch { /* fall through to string */ }
    }
    return text;
  }

  async function addNewRule() {
    const entry = currentConfig();
    if (!entry?.config) { logBox.log('{red-fg}invalid config{/}'); return; }

    const action = await promptChoice({
      label: 'new mock rule — pick action',
      options: ACTION_CHOICES,
      initialIdx: 0,
    });
    if (action === null) return;

    const method = await promptChoice({
      label: 'method',
      options: METHOD_CHOICES,
      initialIdx: 0,
    });
    if (method === null) return;

    const matchKind = await promptChoice({
      label: 'url match type',
      options: MATCH_KIND_CHOICES,
      initialIdx: 0,
    });
    if (matchKind === null) return;

    const urlVal = await promptValue({
      label: matchKind === 'contains' ? 'url substring (e.g. /api)' : 'url path (e.g. /users/:id)',
      initial: matchKind === 'contains' ? '/api' : '/',
    });
    if (urlVal === null) return;
    const trimmed = String(urlVal).trim();
    if (!trimmed) { logBox.log('{red-fg}url cannot be empty{/}'); return; }

    const rule = { method, action };
    applyMatchKind(rule, matchKind, trimmed);

    if (action === 'MOCK') {
      const statusVal = await promptValue({ label: 'response status', initial: '200' });
      if (statusVal === null) return;
      const n = Number(statusVal);
      const status = Number.isFinite(n) ? n : 200;
      const bodyVal = await promptValue({
        label: 'response body — JSON or text · [Ctrl-S] save · [Esc] cancel',
        initial: '{\n  "ok": true\n}',
        multiline: true,
      });
      if (bodyVal === null) return;
      const body = parseBodyInput(bodyVal);
      const headers = (typeof body === 'string')
        ? {}
        : { 'content-type': 'application/json' };
      rule.response = { status, headers, body };
    } else if (action === 'RET_REC') {
      const fb = await promptChoice({
        label: 'fallback when no recording',
        options: FALLBACK_CHOICES,
        initialIdx: 0,
      });
      if (fb === null) return;
      rule.fallback = fb;
    }

    entry.config.mock ||= {};
    entry.config.mock.rules ||= [];
    entry.config.mock.rules.push(rule);
    saveCurrentConfig();
    renderMocks();
    mocksList.select(entry.config.mock.rules.length - 1);
    renderMocks();
    await restartIfActive(entry);
  }

  async function openRuleEditor() {
    const entry = currentConfig();
    if (!entry?.config) { logBox.log('{red-fg}invalid config{/}'); return; }
    const rules = entry.config?.mock?.rules || [];
    if (!rules.length) {
      await addNewRule();
      return;
    }
    const idx = mocksList.selected || 0;
    if (idx < 0 || idx >= rules.length) return;
    await editRuleFields(entry, rules[idx]);
    renderMocks();
    await restartIfActive(entry);
  }

  async function deleteCurrentRule() {
    const entry = currentConfig();
    if (!entry?.config) return;
    const rules = entry.config?.mock?.rules || [];
    if (!rules.length) return;
    const idx = mocksList.selected || 0;
    if (idx < 0 || idx >= rules.length) return;
    const rule = rules[idx];
    const target = ruleTargetText(rule) || '?';
    const method = (rule.method || '*').toUpperCase();
    const confirm = await promptChoice({
      label: `delete rule #${idx + 1}: ${method} ${target}?`,
      options: [
        { label: 'cancel', value: 'cancel' },
        { label: 'delete', value: 'delete' },
      ],
      initialIdx: 0,
    });
    if (confirm !== 'delete') return;
    rules.splice(idx, 1);
    saveCurrentConfig();
    if (idx >= rules.length) mocksList.select(Math.max(0, rules.length - 1));
    renderMocks();
    await restartIfActive(entry);
  }

  function moveCurrentRule(dir) {
    const entry = currentConfig();
    if (!entry?.config) return;
    const rules = entry.config?.mock?.rules || [];
    if (rules.length < 2) return;
    const idx = mocksList.selected || 0;
    const ni = idx + dir;
    if (ni < 0 || ni >= rules.length) return;
    [rules[idx], rules[ni]] = [rules[ni], rules[idx]];
    saveCurrentConfig();
    mocksList.select(ni);
    renderMocks();
    restartIfActive(entry).catch(() => {});
  }

  // Field-picker editor for an existing rule. Loops until user presses Esc.
  function editRuleFields(entry, rule) {
    return new Promise((resolve) => {
      popupCount++;
      const previousFocus = screen.focused;

      const box = popupBox({
        label: ' edit rule ',
        width: '70%', height: '70%',
      });
      blessed.box({
        parent: box,
        top: 0, left: 1, right: 1, height: 1,
        content: '[↑/↓] field   [enter] edit field   [Esc] close',
        style: { fg: 'white', bg: POPUP_BG },
      });

      const list = blessed.list({
        parent: box,
        top: 2, left: 1, right: 1, bottom: 1,
        keys: false, mouse: true,
        tags: true,
        style: {
          selected: { bg: 'blue', fg: 'white', bold: true },
          item: { fg: 'white' },
          bg: POPUP_BG,
        },
      });

      function buildFields() {
        const fields = [];
        fields.push({
          key: 'method',
          label: ` method       =  {magenta-fg}${(rule.method || '*').toUpperCase()}{/}`,
        });
        const kind = ruleMatchKind(rule);
        fields.push({
          key: 'matchKind',
          label: ` match type   =  ${kind}`,
        });
        fields.push({
          key: 'url',
          label: ` url          =  {cyan-fg}${ruleTargetText(rule) || '(none)'}{/}`,
        });
        const action = (rule.action || 'PASS').toUpperCase();
        const aColor = action === 'MOCK' ? 'green' : action === 'PASS' ? 'cyan' : 'yellow';
        fields.push({
          key: 'action',
          label: ` action       =  {${aColor}-fg}{bold}${action}{/}`,
        });
        if (action === 'RET_REC') {
          fields.push({
            key: 'fallback',
            label: ` fallback     =  ${rule.fallback || '500'}`,
          });
        }
        if (action === 'MOCK') {
          rule.response ||= {};
          fields.push({
            key: 'status',
            label: ` resp.status  =  ${rule.response.status ?? 200}`,
          });
          const hCount = Object.keys(rule.response.headers || {}).length;
          fields.push({
            key: 'headers',
            label: ` resp.headers →  ${hCount} header(s) …`,
          });
          const body = rule.response.body;
          const bodyKind = body == null || body === ''
            ? '(empty)'
            : typeof body === 'string' ? 'string'
            : 'JSON';
          fields.push({
            key: 'body',
            label: ` resp.body    →  ${bodyKind} …`,
          });
        }
        return fields;
      }

      let fields = buildFields();
      function rebuild() {
        fields = buildFields();
        list.setItems(fields.map((f) => f.label));
        const sel = list.selected || 0;
        if (sel >= fields.length) list.select(Math.max(0, fields.length - 1));
        screen.render();
      }

      let armed = false;
      let done = false;

      const cleanup = () => {
        if (done) return;
        done = true;
        armed = false;
        deferReleasePopup();
        saveCurrentConfig();
        box.destroy();
        restorePopupFocus(previousFocus);
        screen.render();
        resolve();
      };

      const withSubPopup = async (fn) => {
        armed = false;
        try { return await fn(); }
        finally { setImmediate(() => { armed = true; list.focus(); }); }
      };

      list.key('escape', cleanup);
      list.key('up', () => {
        if (!armed) return;
        const cur = list.selected || 0;
        if (cur > 0) { list.select(cur - 1); screen.render(); }
      });
      list.key('down', () => {
        if (!armed) return;
        const cur = list.selected || 0;
        if (cur < fields.length - 1) { list.select(cur + 1); screen.render(); }
      });

      list.key('enter', async () => {
        if (!armed) return;
        const f = fields[list.selected || 0];
        if (!f) return;
        await editField(f.key);
        rebuild();
        list.focus();
      });

      async function editField(key) {
        if (key === 'method') {
          const cur = (rule.method || '*').toUpperCase();
          const idx = METHOD_CHOICES.findIndex((c) => c.value === cur);
          const v = await withSubPopup(() => promptChoice({
            label: 'method',
            options: METHOD_CHOICES,
            initialIdx: idx >= 0 ? idx : METHOD_CHOICES.length - 1,
          }));
          if (v !== null) rule.method = v;
          return;
        }
        if (key === 'matchKind') {
          const cur = ruleMatchKind(rule);
          const idx = MATCH_KIND_CHOICES.findIndex((c) => c.value === cur);
          const v = await withSubPopup(() => promptChoice({
            label: 'url match type',
            options: MATCH_KIND_CHOICES,
            initialIdx: idx >= 0 ? idx : 0,
          }));
          if (v === null) return;
          applyMatchKind(rule, v, ruleTargetText(rule));
          return;
        }
        if (key === 'url') {
          const isContains = rule.urlContains != null;
          const cur = ruleTargetText(rule);
          const v = await withSubPopup(() => promptValue({
            label: isContains ? 'url substring' : 'url path',
            initial: cur,
          }));
          if (v === null) return;
          if (isContains) rule.urlContains = v;
          else rule.url = v;
          return;
        }
        if (key === 'action') {
          const cur = (rule.action || 'PASS').toUpperCase();
          const idx = ACTION_CHOICES.findIndex((c) => c.value === cur);
          const v = await withSubPopup(() => promptChoice({
            label: 'action',
            options: ACTION_CHOICES,
            initialIdx: idx >= 0 ? idx : 0,
          }));
          if (v === null) return;
          rule.action = v;
          if (v === 'MOCK') {
            rule.response ||= { status: 200, headers: { 'content-type': 'application/json' }, body: '' };
            delete rule.fallback;
          } else if (v === 'RET_REC') {
            rule.fallback ||= '500';
            delete rule.response;
          } else {
            delete rule.response;
            delete rule.fallback;
          }
          return;
        }
        if (key === 'fallback') {
          const cur = rule.fallback || '500';
          const idx = FALLBACK_CHOICES.findIndex((c) => c.value === cur);
          const v = await withSubPopup(() => promptChoice({
            label: 'fallback (RET_REC miss)',
            options: FALLBACK_CHOICES,
            initialIdx: idx >= 0 ? idx : 0,
          }));
          if (v !== null) rule.fallback = v;
          return;
        }
        if (key === 'status') {
          rule.response ||= {};
          const v = await withSubPopup(() => promptValue({
            label: 'response status (number)',
            initial: String(rule.response.status ?? 200),
          }));
          if (v === null) return;
          const n = Number(v);
          if (!Number.isFinite(n)) {
            logBox.log('{red-fg}invalid status (must be a number){/}');
            return;
          }
          rule.response.status = n;
          return;
        }
        if (key === 'headers') {
          rule.response ||= {};
          rule.response.headers ||= {};
          await withSubPopup(() => editHeadersObject(rule.response.headers, ' response headers '));
          return;
        }
        if (key === 'body') {
          rule.response ||= {};
          const cur = rule.response.body;
          const initialText = cur == null ? ''
            : typeof cur === 'string' ? cur
            : (() => { try { return JSON.stringify(cur, null, 2); } catch { return String(cur); } })();
          const v = await withSubPopup(() => promptValue({
            label: 'response body — JSON or text · [Ctrl-S] save · [Esc] cancel',
            initial: initialText,
            multiline: true,
          }));
          if (v === null) return;
          rule.response.body = parseBodyInput(v);
        }
      }

      rebuild();
      setImmediate(() => {
        if (done) return;
        armed = true;
        list.focus();
        screen.render();
      });
    });
  }

  // Generic header-object editor (for rule.response.headers).
  // Mirrors openHeadersEditor but works on any plain object reference.
  function editHeadersObject(headersObj, label) {
    return new Promise((resolve) => {
      popupCount++;
      const previousFocus = screen.focused;

      const box = popupBox({ label, width: '70%', height: '60%' });
      blessed.box({
        parent: box,
        top: 0, left: 1, right: 1, height: 1,
        content: '[↑/↓] pick  [enter] edit  [a] add  [d] delete  [Esc] close',
        style: { fg: 'white', bg: POPUP_BG },
      });
      const list = blessed.list({
        parent: box,
        top: 2, left: 1, right: 1, bottom: 1,
        keys: true, mouse: true,
        tags: true,
        style: {
          selected: { bg: 'blue', fg: 'white', bold: true },
          item: { fg: 'white' },
          bg: POPUP_BG,
        },
      });

      function rebuild() {
        const entries = Object.entries(headersObj);
        if (!entries.length) {
          list.setItems([' (no headers — press [a] to add)']);
        } else {
          list.setItems(entries.map(([k, v]) => ` {cyan-fg}${k}{/}  :  ${prettyValue(v)}`));
        }
        screen.render();
      }

      let cleanedUp = false;
      let armed = false;

      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        armed = false;
        deferReleasePopup();
        box.destroy();
        restorePopupFocus(previousFocus);
        screen.render();
        resolve();
      };

      const withSubPopup = async (fn) => {
        armed = false;
        try { return await fn(); }
        finally { setImmediate(() => { armed = true; }); }
      };

      list.key('escape', cleanup);

      list.key('enter', async () => {
        if (!armed) return;
        const entries = Object.entries(headersObj);
        if (!entries.length) return;
        const idx = list.selected || 0;
        const [k, v] = entries[idx];
        const nv = await withSubPopup(() => promptValue({
          label: `edit header ${k}`,
          initial: String(v ?? ''),
        }));
        if (nv === null) { list.focus(); return; }
        headersObj[k] = nv;
        rebuild();
        list.focus();
      });

      list.key('a', async () => {
        if (!armed) return;
        const result = await withSubPopup(() => promptHeaderForm());
        if (result === null) { list.focus(); return; }
        headersObj[result.name] = result.value;
        rebuild();
        list.focus();
      });

      list.key('d', () => {
        if (!armed) return;
        const entries = Object.entries(headersObj);
        if (!entries.length) return;
        const idx = list.selected || 0;
        const [k] = entries[idx];
        delete headersObj[k];
        rebuild();
      });

      rebuild();
      setImmediate(() => {
        if (cleanedUp) return;
        armed = true;
        list.focus();
        screen.render();
      });
    });
  }

  // =====================================================
  //                      LOGGING
  // =====================================================
  logger.on('log', (e) => {
    const color = levelColor(e.level);
    logBox.log(`{cyan-fg}${fmtTs(e.ts)}{/} {${color}-fg}${e.level.padEnd(5)}{/} ${e.msg}`);
  });

  logger.on('trace', (e) => {
    if (e.kind === 'request') {
      const d = e.data;
      const c = d.status >= 500 ? 'red' : d.status >= 400 ? 'yellow' : 'green';
      logBox.log(
        `{cyan-fg}${fmtTs(e.ts)}{/} {${c}-fg}${String(d.status).padEnd(3)}{/} ${d.method.padEnd(6)} ${d.url}  {white-fg}(${d.source}, ${d.ms}ms){/}`,
      );
    } else if (e.kind === 'ws-upgrade') {
      logBox.log(`{cyan-fg}${fmtTs(e.ts)}{/} {magenta-fg}WS   {/} upgrade ${e.data.url}`);
    }
  });

  // =====================================================
  //                       BOOT
  // =====================================================
  loadConfigs();
  showTab(0);
  renderTabBar();
  updateHelp();
  screen.render();

  return { screen, logBox, setStatus, reload: loadConfigs };
}
