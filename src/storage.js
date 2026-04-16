import fs from 'node:fs';
import path from 'node:path';

/**
 * Recording shape:
 * {
 *   id, ts, method, path, query, url,
 *   request: { headers, body (base64|string), bodyEncoding },
 *   response: { status, headers, body, bodyEncoding }
 * }
 */

function encodeBody(buf) {
  if (buf == null) return { body: '', bodyEncoding: 'utf8' };
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
  // crude heuristic: if it decodes cleanly as utf-8 and is "mostly printable"
  const str = b.toString('utf8');
  // eslint-disable-next-line no-control-regex
  if (!/[\x00-\x08\x0E-\x1F]/.test(str)) {
    return { body: str, bodyEncoding: 'utf8' };
  }
  return { body: b.toString('base64'), bodyEncoding: 'base64' };
}

export function decodeBody(rec) {
  if (!rec) return Buffer.alloc(0);
  const { body, bodyEncoding } = rec;
  if (body == null) return Buffer.alloc(0);
  if (bodyEncoding === 'base64') return Buffer.from(body, 'base64');
  return Buffer.from(String(body), 'utf8');
}

export function buildRecord({ method, urlPath, query, req, res }) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    method: method.toUpperCase(),
    path: urlPath,
    query: query || '',
    url: query ? `${urlPath}?${query}` : urlPath,
    request: {
      headers: req.headers || {},
      ...encodeBody(req.body),
    },
    response: {
      status: res.status,
      headers: res.headers || {},
      ...encodeBody(res.body),
    },
  };
}

// ---------- FS storage ----------

class FsStorage {
  constructor({ dir, logger }) {
    this.dir = dir;
    this.logger = logger;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  _safeName(rec) {
    const safePath = rec.path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'root';
    return `${rec.method}__${safePath}__${rec.id}.json`;
  }

  async save(rec) {
    const file = path.join(this.dir, this._safeName(rec));
    fs.writeFileSync(file, JSON.stringify(rec, null, 2));
    return file;
  }

  async findBest({ method, path: urlPath, query }) {
    const files = fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'));
    const matches = [];
    for (const f of files) {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        if (rec.method !== method.toUpperCase()) continue;
        if (rec.path !== urlPath) continue;
        matches.push(rec);
      } catch {}
    }
    if (matches.length === 0) return null;
    if (query) {
      const exact = matches.find((m) => m.query === query);
      if (exact) return exact;
      return null;
    }
    matches.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    return matches[0];
  }
}

// ---------- SQLite storage (optional) ----------

class SqliteStorage {
  constructor({ file, logger, Database }) {
    this.logger = logger;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recordings (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        query TEXT NOT NULL,
        url TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_recordings_lookup
        ON recordings (method, path, ts);
    `);
  }

  async save(rec) {
    this.db
      .prepare(
        'INSERT INTO recordings (id, ts, method, path, query, url, payload) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        rec.id,
        rec.ts,
        rec.method,
        rec.path,
        rec.query || '',
        rec.url,
        JSON.stringify(rec),
      );
    return rec.id;
  }

  async findBest({ method, path: urlPath, query }) {
    const m = method.toUpperCase();
    if (query) {
      const row = this.db
        .prepare(
          'SELECT payload FROM recordings WHERE method=? AND path=? AND query=? ORDER BY ts DESC LIMIT 1',
        )
        .get(m, urlPath, query);
      return row ? JSON.parse(row.payload) : null;
    }
    const row = this.db
      .prepare(
        'SELECT payload FROM recordings WHERE method=? AND path=? ORDER BY ts DESC LIMIT 1',
      )
      .get(m, urlPath);
    return row ? JSON.parse(row.payload) : null;
  }
}

// ---------- Factory ----------

export async function createStorage({ config, logger, configDir }) {
  const s = config.storage || { type: 'fs', path: './recordings' };
  const type = (s.type || 'fs').toLowerCase();
  const resolve = (p) => path.resolve(configDir, p);

  if (type === 'fs' || type === 'filesystem') {
    const dir = resolve(s.path || `./recordings/${config.name || 'default'}`);
    logger.info(`storage: fs at ${dir}`);
    return new FsStorage({ dir, logger });
  }

  if (type === 'sqlite') {
    let Database;
    try {
      ({ default: Database } = await import('better-sqlite3'));
    } catch (err) {
      throw new Error(
        'SQLite storage requested but "better-sqlite3" is not installed. Run: npm i better-sqlite3',
      );
    }
    const file = resolve(s.path || `./recordings/${config.name || 'default'}.sqlite`);
    logger.info(`storage: sqlite at ${file}`);
    return new SqliteStorage({ file, logger, Database });
  }

  throw new Error(`Unknown storage type: ${s.type}`);
}
