import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import httpProxy from 'http-proxy';

import { loadPlugins, runOnRequest, runOnResponse } from './plugins.js';
import { createStorage } from './storage.js';
import { splitPathQuery } from './match.js';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bufferProxyRes(proxyRes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    proxyRes.on('data', (c) => chunks.push(c));
    proxyRes.on('end', () => resolve(Buffer.concat(chunks)));
    proxyRes.on('error', reject);
  });
}

/**
 * Manual forward (used when we need the full response body for plugins like Recorder).
 */
function forwardManual({ config, reqMethod, reqPath, reqHeaders, reqBody }) {
  return new Promise((resolve, reject) => {
    const target = new URL(config.target);
    const isHttps = target.protocol === 'https:';
    const outHeaders = { ...reqHeaders };

    // Headers tweaks
    if (config.changeOrigin) {
      outHeaders.host = target.host;
    }
    delete outHeaders['content-length']; // we set it below
    if (config.requestHeaders) {
      for (const [k, v] of Object.entries(config.requestHeaders)) {
        outHeaders[k] = v;
      }
    }
    if (reqBody && reqBody.length) {
      outHeaders['content-length'] = String(reqBody.length);
    }

    const targetPath = `${target.pathname.replace(/\/$/, '')}${reqPath}`;

    const opts = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      method: reqMethod,
      path: targetPath || '/',
      headers: outHeaders,
      rejectUnauthorized: config.secure !== false ? true : false,
    };

    const lib = isHttps ? https : http;
    const pReq = lib.request(opts, async (pRes) => {
      try {
        // Handle redirects if requested.
        if (
          config.followRedirects &&
          [301, 302, 303, 307, 308].includes(pRes.statusCode) &&
          pRes.headers.location
        ) {
          const next = new URL(pRes.headers.location, target);
          const result = await forwardManual({
            config: { ...config, target: `${next.protocol}//${next.host}` },
            reqMethod,
            reqPath: next.pathname + next.search,
            reqHeaders,
            reqBody,
          });
          return resolve(result);
        }
        const body = await bufferProxyRes(pRes);
        resolve({
          status: pRes.statusCode,
          headers: pRes.headers,
          body,
        });
      } catch (e) {
        reject(e);
      }
    });

    pReq.on('error', reject);
    if (reqBody && reqBody.length) pReq.write(reqBody);
    pReq.end();
  });
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
      const reqBody = await readBody(req);

      const ctx = {
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

      await runOnRequest(plugins, ctx);

      if (!ctx.response) {
        // Forward to target.
        const upstream = await forwardManual({
          config,
          reqMethod: method,
          reqPath: req.url,
          reqHeaders: req.headers,
          reqBody,
        });
        ctx.response = upstream;
        ctx.meta.source = ctx.meta.source || 'proxy';
      }

      await runOnResponse(plugins, ctx);

      // Write response to client.
      const { status, headers, body } = ctx.response;
      const safeHeaders = { ...headers };
      // http-proxy style: node will set content-length; drop transfer-encoding
      delete safeHeaders['transfer-encoding'];
      res.writeHead(status || 200, safeHeaders);
      if (body && body.length) res.end(body);
      else res.end();

      const took = Date.now() - startedAt;
      logger.trace('request', {
        method,
        url: req.url,
        status: status || 200,
        source: ctx.meta.source || 'proxy',
        ms: took,
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
