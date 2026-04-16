import blessed from 'blessed';
import fs from 'node:fs';
import path from 'node:path';

function fmtTs(d) {
  return d.toISOString().slice(11, 23);
}

function levelColor(l) {
  switch (l) {
    case 'error': return 'red';
    case 'warn': return 'yellow';
    case 'info': return 'cyan';
    case 'debug': return 'gray';
    default: return 'white';
  }
}

export function createTui({ configsDir, logger, onStart, onStop }) {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'night-worcoon-3',
    fullUnicode: true,
  });

  const header = blessed.box({
    parent: screen,
    top: 0, left: 0, right: 0, height: 1,
    style: { bg: 'blue', fg: 'white', bold: true },
    content: ' night-worcoon-3 · middleware proxy ',
  });

  const list = blessed.list({
    parent: screen,
    label: ' configs ',
    top: 1, left: 0, bottom: 3, width: '30%',
    border: 'line',
    keys: true, mouse: true, vi: true,
    style: {
      selected: { bg: 'blue', fg: 'white', bold: true },
      item: { fg: 'white' },
      border: { fg: 'gray' },
    },
  });

  const logBox = blessed.log({
    parent: screen,
    label: ' live log ',
    top: 1, left: '30%', right: 0, bottom: 3,
    border: 'line',
    tags: true,
    scrollback: 2000,
    scrollbar: { ch: ' ', style: { bg: 'gray' } },
    mouse: true, keys: true,
    style: { border: { fg: 'gray' } },
  });

  const status = blessed.box({
    parent: screen,
    bottom: 1, left: 0, right: 0, height: 1,
    style: { bg: 'black', fg: 'white' },
    content: ' no active proxy ',
  });

  const help = blessed.box({
    parent: screen,
    bottom: 0, left: 0, right: 0, height: 1,
    style: { bg: 'gray', fg: 'black' },
    content: ' [↑/↓] pick   [enter] start   [s] stop   [r] reload   [q] quit ',
  });

  let active = null;

  function loadConfigs() {
    if (!fs.existsSync(configsDir)) fs.mkdirSync(configsDir, { recursive: true });
    const files = fs.readdirSync(configsDir).filter((f) => f.endsWith('.json'));
    const items = files.map((f) => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(configsDir, f), 'utf8'));
        return { file: f, config: j, label: `${j.name || f}  :${j.port}  → ${j.target}` };
      } catch (e) {
        return { file: f, config: null, label: `${f}  (invalid JSON)` };
      }
    });
    list._items_meta = items;
    list.setItems(items.map((i) => i.label));
    screen.render();
  }

  function setStatus(text, color = 'white') {
    status.style.fg = color;
    status.setContent(` ${text} `);
    screen.render();
  }

  list.on('select', async (_item, idx) => {
    const entry = list._items_meta?.[idx];
    if (!entry?.config) return;
    if (active) {
      logBox.log('{yellow-fg}stop current proxy first (press s){/}');
      return;
    }
    setStatus(`starting ${entry.config.name} …`, 'yellow');
    try {
      active = await onStart(entry.config, entry.file);
      setStatus(
        `running · ${entry.config.name} · :${entry.config.port} → ${entry.config.target}`,
        'green',
      );
    } catch (e) {
      logBox.log(`{red-fg}start failed: ${e.message}{/}`);
      setStatus('failed to start', 'red');
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
      active = null;
      setStatus('no active proxy', 'white');
    } catch (e) {
      logBox.log(`{red-fg}stop failed: ${e.message}{/}`);
    }
  });

  screen.key(['r'], loadConfigs);

  logger.on('log', (e) => {
    const color = levelColor(e.level);
    logBox.log(`{gray-fg}${fmtTs(e.ts)}{/} {${color}-fg}${e.level.padEnd(5)}{/} ${e.msg}`);
  });

  logger.on('trace', (e) => {
    if (e.kind === 'request') {
      const d = e.data;
      const c = d.status >= 500 ? 'red' : d.status >= 400 ? 'yellow' : 'green';
      logBox.log(
        `{gray-fg}${fmtTs(e.ts)}{/} {${c}-fg}${String(d.status).padEnd(3)}{/} ${d.method.padEnd(6)} ${d.url}  {gray-fg}(${d.source}, ${d.ms}ms){/}`,
      );
    } else if (e.kind === 'ws-upgrade') {
      logBox.log(`{gray-fg}${fmtTs(e.ts)}{/} {magenta-fg}WS   {/} upgrade ${e.data.url}`);
    }
  });

  loadConfigs();
  list.focus();
  screen.render();

  return { screen, logBox, setStatus, reload: loadConfigs };
}
