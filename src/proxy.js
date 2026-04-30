import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import httpProxy from 'http-proxy';

import { loadPlugins, runOnRequest, runOnResponse } from './plugins.js';
import { createStorage } from './storage.js';
import { splitPathQuery } from './match.js';

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * Drain a readable stream into a single Buffer.
 * Used for both inbound client requests and outbound upstream responses.
 */
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function buildForwardOptions({ config, reqMethod, reqPath, reqHeaders, reqBody }) {
  const target = new URL(config.target);
  const isHttps = target.protocol === 'https:';

  const outHeaders = { ...reqHeaders };
  if (config.changeOrigin) outHeaders.host = target.host;
  delete outHeaders['content-length']; // recomputed below if we have a body
  if (config.requestHeaders) Object.assign(outHeaders, config.requestHeaders);
  if (reqBody && reqBody.length) {
    outHeaders['content-length'] = String(reqBody.length);
  }

  const targetPath = `${target.pathname.replace(/\/$/, '')}${reqPath}` || '/';

  return {
    target,
    isHttps,
    requestOptions: {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      method: reqMethod,
      path: targetPath,
      headers: outHeaders,
      rejectUnauthorized: config.secure !== false,
    },
  };
}

function isFollowableRedirect(config, res) {
  return (
    config.followRedirects
    && REDIRECT_STATUS_CODES.has(res.statusCode)
    && !!res.headers.location
  );
}

/**
 * Manual forward (used when we need the full response body for plugins like Recorder).
 * Handles optional redirect following.
 */
async function forwardManual({ config, reqMethod, reqPath, reqHeaders, reqBody }) {
  const { target, isHttps, requestOptions } = buildForwardOptions({
    config, reqMethod, reqPath, reqHeaders, reqBody,
  });
  const lib = isHttps ? https : http;

  const upstreamRes = await new Promise((resolve, reject) => {
    const req = lib.request(requestOptions, resolve);
    req.on('error', reject);
    if (reqBody && reqBody.length) req.write(reqBody);
    req.end();
  });

  if (isFollowableRedirect(config, upstreamRes)) {
    const next = new URL(upstreamRes.headers.location, target);
    return forwardManual({
      config: { ...config, target: `${next.protocol}//${next.host}` },
      reqMethod,
      reqPath: next.pathname + next.search,
      reqHeaders,
      reqBody,
    });
  }

  return {
    status: upstreamRes.statusCode,
    headers: upstreamRes.headers,
    body: await streamToBuffer(upstreamRes),
  };
}

function buildRequestContext({ req, reqBody, urlPath, query, method, config, storage, logger }) {
  return {
    config,
    storage,
    logger,
    req: {
      method,
      url: req.url,
      path: urlPath,
      query,
      headers: req.headers,
      body: reqBody,
    },
    response: null, // set by a plugin to short-circuit
    meta: { source: null }, // e.g. 'mock' | 'ret_rec' | 'proxy'
  };
}

function writeClientResponse(res, response) {
  const { status, headers, body } = response;
  // Node sets content-length itself; chunked transfer-encoding from upstream
  // would conflict with that, so drop it.
  const safeHeaders = { ...headers };
  delete safeHeaders['transfer-encoding'];
  res.writeHead(status || 200, safeHeaders);
  res.end(body && body.length ? body : undefined);
}

export async function startProxy({ config, configDir, logger, pluginsDir }) {
  const storage = await createStorage({ config, logger, configDir });
  const plugins = await loadPlugins({ pluginsDir, config, logger });

  // WebSocket passthrough proxy (no plugin interception for v1).
  const wsProxy = httpProxy.createProxyServer({
    target: config.target,
    changeOrigin: !!config.changeOrigin,
    ws: true,
    secure: config.secure !== false,
  });
  wsProxy.on('error', (err) => logger.error(`ws proxy error: ${err.message}`));

  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const { path: urlPath, query } = splitPathQuery(req.url || '/');
    const method = req.method || 'GET';

    try {
      const reqBody = await streamToBuffer(req);
      const ctx = buildRequestContext({
        req, reqBody, urlPath, query, method, config, storage, logger,
      });

      await runOnRequest(plugins, ctx);

      if (!ctx.response) {
        ctx.response = await forwardManual({
          config,
          reqMethod: method,
          reqPath: req.url,
          reqHeaders: req.headers,
          reqBody,
        });
        ctx.meta.source = ctx.meta.source || 'proxy';
      }

      await runOnResponse(plugins, ctx);
      writeClientResponse(res, ctx.response);

      logger.trace('request', {
        method,
        url: req.url,
        status: ctx.response.status || 200,
        source: ctx.meta.source || 'proxy',
        ms: Date.now() - startedAt,
      });
    } catch (err) {
      logger.error(`handler error: ${err.stack || err.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`Bad gateway: ${err.message}`);
    }
  });

  server.on('upgrade', (req, socket, head) => {
    logger.trace('ws-upgrade', { url: req.url });
    wsProxy.ws(req, socket, head);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, () => {
      logger.info(
        `proxy "${config.name}" listening on :${config.port} → ${config.target}`,
      );
      resolve();
    });
  });

  return {
    server,
    async stop() {
      await new Promise((r) => server.close(() => r()));
      try { wsProxy.close(); } catch {}
      logger.info(`proxy "${config.name}" stopped`);
    },
  };
}
