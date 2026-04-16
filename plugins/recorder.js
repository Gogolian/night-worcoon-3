import { buildRecord } from '../src/storage.js';

/**
 * Recorder plugin.
 *
 * Saves each (proxied) request/response pair as a recording via the
 * configured storage backend.
 *
 * By default only records responses that actually came from the upstream
 * (ctx.meta.source === 'proxy'). Set config.recorder.recordAll = true
 * to also capture mocked / replayed responses.
 */
export default function create({ config, logger }) {
  const rc = config.recorder || {};
  const recordAll = !!rc.recordAll;

  return {
    name: 'recorder',
    async onResponse(ctx) {
      if (!ctx.response) return;
      if (!recordAll && ctx.meta.source !== 'proxy') return;

      const rec = buildRecord({
        method: ctx.req.method,
        urlPath: ctx.req.path,
        query: ctx.req.query,
        req: { headers: ctx.req.headers, body: ctx.req.body },
        res: {
          status: ctx.response.status,
          headers: ctx.response.headers,
          body: ctx.response.body,
        },
      });

      try {
        await ctx.storage.save(rec);
        logger.info(
          `[recorder] saved ${rec.method} ${rec.url} → ${rec.response.status} (id=${rec.id})`,
        );
      } catch (err) {
        logger.error(`[recorder] failed to save: ${err.message}`);
      }
    },
  };
}
