#!/usr/bin/env node
'use strict';

/**
 * scripts/generate-invite.js  —  `npm run invite`
 * ---------------------------------------------------------------------------
 * Prints a ready-to-use OAuth2 invite link for every configured bot.
 * The application ID is derived straight from each bot token, so there is
 * nothing to copy by hand.
 *
 * Usage:
 *   npm run invite
 *   npm run invite -- --preset=full
 *   npm run invite -- --guild_id=123456789012345678
 *   npm run invite -- --json
 */

const { loadDotEnv, loadSettings } = require('../src/settings');
const { PERMISSION_PRESETS, buildInviteUrl, buildPortalUrl } = require('../src/permissions');
const utils = require('../src/utils');

const args = process.argv.slice(2);
const flag = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
};

const asJson = args.includes('--json');
const guildId = flag('guild_id');
const presetInput = (flag('preset') || 'minimal').toLowerCase();
const only = flag('bot'); // filter by name or 1-based index

function main() {
  loadDotEnv();
  const settings = loadSettings({ requireTokens: false });

  const presetName = Object.hasOwn(PERMISSION_PRESETS, presetInput) ? presetInput : 'minimal';
  if (!Object.hasOwn(PERMISSION_PRESETS, presetInput)) {
    console.warn(`Unknown preset "${presetInput}". Using "minimal". Available: ${Object.keys(PERMISSION_PRESETS).join(', ')}`);
  }
  const preset = PERMISSION_PRESETS[presetName];

  let bots = settings.bots;
  if (only) {
    const needle = only.toLowerCase();
    bots = bots.filter((bot) => bot.name.toLowerCase() === needle || String(bot.index + 1) === needle);
    if (bots.length === 0) {
      console.error(`No bot matched "${only}". Configured: ${settings.bots.map((b) => `${b.index + 1}=${b.name}`).join(', ')}`);
      process.exit(1);
    }
  }

  const rows = bots.map((bot) => ({
    name: bot.name,
    application_id: bot.applicationId,
    vc_id: bot.vcId,
    guild_id: bot.guildId,
    invite: bot.applicationId ? buildInviteUrl(bot.applicationId, preset.value, guildId ?? bot.guildId) : null,
    reset_token_url: bot.applicationId ? buildPortalUrl(bot.applicationId) : null,
  }));

  if (asJson) {
    console.log(JSON.stringify({ preset: { name: presetName, permissions: Number(preset.value), names: preset.names }, bots: rows }, null, 2));
    return;
  }

  const line = '='.repeat(74);
  console.log(line);
  console.log(' DISCORD INVITE LINKS — Multi-Bot 24/7 Voice Channel Stay');
  console.log(` Preset        : ${preset.label}`);
  console.log(` Permissions   : ${preset.names.join(', ')}  (= ${preset.value})`);
  console.log(` Default guild : ${guildId ?? '(not set — add --guild_id=<ID>)'}`);
  console.log(line);

  for (const [index, row] of rows.entries()) {
    console.log(`\n#${String(index + 1).padStart(2)} ${row.name}`);
    console.log(`   Voice channel : ${row.vc_id}`);
    if (row.invite) {
      console.log(`   INVITE        : ${row.invite}`);
      console.log(`   Reset token   : ${row.reset_token_url}`);
    } else {
      console.log('   INVITE        : (unavailable — token is empty, so the application ID is unknown)');
    }
  }

  console.log(`\n${line}`);
  if (rows.some((row) => !row.invite)) {
    console.log(' Some tokens are still empty. Fill BOT_1_TOKEN… in your .env and re-run.');
  } else {
    console.log(' Steps: 1) invite every bot  2) run `npm start`  3) done — they park themselves in the VC.');
  }
  console.log(line);
  console.log('');
}

try {
  main();
} catch (error) {
  console.error(utils.describeError(error));
  process.exit(1);
}