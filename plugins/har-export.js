import fs from 'node:fs';
import path from 'node:path';

/**
 * har-export plugin
 *
 * Accumulates HTTP traffic and produces a standard HAR 1.2 file on demand.
 *
 * HTTP control endpoints (intercepted before the upstream, served from
 * `controlPath`, default `/_har`):
 *   GET  /_har/export   → download the current capture as application/json
 *   POST /_har/save     → write the capture to `outputPath` on disk
 *   POST /_har/reset    → clear the in-memory capture (returns { ok, cleared })
 *
 * Config:
 *   {
 *     "plugins": ["har-export"],
 *     "harExport": {
 *       "outputPath": "./recordings/capture.har",   // default write path for /save
 *       "captureAll": false,                        // false = only 'proxy' source
 *       "controlPath": "/_har"                      // HTTP control prefix
 *     }
 *   }
 *
 * Each captured entry is also emitted as a logger trace event (kind "har-export")
 * so the TUI tab can display a live feed without duplicating the entry array.
 */

const STATUS_TEXTS = {
  100: 'Continue', 101: 'Switching Protocols',
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  301: 'Moved Permanently', 302: 'Found', 303: 'See Other',
  304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict',
  422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway',
  503: 'Service Unavailable', 504: 'Gateway Timeout',
};

function statusText(code) {
  return STATUS_TEXTS[code] || '';
}

function headersToHar(headers) {
  if (!headers || typeof headers !== 'object') return [];
  const out = [];
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const v of value) out.push({ name, value: String(v) });
    } else {
      out.push({ name, value: String(value) });
    }
  }
  return out;
}

function queryToHar(query) {
  if (!query || typeof query !== 'object') return [];
  const out = [];
  for (const [name, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const v of value) out.push({ name, value: String(v) });
    } else {
      out.push({ name, value: String(value) });
    }
  }
  return out;
}

function parseCookieHeader(cookieHeader) {
  if (!cookieHeader) return [];
  return String(cookieHeader)
    .split(';')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return { name: pair.trim(), value: '' };
      return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() };
    })
    .filter((c) => c.name);
}

function isTextMime(mimeType) {
  return /^text\/|\/json|\/xml|\/javascript|\/html/.test(mimeType || '');
}

function bodyContent(body, mimeType) {
  const buf = Buffer.isBuffer(body)
    ? body
    : Buffer.from(body == null ? '' : String(body));
  const size = buf.length;
  if (!size) return { size: 0, mimeType: mimeType || 'application/octet-stream', text: '' };
  if (isTextMime(mimeType)) {
    return { size, mimeType, text: buf.toString('utf8') };
  }
  return { size, mimeType: mimeType || 'application/octet-stream', text: buf.toString('base64'), encoding: 'base64' };
}

function buildHarEntry(ctx, startedAt) {
  const { config, req, response, meta } = ctx;
  const now = Date.now();
  const timeMs = now - startedAt;
  const startedDateTime = new Date(startedAt).toISOString();

  const target = (config.target || '').replace(/\/$/, '');
  const fullUrl = `${target}${req.url || '/'}`;

  const reqBody = req.body;
  const reqBodySize = Buffer.isBuffer(reqBody) ? reqBody.length : 0;
  const reqMime = req.headers?.['content-type'] || '';

  const resMime = response.headers?.['content-type'] || 'application/octet-stream';
  const content = bodyContent(response.body, resMime);

  const entry = {
    startedDateTime,
    time: timeMs,
    request: {
      method: req.method || 'GET',
      url: fullUrl,
      httpVersion: 'HTTP/1.1',
      cookies: parseCookieHeader(req.headers?.cookie),
      headers: headersToHar(req.headers),
      queryString: queryToHar(req.query),
      headersSize: -1,
      bodySize: reqBodySize,
    },
    response: {
      status: response.status || 200,
      statusText: statusText(response.status),
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: headersToHar(response.headers),
      content,
      redirectURL: response.headers?.location || '',
      headersSize: -1,
      bodySize: content.size,
    },
    cache: {},
    timings: {
      send: 0,
      wait: timeMs,
      receive: 0,
    },
    _source: meta.source || 'proxy',
  };

  if (reqBodySize > 0) {
    const postData = { mimeType: reqMime };
    if (isTextMime(reqMime)) {
      postData.text = reqBody.toString('utf8');
    } else {
      postData.text = reqBody.toString('base64');
      postData.encoding = 'base64';
    }
    entry.request.postData = postData;
  }

  return entry;
}

function toHarDoc(entries, config) {
  return {
    log: {
      version: '1.2',
      creator: {
        name: 'night-worcoon-3',
        version: '0.1.0',
        comment: `profile: ${config.name || 'proxy'}`,
      },
      pages: [],
      entries,
    },
  };
}

export default function create({ config, logger }) {
  const hc = config.harExport || config['har-export'] || {};
  const defaultPath = path.resolve(
    hc.outputPath || `./recordings/${config.name || 'proxy'}-capture.har`,
  );
  const captureAll = !!hc.captureAll;
  const controlPath = (hc.controlPath || '/_har').replace(/\/+$/, '');

  let entries = [];

  function buildHar() {
    return toHarDoc(entries, config);
  }

  function writeHar(filePath) {
    const target = filePath || defaultPath;
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    fs.writeFileSync(path.resolve(target), JSON.stringify(buildHar(), null, 2));
    return target;
  }

  function reset() {
    const count = entries.length;
    entries = [];
    return count;
  }

  return {
    name: 'har-export',

    async onRequest(ctx) {
      const p = ctx.req.path;
      const m = ctx.req.method.toUpperCase();

      if (p === `${controlPath}/export` && m === 'GET') {
        const body = Buffer.from(JSON.stringify(buildHar(), null, 2));
        ctx.response = {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-disposition': `attachment; filename="${config.name || 'proxy'}-capture.har"`,
          },
          body,
        };
        ctx.meta.source = 'har-export';
        logger.info(`[har-export] exported ${entries.length} entries via HTTP`);
        return;
      }

      if (p === `${controlPath}/save` && m === 'POST') {
        const savedPath = writeHar(defaultPath);
        const body = Buffer.from(JSON.stringify({ ok: true, path: savedPath, entries: entries.length }));
        ctx.response = {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body,
        };
        ctx.meta.source = 'har-export';
        logger.info(`[har-export] saved ${entries.length} entries to ${savedPath}`);
        return;
      }

      if (p === `${controlPath}/reset` && m === 'POST') {
        const count = reset();
        const body = Buffer.from(JSON.stringify({ ok: true, cleared: count }));
        ctx.response = {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body,
        };
        ctx.meta.source = 'har-export';
        logger.info(`[har-export] reset — cleared ${count} entries`);
        return;
      }
    },

    async onResponse(ctx) {
      if (!ctx.response) return;
      if (ctx.meta.source === 'har-export') return;
      if (!captureAll && ctx.meta.source !== 'proxy') return;

      const startedAt = Number.isFinite(ctx.meta.startedAt) ? ctx.meta.startedAt : Date.now();
      const entry = buildHarEntry(ctx, startedAt);
      entries.push(entry);

      logger.trace('har-export', {
        startedDateTime: entry.startedDateTime,
        method: entry.request.method,
        url: entry.request.url,
        status: entry.response.status,
        timeMs: entry.time,
        size: entry.response.content.size,
        source: entry._source,
        total: entries.length,
      });
    },
  };
}
