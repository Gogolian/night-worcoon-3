#!/usr/bin/env node
// docs/check-docs.mjs
//
// Tells you whether the HTML docs in this folder are still in sync with the
// source files they describe.
//
// Usage:
//   node docs/check-docs.mjs            # report drift, exit 1 if any
//   node docs/check-docs.mjs --json     # machine-readable report
//   node docs/check-docs.mjs --update   # rewrite MANIFEST.json with current hashes
//                                       # (run this AFTER you have updated the
//                                       #  doc pages flagged as stale)
//
// How it works
// ------------
// MANIFEST.json declares, for each documented source file:
//   - its path
//   - the SHA-256 of its current content (at the time the docs were last refreshed)
//   - its line count
//   - which doc page(s) cover it
//
// This script recomputes the hash + line count and prints any source files
// whose content has drifted, grouped by the doc pages affected.
//
// If you're an LLM agent updating the codebase: run this before declaring the
// task done. If anything is reported stale, edit the listed doc page(s),
// then rerun with --update to refresh the manifest.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const docsDir = path.dirname(__filename);
const repoRoot = path.resolve(docsDir, '..');
const manifestPath = path.join(docsDir, 'MANIFEST.json');

const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const wantUpdate = args.includes('--update');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function statFile(absPath) {
  const buf = fs.readFileSync(absPath);
  const lines = buf.toString('utf8').split('\n').length;
  return { sha256: sha256(buf), lines };
}

function loadManifest() {
  if (!fs.existsSync(manifestPath)) {
    console.error(`MANIFEST.json not found at ${manifestPath}`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function main() {
  const manifest = loadManifest();
  const sources = manifest.sources || {};
  const drifted = [];
  const missing = [];
  const fresh = {};

  for (const [relPath, recorded] of Object.entries(sources)) {
    const abs = path.resolve(repoRoot, relPath);
    if (!fs.existsSync(abs)) {
      missing.push(relPath);
      continue;
    }
    const cur = statFile(abs);
    fresh[relPath] = { ...recorded, sha256: cur.sha256, lines: cur.lines };
    if (cur.sha256 !== recorded.sha256) {
      drifted.push({
        path: relPath,
        was: { sha256: recorded.sha256, lines: recorded.lines },
        now: cur,
        covers: recorded.covers || [],
      });
    }
  }

  // Reverse map: doc page → list of drifted source files
  const docToSources = {};
  for (const d of drifted) {
    for (const doc of d.covers) {
      (docToSources[doc] ||= []).push(d.path);
    }
  }

  if (wantUpdate) {
    const next = { ...manifest, generatedAt: new Date().toISOString(), sources: fresh };
    fs.writeFileSync(manifestPath, JSON.stringify(next, null, 2) + '\n');
    console.log(`✓ MANIFEST.json refreshed (${Object.keys(fresh).length} sources hashed).`);
    return;
  }

  if (wantJson) {
    process.stdout.write(JSON.stringify({ drifted, missing, docToSources }, null, 2) + '\n');
    process.exit(drifted.length || missing.length ? 1 : 0);
  }

  // Human report
  if (missing.length) {
    console.log('\n  Missing source files (in MANIFEST but not on disk):');
    for (const m of missing) console.log(`    - ${m}`);
  }

  if (!drifted.length && !missing.length) {
    console.log('\n  ✓ Docs are in sync. No tracked source file has changed.\n');
    return;
  }

  if (drifted.length) {
    console.log(`\n  ⚠  ${drifted.length} tracked source file(s) have changed since the docs were last refreshed:\n`);
    for (const d of drifted) {
      console.log(`    • ${d.path}`);
      console.log(`        was: ${d.was.sha256.slice(0, 12)}…  (${d.was.lines} lines)`);
      console.log(`        now: ${d.now.sha256.slice(0, 12)}…  (${d.now.lines} lines)`);
      console.log(`        covered by: ${d.covers.join(', ') || '(none)'}`);
    }
    console.log('\n  Likely-stale doc pages (review these, update if needed):\n');
    for (const [doc, srcs] of Object.entries(docToSources)) {
      console.log(`    - ${doc}`);
      for (const s of srcs) console.log(`        because: ${s}`);
    }
    console.log('\n  Workflow:');
    console.log('    1. Open each listed doc page and update it to match the new source.');
    console.log('    2. When done, run:  node docs/check-docs.mjs --update');
    console.log('       (this rewrites MANIFEST.json with the current hashes).\n');
  }

  process.exit(1);
}

main();
