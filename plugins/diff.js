const DEFAULT_IGNORED_HEADERS = [
  'date',
  'connection',
  'keep-alive',
  'transfer-encoding',
];

function bufferFrom(body) {
  if (body == null) return Buffer.alloc(0);
  return Buffer.isBuffer(body) ? body : Buffer.from(String(body));
}

function parseJsonBody(response) {
  const body = bufferFrom(response?.body);
  if (!body.length) return { ok: true, value: null, empty: true };

  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')), empty: false };
  } catch (err) {
    return { ok: false, error: err.message, empty: false };
  }
}

function normalizeHeaderValue(value) {
  return Array.isArray(value) ? value.join(', ') : String(value);
}

function normalizeHeaders(headers, ignored) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    if (ignored.has(lower)) continue;
    out[lower] = normalizeHeaderValue(value);
  }
  return out;
}

function diffHeaders(replayHeaders, upstreamHeaders, ignoredHeaders) {
  const replay = normalizeHeaders(replayHeaders, ignoredHeaders);
  const upstream = normalizeHeaders(upstreamHeaders, ignoredHeaders);
  const names = new Set([...Object.keys(replay), ...Object.keys(upstream)]);
  const changes = [];

  for (const name of [...names].sort()) {
    if (!(name in replay)) {
      changes.push({ path: name, kind: 'extra', upstream: upstream[name] });
    } else if (!(name in upstream)) {
      changes.push({ path: name, kind: 'missing', replay: replay[name] });
    } else if (replay[name] !== upstream[name]) {
      changes.push({
        path: name,
        kind: 'changed',
        replay: replay[name],
        upstream: upstream[name],
      });
    }
  }

  return changes;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatPath(base, key) {
  if (typeof key === 'number') return `${base}[${key}]`;
  return base ? `${base}.${key}` : key;
}

function sameJsonValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffJsonValues(replay, upstream, maxDiffs, path = '$', changes = []) {
  if (changes.length >= maxDiffs) return changes;
  if (Array.isArray(replay) && Array.isArray(upstream)) {
    if (replay.length !== upstream.length) {
      changes.push({
        path: `${path}.length`,
        kind: 'changed',
        replay: replay.length,
        upstream: upstream.length,
      });
      if (changes.length >= maxDiffs) return changes;
    }
    const limit = Math.max(replay.length, upstream.length);
    for (let i = 0; i < limit && changes.length < maxDiffs; i += 1) {
      if (i >= replay.length) {
        changes.push({ path: formatPath(path, i), kind: 'extra', upstream: upstream[i] });
      } else if (i >= upstream.length) {
        changes.push({ path: formatPath(path, i), kind: 'missing', replay: replay[i] });
      } else {
        diffJsonValues(replay[i], upstream[i], maxDiffs, formatPath(path, i), changes);
      }
    }
    return changes;
  }

  if (isObject(replay) && isObject(upstream)) {
    const keys = new Set([...Object.keys(replay), ...Object.keys(upstream)]);
    for (const key of [...keys].sort()) {
      if (changes.length >= maxDiffs) break;
      const nextPath = formatPath(path, key);
      if (!(key in replay)) {
        changes.push({ path: nextPath, kind: 'extra', upstream: upstream[key] });
      } else if (!(key in upstream)) {
        changes.push({ path: nextPath, kind: 'missing', replay: replay[key] });
      } else {
        diffJsonValues(replay[key], upstream[key], maxDiffs, nextPath, changes);
      }
    }
    return changes;
  }

  if (!sameJsonValue(replay, upstream)) {
    changes.push({ path, kind: 'changed', replay, upstream });
  }
  return changes;
}

function buildDiff({ replay, upstream, ignoredHeaders, maxBodyDiffs }) {
  const status = replay.status === upstream.status ? [] : [{
    path: 'status',
    kind: 'changed',
    replay: replay.status,
    upstream: upstream.status,
  }];
  const headers = diffHeaders(replay.headers, upstream.headers, ignoredHeaders);
  const replayJson = parseJsonBody(replay);
  const upstreamJson = parseJsonBody(upstream);
  let json = [];

  if (replayJson.ok && upstreamJson.ok) {
    json = diffJsonValues(replayJson.value, upstreamJson.value, maxBodyDiffs);
  } else if (replayJson.ok !== upstreamJson.ok) {
    json = [{
      path: '$',
      kind: 'json-parse',
      replay: replayJson.ok ? 'valid JSON' : replayJson.error,
      upstream: upstreamJson.ok ? 'valid JSON' : upstreamJson.error,
    }];
  }

  return {
    status,
    headers,
    json,
    drift: status.length > 0 || headers.length > 0 || json.length > 0,
  };
}

export default function create({ config, logger }) {
  const diffCfg = config.diff || {};
  const ignoredHeaders = new Set([
    ...DEFAULT_IGNORED_HEADERS,
    ...((diffCfg.ignoreHeaders || []).map((h) => String(h).toLowerCase())),
  ]);
  const maxBodyDiffs = Number.isFinite(diffCfg.maxBodyDiffs)
    ? Math.max(1, Math.floor(diffCfg.maxBodyDiffs))
    : 20;
  const logMatches = !!diffCfg.logMatches;

  return {
    name: 'diff',
    async onResponse(ctx) {
      if (!ctx.response || ctx.meta.source !== 'ret_rec') return;
      if (typeof ctx.forwardUpstream !== 'function') {
        logger.warn('[diff] cannot shadow upstream: ctx.forwardUpstream unavailable');
        return;
      }

      let upstream;
      try {
        upstream = await ctx.forwardUpstream();
      } catch (err) {
        const event = {
          method: ctx.req.method,
          url: ctx.req.url,
          error: err.message,
        };
        ctx.meta.diff = { drift: true, error: err.message };
        logger.warn(`[diff] shadow upstream failed ${ctx.req.method} ${ctx.req.url}: ${err.message}`);
        logger.trace('diff', event);
        return;
      }

      const result = buildDiff({
        replay: ctx.response,
        upstream,
        ignoredHeaders,
        maxBodyDiffs,
      });
      const event = {
        method: ctx.req.method,
        url: ctx.req.url,
        replay: { status: ctx.response.status, headers: ctx.response.headers },
        upstream: { status: upstream.status, headers: upstream.headers },
        differences: {
          status: result.status,
          headers: result.headers,
          json: result.json,
        },
        drift: result.drift,
      };
      ctx.meta.diff = event;

      if (result.drift) {
        logger.warn(
          `[diff] drift ${ctx.req.method} ${ctx.req.url} `
          + `(status=${result.status.length}, headers=${result.headers.length}, json=${result.json.length})`,
        );
        logger.trace('diff', event);
      } else if (logMatches) {
        logger.info(`[diff] match ${ctx.req.method} ${ctx.req.url}`);
      }
    },
  };
}
