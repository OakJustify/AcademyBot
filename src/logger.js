'use strict';

/**
 * logger.js
 * ---------------------------------------------------------------------------
 * Structured, dependency-free logger with:
 *   - Timestamped console output
 *   - Per-bot scoping so multi-bot output stays readable
 *   - Colored output when the terminal supports it
 *   - Optional JSON mode for cloud log aggregators (Render, Railway, Fly, ...)
 *
 * Levels: debug (10) < info (20) < warn (30) < error (40) < silent (100)
 */

const { describeError } = require('./utils');

const LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
});

const ANSI = Object.freeze({
  reset: '\u001B[0m',
  bold: '\u001B[1m',
  dim: '\u001B[2m',
  red: '\u001B[31m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  blue: '\u001B[34m',
  magenta: '\u001B[35m',
  cyan: '\u001B[36m',
  gray: '\u001B[90m',
});

/** Detect whether ANSI colors should be emitted. */
function detectColor() {
  if (process.env.FORCE_COLOR !== undefined) return process.env.FORCE_COLOR !== '0' && process.env.FORCE_COLOR !== 'false';
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.NODE_ENV === 'production') return false;
  return Boolean(process.stdout && process.stdout.isTTY);
}

const state = {
  level: LEVELS.info,
  json: false,
  color: detectColor(),
};

/** Two-digit pad. */
const pad = (n, len = 2) => String(n).padStart(len, '0');

/** `YYYY-MM-DD HH:MM:SS.mmm` in local time. */
function timestamp() {
  const d = new Date();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

function paint(text, colorCode) {
  return state.color ? `${colorCode}${text}${ANSI.reset}` : text;
}

function write(levelName, scope, message, meta) {
  const levelValue = LEVELS[levelName];
  if (levelValue < state.level) return;

  if (state.json) {
    const payload = {
      ts: new Date().toISOString(),
      level: levelName.toUpperCase(),
      scope: scope || 'app',
      msg: typeof message === 'string' ? message : describeError(message),
      ...(meta && typeof meta === 'object' ? meta : {}),
    };
    if (message instanceof Error) payload.err = describeError(message);
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  const levelTag = {
    debug: paint('DEBUG', ANSI.gray),
    info: paint('INFO ', ANSI.green),
    warn: paint('WARN ', ANSI.yellow),
    error: paint('ERROR', ANSI.red),
  }[levelName];

  const scopeTag = scope ? paint(`[${scope}]`, ANSI.cyan) : '';
  const text = message instanceof Error ? describeError(message) : message;
  const metaText = meta && Object.keys(meta).length > 0 ? ` ${paint(JSON.stringify(meta), ANSI.gray)}` : '';

  process.stdout.write(
    `${paint(timestamp(), ANSI.gray)} ${levelTag} ${scopeTag} ${text}${metaText}\n`,
  );
}

/**
 * Create a logger scoped to a component (e.g. a bot name).
 * @param {string} [scope]
 */
function createLogger(scope) {
  return {
    scope: scope || 'app',
    debug: (message, meta) => write('debug', scope, message, meta),
    info: (message, meta) => write('info', scope, message, meta),
    warn: (message, meta) => write('warn', scope, message, meta),
    error: (message, meta) => write('error', scope, message, meta),
    /** Derive a sub-logger, e.g. log.child('voice'). */
    child: (sub) => createLogger(scope ? `${scope}:${sub}` : sub),
  };
}

module.exports = {
  logger: createLogger('app'),
  createLogger,
  describeError,
  LEVELS,
  configure({ level, json } = {}) {
    if (level && Object.hasOwn(LEVELS, level)) state.level = LEVELS[level];
    if (json !== undefined) state.json = Boolean(json);
    if (process.env.FORCE_COLOR !== undefined) state.color = process.env.FORCE_COLOR !== '0';
  },
  getState: () => ({ level: state.level, json: state.json, color: state.color }),
};