function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function isPrintableBuffer(buf) {
  if (!buf || !buf.length) return true;
  for (const byte of buf) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte < 32 || byte === 127) return false;
  }
  return true;
}

function formatHeaderValue(value) {
  return Array.isArray(value) ? value.join(', ') : String(value);
}

function buildCurlCommand(ctx) {
  const targetUrl = `http://localhost:${ctx.config.port}${ctx.req.url || '/'}`;
  const parts = ['curl', '-i', '-X', shellQuote(ctx.req.method || 'GET')];
  for (const [name, value] of Object.entries(ctx.req.headers || {})) {
    const lower = name.toLowerCase();
    if (lower === 'host' || lower === 'content-length') continue;
    parts.push('-H', shellQuote(`${name}: ${formatHeaderValue(value)}`));
  }
  if (ctx.req.body && ctx.req.body.length) {
    if (isPrintableBuffer(ctx.req.body)) {
      parts.push('--data-binary', shellQuote(ctx.req.body.toString('utf8')));
    } else {
      parts.push('--data-binary', shellQuote(`[${ctx.req.body.length} bytes of binary request body omitted]`));
    }
  }
  parts.push(shellQuote(targetUrl));
  return parts.join(' ');
}

export default function create({ config, logger }) {
  return {
    name: 'tap',
    async onResponse(ctx) {
      if (!ctx.response) return;
      const body = ctx.response.body;
      const size = Buffer.isBuffer(body)
        ? body.length
        : Buffer.byteLength(body == null ? '' : String(body));
      const startedAt = Number.isFinite(ctx.meta.startedAt) ? ctx.meta.startedAt : Date.now();
      logger.trace('tap', {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        ts: new Date().toISOString(),
        configName: config.name || 'proxy',
        port: config.port,
        method: ctx.req.method,
        url: ctx.req.url,
        path: ctx.req.path,
        status: ctx.response.status || 200,
        latencyMs: Date.now() - startedAt,
        size,
        source: ctx.meta.source || 'proxy',
        requestHeaders: ctx.req.headers || {},
        responseHeaders: ctx.response.headers || {},
        curl: buildCurlCommand(ctx),
      });
    },
  };
}
