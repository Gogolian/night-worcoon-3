import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

/**
 * Auto-load all plugins from ./plugins/*.js (relative to repo root).
 * Each plugin file must `export default` an object or a factory function:
 *   export default { name, onRequest?, onResponse?, init? }
 *   export default (ctx) => ({ name, ... })   // factory gets { config, logger }
 *
 * A plugin is only instantiated for a config if its name is present in
 * config.plugins (array of strings).
 */
export async function loadPlugins({ pluginsDir, config, logger }) {
  const enabled = Array.isArray(config.plugins) ? config.plugins : [];
  if (enabled.length === 0) return [];

  if (!fs.existsSync(pluginsDir)) {
    logger.warn(`plugins dir not found: ${pluginsDir}`);
    return [];
  }

  const files = fs.readdirSync(pluginsDir).filter((f) => f.endsWith('.js'));
  const instances = [];

  for (const file of files) {
    const full = path.join(pluginsDir, file);
    const mod = await import(url.pathToFileURL(full).href);
    const exp = mod.default ?? mod;
    let plugin;
    if (typeof exp === 'function') {
      plugin = await exp({ config, logger });
    } else {
      plugin = exp;
    }
    if (!plugin || !plugin.name) continue;
    if (!enabled.includes(plugin.name)) continue;
    if (typeof plugin.init === 'function') {
      await plugin.init({ config, logger });
    }
    instances.push(plugin);
    logger.info(`plugin loaded: ${plugin.name}`);
  }

  // Preserve order from config.plugins
  instances.sort(
    (a, b) => enabled.indexOf(a.name) - enabled.indexOf(b.name),
  );
  return instances;
}

/**
 * Run onRequest pipeline. Stops as soon as any plugin short-circuits
 * (sets ctx.response). Returns the (possibly mutated) ctx.
 */
export async function runOnRequest(plugins, ctx) {
  for (const p of plugins) {
    if (ctx.response) break;
    if (typeof p.onRequest === 'function') {
      await p.onRequest(ctx);
    }
  }
  return ctx;
}

export async function runOnResponse(plugins, ctx) {
  for (const p of plugins) {
    if (typeof p.onResponse === 'function') {
      await p.onResponse(ctx);
    }
  }
  return ctx;
}
