'use strict';

/**
 * permissions.js
 * ---------------------------------------------------------------------------
 * Shared helpers for building OAuth2 bot invite links.
 * Used by both the HTTP server (`GET /invite`) and the CLI scripts, so the
 * links you test locally are exactly the ones the running server prints.
 */

const { PermissionFlagsBits } = require('discord.js');

/**
 * Permission presets for an AFK / "stay in voice channel" bot.
 *
 * Note: a bot that only parks itself in a voice channel never streams audio,
 * so it does NOT need the `Speak` permission. `minimal` is all that is required.
 */
const PERMISSION_PRESETS = Object.freeze({
  minimal: {
    label: 'Minimal (recommended for a pure AFK stay)',
    value: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect,
    names: ['ViewChannel', 'Connect'],
  },
  recommended: {
    label: 'Recommended (can also move members between channels)',
    value:
      PermissionFlagsBits.ViewChannel |
      PermissionFlagsBits.Connect |
      PermissionFlagsBits.MoveMembers |
      PermissionFlagsBits.UseEmbeddedActivities,
    names: ['ViewChannel', 'Connect', 'MoveMembers', 'UseEmbeddedActivities'],
  },
  full: {
    label: 'Full voice control (can also mute/deafen members)',
    value:
      PermissionFlagsBits.ViewChannel |
      PermissionFlagsBits.Connect |
      PermissionFlagsBits.MoveMembers |
      PermissionFlagsBits.Speak |
      PermissionFlagsBits.UseEmbeddedActivities |
      PermissionFlagsBits.MuteMembers |
      PermissionFlagsBits.DeafenMembers,
    names: [
      'ViewChannel',
      'Connect',
      'MoveMembers',
      'Speak',
      'UseEmbeddedActivities',
      'MuteMembers',
      'DeafenMembers',
    ],
  },
});

/**
 * Build a bot authorization URL.
 * @param {string} applicationId Bot application (user) ID
 * @param {bigint|number} permissions Permission bitfield
 * @param {string} [guildId] Pre-select a server for the invite
 * @returns {string}
 */
function buildInviteUrl(applicationId, permissions, guildId) {
  const params = new URLSearchParams({
    client_id: String(applicationId),
    scope: 'bot',
    permissions: String(permissions),
  });
  if (guildId) params.set('guild_id', String(guildId));
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

/** Link to the Developer Portal page where the token can be reset. */
function buildPortalUrl(applicationId) {
  return `https://discord.com/developers/applications/${applicationId}/bot`;
}

module.exports = { PERMISSION_PRESETS, buildInviteUrl, buildPortalUrl };