#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';
import { startProxy } from './proxy.js';
import { createTui } from './tui.js';

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), '..');
const configsDir = path.resolve(rootDir, 'configs');
const pluginsDir = path.resolve(rootDir, 'plugins');

const args = process.argv.slice(2);
const headless = args.includes('--headless');
const configArgIdx = args.indexOf('--config');
const configArg = configArgIdx !== -1 ? args[configArgIdx + 1] : null;

async function runHeadless() {
  if (!configArg) {
    console.error('usage: node src/index.js --headless --config <file.json>');
    process.exit(2);
  }
  const cfgFile = path.resolve(configsDir, configArg);
  const { default: fs } = await import('node:fs');
  const config = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));

  logger.on('log', (e) => {
    const t = e.ts.toISOString();
    const line = `${t} ${e.level.toUpperCase().padEnd(5)} ${e.msg}`;
    const stream = e.level === 'error' ? process.stderr : process.stdout;
    stream.write(line + '\n');
  });
  logger.on('trace', (e) => {
    if (e.kind !== 'request') return;
    const d = e.data;
    process.stdout.write(
      `${e.ts.toISOString()} ${d.status} ${d.method} ${d.url} (${d.source}, ${d.ms}ms)\n`,
    );
  });

  const handle = await startProxy({ config, configDir: rootDir, logger, pluginsDir });
  const shutdown = async () => {
    try { await handle.stop(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function runTui() {
  createTui({
    configsDir,
    logger,
    onStart: async (config) => {
      return startProxy({ config, configDir: rootDir, logger, pluginsDir });
    },
    onStop: async (handle) => handle.stop(),
  });
}

if (headless) {
  runHeadless().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  runTui().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
