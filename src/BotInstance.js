'use strict';

/**
 * BotInstance.js
 * ---------------------------------------------------------------------------
 * One instance = one Discord bot account that keeps a voice connection alive
 * in a target channel, forever, retrying until it succeeds.
 *
 * Design notes:
 *  - `start()` never rejects. It runs a supervision loop so a broken instance
 *    cannot take down the other bots in the process.
 *  - Failure detection has three independent layers:
 *      1. Discord.js events (voice connection state, gateway shard events)
 *      2. A watchdog timer that verifies "am I actually in the VC right now?"
 *      3. The supervisor's own error handling around login/join
 *  - Reconnects use exponential backoff with jitter, configurable per bot.
 */

const { Client, Events, GatewayIntentBits, Options } = require('discord.js');
const {
  joinVoiceChannel,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus,
} = require('@discordjs/voice');

const { createLogger } = require('./logger');
const utils = require('./utils');

/** Public lifecycle states, exposed through the HTTP status endpoint. */
const State = Object.freeze({
  IDLE: 'idle',
  LOGGING_IN: 'logging_in',
  JOINING: 'joining',
  ONLINE: 'online',
  RECONNECTING: 'reconnecting',
  STOPPED: 'stopped',
});

class BotInstance {
  /**
   * @param {object} config Normalized bot config (see src/settings.js)
   * @param {{ onStateChange?: (name: string, state: string) => void }} [hooks]
   */
  constructor(config, hooks = {}) {
    this.config = config;
    this.log = createLogger(config.name);
    this.onStateChange = hooks.onStateChange ?? (() => {});

    this.state = State.IDLE;
    this.client = null;
    this.connection = null;
    this.guildId = config.guildId;
    /** Cached Guild object — also the source of the voice adapter creator. */
    this.guild = null;

    this.startedAt = Date.now();
    this.readyAt = null;
    this.reconnectCount = 0;
    this.attempt = 0;
    this.lastError = null;
    this.lastErrorAt = null;
    this.everReady = false;

    /** Set when a reconnect is requested while the session is healthy. */
    this._pendingReason = null;
    this._deferred = null;
    this._watchdogTimer = null;
    this._verifyTimer = null;
    this._stopping = false;
    this._detachers = [];
    /** Aborted on stop() so pending backoff waits end immediately. */
    this._abort = new AbortController();
    /** Unique voice group per instance so bots never fight over the same connection. */
    this._voiceGroup = `afk-${config.key}-${config.vcId}`;
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /** Start the supervision loop. Never throws, never resolves until stopped. */
  async start() {
    this.log.info(
      `Starting • token=${utils.maskToken(this.config.token)} • vc=${this.config.vcId}` +
        `${this.config.selfMute ? ' • muted' : ''}${this.config.selfDeaf ? ' • deafened' : ''}`,
    );

    while (!this._stopping) {
      this.attempt = 0;
      let reason = 'startup';

      // Inner loop: keep retrying the current login attempt until it succeeds
      // or the retry budget for this cycle is exhausted.
      for (;;) {
        if (this._stopping) break;
        try {
          await this._connect();
          reason = await this._monitor();
          break; // A failure was detected while healthy -> recycle the session.
        } catch (error) {
          reason = this._describeFailure(error);
          this._recordError(error);

          const maxAttempts = this.config.reconnect.maxAttempts;
          if (maxAttempts > 0 && this.attempt >= maxAttempts) {
            this.log.error(
              `Giving up after ${this.attempt} attempt(s) in this cycle (RECONNECT_MAX_ATTEMPTS=${maxAttempts}). ` +
                `Last reason: ${reason}`,
            );
            break;
          }

          this.attempt += 1;
          const delay = utils.computeBackoffDelay(this.attempt, this.config.reconnect);
          this._setState(this.attempt === 1 && !this.everReady ? State.LOGGING_IN : State.RECONNECTING, reason);
          this.log.warn(`${reason} — retry #${this.attempt} in ${utils.formatDuration(delay)}`);
          await utils.sleep(delay, { signal: this._abort.signal });
        }
      }

      if (this._stopping) break;

      // Session died while healthy: tear it down and start a fresh cycle.
      this.reconnectCount += 1;
      this._setState(State.RECONNECTING, reason);
      this.log.warn(`Session lost (${reason}) — reconnecting (#${this.reconnectCount}).`);
      await this._cleanupSession();
      if (this._stopping) break;
      await utils.sleep(this.config.reconnect.initialDelay, { signal: this._abort.signal });
    }

    await this._cleanupSession();
    this._setState(State.STOPPED, 'shutdown requested');
    this.log.info('Stopped.');
  }

  /** Request a graceful stop. */
  async stop() {
    if (this._stopping) return;
    this._stopping = true;
    this.log.info('Shutdown requested — leaving voice channel...');

    // Cancel any in-flight backoff wait and wake the supervisor immediately.
    this._abort.abort();
    if (this._deferred) this._deferred.resolve('shutdown requested');
    await this._cleanupSession();
  }

  /** Machine-readable snapshot used by the Express status endpoint. */
  getStatus() {
    const inVoice =
      Boolean(this.connection) &&
      this.connection.state.status === VoiceConnectionStatus.Ready &&
      Boolean(this.guildId);

    return {
      name: this.config.name,
      index: this.config.index + 1,
      state: this.state,
      in_voice: inVoice,
      voice_state: this.connection ? this.connection.state.status : null,
      guild_id: this.guildId,
      vc_id: this.config.vcId,
      application_id: this.config.applicationId,
      muted: this.config.selfMute,
      deafened: this.config.selfDeaf,
      reconnects: this.reconnectCount,
      pending_retry: this.attempt,
      uptime_ms: Date.now() - this.startedAt,
      ready_uptime_ms: this.readyAt ? Date.now() - this.readyAt : null,
      gateway_ping_ms: this.client?.ws?.ping ?? null,
      last_error: this.lastError,
      last_error_at: this.lastErrorAt,
    };
  }

  // =========================================================================
  // Session lifecycle
  // =========================================================================

  /** Build a fresh discord.js client for this instance. */
  _createClient() {
    const options = {
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
      // Keep memory flat when hundreds of bots run in one process.
      ...(this.config.limitCache
        ? {
            makeCache: Options.cacheWithLimits({
              GuildMemberManager: 100,
              GuildVoiceStateManager: 500,
              GuildChannelManager: 100,
            }),
          }
        : {}),
      rest: { timeout: 20_000, retries: 5 },
    };
    if (this.config.presence) options.presence = this.config.presence;

    return new Client(options);
  }

  /** One full attempt: create client -> login -> resolve guild -> join VC -> ready. */
  async _connect() {
    this._setState(this.everReady ? State.RECONNECTING : State.LOGGING_IN, 'connecting to Discord gateway');
    this.client = this._createClient();

    const readyPromise = new Promise((resolve) => {
      this.client.once(Events.ClientReady, (user) => resolve(user));
    });
    this._attachClientListeners();

    this.log.info(`Logging in as ${utils.maskToken(this.config.token)}...`);
    await this.client.login(this.config.token);

    // Safety net: normally `login()` resolves alongside ClientReady.
    await Promise.race([
      readyPromise,
      // `unref` so this race timeout can never hold the process open.
      utils
        .sleep(this.config.watchdog.voiceJoinTimeoutMs, { unref: true })
        .then(() => {
          throw new Error('Timed out waiting for the gateway to report the bot as ready.');
        }),
    ]);

    this.log.info(`Gateway ready • user=${this.client.user.tag} • ping=${Math.round(this.client.ws.ping)}ms`);
    this._applyPresence();

    await this._resolveGuild();
    await this._joinVoice();
  }

  /** Determine (and cache) the guild id that owns the target voice channel. */
  async _resolveGuild() {
    let guildId = this.config.guildId;

    if (!guildId) {
      const channel = await this.client.channels.fetch(this.config.vcId).catch(() => null);
      if (!channel) {
        throw new Error(
          `Voice channel ${this.config.vcId} was not found. Make sure the bot is in that server and has "View Channel" access to it.`,
        );
      }
      if (typeof channel.isVoiceBased === 'function' && !channel.isVoiceBased()) {
        throw new Error(`Channel ${this.config.vcId} is not a voice/stage channel (type=${channel.type}).`);
      }
      guildId = channel.guildId ?? null;
      if (!guildId) {
        throw new Error(`Could not determine which server owns voice channel ${this.config.vcId}. Set "guild_id" in config.json.`);
      }
    }

    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      throw new Error(
        `The bot is not a member of the server owning channel ${this.config.vcId}. Invite it with the "Connect" permission.`,
      );
    }

    this.guildId = guild.id;
    this.guild = guild;
  }

  /** Join the voice channel and wait until the voice connection is truly Ready. */
  async _joinVoice() {
    this._setState(State.JOINING, `joining voice channel ${this.config.vcId}`);
    this.log.info(`Joining voice channel ${this.config.vcId} on guild ${this.guildId}...`);

    const { group, selfMute, selfDeaf, daveEncryption } = this.config;

    if (!this.guild) {
      throw new Error('Internal error: the guild object is missing, so no voice adapter could be created.');
    }

    const connection = joinVoiceChannel({
      channelId: this.config.vcId,
      guildId: this.guildId,
      // discord.js >= 14.16 no longer exposes `client.options.adapterCreator`.
      // `guild.voiceAdapterCreator` is the supported bridge: it registers the
      // adapter in `client.voice.adapters` so gateway VOICE_STATE_UPDATE and
      // VOICE_SERVER_UPDATE packets reach @discordjs/voice.
      adapterCreator: this.guild.voiceAdapterCreator,
      // A unique group keeps every instance isolated: joining again under the
      // same group is what makes @discordjs/voice clean up our stale socket.
      group,
      selfMute,
      selfDeaf,
      // Forwarded by @discordjs/voice to the DAVE (voice E2EE) session.
      daveEncryption,
    });
    this.connection = connection;
    this._attachVoiceListeners(connection);

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, this.config.watchdog.voiceJoinTimeoutMs);
    } catch (error) {
      throw new Error(
        `Timed out after ${this.config.watchdog.voiceJoinTimeoutMs}ms waiting for the voice connection to become Ready: ${error.message}`,
      );
    }

    this.everReady = true;
    this.readyAt = Date.now();
    this._setState(State.ONLINE, 'connected');
    this.log.info(
      `In voice ✓ channel=${this.config.vcId}` +
        `${selfMute ? ' • muted' : ''}${selfDeaf ? ' • deafened' : ''}` +
        ` • rejoin-protected`,
    );
  }

  /** Resolve when the session becomes unhealthy (or on stop). Never rejects. */
  async _monitor() {
    // A fresh reason for each monitored session.
    this._pendingReason = null;
    this._deferred = utils.createDeferred();
    this._startWatchdog();

    try {
      const reason = await this._deferred.promise;
      return reason || 'connection lost';
    } finally {
      this._stopWatchdog();
      this._clearVerifyTimer();
      this._deferred = null;
    }
  }

  // =========================================================================
  // Listeners
  // =========================================================================

  _attachClientListeners() {
    const { client } = this;
    const log = this.log;

    const detachers = [
      client.on(Events.ClientReady, (user) => {
        log.debug(`ClientReady as ${user.tag}`);
        this._applyPresence();
      }),

      client.on(Events.Error, (error) => {
        // Never let a client error bubble up and kill the process.
        log.warn(`Client error: ${utils.describeError(error)}`);
      }),

      client.on(Events.Warn, (message) => {
        log.warn(`Discord warning: ${message}`);
      }),

      client.on(Events.Debug, (message) => {
        log.debug(`gateway: ${message}`);
      }),

      client.on(Events.ShardDisconnect, (event, shardId) => {
        log.warn(`Gateway shard ${shardId} disconnected (code=${event?.code}). Discord.js will attempt to resume.`);
        this._scheduleVerification('gateway shard disconnected');
      }),

      client.on(Events.ShardResumed, (shardId) => {
        log.info(`Gateway shard ${shardId} resumed.`);
        this._scheduleVerification(2_000, 'resumed — verifying voice channel');
      }),

      client.on(Events.ShardReady, (shardId) => {
        log.debug(`Gateway shard ${shardId} ready.`);
      }),
    ];

    this._detachers.push(...detachers);
  }

  _attachVoiceListeners(connection) {
    const log = this.log;

    const onStateChange = (oldState, newState) => {
      const from = oldState.status;
      const to = newState.status;
      log.debug(`voice: ${from} -> ${to}`);

      if (to === VoiceConnectionStatus.Ready) {
        this._clearVerifyTimer();
        this.readyAt = Date.now();
        if (this.state !== State.ONLINE) {
          this._setState(State.ONLINE, 'voice connection ready');
          log.info('Voice connection recovered ✓');
        }
        return;
      }

      if (to === VoiceConnectionStatus.Destroyed) {
        this._requestReconnect('voice connection was destroyed');
        return;
      }

      if (to === VoiceConnectionStatus.Disconnected) {
        // @discordjs/voice usually heals itself; give it a grace period first.
        this._scheduleVerification(
          `voice connection ${from === VoiceConnectionStatus.Ready ? 'dropped' : 'not established'}`,
        );
        return;
      }

      if (to === VoiceConnectionStatus.Signalling && this.everReady) {
        // Discord sends Signalling again only when the endpoint changes
        // (channel deleted, moved, or the bot was disconnected server-side).
        this._requestReconnect('voice endpoint changed (channel deleted/moved or kicked)');
      }
    };

    connection.on('stateChange', onStateChange);
    this._detachers.push(() => connection.off('stateChange', onStateChange));
  }

  /**
   * Broadcast our configured presence over the gateway.
   *
   * `ClientUser.setPresence()` is SYNCHRONOUS in discord.js v14: it patches the
   * cache and writes straight to the gateway socket, returning a ClientPresence
   * — not a Promise. Chaining `.catch()` onto it throws a TypeError and would
   * take down every bot on every startup, so only a plain try/catch is used.
   */
  _applyPresence() {
    const { client } = this;
    if (!client?.user || !this.config.presence) return;
    try {
      client.user.setPresence(this.config.presence);
      this.log.debug('Presence applied');
    } catch (error) {
      this.log.debug(`Could not set presence: ${error.message}`);
    }
  }

  // =========================================================================
  // Watchdog
  // =========================================================================

  _startWatchdog() {
    this._stopWatchdog();
    const { enabled, intervalMs } = this.config.watchdog;
    if (!enabled) return;

    this._watchdogTimer = setInterval(() => {
      this._healthCheck('watchdog').catch((error) => {
        this.log.debug(`Watchdog error: ${utils.describeError(error)}`);
      });
    }, intervalMs);
    this._watchdogTimer.unref?.();
  }

  _stopWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  /**
   * Verify the bot is really still sitting in the target channel.
   * Detects the silent failures that Discord's events do not always surface
   * (channel emptied, bot kicked, connection object present but dead).
   */
  async _healthCheck(reason) {
    if (this._stopping || !this.client || !this.connection) return;
    if (this.state === State.JOINING || this.state === State.LOGGING_IN) return;

    const problems = [];

    const voiceStatus = this.connection.state.status;
    if (voiceStatus === VoiceConnectionStatus.Ready) {
      // Still, confirm Discord's own view of our channel membership.
      const membership = await this._verifyChannelMembership();
      if (!membership.ok) problems.push(membership.reason);
    } else if (voiceStatus === VoiceConnectionStatus.Destroyed) {
      problems.push('voice connection destroyed');
    } else {
      problems.push(`voice state is "${voiceStatus}"`);
    }

    if (problems.length > 0) {
      this.log.warn(`Health check failed (${reason}): ${problems.join('; ')}`);
      this._requestReconnect(problems.join('; '));
    }
  }

  /** Ask discord.js's cache whether our member is in the target channel. */
  async _verifyChannelMembership() {
    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) return { ok: false, reason: 'guild is not cached (bot was removed from the server?)' };

    let me = guild.members.me;
    if (!me && typeof guild.members.fetchMe === 'function') {
      try {
        await guild.members.fetchMe();
        me = guild.members.me;
      } catch {
        return { ok: false, reason: 'could not fetch own member object' };
      }
    }
    if (!me) return { ok: false, reason: 'member object unavailable' };

    const currentChannelId = me.voice?.channelId ?? null;
    if (currentChannelId === this.config.vcId) return { ok: true };

    if (!currentChannelId) return { ok: false, reason: 'bot is no longer in any voice channel' };
    return { ok: false, reason: `bot drifted to another voice channel (${currentChannelId})` };
  }

  /** Defer a health check so Discord.js gets a chance to self-heal first. */
  _scheduleVerification(reason, delayMs) {
    if (this._stopping) return;
    this._clearVerifyTimer();
    const delay = delayMs ?? this.config.watchdog.voiceRecoveryGraceMs;
    this._verifyTimer = setTimeout(() => {
      this._verifyTimer = null;
      this._healthCheck(reason).catch((error) => {
        this.log.debug(`Verification error: ${utils.describeError(error)}`);
      });
    }, delay);
    this._verifyTimer.unref?.();
  }

  _clearVerifyTimer() {
    if (this._verifyTimer) {
      clearTimeout(this._verifyTimer);
      this._verifyTimer = null;
    }
  }

  /** Signal the supervisor loop that the current session must be recycled. */
  _requestReconnect(reason) {
    if (this._stopping || !this._deferred || this._deferred.settled) return;
    this._pendingReason = reason;
    this._deferred.resolve(reason);
  }

  // =========================================================================
  // Teardown
  // =========================================================================

  /** Detach listeners, leave the VC, and destroy the client. */
  async _cleanupSession() {
    this._pendingReason = null;
    this._stopWatchdog();
    this._clearVerifyTimer();

    for (const detach of this._detachers.splice(0)) {
      try {
        detach();
      } catch {
        /* listener already gone */
      }
    }

    const connection = this.connection;
    this.connection = null;
    if (connection) {
      try {
        connection.destroy();
      } catch (error) {
        this.log.debug(`connection.destroy() failed: ${error.message}`);
      }
      // Also make sure nothing is left registered under our voice group.
      try {
        getVoiceConnection(this.guildId)?.destroy();
      } catch {
        /* noop */
      }
    }

    const { client } = this;
    this.client = null;
    this.readyAt = null;
    if (client) {
      try {
        await client.destroy();
      } catch (error) {
        this.log.debug(`client.destroy() failed: ${error.message}`);
      }
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  _setState(next, detail) {
    if (this.state === next) return;
    this.state = next;
    try {
      this.onStateChange(this.config.name, next);
    } catch {
      /* never let a hook break the instance */
    }
  }

  _recordError(error) {
    this.lastError = utils.describeError(error);
    this.lastErrorAt = new Date().toISOString();
  }

  _describeFailure(error) {
    const { kind, hint } = utils.classifyError(error);
    const base = `Failed to stay in voice: ${utils.describeError(error)}`;
    if (kind === 'unknown') return base;
    return `${base} (${kind}: ${hint})`;
  }
}

module.exports = { BotInstance, State };