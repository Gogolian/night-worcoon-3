/**
 * CORS plugin.
 *
 * Adds CORS headers to responses and short-circuits preflight OPTIONS
 * requests with a 204 before they hit the upstream / mock.
 *
 * Config:
 *   {
 *     "plugins": ["cors", ...],
 *     "cors": {
 *       "origin": "*",                           // or "https://app.example.com"
 *       "methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
 *       "headers": "Content-Type,Authorization", // allowed request headers
 *       "exposeHeaders": "X-Request-Id",         // optional
 *       "credentials": false,                    // sets Access-Control-Allow-Credentials
 *       "maxAge": 600                            // preflight cache seconds
 *     }
 *   }
 */
export default function create({ config, logger }) {
  const cc = config.cors || {};
  const origin = cc.origin || '*';
  const methods = cc.methods || 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS';
  const allowHeaders = cc.headers || 'Content-Type,Authorization';
  const exposeHeaders = cc.exposeHeaders || '';
  const credentials = !!cc.credentials;
  const maxAge = cc.maxAge != null ? cc.maxAge : 600;

  function resolveOrigin(reqOrigin) {
    if (origin === '*' && !credentials) return '*';
    if (origin === '*') return reqOrigin || '*';
    if (Array.isArray(origin)) {
      return origin.includes(reqOrigin) ? reqOrigin : origin[0];
    }
    return origin;
  }

  function corsHeaders(ctx) {
    const reqOrigin = ctx.req.headers.origin;
    const h = {
      'access-control-allow-origin': resolveOrigin(reqOrigin),
      'access-control-allow-methods': methods,
      'access-control-allow-headers': allowHeaders,
    };
    if (exposeHeaders) h['access-control-expose-headers'] = exposeHeaders;
    if (credentials) h['access-control-allow-credentials'] = 'true';
    if (origin !== '*' || credentials) h['vary'] = 'Origin';
    return h;
  }

  return {
    name: 'cors',
    async onRequest(ctx) {
      if (ctx.req.method.toUpperCase() !== 'OPTIONS') return;
      const headers = { ...corsHeaders(ctx), 'access-control-max-age': String(maxAge) };
      ctx.response = { status: 204, headers, body: Buffer.alloc(0) };
      ctx.meta.source = 'cors';
      logger.info(`[cors] preflight 204 ${ctx.req.url}`);
    },
    async onResponse(ctx) {
      if (!ctx.response) return;
      ctx.response.headers = { ...(ctx.response.headers || {}), ...corsHeaders(ctx) };
    },
  };
}
