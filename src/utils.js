'use strict';

/**
 * utils.js
 * ---------------------------------------------------------------------------
 * Small, dependency-free helpers shared across the project.
 */

/** Extract a short, safe label from an Error for logging. */
function describeError(error) {
  if (error === null || error === undefined) return 'Unknown error';
  if (typeof error === 'string') return error;

  const name = error.name || 'Error';
  let message = error.message || String(error);

  // Trim, then cap the length. Newlines are preserved (up to a point) so that
  // multi-line validation reports stay readable; only runaway whitespace is
  // collapsed and overlong payloads are truncated.
  message = message.trim();
  if (message.length > 800) message = `${message.slice(0, 800)}...`;
  message = message.replace(/[ \t]{2,}/g, '  ');

  const code = error.code ? ` [code=${error.code}]` : '';
  const status = error.status ? ` [status=${error.status}]` : '';
  const httpStatus = error.httpStatus ? ` [http=${error.httpStatus}]` : '';

  return `${name}${code}${status}${httpStatus}: ${message}`;
}

/**
 * Promise-based sleep. Can be aborted early via an AbortSignal.
 *
 * The timer intentionally keeps the event loop alive (`unref: false`) so that a
 * backoff wait between reconnect attempts never lets the process exit early.
 * Pass `unref: true` only for "fire and forget" waits that must not hold
 * the process open.
 *
 * @param {number} ms
 * @param {{ signal?: AbortSignal, unref?: boolean }} [options]
 * @returns {Promise<void>}
 */
function sleep(ms, { signal, unref = false } = {}) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal) {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (unref) timer.unref?.();
  });
}

/**
 * Exponential backoff with full jitter.
 * @param {number} attempt 1-based attempt counter
 * @param {{ initialDelay: number, maxDelay: number, factor: number, jitter: number }} cfg
 * @returns {number} delay in milliseconds
 */
function computeBackoffDelay(attempt, cfg) {
  const { initialDelay = 2000, maxDelay = 60_000, factor = 1.8, jitter = 0.3 } = cfg ?? {};
  const safeAttempt = Math.max(1, attempt);
  const exponential = initialDelay * factor ** (safeAttempt - 1);
  const capped = Math.min(maxDelay, exponential);
  if (jitter <= 0) return Math.round(capped);

  const spread = capped * jitter;
  const min = Math.max(0, capped - spread);
  return Math.round(min + Math.random() * (capped - min));
}

/**
 * Mask a Discord token so it can safely appear in logs.
 * Keeps a short prefix/suffix only.
 * @param {string|null|undefined} token
 */
function maskToken(token) {
  if (!token || typeof token !== 'string') return '(none)';
  if (token.length <= 12) return '***';
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

/**
 * Extract the application (bot user) ID from a Discord bot token.
 * The first JWT-like segment base64url-decodes to the application ID.
 * This lets us build OAuth2 invite URLs without hardcoding client IDs.
 * @param {string} token
 * @returns {string|null}
 */
function getApplicationIdFromToken(token) {
  if (!token || typeof token !== 'string') return null;
  const segment = token.split('.')[0];
  if (!segment) return null;
  try {
    const decoded = Buffer.from(segment, 'base64url').toString('utf8');
    return /^\d{15,25}$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** Loose snowflake validation (Discord IDs are 17-20 digits nowadays). */
function isSnowflake(value) {
  return typeof value === 'string' && /^\d{17,20}$/.test(value.trim());
}

/** Strip surrounding quotes so tokens pasted with quotes still work. */
function stripQuotes(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Replace `${VAR}` placeholders with environment variable values.
 * Unknown placeholders resolve to an empty string so validation can report them.
 * @param {string} value
 * @param {NodeJS.ProcessEnv} env
 */
function interpolateEnv(value, env = process.env) {
  if (typeof value !== 'string' || !value.includes('${')) return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, key) => {
    const replacement = env[key];
    return replacement === undefined ? '' : replacement;
  });
}

/**
 * Parse flexible truthy strings from environment variables.
 * Accepts: true/1/yes/on/enabled -> true; false/0/no/off/disabled -> false.
 */
function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on', 'enable', 'enabled'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off', 'disable', 'disabled'].includes(normalized)) return false;
  return fallback;
}

/** Parse an integer with bounds, falling back on garbage input. */
function toInteger(value, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value).trim(), 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Parse a float (0..1) with clamping. */
function toFloat(value, fallback, { min = 0, max = 1 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseFloat(String(value).trim());
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Human-friendly uptime, e.g. `3d 4h 12m 30s`. */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (days || hours) parts.push(`${hours}h`);
  if (days || hours || minutes) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

/**
 * Minimal deferred (externally resolvable promise).
 * `settled` guards against double-resolution, which matters for the reconnect
 * signal because several listeners can fire for the same failure.
 */
function createDeferred() {
  const box = {
    settled: false,
    resolve(value) {
      if (box.settled) return false;
      box.settled = true;
      box._resolve(value);
      return true;
    },
    reject(reason) {
      if (box.settled) return false;
      box.settled = true;
      box._reject(reason);
      return true;
    },
  };
  box.promise = new Promise((res, rej) => {
    box._resolve = res;
    box._reject = rej;
  });
  return box;
}

/**
 * Classify a login/network error so we can log actionable guidance.
 * @param {any} error
 * @returns {{ kind: string, retryable: boolean, hint: string }}
 */
function classifyError(error) {
  const code = error?.code;
  const message = String(error?.message ?? '');
  const status = error?.status ?? error?.httpStatus;

  if (code === 'TokenInvalid' || /invalid token/i.test(message)) {
    return {
      kind: 'invalid_token',
      retryable: true,
      hint: 'Token is malformed or revoked. Check the token in config.json / .env and regenerate it in the Discord Developer Portal if needed.',
    };
  }
  if (code === 'DisallowedIntents' || /disallowed intents|privileged intent/i.test(message)) {
    return {
      kind: 'disallowed_intents',
      retryable: true,
      hint: 'Only non-privileged intents (Guilds + GuildVoiceStates) are used. If this appears, check the bot is still in the server and re-invite it.',
    };
  }
  if (status === 401 || code === 0x8001) {
    return { kind: 'unauthorized', retryable: true, hint: 'Discord rejected the credentials (401 Unauthorized).' };
  }
  if (status === 403) {
    return { kind: 'forbidden', retryable: true, hint: 'The bot lacks access to this guild. Invite it again with the Connect permission.' };
  }
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN') {
    return { kind: 'network', retryable: true, hint: 'Network hiccup while reaching Discord. Will retry automatically.' };
  }
  if (/websocket|ECONN|ENOTFOUND|EHOSTUNREACH|EPIPE/i.test(message)) {
    return { kind: 'gateway_network', retryable: true, hint: 'Gateway socket dropped. Will retry automatically.' };
  }
  if (error?.name === 'RangeError' || /Maximum number of guilds/i.test(message)) {
    return { kind: 'rate_limited', retryable: true, hint: 'Rate limited or too many guilds. Will retry with backoff.' };
  }
  if (error?.name === 'AbortError' || /timeout|timed out/i.test(message)) {
    return { kind: 'timeout', retryable: true, hint: 'Operation timed out. Will retry automatically.' };
  }
  return { kind: 'unknown', retryable: true, hint: 'Retrying with exponential backoff.' };
}

module.exports = {
  sleep,
  describeError,
  computeBackoffDelay,
  maskToken,
  getApplicationIdFromToken,
  isSnowflake,
  stripQuotes,
  interpolateEnv,
  toBoolean,
  toInteger,
  toFloat,
  formatDuration,
  createDeferred,
  classifyError,
};