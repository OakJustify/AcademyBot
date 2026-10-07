'use strict';

/**
 * BotManager.js
 * ---------------------------------------------------------------------------
 * Owns the fleet. Reads the bot list from configuration, spins up one
 * BotInstance per entry, and aggregates their status for the HTTP endpoint.
 *
 * This is the only place that needs to change when you scale: adding a 7th,
 * 10th or 100th bot is a config.json edit — index.js never changes.
 */

const { BotInstance, State } = require('./BotInstance');
const { createLogger } = require('./logger');
const utils = require('./utils');

class BotManager {
  /** @param {object} settings Output of src/settings.js#loadSettings */
  constructor(settings) {
    this.settings = settings;
    this.log = createLogger('manager');
    /** @type {Map<string, BotInstance>} */
    this.instances = new Map();
    this.startedAt = Date.now();
    this._supervision = [];
  }

  /**
   * Create and launch every configured bot instance.
   * Returns once all instances have been launched (they run concurrently).
   */
  async startAll() {
    for (const config of this.settings.bots) {
      const instance = new BotInstance(config, {
        onStateChange: (name, state) => this._onStateChange(name, state),
      });
      this.instances.set(config.name, instance);
    }

    this._warnAboutDuplicateTokens();

    const stagger = this.settings.startupStaggerMs;
    if (stagger > 0 && this.instances.size > 1) {
      this.log.info(`Launching ${this.instances.size} instances with ${stagger}ms stagger...`);
    } else {
      this.log.info(`Launching ${this.instances.size} instance(s)...`);
    }

    for (const instance of this.instances.values()) {
      // Fire and forget: each instance supervises itself forever.
      this._supervision.push(
        instance.start().catch((error) => {
          // BotInstance.start() is designed not to reject, but never let one
          // instance's failure take down the fleet.
          this.log.error(`Instance "${instance.config.name}" supervisor crashed: ${utils.describeError(error)}`);
        }),
      );
      if (stagger > 0) await utils.sleep(stagger);
    }

    return this.instances;
  }

  /**
   * Two entries sharing one token will constantly kick each other off Discord.
   * Catch this before it turns into a mystery reconnect loop.
   */
  _warnAboutDuplicateTokens() {
    const byToken = new Map();
    for (const instance of this.instances.values()) {
      const token = instance.config.token;
      if (!token) continue;
      if (!byToken.has(token)) byToken.set(token, []);
      byToken.get(token).push(instance.config.name);
    }

    for (const [token, names] of byToken) {
      if (names.length > 1) {
        this.log.warn(
          `Duplicate token ${utils.maskToken(token)} used by: ${names.join(', ')}. ` +
            'Discord allows only one session per token — give each bot its own token.',
        );
      }
    }
  }

  _onStateChange(name, state) {
    if (state === State.ONLINE) {
      this.log.info(`✓ ${name} is online and in its voice channel.`);
    }
  }

  /** Aggregate fleet status. */
  getStatus() {
    const bots = [...this.instances.values()].map((instance) => instance.getStatus());
    const online = bots.filter((bot) => bot.state === State.ONLINE).length;
    const inVoice = bots.filter((bot) => bot.in_voice).length;

    return {
      ok: bots.length > 0 && inVoice === bots.length,
      uptime_ms: Date.now() - this.startedAt,
      uptime: utils.formatDuration(Date.now() - this.startedAt),
      total: bots.length,
      online,
      in_voice: inVoice,
      reconnecting: bots.filter((bot) => bot.state === State.RECONNECTING || bot.state === State.LOGGING_IN).length,
      joining: bots.filter((bot) => bot.state === State.JOINING).length,
      stopped: bots.filter((bot) => bot.state === State.STOPPED).length,
      reconnects_total: bots.reduce((sum, bot) => sum + bot.reconnects, 0),
      bots,
    };
  }

  /** Stop every instance, in parallel, with a hard timeout. */
  async shutdown(timeoutMs = 10_000) {
    if (this.instances.size === 0) return;

    this.log.info(`Shutting down ${this.instances.size} instance(s)...`);
    const timeout = utils.sleep(timeoutMs).then(() => {
      this.log.warn('Shutdown timeout reached — forcing exit.');
    });

    await Promise.race([
      Promise.allSettled([...this.instances.values()].map((instance) => instance.stop())),
      timeout,
    ]);
  }
}

module.exports = { BotManager };