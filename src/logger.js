import { EventEmitter } from 'node:events';

export class Logger extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }

  _emit(level, msg, extra) {
    const entry = {
      ts: new Date(),
      level,
      msg,
      ...(extra ? { extra } : {}),
    };
    this.emit('log', entry);
  }

  info(msg, extra) { this._emit('info', msg, extra); }
  warn(msg, extra) { this._emit('warn', msg, extra); }
  error(msg, extra) { this._emit('error', msg, extra); }
  debug(msg, extra) { this._emit('debug', msg, extra); }
  trace(kind, data) { this.emit('trace', { ts: new Date(), kind, data }); }
}

export const logger = new Logger();
