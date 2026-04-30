import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { URL } from 'node:url';

import { runOnWsMessage } from './plugins.js';
import { splitPathQuery } from './match.js';

const OPCODES = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
};

function buildTargetUrl(config, reqUrl) {
  const target = new URL(config.target);
  const basePath = target.pathname.replace(/\/$/, '');
  const { path, query } = splitPathQuery(reqUrl || '/');
  target.pathname = `${basePath}${path.startsWith('/') ? path : `/${path}`}`;
  target.search = query ? `?${query}` : '';
  if (target.protocol === 'https:') target.protocol = 'wss:';
  if (target.protocol === 'http:') target.protocol = 'ws:';
  return target;
}

function buildUpgradeRequest({ config, req, target }) {
  const headers = { ...req.headers };
  delete headers['proxy-connection'];
  delete headers['content-length'];
  if (config.changeOrigin) headers.host = target.host;
  if (config.requestHeaders) Object.assign(headers, config.requestHeaders);
  headers.connection = 'Upgrade';
  headers.upgrade = 'websocket';

  const path = `${target.pathname || '/'}${target.search || ''}`;
  const lines = [`GET ${path} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${name}: ${item}`);
    } else {
      lines.push(`${name}: ${value}`);
    }
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

function encodeFrame({ opcode, payload, fin = true }, masked) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const first = (fin ? 0x80 : 0) | (opcode & 0x0f);
  let lenBytes;
  if (body.length < 126) {
    lenBytes = Buffer.from([masked ? 0x80 | body.length : body.length]);
  } else if (body.length <= 0xffff) {
    lenBytes = Buffer.alloc(3);
    lenBytes[0] = masked ? 0x80 | 126 : 126;
    lenBytes.writeUInt16BE(body.length, 1);
  } else {
    lenBytes = Buffer.alloc(9);
    lenBytes[0] = masked ? 0x80 | 127 : 127;
    lenBytes.writeBigUInt64BE(BigInt(body.length), 1);
  }

  if (!masked) return Buffer.concat([Buffer.from([first]), lenBytes, body]);

  const mask = crypto.randomBytes(4);
  const out = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i += 1) out[i] = body[i] ^ mask[i % 4];
  return Buffer.concat([Buffer.from([first]), lenBytes, mask, out]);
}

class WsFrameParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames = [];

    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const masked = !!(second & 0x80);
      let len = second & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.buffer.length < offset + 2) break;
        len = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this.buffer.length < offset + 8) break;
        const bigLen = this.buffer.readBigUInt64BE(offset);
        if (bigLen > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame too large');
        len = Number(bigLen);
        offset += 8;
      }

      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.buffer.length < offset + len) break;

      let payload = this.buffer.subarray(offset, offset + len);
      if (masked) {
        const mask = this.buffer.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      } else {
        payload = Buffer.from(payload);
      }

      frames.push({
        fin: !!(first & 0x80),
        opcode: first & 0x0f,
        payload,
      });
      this.buffer = this.buffer.subarray(offset + len);
    }

    return frames;
  }
}

function writeFrame(socket, frame, masked) {
  if (!socket.destroyed) socket.write(encodeFrame(frame, masked));
}

function normalizeInjectedMessages(messages, fallbackOpcode) {
  if (!Array.isArray(messages)) return [];
  return messages.map((message) => {
    if (Buffer.isBuffer(message)) return { opcode: OPCODES.BINARY, payload: message };
    if (message && typeof message === 'object' && 'body' in message) {
      const binary = message.binary === true;
      const payload = binary || Buffer.isBuffer(message.body)
        ? Buffer.from(message.body)
        : Buffer.from(String(message.body));
      return { opcode: binary ? OPCODES.BINARY : OPCODES.TEXT, payload };
    }
    return { opcode: fallbackOpcode, payload: Buffer.from(String(message)) };
  });
}

async function handleMessageFrame({
  frame, direction, req, config, storage, logger, plugins, clientSocket, upstreamSocket,
}) {
  const fromClient = direction === 'client';
  const { path, query } = splitPathQuery(req.url || '/');
  const ctx = {
    config,
    storage,
    logger,
    ws: {
      connectionId: req._nightWorcoonWsId,
      direction,
      url: req.url || '/',
      path,
      query,
      headers: req.headers,
    },
    frame: {
      opcode: frame.opcode,
      binary: frame.opcode === OPCODES.BINARY,
      data: frame.payload,
      text: frame.opcode === OPCODES.TEXT ? frame.payload.toString('utf8') : null,
    },
    drop: false,
    inject: [],
    meta: { source: 'proxy' },
  };

  await runOnWsMessage(plugins, ctx);

  const destination = fromClient ? upstreamSocket : clientSocket;
  const sourcePeer = fromClient ? clientSocket : upstreamSocket;
  const outboundMasked = fromClient;

  if (!ctx.drop) {
    writeFrame(destination, { ...frame, payload: ctx.frame.data }, outboundMasked);
  }

  const injectMasked = !fromClient;
  const injectDestination = fromClient ? clientSocket : upstreamSocket;
  for (const injected of normalizeInjectedMessages(ctx.inject, frame.opcode)) {
    writeFrame(injectDestination, injected, injectMasked);
  }

  logger.trace('ws-message', {
    direction,
    url: req.url,
    bytes: ctx.frame.data.length,
    dropped: !!ctx.drop,
    injected: Array.isArray(ctx.inject) ? ctx.inject.length : 0,
    source: ctx.meta.source || 'proxy',
  });

  if (sourcePeer.destroyed) destination.end();
}

function attachFramePump({
  source, destination, direction, req, config, storage, logger, plugins, clientSocket, upstreamSocket,
}) {
  const parser = new WsFrameParser();
  let queue = Promise.resolve();
  const fromClient = direction === 'client';

  source.on('data', (chunk) => {
    let frames;
    try {
      frames = parser.push(chunk);
    } catch (err) {
      logger.error(`ws frame parse error: ${err.message}`);
      source.destroy();
      destination.destroy();
      return;
    }

    for (const frame of frames) {
      queue = queue.then(async () => {
        if (frame.opcode !== OPCODES.TEXT && frame.opcode !== OPCODES.BINARY) {
          writeFrame(destination, frame, fromClient);
          return;
        }
        await handleMessageFrame({
          frame, direction, req, config, storage, logger, plugins, clientSocket, upstreamSocket,
        });
      }).catch((err) => {
        logger.error(`ws hook error: ${err.stack || err.message}`);
        source.destroy();
        destination.destroy();
      });
    }
  });

  source.on('end', () => destination.end());
  source.on('error', (err) => {
    logger.error(`ws ${direction} socket error: ${err.message}`);
    destination.destroy();
  });
}

export function proxyWebSocketUpgrade({
  req, socket, head, config, storage, logger, plugins,
}) {
  req._nightWorcoonWsId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const target = buildTargetUrl(config, req.url);
  const isSecure = target.protocol === 'wss:';
  const connectOptions = {
    host: target.hostname,
    port: target.port || (isSecure ? 443 : 80),
    servername: target.hostname,
    rejectUnauthorized: config.secure !== false,
  };
  const upstreamSocket = isSecure ? tls.connect(connectOptions) : net.connect(connectOptions);

  upstreamSocket.once(isSecure ? 'secureConnect' : 'connect', () => {
    upstreamSocket.write(buildUpgradeRequest({ config, req, target }));
    if (head && head.length) upstreamSocket.write(head);
  });

  let handshake = Buffer.alloc(0);
  const onHandshakeData = (chunk) => {
    handshake = Buffer.concat([handshake, chunk]);
    const end = handshake.indexOf('\r\n\r\n');
    if (end === -1) return;

    upstreamSocket.off('data', onHandshakeData);
    socket.write(handshake.subarray(0, end + 4));
    const rest = handshake.subarray(end + 4);

    attachFramePump({
      source: socket, destination: upstreamSocket, direction: 'client',
      req, config, storage, logger, plugins, clientSocket: socket, upstreamSocket,
    });
    attachFramePump({
      source: upstreamSocket, destination: socket, direction: 'server',
      req, config, storage, logger, plugins, clientSocket: socket, upstreamSocket,
    });
    if (rest.length) upstreamSocket.emit('data', rest);
  };

  upstreamSocket.on('data', onHandshakeData);
  upstreamSocket.once('error', (err) => {
    logger.error(`ws proxy error: ${err.message}`);
    socket.destroy();
  });
  socket.once('error', (err) => {
    logger.error(`ws client socket error: ${err.message}`);
    upstreamSocket.destroy();
  });
}
