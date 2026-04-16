/**
 * URL matching utilities.
 *
 * Rule shape:
 *   { method?: "GET"|"*"|..., url?: "/users/:id", urlContains?: "/api", ... }
 *
 * Matching strategy:
 *   - If `urlContains` is set → substring match.
 *   - Else if `url` contains ":segment" tokens → regex with named params.
 *   - Else → exact match against the path (query stripped).
 */

export function compileRule(rule) {
  const method = (rule.method || '*').toUpperCase();
  const compiled = { method, raw: rule };

  if (rule.urlContains) {
    compiled.kind = 'substring';
    compiled.needle = rule.urlContains;
    return compiled;
  }

  if (!rule.url) {
    compiled.kind = 'any';
    return compiled;
  }

  if (rule.url.includes(':')) {
    const pattern = rule.url.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '([^/]+)');
    compiled.kind = 'regex';
    compiled.regex = new RegExp(`^${pattern}$`);
    return compiled;
  }

  compiled.kind = 'exact';
  compiled.value = rule.url;
  return compiled;
}

export function matchRule(compiled, method, urlPath) {
  if (compiled.method !== '*' && compiled.method !== method.toUpperCase()) {
    return false;
  }
  switch (compiled.kind) {
    case 'any': return true;
    case 'substring': return urlPath.includes(compiled.needle);
    case 'exact': return urlPath === compiled.value;
    case 'regex': return compiled.regex.test(urlPath);
    default: return false;
  }
}

export function splitPathQuery(reqUrl) {
  const i = reqUrl.indexOf('?');
  if (i === -1) return { path: reqUrl, query: '' };
  return { path: reqUrl.slice(0, i), query: reqUrl.slice(i + 1) };
}
