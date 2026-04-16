import { compileRule, matchRule } from '../src/match.js';
import { decodeBody } from '../src/storage.js';

/**
 * Mock plugin.
 *
 * Config (on the parent config object):
 *   {
 *     "plugins": ["mock", ...],
 *     "mock": {
 *       "rules": [
 *         { "method": "GET", "url": "/users/:id", "action": "RET_REC",
 *           "fallback": "500" | "empty200" | "PASS" },
 *         { "method": "POST", "url": "/login", "action": "MOCK",
 *           "response": { "status": 200, "headers": {...}, "body": {...} } },
 *         { "method": "*", "urlContains": "/debug", "action": "PASS" }
 *       ]
 *     }
 *   }
 */
export default function create({ config, logger }) {
  const mockCfg = config.mock || {};
  const rules = (mockCfg.rules || []).map((r) => ({
    ...r,
    _c: compileRule(r),
  }));

  async function handleRetRec(ctx, rule) {
    const rec = await ctx.storage.findBest({
      method: ctx.req.method,
      path: ctx.req.path,
      query: ctx.req.query,
    });
    if (rec) {
      ctx.response = {
        status: rec.response.status,
        headers: rec.response.headers,
        body: decodeBody(rec.response),
      };
      ctx.meta.source = 'ret_rec';
      logger.info(`[mock] RET_REC hit ${ctx.req.method} ${ctx.req.url} (id=${rec.id})`);
      return;
    }
    const fb = (rule.fallback || '500').toString().toLowerCase();
    if (fb === 'pass') {
      logger.warn(`[mock] RET_REC miss → PASS ${ctx.req.method} ${ctx.req.url}`);
      return; // leave ctx.response null → forwarded
    }
    if (fb === 'empty200') {
      ctx.response = { status: 200, headers: {}, body: Buffer.alloc(0) };
      ctx.meta.source = 'ret_rec_fallback';
      logger.warn(`[mock] RET_REC miss → 200-empty ${ctx.req.method} ${ctx.req.url}`);
      return;
    }
    ctx.response = {
      status: 500,
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from(`No recording for ${ctx.req.method} ${ctx.req.url}`),
    };
    ctx.meta.source = 'ret_rec_fallback';
    logger.warn(`[mock] RET_REC miss → 500 ${ctx.req.method} ${ctx.req.url}`);
  }

  function handleMock(ctx, rule) {
    const r = rule.response || {};
    let body = r.body;
    let headers = { ...(r.headers || {}) };
    if (body != null && typeof body !== 'string' && !Buffer.isBuffer(body)) {
      body = JSON.stringify(body);
      if (!headers['content-type']) headers['content-type'] = 'application/json';
    }
    const buf = body == null ? Buffer.alloc(0)
      : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    ctx.response = { status: r.status || 200, headers, body: buf };
    ctx.meta.source = 'mock';
    logger.info(`[mock] MOCK ${ctx.req.method} ${ctx.req.url} → ${ctx.response.status}`);
  }

  return {
    name: 'mock',
    async onRequest(ctx) {
      for (const rule of rules) {
        if (!matchRule(rule._c, ctx.req.method, ctx.req.path)) continue;
        const action = (rule.action || 'PASS').toUpperCase();
        if (action === 'PASS') {
          logger.info(`[mock] PASS ${ctx.req.method} ${ctx.req.url}`);
          return;
        }
        if (action === 'MOCK') return handleMock(ctx, rule);
        if (action === 'RET_REC') return handleRetRec(ctx, rule);
        logger.warn(`[mock] unknown action "${rule.action}"`);
        return;
      }
      // No rule matched → pass through.
    },
  };
}
