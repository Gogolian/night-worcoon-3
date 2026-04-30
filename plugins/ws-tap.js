import fs from 'node:fs';
import path from 'node:path';
import { compileRule, matchRule } from '../src/match.js';

function encodePayload(ctx) {
  if (ctx.frame.binary) {
    return {
      body: ctx.frame.data.toString('base64'),
      bodyEncoding: 'base64',
      binary: true,
    };
  }
  return {
    body: ctx.frame.text ?? ctx.frame.data.toString('utf8'),
    bodyEncoding: 'utf8',
    binary: false,
  };
}

function decodePayload(frame) {
  if (!frame) return null;
  if (frame.bodyEncoding === 'base64') {
    return { body: Buffer.from(frame.body || '', 'base64'), binary: true };
  }
  return { body: frame.body == null ? '' : String(frame.body), binary: !!frame.binary };
}

function safePathPart(value) {
  return String(value || 'root').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'root';
}

function makeResponseFrames(response) {
  const list = Array.isArray(response) ? response : [response];
  return list.filter((item) => item != null).map((item) => {
    if (Buffer.isBuffer(item)) return { body: item, binary: true };
    if (typeof item === 'object' && 'body' in item) return item;
    if (typeof item === 'object') return { body: JSON.stringify(item), binary: false };
    return { body: String(item), binary: false };
  });
}

export default function create({ config, logger }) {
  const wc = config.wsTap || config['ws-tap'] || {};
  const logFrames = wc.log !== false;
  const record = wc.record !== false;
  const recordPath = path.resolve(wc.recordPath || `./recordings/${config.name || 'default'}-ws`);
  const rules = (wc.rules || []).map((r) => ({ ...r, _c: compileRule(r) }));
  const sessions = new Map();
  const replayCursors = new Map();

  function sessionFor(ctx) {
    const id = ctx.ws.connectionId;
    if (sessions.has(id)) return sessions.get(id);
    const session = {
      id,
      ts: new Date().toISOString(),
      url: ctx.ws.url,
      path: ctx.ws.path,
      query: ctx.ws.query,
      frames: [],
    };
    sessions.set(id, session);
    return session;
  }

  function saveSession(session) {
    fs.mkdirSync(recordPath, { recursive: true });
    const file = path.join(
      recordPath,
      `${safePathPart(session.path)}__${session.id}.json`,
    );
    fs.writeFileSync(file, JSON.stringify(session, null, 2));
  }

  function recordFrame(ctx) {
    if (!record) return;
    const session = sessionFor(ctx);
    session.frames.push({
      ts: new Date().toISOString(),
      direction: ctx.ws.direction,
      opcode: ctx.frame.opcode,
      ...encodePayload(ctx),
    });
    saveSession(session);
  }

  function matchingRule(ctx) {
    for (const rule of rules) {
      if (rule.direction && rule.direction !== ctx.ws.direction) continue;
      if (!matchRule(rule._c, 'WS', ctx.ws.path)) continue;
      if (rule.textContains && !String(ctx.frame.text || '').includes(rule.textContains)) continue;
      if (rule.textEquals != null && String(ctx.frame.text || '') !== String(rule.textEquals)) continue;
      return rule;
    }
    return null;
  }

  function readSessions(wsPath) {
    if (!fs.existsSync(recordPath)) return [];
    const prefix = `${safePathPart(wsPath)}__`;
    return fs.readdirSync(recordPath)
      .filter((file) => file.startsWith(prefix) && file.endsWith('.json'))
      .map((file) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(recordPath, file), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => (a.ts < b.ts ? 1 : -1));
  }

  function replayFrame(ctx, rule) {
    const session = readSessions(ctx.ws.path)[0];
    if (!session) return false;
    const replyDirection = ctx.ws.direction === 'client' ? 'server' : 'client';
    const frames = (session.frames || []).filter((frame) => frame.direction === replyDirection);
    const key = `${ctx.ws.connectionId}:${rule.id || rule.url || rule.urlContains || ctx.ws.path}`;
    const cursor = replayCursors.get(key) || 0;
    const next = frames[cursor];
    if (!next) return false;
    replayCursors.set(key, cursor + 1);
    ctx.drop = rule.dropOriginal !== false;
    ctx.inject.push(decodePayload(next));
    ctx.meta.source = 'ws_tap_replay';
    logger.info(`[ws-tap] REPLAY ${ctx.ws.direction} ${ctx.ws.url} frame ${cursor + 1}/${frames.length}`);
    return true;
  }

  function fallback(ctx, rule) {
    const fb = String(rule.fallback || 'PASS').toUpperCase();
    if (fb === 'DROP') {
      ctx.drop = true;
      ctx.meta.source = 'ws_tap_drop';
    }
  }

  return {
    name: 'ws-tap',
    async onWsMessage(ctx) {
      if (logFrames) {
        logger.info(
          `[ws-tap] ${ctx.ws.direction} ${ctx.ws.url} ${ctx.frame.binary ? 'binary' : 'text'} ${ctx.frame.data.length}b`,
        );
      }

      const rule = matchingRule(ctx);
      if (rule) {
        const action = String(rule.action || 'PASS').toUpperCase();
        if (action === 'DROP') {
          ctx.drop = true;
          ctx.meta.source = 'ws_tap_drop';
        } else if (action === 'MOCK') {
          ctx.drop = rule.dropOriginal !== false;
          ctx.inject.push(...makeResponseFrames(rule.response));
          ctx.meta.source = 'ws_tap_mock';
          logger.info(`[ws-tap] MOCK ${ctx.ws.direction} ${ctx.ws.url}`);
        } else if (action === 'REPLAY' || action === 'RET_REC') {
          if (!replayFrame(ctx, rule)) fallback(ctx, rule);
        } else if (action !== 'PASS') {
          logger.warn(`[ws-tap] unknown action "${rule.action}"`);
        }
      }

      recordFrame(ctx);
    },
  };
}
