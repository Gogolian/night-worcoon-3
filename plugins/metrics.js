/**
 * Metrics plugin — per-route request counters, latency histograms
 * (p50/p95/p99), error rates, and bytes in/out.
 *
 * Config:
 *   {
 *     "plugins": ["metrics", ...],
 *     "metrics": {
 *       "endpoint": "/__metrics",   // optional; default /__metrics
 *       "maxSamples": 1000          // optional; rolling latency window per route
 *     }
 *   }
 *
 * The endpoint (default GET /__metrics) responds with Prometheus text format
 * (Content-Type: text/plain; version=0.0.4).  Requests to the endpoint are
 * not counted toward route metrics.
 *
 * Place "metrics" early in config.plugins so it can observe every response,
 * regardless of which plugin short-circuited the request.
 */

const MAX_SAMPLES_DEFAULT = 1000;
const ENDPOINT_DEFAULT = '/__metrics';

function percentile(samples, p) {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[idx];
}

function promEscape(s) {
  // Escape backslashes, double-quotes, and newlines per Prometheus label spec.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function label(method, path) {
  return `method="${promEscape(method)}",path="${promEscape(path)}"`;
}

function buildPrometheusText(routes) {
  const lines = [];

  lines.push('# HELP proxy_requests_total Total number of proxied HTTP requests.');
  lines.push('# TYPE proxy_requests_total counter');
  for (const r of routes) {
    lines.push(`proxy_requests_total{${label(r.method, r.path)}} ${r.requests}`);
  }

  lines.push('');
  lines.push('# HELP proxy_request_errors_total Number of 5xx responses.');
  lines.push('# TYPE proxy_request_errors_total counter');
  for (const r of routes) {
    lines.push(`proxy_request_errors_total{${label(r.method, r.path)}} ${r.errors}`);
  }

  lines.push('');
  lines.push('# HELP proxy_bytes_in_total Total request body bytes received.');
  lines.push('# TYPE proxy_bytes_in_total counter');
  for (const r of routes) {
    lines.push(`proxy_bytes_in_total{${label(r.method, r.path)}} ${r.bytesIn}`);
  }

  lines.push('');
  lines.push('# HELP proxy_bytes_out_total Total response body bytes sent.');
  lines.push('# TYPE proxy_bytes_out_total counter');
  for (const r of routes) {
    lines.push(`proxy_bytes_out_total{${label(r.method, r.path)}} ${r.bytesOut}`);
  }

  lines.push('');
  lines.push('# HELP proxy_request_duration_ms Request latency in milliseconds (rolling window).');
  lines.push('# TYPE proxy_request_duration_ms summary');
  for (const r of routes) {
    const lbl = label(r.method, r.path);
    const p50 = percentile(r.latencies, 0.50);
    const p95 = percentile(r.latencies, 0.95);
    const p99 = percentile(r.latencies, 0.99);
    lines.push(`proxy_request_duration_ms{${lbl},quantile="0.5"} ${p50}`);
    lines.push(`proxy_request_duration_ms{${lbl},quantile="0.95"} ${p95}`);
    lines.push(`proxy_request_duration_ms{${lbl},quantile="0.99"} ${p99}`);
    lines.push(`proxy_request_duration_ms_count{${lbl}} ${r.requests}`);
  }

  lines.push('');
  return lines.join('\n');
}

export default function create({ config, logger }) {
  const mc = config.metrics || {};
  const endpoint = typeof mc.endpoint === 'string' ? mc.endpoint : ENDPOINT_DEFAULT;
  const maxSamples = (Number.isInteger(mc.maxSamples) && mc.maxSamples > 0)
    ? mc.maxSamples
    : MAX_SAMPLES_DEFAULT;

  /**
   * @type {Map<string, {
   *   method: string, path: string,
   *   requests: number, errors: number,
   *   bytesIn: number, bytesOut: number,
   *   latencies: number[]
   * }>}
   */
  const routeMap = new Map();

  function getRoute(method, path) {
    const key = `${method} ${path}`;
    if (!routeMap.has(key)) {
      routeMap.set(key, {
        method,
        path,
        requests: 0,
        errors: 0,
        bytesIn: 0,
        bytesOut: 0,
        latencies: [],
      });
    }
    return routeMap.get(key);
  }

  function snapshot() {
    return [...routeMap.values()].map((r) => ({ ...r, latencies: [...r.latencies] }));
  }

  return {
    name: 'metrics',

    async onRequest(ctx) {
      if (ctx.req.method === 'GET' && ctx.req.path === endpoint) {
        const body = Buffer.from(buildPrometheusText(snapshot()), 'utf8');
        ctx.response = {
          status: 200,
          headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
          body,
        };
        ctx.meta.source = 'metrics';
      }
    },

    async onResponse(ctx) {
      // Do not count requests to the metrics endpoint itself.
      if (ctx.req.path === endpoint) return;

      const method = ctx.req.method.toUpperCase();
      const path = ctx.req.path;
      const route = getRoute(method, path);

      route.requests += 1;

      const status = ctx.response ? (ctx.response.status || 200) : 200;
      if (status >= 500) route.errors += 1;

      route.bytesIn += ctx.req.body ? ctx.req.body.length : 0;
      const resBody = ctx.response ? ctx.response.body : null;
      if (resBody) {
        route.bytesOut += Buffer.isBuffer(resBody)
          ? resBody.length
          : Buffer.byteLength(String(resBody));
      }

      const startedAt = Number.isFinite(ctx.meta.startedAt) ? ctx.meta.startedAt : Date.now();
      const latencyMs = Date.now() - startedAt;
      route.latencies.push(latencyMs);
      if (route.latencies.length > maxSamples) {
        route.latencies = route.latencies.slice(-maxSamples);
      }

      logger.trace('metrics', {
        method,
        path,
        requests: route.requests,
        errors: route.errors,
        bytesIn: route.bytesIn,
        bytesOut: route.bytesOut,
        p50: percentile(route.latencies, 0.50),
        p95: percentile(route.latencies, 0.95),
        p99: percentile(route.latencies, 0.99),
      });
    },
  };
}
