import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Bucket plugin — built-in mock data store with CRUD semantics.
 *
 * Config:
 *   {
 *     "plugins": ["bucket", "mock", "recorder"],
 *     "bucket": {
 *       "persistPath": "./recordings/httpbin-bucket.json",   // optional
 *       "collections": [
 *         {
 *           "path": "/api/users",
 *           "idPattern": "uuid" | "numeric" | "alphanumeric" | "regex:<pattern>",
 *           "responseTemplate": { "id": "{{id}}", "name": "{{name}}" }   // optional
 *         }
 *       ]
 *     }
 *   }
 *
 * Request handling (per matched collection):
 *   POST   /coll         → create resource, auto-generate id (or use body.id if matches pattern)
 *   GET    /coll         → list all resources
 *   GET    /coll/:id     → fetch one
 *   PATCH  /coll/:id     → shallow merge
 *   PUT    /coll/:id     → replace (id preserved)
 *   DELETE /coll/:id     → remove → 204
 *
 * Non-blocking miss: if no collection matches the request path, or the id is
 * unknown on GET/PATCH/PUT/DELETE, the plugin leaves ctx.response untouched
 * so the pipeline continues to Mock, then upstream proxy.
 *
 * Numeric counters are rebuilt from persisted data on startup so ids are
 * never reused after a restart.
 */

const ID_PATTERNS = {
  uuid: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  numeric: /^\d+$/,
  alphanumeric: /^[A-Za-z0-9]+$/,
};

function compileCollection(raw) {
  if (!raw.path || typeof raw.path !== 'string') {
    throw new Error('[bucket] each collection requires a "path"');
  }
  const pattern = raw.idPattern || 'alphanumeric';

  let idKind;
  let idRegex;
  if (pattern in ID_PATTERNS) {
    idKind = pattern;
    idRegex = ID_PATTERNS[pattern];
  } else if (typeof pattern === 'string' && pattern.startsWith('regex:')) {
    idKind = 'regex';
    idRegex = new RegExp(`^${pattern.slice(6)}$`);
  } else {
    throw new Error(`[bucket] unknown idPattern "${pattern}"`);
  }

  return {
    path: raw.path.replace(/\/+$/, ''),
    idKind,
    idRegex,
    responseTemplate: raw.responseTemplate || null,
    items: new Map(),
    counter: 0,
  };
}

function generateId(col) {
  if (col.idKind === 'uuid') return crypto.randomUUID();
  if (col.idKind === 'numeric') {
    col.counter += 1;
    return String(col.counter);
  }
  // alphanumeric or regex fallback
  for (let i = 0; i < 5; i++) {
    const candidate = crypto.randomBytes(6).toString('base64url')
      .replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
    if (candidate && col.idRegex.test(candidate)) return candidate;
  }
  // last resort: let caller deal with it (shouldn't happen for alphanumeric)
  return crypto.randomBytes(4).toString('hex');
}

function parseJsonBody(ctx) {
  if (!ctx.req.body || !ctx.req.body.length) return {};
  try {
    const parsed = JSON.parse(ctx.req.body.toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function renderTemplate(template, data) {
  if (!template) return data;
  const json = JSON.stringify(template);
  const replaced = json.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const parts = key.split('.');
    let v = data;
    for (const p of parts) {
      if (v == null) break;
      v = v[p];
    }
    if (v == null) return '';
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  });
  try { return JSON.parse(replaced); } catch { return data; }
}

function applyTemplate(col, record) {
  return col.responseTemplate ? renderTemplate(col.responseTemplate, record) : record;
}

function respondJson(ctx, status, body) {
  ctx.response = {
    status,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(body)),
  };
  ctx.meta.source = 'bucket';
}

function respondNoContent(ctx) {
  ctx.response = { status: 204, headers: {}, body: Buffer.alloc(0) };
  ctx.meta.source = 'bucket';
}

export default function create({ config, logger }) {
  const bc = config.bucket || {};
  const persistPath = bc.persistPath ? path.resolve(bc.persistPath) : null;
  const collections = (bc.collections || []).map(compileCollection);

  function loadState() {
    if (!persistPath || !fs.existsSync(persistPath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(persistPath, 'utf8'));
      for (const col of collections) {
        const data = raw[col.path];
        if (!data || !data.items) continue;
        for (const [k, v] of Object.entries(data.items)) {
          col.items.set(k, v);
        }
        if (col.idKind === 'numeric') {
          col.counter = Math.max(
            0,
            ...[...col.items.keys()].map((k) => parseInt(k, 10)).filter((n) => !Number.isNaN(n)),
          );
        }
      }
      logger.info(`[bucket] loaded state from ${persistPath}`);
    } catch (err) {
      logger.warn(`[bucket] failed to load state: ${err.message}`);
    }
  }

  function saveState() {
    if (!persistPath) return;
    const obj = {};
    for (const col of collections) {
      obj[col.path] = { items: Object.fromEntries(col.items) };
    }
    try {
      fs.mkdirSync(path.dirname(persistPath), { recursive: true });
      fs.writeFileSync(persistPath, JSON.stringify(obj, null, 2));
    } catch (err) {
      logger.error(`[bucket] failed to save state: ${err.message}`);
    }
  }

  function matchCollection(reqPath) {
    for (const col of collections) {
      if (reqPath === col.path) return { col, id: null };
      if (reqPath.startsWith(col.path + '/')) {
        const rest = reqPath.slice(col.path.length + 1);
        if (!rest || rest.includes('/')) continue;
        if (!col.idRegex.test(rest)) continue;
        return { col, id: rest };
      }
    }
    return null;
  }

  // ---------- per-method handlers ----------

  function handleGet(ctx, col, id) {
    if (id == null) {
      const all = Array.from(col.items.values());
      logger.info(`[bucket] GET list ${col.path} (${all.length})`);
      return respondJson(ctx, 200, all.map((r) => applyTemplate(col, r)));
    }
    const rec = col.items.get(id);
    if (!rec) {
      logger.warn(`[bucket] GET miss ${col.path}/${id} → pass-through`);
      return;
    }
    logger.info(`[bucket] GET ${col.path}/${id}`);
    return respondJson(ctx, 200, applyTemplate(col, rec));
  }

  function handlePost(ctx, col, id) {
    if (id != null) {
      logger.warn(`[bucket] POST to ${col.path}/${id} not allowed → pass-through`);
      return;
    }
    const body = parseJsonBody(ctx);
    let newId;
    if (body.id != null && col.idRegex.test(String(body.id))) {
      newId = String(body.id);
      if (col.idKind === 'numeric') {
        const n = parseInt(newId, 10);
        if (n > col.counter) col.counter = n;
      }
    } else {
      newId = generateId(col);
    }
    const rec = { ...body, id: newId };
    col.items.set(newId, rec);
    saveState();
    logger.info(`[bucket] POST ${col.path} → id=${newId}`);
    return respondJson(ctx, 201, applyTemplate(col, rec));
  }

  function handleUpdate(ctx, col, id, method) {
    if (id == null) {
      logger.warn(`[bucket] ${method} ${col.path} requires an id → pass-through`);
      return;
    }
    const existing = col.items.get(id);
    if (!existing) {
      logger.warn(`[bucket] ${method} miss ${col.path}/${id} → pass-through`);
      return;
    }
    const body = parseJsonBody(ctx);
    const rec = method === 'PUT' ? { ...body, id } : { ...existing, ...body, id };
    col.items.set(id, rec);
    saveState();
    logger.info(`[bucket] ${method} ${col.path}/${id}`);
    return respondJson(ctx, 200, applyTemplate(col, rec));
  }

  function handleDelete(ctx, col, id) {
    if (id == null) {
      logger.warn(`[bucket] DELETE ${col.path} requires an id → pass-through`);
      return;
    }
    if (!col.items.has(id)) {
      logger.warn(`[bucket] DELETE miss ${col.path}/${id} → pass-through`);
      return;
    }
    col.items.delete(id);
    saveState();
    logger.info(`[bucket] DELETE ${col.path}/${id}`);
    respondNoContent(ctx);
  }

  loadState();

  return {
    name: 'bucket',
    async onRequest(ctx) {
      if (collections.length === 0) return;
      const hit = matchCollection(ctx.req.path);
      if (!hit) return;

      const { col, id } = hit;
      const method = ctx.req.method.toUpperCase();

      switch (method) {
        case 'GET': return handleGet(ctx, col, id);
        case 'POST': return handlePost(ctx, col, id);
        case 'PATCH':
        case 'PUT': return handleUpdate(ctx, col, id, method);
        case 'DELETE': return handleDelete(ctx, col, id);
        default: return; // unhandled method → pass-through
      }
    },
  };
}

