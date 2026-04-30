<div align="center">

# 🌙 night-worcoon-3

**A TUI-driven middleware proxy for HTTP & WebSocket — mock, record, replay, and chaos-test any API from your terminal.**

> 📖 **Full HTML docs:** open [`docs/index.html`](docs/index.html) — overview,
> architecture, every config field, every plugin, and a guide for writing
> your own. See [`docs/README.md`](docs/README.md) for how the docs stay in
> sync with the codebase (`node docs/check-docs.mjs`).

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](https://nodejs.org)
[![Made with JavaScript](https://img.shields.io/badge/made%20with-JavaScript-f7df1e.svg)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#-contributing)

*Pick a config, hit enter, and you're proxying. Drop in plugins to mock, replay, throttle, or break things on demand.*

</div>

---

## ✨ Why night-worcoon-3?

Building against a flaky third-party API? Need to replay yesterday's traffic? Want to see how your client behaves on a slow 3G connection or when the backend returns a 503 every fifth request?

`night-worcoon-3` sits between your client and any HTTP/WebSocket target as a **middleware proxy with a pluggable pipeline**. You drive it from a tiny terminal UI, swap config profiles on the fly, and compose behavior from a small set of focused plugins.

```
┌──────────┐       ┌─────────────────────────────────────────┐       ┌──────────┐
│  client  │ ────▶ │  cors → latency → bucket → mock → rec   │ ────▶ │  target  │
└──────────┘       └─────────────────────────────────────────┘       └──────────┘
                              night-worcoon-3 pipeline
```

## 🚀 Features

- 🖥️ **Interactive TUI** — pick configs, start/stop proxies, reload on the fly (powered by [`blessed`](https://github.com/chjj/blessed)).
- 🤖 **Headless mode** — run a single config from CI or scripts with `--headless`.
- 🧩 **Pluggable pipeline** — auto-loaded plugins, ordered per profile, short-circuit semantics.
- 🪣 **Built-in Bucket** — instant CRUD datastore (`POST/GET/PATCH/PUT/DELETE`) for prototyping.
- 🎭 **Rule-based mocks** — `PASS`, `MOCK`, `RET_REC` (replay from recordings) with fallbacks.
- 📼 **Recorder** — capture real upstream responses to disk or SQLite for later replay.
- 🐢 **Chaos / latency** — inject delays, jitter, and random failures globally or per-rule.
- 🌐 **CORS plugin** — preflight handling and response augmentation out of the box.
- 🔌 **WebSocket tap** — per-frame hooks with logging, rule-based mocks, and session record/replay.
- 💾 **Pluggable storage** — filesystem JSON or SQLite (optional dep).
- 📦 **Zero scaffolding** — drop a JSON in `configs/`, drop a `.js` in `plugins/`, done.

## 📚 Table of Contents

- [Quick Start](#-quick-start)
- [The TUI](#-the-tui)
- [Configuration](#-configuration)
- [Mock plugin](#-mock-plugin)
- [Bucket plugin](#-bucket-plugin)
- [Recorder & Storage](#-recorder--storage)
- [Latency plugin](#-latency-plugin)
- [CORS plugin](#-cors-plugin)
- [Writing your own plugin](#-writing-your-own-plugin)
- [WebSocket](#-websocket)
- [Project layout](#-project-layout)
- [Roadmap](#-roadmap)
- [Contributing](#-contributing)
- [License](#-license)

## ⚡ Quick Start

```bash
# 1. install
npm install

# 2. launch the TUI and pick a config
npm start

# …or run a single profile headless (great for CI / Docker)
npm run start:headless -- --config httpbin.json
```

That's it. The bundled [`configs/httpbin.json`](configs/httpbin.json) profile boots a proxy on `:8080` that fronts `https://httpbin.org`, mocks `GET /mock/hello`, and replays `GET /users/:id` from previous recordings.

```bash
curl http://localhost:8080/mock/hello
# => {"message":"hello from night-worcoon-3"}
```

> **Requirements:** Node.js ≥ 18. SQLite storage requires `better-sqlite3` (installed automatically as an optional dependency).

## 🎛 The TUI

Launch with `npm start` and you get a config picker:

| key          | action                          |
| ------------ | ------------------------------- |
| `↑` / `↓`    | navigate configs                |
| `enter`      | start the selected proxy        |
| `s`          | stop the active proxy           |
| `r`          | reload the configs list         |
| `q` / `Ctrl-C` | quit                          |

Add or edit a JSON in [`configs/`](configs/), press `r`, and your new profile shows up — no restart required.

## ⚙️ Configuration

Each file in `configs/` is one proxy profile. The full shape:

```jsonc
{
  "name": "httpbin",                    // shown in the TUI
  "port": 8080,                         // local listen port
  "target": "https://httpbin.org",      // upstream
  "requestHeaders": { "X-Forwarded-By": "night-worcoon-3" },
  "changeOrigin": true,
  "followRedirects": false,

  // pipeline order; only listed plugins run
  "plugins": ["cors", "latency", "bucket", "mock", "recorder", "ws-tap"],

  // recording backend (used by `recorder` and `RET_REC`)
  "storage": { "type": "fs",     "path": "./recordings/httpbin" },
  // or:    { "type": "sqlite", "path": "./recordings/httpbin.db" }

  "mock":     { /* see below */ },
  "bucket":   { /* see below */ },
  "recorder": { "recordAll": false },
  "latency":  { /* see below */ },
  "cors":     { /* see below */ },
  "wsTap":    { /* see below */ }
}
```

Recommended plugin order: **`["cors", "latency", "bucket", "mock", "recorder"]`** — security/transport first, simulation next, data layer, rule-based behavior, then observation.

## 🎭 Mock plugin

Match incoming requests against a list of rules and decide what to do:

```jsonc
"mock": {
  "rules": [
    { "method": "GET",  "url": "/users/:id", "action": "RET_REC", "fallback": "PASS" },
    { "method": "POST", "url": "/login",     "action": "MOCK",
      "response": { "status": 200, "body": { "token": "abc" } } },
    { "method": "*",    "urlContains": "/debug", "action": "PASS" }
  ]
}
```

**Actions**

| action     | behavior                                                                  |
| ---------- | ------------------------------------------------------------------------- |
| `PASS`     | forward to the real target (same as no rule)                              |
| `MOCK`     | return the inline `response`                                              |
| `RET_REC`  | replay from storage                                                       |

`RET_REC` lookup rules:

- No query string → newest match for `method` + `path`.
- With query string → exact `method` + `path` + `query` match only.
- Miss → `fallback`: `"PASS"`, `"empty200"`, or `"500"` (default).

**Rule matching**

| field          | meaning                                |
| -------------- | -------------------------------------- |
| `url: "/users/:id"` | dynamic segment regex             |
| `url: "/exact/path"` | exact match                       |
| `urlContains: "/api"` | substring match                  |
| `method: "*"`  | any verb                               |

## 🪣 Bucket plugin

A built-in mock datastore — get a working CRUD API in seconds, no upstream required. Add `"bucket"` to `plugins` (typically **before** `mock`) and configure collections:

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

| method   | path        | effect                                                                          |
| -------- | ----------- | ------------------------------------------------------------------------------- |
| `POST`   | `/coll`     | create resource, auto-generate id (or honor `body.id` if it matches) → `201`    |
| `GET`    | `/coll`     | list all resources → `200`                                                      |
| `GET`    | `/coll/:id` | fetch one → `200`, or miss → falls through                                      |
| `PATCH`  | `/coll/:id` | shallow merge → `200`, or miss → falls through                                  |
| `PUT`    | `/coll/:id` | replace (id preserved) → `200`, or miss → falls through                         |
| `DELETE` | `/coll/:id` | remove → `204`, or miss → falls through                                         |

Supported `idPattern` values: `uuid`, `numeric` (auto-increment), `alphanumeric` (random 8 chars), or `regex:<pattern>` for validation. Numeric counters are rebuilt from persisted data on startup, so ids are never reused after a restart.

Misses are **non-blocking**: unmatched paths or unknown ids leave `ctx.response` null, so the request continues down the pipeline (Mock → upstream proxy). See [`configs/example-bucket.json`](configs/example-bucket.json).

## 📼 Recorder & Storage

The `recorder` plugin saves real upstream responses so they can be replayed later via `RET_REC`. Storage is configured per profile:

| backend  | storage                                                       |
| -------- | ------------------------------------------------------------- |
| `fs`     | one JSON file per recording, under `path/`                    |
| `sqlite` | single DB file (requires `better-sqlite3`, optional dep)      |

Bodies are stored as UTF‑8 when printable, otherwise base64.

```jsonc
"recorder": { "recordAll": false }   // true → record every request, not just mock-matched
```

## 🐢 Latency plugin

Simulate slow networks, flaky services, and tail-latency outliers:

```jsonc
"latency": {
  "delayMs": 300,
  "jitterMs": 200,
  "failRate": 0.1,
  "failStatus": 503,
  "rules": [
    { "urlContains": "/slow",          "delayMs": 3000 },
    { "method": "POST", "url": "/api/flaky", "failRate": 0.5 }
  ]
}
```

Per-rule settings override defaults. Delay is applied **before any other request hook**, so it affects mocked and bucketed responses too — handy for end-to-end loading-state tests.

## 🌐 CORS plugin

```jsonc
"cors": {
  "origin": "*",
  "methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "headers": "Content-Type,Authorization",
  "credentials": false,
  "maxAge": 600
}
```

`origin` can be `"*"`, a single origin string, or an array of allowed origins. Preflight `OPTIONS` requests get a `204` short-circuit; every other response is augmented with the CORS headers.

## 🛠 Writing your own plugin

Drop a `.js` file in [`plugins/`](plugins/). Each file `export default`s either an object or a factory:

```js
export default function create({ config, logger }) {
  return {
    name: 'my-plugin',
    async init({ config, logger }) { /* optional */ },
    async onRequest(ctx)  { /* set ctx.response to short-circuit */ },
    async onResponse(ctx) { /* observe / mutate the final response */ },
  };
}
```

A plugin only runs if its `name` is listed in the profile's `plugins` array.

**Pipeline semantics**

- `onRequest` runs **top-to-bottom** and stops at the first plugin that sets `ctx.response`.
- `onResponse` runs **top-to-bottom** for all loaded plugins, regardless of who produced the response.

**`ctx` shape**

```ts
ctx = {
  config, storage, logger,
  req: { method, url, path, query, headers, body: Buffer },
  response: null | { status, headers, body: Buffer },
  meta: { source: null | 'proxy' | 'mock' | 'ret_rec' | 'ret_rec_fallback'
                       | 'bucket' | 'cors' | 'latency_fail' }
}
```

**Built-in plugins reference**

| name       | purpose                                                     |
| ---------- | ----------------------------------------------------------- |
| `bucket`   | built-in mock datastore (CRUD, see above)                   |
| `mock`     | rule-based mock / replay from recordings                    |
| `recorder` | save real upstream responses                                |
| `latency`  | inject delay + random failures (chaos testing)              |
| `cors`     | add CORS headers + handle `OPTIONS` preflight               |
| `ws-tap`   | inspect, mock, record, and replay WebSocket frames           |

## 🔌 WebSocket

`ws://` upgrades on the listening port are forwarded to `target` and message
frames can flow through the plugin pipeline via the built-in `ws-tap` plugin.
Enable it with `"plugins": ["ws-tap"]` and configure `wsTap`:

```jsonc
"wsTap": {
  "log": true,
  "record": true,
  "recordPath": "./recordings/httpbin-ws",
  "rules": [
    { "url": "/socket", "direction": "client", "textContains": "ping",
      "action": "MOCK", "response": "pong" },
    { "url": "/socket", "direction": "client", "action": "REPLAY",
      "fallback": "PASS" }
  ]
}
```

`ws-tap` calls `onWsMessage(ctx)` for every text/binary frame. Rules support
`PASS`, `DROP`, `MOCK`, and `REPLAY`/`RET_REC`; mocked client frames are dropped
by default and their configured response is injected back to the client.

## 🗂 Project layout

```
configs/        profile JSONs — one per proxy
plugins/        auto-loaded plugins (mock, recorder, your own)
recordings/     default storage dir (gitignored)
src/
  index.js      entry (TUI or --headless)
  tui.js        blessed UI
  proxy.js      HTTP + WS proxy + hook pipeline
  plugins.js    plugin loader
  storage.js    fs + sqlite backends
  match.js      URL/rule matching
  logger.js     EventEmitter logger
```

## 🗺 Roadmap

- [x] Plugin hooks for WebSocket frames (record / mock / replay)
- [ ] HTTPS upstream cert pinning options
- [ ] Live request log pane in the TUI
- [ ] Hot-reload of running proxies on config change

Have an idea? [Open an issue](../../issues) or jump straight to a PR.

## 🤝 Contributing

PRs welcome! The codebase is small and dependency-light on purpose — it should stay that way.

1. Fork & branch.
2. Keep the public surface (config schema, `ctx` shape, plugin contract) backwards-compatible, or call it out clearly.
3. Add a config under `configs/` if you're demoing a new feature.
4. Run `npm start` against a real or `httpbin` target to smoke-test before opening the PR.

## 📄 License

[MIT](LICENSE) © night-worcoon-3 contributors.
