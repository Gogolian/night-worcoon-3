Found Bugs:
- when server started and port edited, server is still running on old port. solution: restart on any config change.
- tui bug: When we go to headers edit, and type a to add header, and then not enter value but click esc, overlay of header input closes, then we click esc one more time, overlay requestHeaders closes, then if we enter requestHeaders again we see 2 overlays, and when we click esc, only the heder input overlay disappears, and we are navigating main layout with requestHeaders overlay visible and no way to close it.
- if we are navigating through `config` or through `options` header of that section could be in [] brackets
- for boolean config values overlay we should have vertical two buttons true / false
- if we try to start another config then we see message in logs wich is in another tab. It would be nice to show it in popup with info which config is running, close button, and "switch to this config" button which would stop the previous one and start this one.
