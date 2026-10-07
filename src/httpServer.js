'use strict';

/**
 * httpServer.js
 * ---------------------------------------------------------------------------
 * Minimal Express server whose only job is to stay reachable.
 *
 * Free-tier hosts (Render, Koyeb, Fly, Railway, Replit, DisCloud, ...) rely on
 * inbound HTTP traffic to decide whether to suspend a free container. A tiny
 * endpoint that answers 200 instantly satisfies those health checkers.
 *
 * Routes:
 *   GET /        -> 200 "OK" + human-readable fleet status
 *   GET /health  -> JSON health summary
 *   GET /bots    -> JSON array with per-bot detail
 *   GET /invite  -> ready-to-use OAuth2 invite links (no secrets exposed)
 */

const express = require('express');
const http = require('node:http');

const { PERMISSION_PRESETS, buildInviteUrl } = require('./permissions');
const { createLogger } = require('./logger');
const utils = require('./utils');

/** True when the caller prefers JSON (query param, Accept header, or bot UA). */
function wantsJson(req) {
  if (req.query?.format === 'json') return true;
  const accept = req.get('accept') || '';
  if (accept.includes('application/json')) return true;
  if (req.query?.format === 'text') return false;
  return false;
}

const STATE_GLYPH = {
  online: '[ ONLINE ]',
  joining: '[ JOINING ]',
  logging_in: '[ LOGIN  ]',
  reconnecting: '[RETRY  ]',
  idle: '[ IDLE   ]',
  stopped: '[STOPPED]',
};

/**
 * @param {{ port: number, host: string, enableInviteEndpoint: boolean }} settings
 * @param {import('./BotManager').BotManager} manager
 */
function createHttpServer(settings, manager) {
  const log = createLogger('http');
  const app = express();
  /** Created in listen() so we never bind a port at require-time. */
  let server = null;

  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.set('etag', false);

  // Never cache status responses: monitors must always see fresh data.
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    next();
  });

  app.get('/', (req, res) => {
    const status = manager.getStatus();
    const uptime = utils.formatDuration(status.uptime_ms);

    if (wantsJson(req)) {
      return res.status(200).json({ status: 'OK', ...status });
    }

    const lines = [
      'OK',
      '',
      'Multi-Bot 24/7 Voice Channel Stay',
      `Uptime: ${uptime}`,
      `Bots: ${status.total} | Online: ${status.online} | In-Voice: ${status.in_voice} | Retrying: ${status.reconnecting}`,
      `Fleet status: ${status.ok ? 'HEALTHY' : 'DEGRADED'} | Total reconnects: ${status.reconnects_total}`,
      '',
    ];

    if (status.bots.length === 0) {
      lines.push('(no bot instances configured)');
    }

    for (const bot of status.bots) {
      const glyph = STATE_GLYPH[bot.state] || `[${bot.state}]`;
      const voice = bot.in_voice ? 'IN VOICE' : 'NOT IN VOICE';
      lines.push(`${glyph} ${bot.name}  |  ${voice}  |  vc=${bot.vc_id}  |  up=${utils.formatDuration(bot.uptime_ms)}  |  reconnects=${bot.reconnects}`);
      if (bot.last_error) {
        lines.push(`             last error: ${bot.last_error}`);
      }
    }

    lines.push('', 'Endpoints: /health  /bots  /invite');
    return res.status(200).type('text/plain; charset=utf-8').send(`${lines.join('\n')}\n`);
  });

  app.get('/health', (_req, res) => {
    const status = manager.getStatus();
    res.status(status.ok ? 200 : 503).json({
      status: status.ok ? 'healthy' : 'degraded',
      uptime_ms: status.uptime_ms,
      uptime: status.uptime,
      total: status.total,
      online: status.online,
      in_voice: status.in_voice,
      reconnecting: status.reconnecting,
    });
  });

  app.get('/bots', (_req, res) => {
    const status = manager.getStatus();
    res.status(200).json({ ok: status.ok, total: status.total, bots: status.bots });
  });

  app.get('/invite', (req, res) => {
    if (!settings.enableInviteEndpoint) {
      return res.status(404).json({ error: 'Invite endpoint disabled (ENABLE_INVITE_ENDPOINT=false)' });
    }

    const presetNames = Object.keys(PERMISSION_PRESETS);
    const requested = String(req.query.preset || 'minimal').toLowerCase();
    if (!presetNames.includes(requested)) {
      return res.status(400).json({ error: `Unknown preset "${requested}"`, available: presetNames });
    }
    const preset = PERMISSION_PRESETS[requested];

    const guildId = req.query.guild_id ? String(req.query.guild_id) : undefined;
    const invites = manager.instances.values().map((instance) => {
      const { name, applicationId, vcId, guildId: configuredGuild } = instance.config;
      return {
        name,
        application_id: applicationId,
        target_vc_id: vcId,
        guild_id: guildId ?? configuredGuild ?? undefined,
        invite: applicationId ? buildInviteUrl(applicationId, preset.value, guildId ?? configuredGuild) : null,
        note: applicationId ? undefined : 'Could not derive application ID from the token — copy the Client ID from the Developer Portal.',
      };
    });

    const response = {
      preset: { name: requested, ...preset, permissions: Number(preset.value) },
      bots: invites,
    };

    if (wantsJson(req) || req.query.format === 'json') {
      return res.status(200).json(response);
    }

    const text = [
      `Permission preset: ${preset.label}`,
      `Permissions: ${preset.names.join(', ')} (= ${preset.value})`,
      '',
      ...invites.flatMap((entry) => [
        `• ${entry.name}`,
        `  ${entry.invite ?? entry.note}`,
        '',
      ]),
      'Tip: add &guild_id=<SERVER_ID> to pre-select a server, e.g. /invite?guild_id=1234567890',
    ];
    return res.status(200).type('text/plain; charset=utf-8').send(`${text.join('\n')}\n`);
  });

  // 404 for anything else.
  app.use((req, res) => {
    if (wantsJson(req)) {
      return res.status(404).json({ status: 'OK', error: 'Not found', path: req.path, hint: 'Try /health, /bots or /invite' });
    }
    return res.status(404).type('text/plain; charset=utf-8').send(`OK\n404 - Not Found: ${req.path}\nTry /health, /bots or /invite\n`);
  });

  // Central error handler.
  app.use((error, req, res, _next) => {
    log.error(`Unhandled HTTP error on ${req.method} ${req.path}: ${utils.describeError(error)}`);
    if (res.headersSent) return;
    res.status(500).json({ error: 'Internal Server Error' });
  });

  return {
    app,
    get server() {
      return server;
    },
    listen(port, host) {
      return new Promise((resolve, reject) => {
        server = http.createServer(app);
        const onStartupError = (error) => reject(error);
        server.once('error', onStartupError);

        server.listen(port, host, () => {
          server.off('error', onStartupError);
          server.on('error', (error) => {
            log.error(`HTTP server error: ${utils.describeError(error)}`);
          });
          log.info(`Keep-alive server listening on http://${host}:${port}`);
          log.info(`Health check URL: http://${host}:${port}/  |  /health  |  /bots  |  /invite`);
          resolve(server);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        if (!server) return resolve();
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

module.exports = { createHttpServer, PERMISSION_PRESETS };