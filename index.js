#!/usr/bin/env node
'use strict';

/**
 * index.js — Multi-Bot 24/7 Voice Channel Stay
 * ===========================================================================
 * Boots every bot instance declared in config.json inside a single Node.js
 * process, keeps each of them parked in its target voice channel, and exposes a
 * tiny HTTP server so free-tier hosts never suspend the container.
 *
 * Scaling is a config.json edit — this file never needs to change.
 *
 *   config.json  ->  [ { name, token, vc_id }, ... ]   (add as many as you like)
 */

const path = require('node:path');

const { createLogger, configure } = require('./src/logger');
const { loadDotEnv, loadSettings } = require('./src/settings');
const { BotManager } = require('./src/BotManager');
const utils = require('./src/utils');

const SHUTDOWN_TIMEOUT_MS = 15_000;

/** Never let a stray rejection or exception kill the whole fleet. */
function installGlobalGuards(log) {
  process.on('unhandledRejection', (reason) => {
    log.error(`Unhandled promise rejection (ignored on purpose): ${utils.describeError(reason)}`);
    if (reason instanceof Error && reason.stack) log.debug(reason.stack);
  });

  process.on('uncaughtException', (error) => {
    // A single bot's failure must not take down the other instances, so we log
    // and keep going. The supervision loops will recover the affected bot.
    log.error(`Uncaught exception (ignored on purpose): ${utils.describeError(error)}`);
    if (error?.stack) log.debug(error.stack);
  });
}

function printBanner(settings, log) {
  const line = '─'.repeat(72);
  log.info('');
  log.info('════════════════════════════════════════════════════════════════════════');
  log.info('  MULTI-BOT 24/7 VOICE CHANNEL STAY');
  log.info(`  ${settings.bots.length} bot instance(s) • Node ${process.version} • ${process.platform}`);
  log.info(line);

  for (const bot of settings.bots) {
    const appId = bot.applicationId ? bot.applicationId.padEnd(19) : 'unknown-app-id'.padEnd(19);
    const muted = `${bot.selfMute ? 'muted' : 'unmuted'}/${bot.selfDeaf ? 'deafened' : 'not-deafened'}`;
    log.info(`  #${String(bot.index + 1).padStart(2)}  ${bot.name}`);
    log.info(`      vc_id      : ${bot.vcId}`);
    log.info(`      guild_id   : ${bot.guildId ?? '(auto-resolved)'}`);
    log.info(`      app id     : ${appId}`);
    log.info(`      voice      : ${muted}${bot.daveEncryption ? ' • DAVE E2EE on' : ''}`);
  }

  if (settings.disabledBots.length > 0) {
    log.info(line);
    log.info(`  Skipped (enabled: false): ${settings.disabledBots.map((b) => b.name).join(', ')}`);
  }

  log.info(line);
  log.info(`  Config : ${path.relative(process.cwd(), settings.configPath) || settings.configPath}`);
  if (settings.httpEnabled) {
    log.info(`  Health : http://${settings.host}:${settings.port}/health`);
    log.info(`  Invite : http://${settings.host}:${settings.port}/invite`);
  } else {
    log.info('  Health : disabled (HTTP_ENABLED=false) — uptime dipantau via log');
  }
  log.info('════════════════════════════════════════════════════════════════════════');
  log.info('');
}

async function main() {
  process.title = 'discord-afk-multi-bot';

  // 1) Environment variables (optional .env file).
  const envPath = loadDotEnv();

  // 2) Logging.
  const logFormat = String(process.env.LOG_FORMAT || 'pretty').toLowerCase();
  configure({
    level: String(process.env.LOG_LEVEL || 'info').toLowerCase(),
    json: logFormat === 'json',
  });
  const log = createLogger('main');
  installGlobalGuards(log);

  // 3) Configuration (config.json + env, fully validated).
  const settings = loadSettings();
  if (envPath) log.debug(`Loaded environment from ${envPath}`);

  // 4) HTTP keep-alive server FIRST, so platform health checks succeed
  //    immediately — even while the bots are still logging in.
  //    Skipped entirely when HTTP_ENABLED=false: Express alone costs ~21 MB of
  //    RSS, which is decisive on hosts with a tight memory cap.
  const manager = new BotManager(settings);
  let httpService = null;

  if (settings.httpEnabled) {
    // Required lazily so Express is never loaded (and never occupies memory)
    // when the HTTP server is disabled.
    const { createHttpServer } = require('./src/httpServer');
    httpService = createHttpServer(settings, manager);
    await httpService.listen(settings.port, settings.host);
  }

  // 5) Operator overview.
  printBanner(settings, log);

  // 6) Launch the fleet (each instance supervises itself from here on).
  await manager.startAll();

  // 7) Graceful shutdown.
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received — shutting down gracefully...`);

    const forceExit = setTimeout(() => {
      log.error(`Shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit.`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    await Promise.allSettled([manager.shutdown(10_000), httpService ? httpService.close() : Promise.resolve()]);
    clearTimeout(forceExit);

    log.info('All bots left their voice channels. Goodbye.');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGHUP', () => void shutdown('SIGHUP'));

  // 8) Periodic fleet summary so long-running deployments are observable.
  const summaryIntervalMs = utils.toInteger(process.env.SUMMARY_INTERVAL_MS, 0, { min: 0, max: 86_400_000 });
  if (summaryIntervalMs > 0) {
    const timer = setInterval(() => {
      const status = manager.getStatus();
      log.info(
        `Fleet summary • ${status.in_voice}/${status.total} in voice • online=${status.online} • ` +
          `retrying=${status.reconnecting} • reconnects=${status.reconnects_total} • up=${status.uptime}`,
      );
    }, summaryIntervalMs);
    timer.unref();
  }
}

main().catch((error) => {
  // Startup failures (bad config, port in use, ...) are fatal and must exit
  // non-zero so the platform restarts / surfaces the problem.
  const log = createLogger('main');
  log.error(`Fatal startup error: ${utils.describeError(error)}`);
  // Only the stack for errors that aren't already self-explanatory
  // (config validation errors print their own detailed, readable list).
  if (error?.stack && !/^Invalid configuration in /.test(error.message ?? '')) {
    console.error(error.stack);
  }
  process.exit(1);
});