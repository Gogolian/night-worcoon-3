import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const PLUGIN_NAME = 'post';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const NO_BODY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function normalizePath(value) {
  const s = String(value || '/').trim();
  return s.startsWith('/') ? s : `/${s}`;
}

function safeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const k = String(key).trim();
    if (!k) continue;
    const lower = k.toLowerCase();
    if (lower === 'host' || lower === 'content-length') continue;
    out[k] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

function parseJsonObject(raw) {
  const parsed = JSON.parse(raw || '{}');
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('headers must be a JSON object');
  }
  return parsed;
}

function bodyPreview(body) {
  if (!body) return '(empty)';
  try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return body; }
}

function headersPreview(headers) {
  const entries = Object.entries(headers || {});
  if (!entries.length) return '(none)';
  return entries.map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n');
}

function decodeBody(buffer, headers) {
  const text = buffer.toString('utf8');
  const contentType = String(headers?.['content-type'] || '');
  if (contentType.includes('application/json')) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch {}
  }
  return text;
}

function requestUrl({ cfg, targetMode, reqPath }) {
  const normalPath = normalizePath(reqPath);
  if (targetMode === 'local') {
    return new URL(`http://127.0.0.1:${cfg.port}${normalPath}`);
  }

  const target = new URL(cfg.target);
  const basePath = target.pathname.replace(/\/$/, '');
  return new URL(`${basePath}${normalPath}`, `${target.protocol}//${target.host}`);
}

async function sendHttpRequest({
  cfg, targetMode, method, reqPath, headers, body,
}) {
  const start = Date.now();
  const url = requestUrl({ cfg, targetMode, reqPath });
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  const upperMethod = method.toUpperCase();
  const bodyBuf = (!NO_BODY_METHODS.has(upperMethod) && body) ? Buffer.from(body, 'utf8') : null;
  const reqHeaders = {
    ...safeHeaders(cfg.requestHeaders),
    ...safeHeaders(headers),
  };

  if (bodyBuf) {
    reqHeaders['content-length'] = String(bodyBuf.length);
    if (!Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'content-type')) {
      reqHeaders['content-type'] = 'application/json';
    }
  }

  const options = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    method: upperMethod,
    headers: reqHeaders,
    rejectUnauthorized: cfg.secure !== false,
  };

  return new Promise((resolve, reject) => {
    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: res.headers,
          body: decodeBody(raw, res.headers),
          latency: Date.now() - start,
          url: url.toString(),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

export default {
  tabName: 'POST',

  isEnabled(cfg) {
    return Array.isArray(cfg?.plugins) && cfg.plugins.includes(PLUGIN_NAME);
  },

  build({ page, helpers }) {
    const {
      blessed,
      getConfigEntry,
      promptValue,
      promptChoice,
      leaveContentFocus,
      requestRender,
    } = helpers;

    const requestList = blessed.list({
      parent: page,
      label: ' request ',
      top: 0, left: 0, bottom: 0, width: '42%',
      border: 'line',
      keys: false, mouse: true,
      style: {
        selected: { bg: 'blue', fg: 'white', bold: true },
        item: { fg: 'white' },
        border: { fg: 'cyan' },
      },
    });

    const responseBox = blessed.box({
      parent: page,
      label: ' response ',
      top: 0, left: '42%', right: 0, bottom: 0,
      border: 'line',
      scrollable: true,
      alwaysScroll: true,
      keys: false,
      mouse: true,
      style: { border: { fg: 'cyan' }, fg: 'white' },
    });

    let targetMode = 'proxy';
    let method = 'GET';
    let reqPath = '/';
    let headers = {};
    let body = '{\n  \n}';
    let selected = 0;
    let loading = false;
    let response = null;
    let error = null;
    let lastConfigFile = null;

    function currentEntry() {
      return getConfigEntry?.() || null;
    }

    function currentCfg() {
      return currentEntry()?.config || null;
    }

    function maybeLoadConfigHeaders(entry) {
      if (!entry || entry.file === lastConfigFile) return;
      lastConfigFile = entry.file;
      headers = { ...(entry.config?.requestHeaders || {}) };
      response = null;
      error = null;
    }

    function targetLabel() {
      return targetMode === 'local' ? 'NightWorcoon (plugin pipeline)' : 'End System (direct target)';
    }

    function rows() {
      const cfg = currentCfg();
      return [
        `Target   ${targetLabel()}`,
        `Method   ${method}`,
        `Path     ${reqPath || '/'}`,
        `Headers  ${Object.keys(headers || {}).length} custom/config header(s)`,
        `Body     ${NO_BODY_METHODS.has(method) ? '(disabled for method)' : bodyPreview(body).split('\n')[0]}`,
        loading ? 'Send     sending…' : 'Send     press Enter',
        `Profile  ${cfg ? `${cfg.name || '(unnamed)'} :${cfg.port} -> ${cfg.target}` : '(no valid config)'}`,
      ];
    }

    function renderResponse() {
      if (loading) {
        responseBox.setContent('\n  Sending request…');
        return;
      }
      if (error) {
        responseBox.setContent(`\n  Error: ${error}`);
        return;
      }
      if (!response) {
        responseBox.setContent([
          '',
          '  Press Enter on "Send" to run the request.',
          '',
          '  Target modes:',
          '  - End System: sends directly to the selected config target.',
          '  - NightWorcoon: sends to localhost:port so bucket/mock/recorder/etc. run.',
        ].join('\n'));
        return;
      }
      responseBox.setContent([
        `${method} ${response.url}`,
        '',
        `status:  ${response.status} ${response.statusText || ''}`,
        `latency: ${response.latency} ms`,
        '',
        'headers',
        headersPreview(response.headers),
        '',
        'body',
        response.body || '(empty)',
      ].join('\n'));
    }

    function renderAll() {
      requestList.setItems(rows());
      requestList.select(Math.max(0, selected));
      renderResponse();
      requestRender();
    }

    async function editMethod() {
      const initialIdx = Math.max(0, METHODS.indexOf(method));
      const picked = await promptChoice({
        label: 'HTTP method',
        options: METHODS.map((m) => ({ label: m, value: m })),
        initialIdx,
      });
      if (picked) method = picked;
      renderAll();
    }

    async function editPath() {
      const val = await promptValue({ label: 'Request path', initial: reqPath });
      if (val !== null) reqPath = normalizePath(val);
      renderAll();
    }

    async function editHeaders() {
      const val = await promptValue({
        label: 'Headers JSON',
        initial: JSON.stringify(headers || {}, null, 2),
        multiline: true,
      });
      if (val === null) { renderAll(); return; }
      try {
        headers = parseJsonObject(val);
        error = null;
      } catch (e) {
        error = e.message;
      }
      renderAll();
    }

    async function editBody() {
      if (NO_BODY_METHODS.has(method)) return;
      const val = await promptValue({ label: 'Request body', initial: body, multiline: true });
      if (val !== null) body = val;
      renderAll();
    }

    async function send() {
      const cfg = currentCfg();
      if (!cfg) {
        error = 'select a valid config first';
        renderAll();
        return;
      }
      loading = true;
      response = null;
      error = null;
      renderAll();
      try {
        response = await sendHttpRequest({
          cfg, targetMode, method, reqPath, headers, body,
        });
      } catch (e) {
        error = e.message;
      } finally {
        loading = false;
        responseBox.setScroll(0);
        renderAll();
      }
    }

    async function activateSelected() {
      if (selected === 0) targetMode = targetMode === 'local' ? 'proxy' : 'local';
      else if (selected === 1) await editMethod();
      else if (selected === 2) await editPath();
      else if (selected === 3) await editHeaders();
      else if (selected === 4) await editBody();
      else if (selected === 5) await send();
      renderAll();
    }

    function move(delta) {
      const next = selected + delta;
      if (next < 0) {
        leaveContentFocus();
        return;
      }
      selected = Math.max(0, Math.min(rows().length - 1, next));
      renderAll();
    }

    return {
      isEnabled: (cfg) => Array.isArray(cfg?.plugins) && cfg.plugins.includes(PLUGIN_NAME),
      onShow(entry) {
        maybeLoadConfigHeaders(entry);
        renderAll();
      },
      onEnterFromTabs() {
        requestList.focus();
        renderAll();
      },
      renderFrames(isActive) {
        requestList.setLabel(isActive ? ' [ request ] ' : ' request ');
        requestList.style.border.fg = isActive ? 'white' : 'cyan';
        responseBox.setLabel(isActive ? ' [ response ] ' : ' response ');
        responseBox.style.border.fg = isActive ? 'white' : 'cyan';
      },
      help() {
        return '[↑/↓] pick field   [enter] edit/toggle/send   [←/→] scroll response   [↑@top → tabs]   [q] quit';
      },
      handleKey(name) {
        if (name === 'up') { move(-1); return true; }
        if (name === 'down') { move(1); return true; }
        if (name === 'left') { responseBox.scroll(-3); requestRender(); return true; }
        if (name === 'right') { responseBox.scroll(3); requestRender(); return true; }
        if (name === 'enter') { activateSelected(); return true; }
        return false;
      },
    };
  },
};
