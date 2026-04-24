TUI node application.
ran by `npm start`.
advanced middleware proxy.
- config list, each item consisting of:
name
port (listening)
target (url that requests will be forwarded to)
requestHeaders": {},
changeOrigin: true/false,
followRedirects: true/false
enabled plugins

upon start we pick config, but can change while app is running.

- http/websocket forwarding
- logs that run live and show what url got passed(or mocked, or whatever elde'd)
- ability to add plugins by developers
- Recorder plugin that sits in the response path and saves each proxied request/response pair as JSON
- Mock plugin runs before proxying to the target server and can intercept requests instead of forwarding them.

It uses rules to decide what to do:
    RET_REC: return a previously recorded response from the recordings
    MOCK: return a manually defined inline mock response
    PASS: forward the request to the real target server

Rules support matching by HTTP method and URL patterns, including exact paths, substring matching, and simple dynamic segments like :id.

When RET_REC is selected, the plugin searches stored recordings for the best match:

    If the request has no query string, it uses the newest matching recording.
    If query params are present, it tries to find an exact URI match.

If no recording is found, a secondary fallback decides whether to:

    return a 500 error,
    return an empty 200 response,
    or PASS through to the target server.
