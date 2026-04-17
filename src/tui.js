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
  const TABS = ['Configs', 'Logs', 'Mocks', 'Plugins'];
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

  // Each row: { key, kind } kind: 'scalar' | 'json' | 'headers'
  function buildOptionRows(cfg) {
    if (!cfg) return [];
    const rows = [];
    const scalarKeys = ['name', 'port', 'target', 'changeOrigin', 'followRedirects'];
    for (const k of scalarKeys) {
      if (k in cfg) rows.push({ key: k, value: cfg[k], kind: 'scalar' });
    }
    rows.push({ key: 'requestHeaders', value: cfg.requestHeaders || {}, kind: 'headers' });
    rows.push({ key: 'plugins', value: cfg.plugins || [], kind: 'json' });
    for (const k of Object.keys(cfg)) {
      if (scalarKeys.includes(k)) continue;
      if (k === 'requestHeaders' || k === 'plugins') continue;
      rows.push({ key: k, value: cfg[k], kind: 'json' });
    }
    return rows;
  }

  let optionRows = [];

  function renderRight() {
    const entry = currentConfig();
    const running = !!(active && entry && entry.file === activeFile);
    const btnActive = cfgPane === 'right' && cfgRightFocus === 'btn' && focusZone === 'content';
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
      if (r.kind === 'json') {
        return ` {cyan-fg}${r.key}{/}  =  ${prettyValue(r.value).slice(0, 80)}`;
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
  const mocksBox = blessed.list({
    parent: pages['Mocks'],
    label: ' mock rules (selected config) ',
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

  function renderMocks() {
    const entry = currentConfig();
    const rules = entry?.config?.mock?.rules || [];
    if (!rules.length) {
      mocksBox.setItems([' (no mock rules defined for this config)']);
      return;
    }
    mocksBox.setItems(rules.map((r, i) => {
      const method = r.method || '*';
      const target = r.url || r.urlContains || r.urlMatches || '?';
      const action = r.action || '?';
      const color =
        action === 'MOCK' ? 'green' :
        action === 'PASS' ? 'cyan' :
        action.startsWith('REC') || action.startsWith('RET') ? 'yellow' : 'white';
      return ` ${String(i + 1).padStart(2)}  {magenta-fg}${method.padEnd(6)}{/}  ${String(target).padEnd(30)}  {${color}-fg}${action}{/}`;
    }));
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
      setHelp('[↑/↓] browse   [↑@top → tabs]   [q] quit');
    } else if (tab === 'Plugins') {
      setHelp('[↑/↓] browse   [↑@top → tabs]   [q] quit');
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
        mocksBox.focus();
        if ((mocksBox.selected || 0) < 0) mocksBox.select(0);
      } else if (tab === 'Plugins') {
        pluginsBox.focus();
        if ((pluginsBox.selected || 0) < 0) pluginsBox.select(0);
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
      mocksBox.select((mocksBox.selected || 0) + 1); screen.render();
    } else if (tab === 'Plugins') {
      pluginsBox.select((pluginsBox.selected || 0) + 1); screen.render();
    }
  });

  screen.key('up', () => {
    if (!navActive()) return;
    if (focusZone === 'tabs') return;
    const tab = TABS[tabIdx];
    if (tab === 'Configs') {
      if (cfgPane === 'left') {
        if (atTopOfList(cfgList)) {
          focusZone = 'tabs'; renderTabBar(); updateHelp();
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
      const cur = mocksBox.selected || 0;
      if (cur === 0) { focusZone = 'tabs'; renderTabBar(); updateHelp(); }
      else { mocksBox.select(cur - 1); screen.render(); }
    } else if (tab === 'Plugins') {
      const cur = pluginsBox.selected || 0;
      if (cur === 0) { focusZone = 'tabs'; renderTabBar(); updateHelp(); }
      else { pluginsBox.select(cur - 1); screen.render(); }
    }
  });

  screen.key('enter', async () => {
    if (!navActive()) return;
    if (focusZone === 'tabs') {
      focusZone = 'content';
      const tab = TABS[tabIdx];
      if (tab === 'Configs') { cfgPane = 'left'; cfgList.focus(); }
      else if (tab === 'Logs') logBox.focus();
      else if (tab === 'Mocks') mocksBox.focus();
      else if (tab === 'Plugins') pluginsBox.focus();
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
      logBox.log('{yellow-fg}another proxy is running – press s to stop first{/}');
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
  function popupBox(opts) {
    return blessed.box({
      parent: screen,
      top: 'center', left: 'center',
      width: opts.width || '60%',
      height: opts.height || '50%',
      border: 'line',
      label: opts.label,
      tags: true,
      style: { border: { fg: 'yellow' }, bg: 'black' },
      keys: false, mouse: true,
    });
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
        style: { fg: 'white' },
      });
      const input = (multiline ? blessed.textarea : blessed.textbox)({
        parent: box,
        top: 2, left: 1, right: 1, bottom: 1,
        inputOnFocus: true,
        keys: true,
        mouse: true,
        style: { fg: 'white', bg: 'black' },
      });
      input.setValue(initial ?? '');
      const cleanup = (val) => {
        popupCount = Math.max(0, popupCount - 1);
        box.destroy();
        screen.render();
        resolve(val);
      };
      input.key('escape', () => cleanup(null));
      if (multiline) {
        input.key(['C-s'], () => cleanup(input.getValue()));
      } else {
        input.on('submit', () => cleanup(input.getValue()));
      }
      input.focus();
      screen.render();
    });
  }

  async function openOptionEditor(row) {
    const entry = currentConfig();
    if (!entry?.config) return;

    if (row.kind === 'headers') {
      await openHeadersEditor(entry);
      renderRight();
      return;
    }

    if (row.kind === 'scalar') {
      const current = entry.config[row.key];
      const kind = typeof current;
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
      } else if (kind === 'boolean') {
        parsed = /^(true|1|yes|on)$/i.test(String(val).trim());
      }
      entry.config[row.key] = parsed;
      saveCurrentConfig();
      renderRight();
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
      } catch (e) {
        logBox.log(`{red-fg}invalid JSON for ${row.key}: ${e.message}{/}`);
      }
    }
  }

  async function openHeadersEditor(entry) {
    return new Promise((resolve) => {
      popupCount++;
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
        style: { fg: 'white' },
      });
      const list = blessed.list({
        parent: box,
        top: 2, left: 1, right: 1, bottom: 1,
        keys: true, mouse: true,
        tags: true,
        style: {
          selected: { bg: 'blue', fg: 'white', bold: true },
          item: { fg: 'white' },
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

      const cleanup = () => {
        popupCount = Math.max(0, popupCount - 1);
        saveCurrentConfig();
        box.destroy();
        screen.render();
        resolve();
      };

      list.key('escape', cleanup);

      list.key('enter', async () => {
        const entries = Object.entries(cfg.requestHeaders);
        if (!entries.length) return;
        const idx = list.selected || 0;
        const [k, v] = entries[idx];
        const nv = await promptValue({
          label: `edit header ${k}`,
          initial: String(v ?? ''),
        });
        if (nv === null) { list.focus(); return; }
        cfg.requestHeaders[k] = nv;
        rebuild();
        list.focus();
      });

      list.key('a', async () => {
        const name = await promptValue({ label: 'new header name', initial: '' });
        if (name == null || name.trim() === '') { list.focus(); return; }
        const val = await promptValue({ label: `value for ${name}`, initial: '' });
        if (val === null) { list.focus(); return; }
        cfg.requestHeaders[name.trim()] = val;
        rebuild();
        list.focus();
      });

      list.key('d', () => {
        const entries = Object.entries(cfg.requestHeaders);
        if (!entries.length) return;
        const idx = list.selected || 0;
        const [k] = entries[idx];
        delete cfg.requestHeaders[k];
        rebuild();
      });

      rebuild();
      list.focus();
      screen.render();
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
