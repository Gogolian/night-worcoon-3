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

function parseCliArgs(argv) {
  const configIdx = argv.indexOf('--config');
  return {
    headless: argv.includes('--headless'),
    configFile: configIdx !== -1 ? argv[configIdx + 1] : null,
  };
}

function attachHeadlessLogging(log) {
  log.on('log', (e) => {
    const line = `${e.ts.toISOString()} ${e.level.toUpperCase().padEnd(5)} ${e.msg}`;
    const stream = e.level === 'error' ? process.stderr : process.stdout;
    stream.write(line + '\n');
  });
  log.on('trace', (e) => {
    if (e.kind !== 'request') return;
    const d = e.data;
    process.stdout.write(
      `${e.ts.toISOString()} ${d.status} ${d.method} ${d.url} (${d.source}, ${d.ms}ms)\n`,
    );
  });
}

function installShutdownHandlers(handle) {
  const shutdown = async () => {
    try { await handle.stop(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function runHeadless({ configFile }) {
  if (!configFile) {
    console.error('usage: node src/index.js --headless --config <file.json>');
    process.exit(2);
  }
  const cfgPath = path.resolve(configsDir, configFile);
  const { default: fs } = await import('node:fs');
  const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

  attachHeadlessLogging(logger);
  const handle = await startProxy({ config, configDir: rootDir, logger, pluginsDir });
  installShutdownHandlers(handle);
}

async function runTui() {
  await createTui({
    configsDir,
    pluginsDir,
    logger,
    onStart: (config) => startProxy({ config, configDir: rootDir, logger, pluginsDir }),
    onStop: (handle) => handle.stop(),
  });
}

const { headless, configFile } = parseCliArgs(process.argv.slice(2));
const main = headless ? () => runHeadless({ configFile }) : runTui;
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

