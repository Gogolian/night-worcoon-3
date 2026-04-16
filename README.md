# night-worcoon-3

TUI-driven middleware proxy (HTTP + WebSocket) with a pluggable pipeline,
built-in **Mock** and **Recorder** plugins, and pick-at-runtime config
profiles.

## Run

```bash
npm install
npm start                                 # TUI
npm run start:headless -- --config httpbin.json   # no TUI
```

In the TUI:

| key | action |
|-----|--------|
| ↑ / ↓ | navigate configs |
| enter | start selected proxy |
| s | stop active proxy |
| r | reload configs list |
| q / Ctrl-C | quit |

## Configs

Drop JSON files into [configs/](configs/). Each file is one proxy profile:

```jsonc
{
  "name": "httpbin",
  "port": 8080,
  "target": "https://httpbin.org",
  "requestHeaders": { "X-Forwarded-By": "night-worcoon-3" },
  "changeOrigin": true,
  "followRedirects": false,

  "plugins": ["mock", "recorder"],

  "storage": { "type": "fs",     "path": "./recordings/httpbin" },
  // or:    { "type": "sqlite", "path": "./recordings/httpbin.db" }

  "mock": {
    "rules": [
      { "method": "GET", "url": "/users/:id", "action": "RET_REC", "fallback": "PASS" },
      { "method": "POST", "url": "/login",    "action": "MOCK",
        "response": { "status": 200, "body": { "token": "abc" } } },
      { "method": "*", "urlContains": "/debug", "action": "PASS" }
    ]
  },

  "recorder": { "recordAll": false }
}
```

### Mock actions

* `PASS` — forward to the real target (same as no rule).
* `MOCK` — return the inline `response`.
* `RET_REC` — replay from storage.
  * No query string → newest match for method + path.
  * Query string → exact method + path + query match only.
  * Miss → `fallback`: `"PASS"`, `"empty200"`, or `"500"` (default).

### Rule matching

* `url: "/users/:id"` — dynamic segment regex.
* `url: "/exact/path"` — exact.
* `urlContains: "/api"` — substring.
* `method: "*"` — any verb.

## Storage

Configured per profile. Both are supported:

* `fs` — one JSON per recording under `path/`.
* `sqlite` — single DB file (requires `better-sqlite3`, installed as
  an optional dep).

Bodies are stored as UTF‑8 when printable, else base64.

## Bucket (built-in mock datastore)

Enable by adding `"bucket"` to `plugins` (typically **before** `mock`) and a
`bucket` section:

```jsonc
"plugins": ["bucket", "mock", "recorder"],
"bucket": {
  "persistPath": "./recordings/myproxy-bucket.json",   // optional, omit for in-memory
  "collections": [
    { "path": "/api/users",    "idPattern": "numeric" },
    { "path": "/api/sessions", "idPattern": "uuid",
      "responseTemplate": { "session": "{{id}}", "user": "{{user}}" } },
    { "path": "/api/tokens",   "idPattern": "regex:[A-Z]{4}-\\d{4}" }
  ]
}
```

| method | path | effect |
|--------|------|--------|
| `POST`   | `/coll`      | create resource, auto-generate id (or honor `body.id` if it matches the pattern) → `201` |
| `GET`    | `/coll`      | list all resources → `200` |
| `GET`    | `/coll/:id`  | fetch one → `200`, or miss → falls through |
| `PATCH`  | `/coll/:id`  | shallow merge → `200`, or miss → falls through |
| `PUT`    | `/coll/:id`  | replace (id preserved) → `200`, or miss → falls through |
| `DELETE` | `/coll/:id`  | remove → `204`, or miss → falls through |

Supported `idPattern` values: `uuid`, `numeric` (auto-increment), `alphanumeric`
(random 8 chars), or `regex:<pattern>` for validation. Numeric counters are
rebuilt from persisted data on startup so ids are never reused after a restart.

Misses are **non-blocking**: unmatched paths or unknown ids leave `ctx.response`
null, so the request continues down the pipeline (Mock → upstream proxy). See
[configs/example-bucket.json](configs/example-bucket.json).

## Plugins

Auto-loaded from [plugins/](plugins/). The order in `config.plugins` is
the pipeline order: `onRequest` runs top-to-bottom and stops at the first
plugin that sets `ctx.response`; `onResponse` runs top-to-bottom for all
loaded plugins. Built-in plugins:

| name | purpose |
|------|---------|
| `bucket`   | built-in mock datastore (CRUD, see above) |
| `mock`     | rule-based mock / replay from recordings |
| `recorder` | save real upstream responses |
| `latency`  | inject delay + random failures (chaos testing) |
| `cors`     | add CORS headers + handle OPTIONS preflight |

Recommended ordering: `["cors", "latency", "bucket", "mock", "recorder"]`.

### latency

```jsonc
"latency": {
  "delayMs": 300,
  "jitterMs": 200,
  "failRate": 0.1,
  "failStatus": 503,
  "rules": [
    { "urlContains": "/slow", "delayMs": 3000 },
    { "method": "POST", "url": "/api/flaky", "failRate": 0.5 }
  ]
}
```

Per-rule settings override defaults. Delay is applied before any other
request hook, so it affects mocked/bucketed responses too.

### cors

```jsonc
"cors": {
  "origin": "*",
  "methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "headers": "Content-Type,Authorization",
  "credentials": false,
  "maxAge": 600
}
```

`origin` can be `"*"`, a single origin string, or an array of allowed
origins. Preflight `OPTIONS` requests get a `204` short-circuit; every
other response is augmented with the CORS headers.

### Writing your own

Each file `export default`s either an object or a factory:

```js
export default function create({ config, logger }) {
  return {
    name: 'my-plugin',
    async init({ config, logger }) { /* optional */ },
    async onRequest(ctx)  { /* set ctx.response to short-circuit */ },
    async onResponse(ctx) { /* observe / mutate final response */ },
  };
}
```

A plugin only runs if its `name` is listed in the profile's `plugins`
array. `ctx` shape:

```
ctx = {
  config, storage, logger,
  req: { method, url, path, query, headers, body: Buffer },
  response: null | { status, headers, body: Buffer },
  meta: { source: null | 'proxy' | 'mock' | 'ret_rec' | 'ret_rec_fallback' | 'bucket' | 'cors' | 'latency_fail' }
}
```

## WebSocket

`ws://` upgrades on the listening port are forwarded to `target`
using `http-proxy`. Plugin hooks don't see WS traffic yet (planned).

## Layout

```
configs/        profile JSONs
plugins/        auto-loaded plugins (mock, recorder, your own)
recordings/     default storage dir (gitignored)
src/
  index.js      entry (TUI or --headless)
  tui.js        blessed UI
  proxy.js     HTTP + WS proxy + hook pipeline
  plugins.js    plugin loader
  storage.js    fs + sqlite backends
  match.js      URL/rule matching
  logger.js     EventEmitter logger
```
