import { compileRule, matchRule } from '../src/match.js';

/**
 * Latency / chaos plugin.
 *
 * Injects artificial delay and optional random failures — useful for
 * testing client retry/timeout behaviour without touching the upstream.
 *
 * Config:
 *   {
 *     "plugins": ["latency", ...],
 *     "latency": {
 *       "delayMs": 500,              // fixed delay
 *       "jitterMs": 200,             // + uniform random [0, jitter)
 *       "failRate": 0.1,             // 0..1, probability of injecting an error
 *       "failStatus": 503,           // status used when injecting a failure
 *       "failBody": "upstream down", // response body when failing
 *       "rules": [                   // optional per-route overrides; first match wins
 *         { "urlContains": "/slow", "delayMs": 3000 },
 *         { "method": "POST", "url": "/api/flaky", "failRate": 0.5 }
 *       ]
 *     }
 *   }
 *
 * Applies to every request (matched against rules if provided, else the
 * global defaults). Delay is applied on the request path so it affects
 * mocked/bucketed responses too; failure injection short-circuits the
 * pipeline with a synthetic error response.
 */
export default function create({ config, logger }) {
  const lc = config.latency || {};
  const defaults = {
    delayMs: lc.delayMs || 0,
    jitterMs: lc.jitterMs || 0,
    failRate: lc.failRate || 0,
    failStatus: lc.failStatus || 503,
    failBody: lc.failBody != null ? lc.failBody : 'Injected failure',
  };
  const rules = (lc.rules || []).map((r) => ({ ...r, _c: compileRule(r) }));

  function settingsFor(method, path) {
    for (const r of rules) {
      if (matchRule(r._c, method, path)) {
        return {
          delayMs: r.delayMs != null ? r.delayMs : defaults.delayMs,
          jitterMs: r.jitterMs != null ? r.jitterMs : defaults.jitterMs,
          failRate: r.failRate != null ? r.failRate : defaults.failRate,
          failStatus: r.failStatus || defaults.failStatus,
          failBody: r.failBody != null ? r.failBody : defaults.failBody,
        };
      }
    }
    return defaults;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  return {
    name: 'latency',
    async onRequest(ctx) {
      const s = settingsFor(ctx.req.method, ctx.req.path);
      const delay = (s.delayMs || 0) + Math.floor(Math.random() * (s.jitterMs || 0));
      if (delay > 0) {
        logger.info(`[latency] delaying ${ctx.req.method} ${ctx.req.url} by ${delay}ms`);
        await sleep(delay);
      }
      if (s.failRate > 0 && Math.random() < s.failRate) {
        const body = typeof s.failBody === 'string'
          ? Buffer.from(s.failBody)
          : Buffer.from(JSON.stringify(s.failBody));
        const headers = typeof s.failBody === 'string'
          ? { 'content-type': 'text/plain' }
          : { 'content-type': 'application/json' };
        ctx.response = { status: s.failStatus, headers, body };
        ctx.meta.source = 'latency_fail';
        logger.warn(`[latency] injected ${s.failStatus} for ${ctx.req.method} ${ctx.req.url}`);
      }
    },
  };
}
