'use strict';

/**
 * settings.js
 * ---------------------------------------------------------------------------
 * Loads and validates every runtime setting.
 *
 * Precedence (highest first):
 *   1. Process environment variables
 *   2. `settings` block inside config.json
 *   3. Hard-coded defaults in this file
 *
 * Bot instances are read from config.json. Both shapes are supported:
 *
 *   { "bots": [ { "name": "...", "token": "...", "vc_id": "..." } ] }
 *
 * and the flat form:
 *
 *   [ { "name": "...", "token": "...", "vc_id": "..." } ]
 */

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { ActivityType, Status } = require('discord.js');

const {
  interpolateEnv,
  isSnowflake,
  stripQuotes,
  toBoolean,
  toInteger,
  toFloat,
  getApplicationIdFromToken,
} = require('./utils');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_FILE = path.join(ROOT_DIR, 'config.json');

const DEFAULT_RECONNECT = Object.freeze({
  maxAttempts: 0, // 0 = retry forever
  initialDelay: 2_000,
  maxDelay: 60_000,
  factor: 1.8,
  jitter: 0.3,
});

const DEFAULT_WATCHDOG = Object.freeze({
  enabled: true,
  intervalMs: 30_000,
  // Grace period given to @discordjs/voice to self-heal before we force a rejoin.
  voiceRecoveryGraceMs: 20_000,
  voiceJoinTimeoutMs: 25_000,
});

const VALID_STATUSES = new Set(Object.values(Status).filter((value) => typeof value === 'string'));

/** Load `.env` (optional — never fails if missing). */
function loadDotEnv() {
  const envPath = process.env.DOTENV_CONFIG_PATH
    ? path.resolve(ROOT_DIR, process.env.DOTENV_CONFIG_PATH)
    : path.join(ROOT_DIR, '.env');

  if (fs.existsSync(envPath)) {
    // `quiet` suppresses dotenv's "[dotenv@x] injecting env" banner.
    dotenv.config({ path: envPath, quiet: true });
    return envPath;
  }
  return null;
}

/** Read + parse config.json, with clear errors when malformed. */
function readConfigFile(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Config file not found: ${configPath}\n` +
        'Copy config.example.json -> config.json (or set CONFIG_FILE to a custom path).',
    );
  }

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read config file ${configPath}: ${error.message}`);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${configPath}: ${error.message}`);
  }
}

/** Pull the bot array out of either supported config shape. */
function extractBotArray(config) {
  if (Array.isArray(config)) return config;
  if (config && Array.isArray(config.bots)) return config.bots;
  if (config && Array.isArray(config.instances)) return config.instances;
  if (config && Array.isArray(config.afk_bots)) return config.afk_bots;
  return null;
}

/** Normalize `status` + `activities` into a discord.js ClientOptions.presence object. */
function normalizePresence(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const status = typeof raw.status === 'string' ? raw.status.trim().toLowerCase() : 'online';
  const activities = Array.isArray(raw.activities) ? raw.activities : [];

  const mapped = activities
    .map((activity) => {
      if (!activity || typeof activity !== 'object') return null;
      const name = String(activity.name ?? '').trim();
      if (!name) return null;

      let type = ActivityType.Playing;
      if (typeof activity.type === 'number' && Number.isInteger(activity.type)) {
        type = activity.type;
      } else if (typeof activity.type === 'string') {
        const key = activity.type.trim().toLowerCase();
        const found = Object.entries(ActivityType).find(
          ([nameKey, value]) => nameKey.toLowerCase() === key && typeof value === 'number',
        );
        if (found) type = found[1];
      }
      return { name, type };
    })
    .filter(Boolean);

  return {
    status: VALID_STATUSES.has(status) ? status : 'online',
    activities: mapped,
  };
}

/**
 * Validate + normalize one bot entry.
 * Problems are pushed into `errors` instead of throwing, so the user sees
 * every issue at once instead of fixing them one-by-one.
 */
function normalizeBotEntry(raw, index, defaults, errors, warnings = [], { requireTokens = true } = {}) {
  const position = `#${index + 1}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${position}: entry must be a JSON object like { "name", "token", "vc_id" }.`);
    return null;
  }

  const name = String(raw.name ?? raw.id ?? '').trim() || `bot-${index + 1}`;

  // --- token resolution -----------------------------------------------------
  let token = '';
  let tokenMissing = false;
  const tokenEnvKey = raw.token_env ?? raw.tokenEnv ?? null;
  if (tokenEnvKey) {
    const key = String(tokenEnvKey).trim();
    token = stripQuotes(process.env[key] ?? '');
    if (!token) {
      tokenMissing = true;
      (requireTokens ? errors : warnings).push(
        `${position} ("${name}"): token_env "${key}" is not set or is empty in your environment.`,
      );
    }
  } else if (raw.token !== undefined && raw.token !== null) {
    // Supports plain tokens and "${MY_BOT_TOKEN}" placeholders.
    token = stripQuotes(interpolateEnv(String(raw.token)));
    if (!token) {
      tokenMissing = true;
      (requireTokens ? errors : warnings).push(
        `${position} ("${name}"): token is empty. Provide "token" or "token_env", and fill the value in your .env file.`,
      );
    }
  } else {
    tokenMissing = true;
    (requireTokens ? errors : warnings).push(`${position} ("${name}"): missing "token" (or "token_env").`);
  }

  // --- voice channel --------------------------------------------------------
  const vcRaw = raw.vc_id ?? raw.vcId ?? raw.channel_id ?? raw.channelId;
  const vcId = vcRaw === undefined || vcRaw === null ? '' : String(vcRaw).trim();
  if (!vcId) {
    errors.push(`${position} ("${name}"): missing "vc_id" (the target voice channel ID).`);
  } else if (!isSnowflake(vcId)) {
    errors.push(`${position} ("${name}"): "vc_id" must be a Discord snowflake ID (digits only), got "${vcId}".`);
  }

  const guildRaw = raw.guild_id ?? raw.guildId ?? null;
  const guildId = guildRaw === undefined || guildRaw === null || guildRaw === '' ? null : String(guildRaw).trim();
  if (guildId && !isSnowflake(guildId)) {
    errors.push(`${position} ("${name}"): "guild_id" must be a Discord snowflake ID, got "${guildId}".`);
  }

  // --- optional per-bot overrides ------------------------------------------
  const selfMute = toBoolean(raw.selfMute ?? raw.self_mute, defaults.selfMute);
  const selfDeaf = toBoolean(raw.selfDeaf ?? raw.self_deaf, defaults.selfDeaf);
  const daveEncryption = toBoolean(raw.daveEncryption ?? raw.dave_encryption, defaults.daveEncryption);
  const enabled = toBoolean(raw.enabled, true);
  const limitCache = toBoolean(raw.limitCache ?? raw.limit_cache, defaults.limitCache);

  const reconnectSource = raw.reconnect && typeof raw.reconnect === 'object' ? raw.reconnect : {};
  const reconnect = {
    maxAttempts: toInteger(reconnectSource.maxAttempts ?? reconnectSource.max_attempts, defaults.reconnect.maxAttempts, {
      min: 0,
      max: 10_000,
    }),
    initialDelay: toInteger(
      reconnectSource.initialDelay ?? reconnectSource.initial_delay,
      defaults.reconnect.initialDelay,
      { min: 100, max: 300_000 },
    ),
    maxDelay: toInteger(reconnectSource.maxDelay ?? reconnectSource.max_delay, defaults.reconnect.maxDelay, {
      min: 1_000,
      max: 3_600_000,
    }),
    factor: toFloat(reconnectSource.factor, defaults.reconnect.factor, { min: 1, max: 5 }),
    jitter: toFloat(reconnectSource.jitter, defaults.reconnect.jitter, { min: 0, max: 1 }),
  };

  const watchdogSource = raw.watchdog && typeof raw.watchdog === 'object' ? raw.watchdog : {};
  const watchdog = {
    enabled: toBoolean(watchdogSource.enabled, defaults.watchdog.enabled),
    intervalMs: toInteger(watchdogSource.intervalMs ?? watchdogSource.interval_ms, defaults.watchdog.intervalMs, {
      min: 5_000,
      max: 3_600_000,
    }),
    voiceRecoveryGraceMs: toInteger(
      watchdogSource.voiceRecoveryGraceMs ?? watchdogSource.voice_recovery_grace_ms,
      defaults.watchdog.voiceRecoveryGraceMs,
      { min: 1_000, max: 300_000 },
    ),
    voiceJoinTimeoutMs: toInteger(
      watchdogSource.voiceJoinTimeoutMs ?? watchdogSource.voice_join_timeout_ms,
      defaults.watchdog.voiceJoinTimeoutMs,
      { min: 2_000, max: 300_000 },
    ),
  };

  const presence = normalizePresence(raw.presence ?? defaults.presence);

  if (tokenMissing && requireTokens) return null;

  return {
    index,
    key: `bot-${index + 1}`,
    name,
    token,
    applicationId: getApplicationIdFromToken(token),
    vcId,
    guildId: guildId || null,
    selfMute,
    selfDeaf,
    daveEncryption,
    enabled,
    limitCache,
    reconnect,
    watchdog,
    presence,
  };
}

/**
 * Build the complete, validated settings object.
 * @param {{ configPath?: string, requireTokens?: boolean }} [options]
 *   `requireTokens: false` collects missing tokens as warnings instead of
 *   fatal errors — used by `npm run doctor`.
 */
function loadSettings({ configPath, requireTokens = true } = {}) {
  const resolvedConfigPath = path.resolve(ROOT_DIR, configPath || process.env.CONFIG_FILE || DEFAULT_CONFIG_FILE);
  const config = readConfigFile(resolvedConfigPath);
  const globalSettings = config && typeof config === 'object' && !Array.isArray(config) ? config.settings ?? {} : {};

  // --- global defaults ------------------------------------------------------
  const defaults = {
    selfMute: toBoolean(process.env.SELF_MUTE ?? globalSettings.selfMute ?? globalSettings.self_mute, true),
    selfDeaf: toBoolean(process.env.SELF_DEAF ?? globalSettings.selfDeaf ?? globalSettings.self_deaf, true),
    daveEncryption: toBoolean(
      process.env.DAVE_ENCRYPTION ?? globalSettings.daveEncryption ?? globalSettings.dave_encryption,
      true,
    ),
    limitCache: toBoolean(process.env.LIMIT_CACHE ?? globalSettings.limitCache ?? globalSettings.limit_cache, false),
    reconnect: {
      maxAttempts: toInteger(
        process.env.RECONNECT_MAX_ATTEMPTS ?? globalSettings.reconnect?.maxAttempts,
        DEFAULT_RECONNECT.maxAttempts,
        { min: 0, max: 10_000 },
      ),
      initialDelay: toInteger(
        process.env.RECONNECT_INITIAL_DELAY_MS ?? globalSettings.reconnect?.initialDelay,
        DEFAULT_RECONNECT.initialDelay,
        { min: 100, max: 300_000 },
      ),
      maxDelay: toInteger(
        process.env.RECONNECT_MAX_DELAY_MS ?? globalSettings.reconnect?.maxDelay,
        DEFAULT_RECONNECT.maxDelay,
        { min: 1_000, max: 3_600_000 },
      ),
      factor: toFloat(process.env.RECONNECT_FACTOR ?? globalSettings.reconnect?.factor, DEFAULT_RECONNECT.factor, {
        min: 1,
        max: 5,
      }),
      jitter: toFloat(process.env.RECONNECT_JITTER ?? globalSettings.reconnect?.jitter, DEFAULT_RECONNECT.jitter, {
        min: 0,
        max: 1,
      }),
    },
    watchdog: {
      enabled: toBoolean(process.env.WATCHDOG_ENABLED ?? globalSettings.watchdog?.enabled, DEFAULT_WATCHDOG.enabled),
      intervalMs: toInteger(
        process.env.WATCHDOG_INTERVAL_MS ?? globalSettings.watchdog?.intervalMs,
        DEFAULT_WATCHDOG.intervalMs,
        { min: 5_000, max: 3_600_000 },
      ),
      voiceRecoveryGraceMs: toInteger(
        process.env.VOICE_RECOVERY_GRACE_MS ?? globalSettings.watchdog?.voiceRecoveryGraceMs,
        DEFAULT_WATCHDOG.voiceRecoveryGraceMs,
        { min: 1_000, max: 300_000 },
      ),
      voiceJoinTimeoutMs: toInteger(
        process.env.VOICE_JOIN_TIMEOUT_MS ?? globalSettings.watchdog?.voiceJoinTimeoutMs,
        DEFAULT_WATCHDOG.voiceJoinTimeoutMs,
        { min: 2_000, max: 300_000 },
      ),
    },
    presence: normalizePresence(globalSettings.presence ?? null),
  };

  // --- bots -----------------------------------------------------------------
  const rawBots = extractBotArray(config);
  if (!rawBots) {
    throw new Error(
      `No bot list found in ${resolvedConfigPath}.\n` +
        'Expected a "bots" array, e.g. { "bots": [{ "name": "AFK Bot 1", "token": "...", "vc_id": "..." }] }',
    );
  }

  const errors = [];
  const warnings = [];
  const normalized = rawBots
    .map((entry, index) => normalizeBotEntry(entry, index, defaults, errors, warnings, { requireTokens }))
    .filter(Boolean);

  const seen = new Map();
  for (const bot of normalized) {
    const key = bot.name.toLowerCase();
    if (seen.has(key)) {
      errors.push(`Duplicate bot name "${bot.name}" (entries #${seen.get(key) + 1} and #${bot.index + 1}). Names must be unique.`);
    } else {
      seen.set(key, bot.index);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid configuration in ${resolvedConfigPath}:\n  - ${errors.join('\n  - ')}`);
  }

  const enabledBots = normalized.filter((bot) => bot.enabled);

  const settings = {
    rootDir: ROOT_DIR,
    configPath: resolvedConfigPath,
    port: toInteger(process.env.PORT ?? globalSettings.port ?? 8080, 8080, { min: 1, max: 65_535 }),
    host: String(process.env.HOST ?? globalSettings.host ?? '0.0.0.0'),
    enableInviteEndpoint: toBoolean(
      process.env.ENABLE_INVITE_ENDPOINT ?? globalSettings.enableInviteEndpoint,
      true,
    ),
    // The keep-alive/status server costs ~21 MB of RSS because of Express. It
    // only exists to satisfy HTTP health checkers (Render, Fly, Koyeb, ...).
    // Hosts that track bot uptime over the gateway instead — DisCloud, pm2,
    // systemd — don't need it, so it can be switched off entirely.
    httpEnabled: toBoolean(
      process.env.HTTP_ENABLED ?? globalSettings.httpEnabled ?? globalSettings.http_enabled,
      true,
    ),
    startupStaggerMs: toInteger(
      process.env.STARTUP_STAGGER_MS ?? globalSettings.startupStaggerMs,
      1_500,
      { min: 0, max: 60_000 },
    ),
    selfMute: defaults.selfMute,
    selfDeaf: defaults.selfDeaf,
    daveEncryption: defaults.daveEncryption,
    limitCache: defaults.limitCache,
    reconnect: defaults.reconnect,
    watchdog: defaults.watchdog,
    presence: defaults.presence,
    bots: enabledBots,
    disabledBots: normalized.filter((bot) => !bot.enabled),
    warnings,
  };

  if (settings.bots.length === 0) {
    throw new Error(
      `No enabled bots found in ${resolvedConfigPath}. Add at least one entry with "enabled": true (or remove the flag).`,
    );
  }

  return settings;
}

module.exports = { loadSettings, loadDotEnv, ROOT_DIR, DEFAULT_CONFIG_FILE };