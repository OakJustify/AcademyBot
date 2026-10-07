#!/usr/bin/env node
'use strict';

/**
 * scripts/doctor.js  —  `npm run doctor`
 * ---------------------------------------------------------------------------
 * Pre-flight check you can run before deploying:
 *
 *   1. Node.js version compatibility
 *   2. config.json / .env validation
 *   3. Native dependency report from @discordjs/voice (libsodium, ffmpeg, DAVE)
 *   4. Live token validation against Discord's REST API (`users/@me`)
 *   5. Ready-to-use OAuth2 invite links
 *
 * Flags:
 *   --offline     skip the live token check
 *   --preset=min  use a different permission preset for invite links
 */

const { loadDotEnv, loadSettings } = require('../src/settings');
const { generateDependencyReport, version: voiceVersion } = require('@discordjs/voice');
const { version: djsVersion } = require('discord.js');
const { PERMISSION_PRESETS, buildInviteUrl, buildPortalUrl } = require('../src/permissions');
const utils = require('../src/utils');

const DISCORD_API = 'https://discord.com/api/v10';
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 12;

const args = process.argv.slice(2);
const offline = args.includes('--offline');
const presetArg = (args.find((a) => a.startsWith('--preset=')) || '').split('=')[1] || 'minimal';

const c = {
  reset: '\u001B[0m',
  bold: '\u001B[1m',
  red: '\u001B[31m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  cyan: '\u001B[36m',
  gray: '\u001B[90m',
};
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (text, code) => (color ? `${code}${text}${c.reset}` : text);

const ok = (m) => console.log(`  ${paint('✓', c.green)} ${m}`);
const warn = (m) => console.log(`  ${paint('!', c.yellow)} ${m}`);
const bad = (m) => console.log(`  ${paint('✗', c.red)} ${m}`);
const section = (m) => console.log(`\n${paint(c.bold, '')}${m}`);

/** Validate one token against Discord and return the bot user, or an error. */
async function checkToken(token) {
  try {
    const response = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bot ${token}`, 'User-Agent': 'DiscordBot (MultiBotAFK, 1.0.0)' },
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status === 401) return { ok: false, reason: '401 Unauthorized — token is invalid or was reset' };
    if (response.status === 403) return { ok: false, reason: '403 Forbidden — token lacks access' };
    if (response.status === 429) return { ok: false, reason: '429 Rate limited — retry in a moment' };
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status} ${response.statusText}` };

    const user = await response.json();
    return { ok: true, user };
  } catch (error) {
    return { ok: false, reason: `network error: ${error.message}` };
  }
}

async function main() {
  let fatal = false;

  // --- 1. Runtime -----------------------------------------------------------
  section('1) Runtime');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR)) {
    ok(`Node.js ${process.versions.node} is supported (requires >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR})`);
  } else {
    bad(`Node.js ${process.versions.node} is TOO OLD — @discordjs/voice needs >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`);
    fatal = true;
  }
  ok(`discord.js ${djsVersion} • @discordjs/voice ${voiceVersion}`);

  // --- 2. Native deps -------------------------------------------------------
  section('2) Native dependencies (@discordjs/voice)');
  const report = generateDependencyReport();
  const hasLibsodium = /libsodium-wrappers: (?!not found)/.test(report);
  const hasDave = /@snazzah\/davey: (?!not found)/.test(report);
  const hasFfmpeg = /FFmpeg[\s\S]*version: (?!not found)/.test(report) || /libopus: yes/.test(report);

  hasLibsodium
    ? ok('libsodium-wrappers found (needed for DAVE voice encryption)')
    : bad('libsodium-wrappers MISSING — run `npm install` (DAVE encryption will fail)');
  hasDave ? ok('DAVE library available') : bad('DAVE library MISSING — run `npm install`');
  hasFfmpeg
    ? ok('FFmpeg available (not required for AFK stay, only for audio playback)')
    : warn('FFmpeg not detected (irrelevant for a stay-only bot)');
  if (color) console.log(paint(report, c.gray));

  // --- 3. Configuration -----------------------------------------------------
  section('3) Configuration');
  const envPath = loadDotEnv();
  envPath ? ok(`.env loaded from ${envPath}`) : warn('No .env file found — falling back to config.json tokens / process env');

  let settings;
  try {
    settings = loadSettings({ requireTokens: false });
    ok(`Config parsed: ${settings.bots.length} enabled bot(s), ${settings.disabledBots.length} disabled`);
    for (const message of settings.warnings ?? []) warn(message);
  } catch (error) {
    bad(error.message);
    console.log('\nFix the problems above, then run `npm run doctor` again.');
    process.exit(1);
  }

  // --- 4. Tokens ------------------------------------------------------------
  section(offline ? '4) Tokens (skipped — --offline)' : '4) Tokens (live check against discord.com)');

  const results = [];
  const withToken = settings.bots.filter((bot) => bot.token);

  if (offline || withToken.length === 0) {
    if (withToken.length === 0) warn('No tokens found — fill BOT_1_TOKEN ... in your .env first.');
    else warn('Live token check skipped.');
    for (const bot of settings.bots) results.push({ bot, result: null });
  } else {
    for (const bot of withToken) {
      // Sequential on purpose: avoids tripping Discord's rate limiter.
      const result = await checkToken(bot.token);
      results.push({ bot, result });
      if (result.ok) ok(`${bot.name} → ${result.user.username}#${result.user.discriminator ?? '0'} (${result.user.id})`);
      else bad(`${bot.name} → ${result.reason}`);
      await utils.sleep(350);
    }
    for (const bot of settings.bots.filter((b) => !b.token)) {
      results.push({ bot, result: null });
      bad(`${bot.name} → token is empty`);
    }
  }

  // --- 5. Invite links ------------------------------------------------------
  section('5) Invite links');
  const presetName = presetArg.startsWith('m') ? 'minimal' : presetArg.startsWith('f') ? 'full' : 'recommended';
  const preset = PERMISSION_PRESETS[presetName] ?? PERMISSION_PRESETS.minimal;

  console.log(`  Preset: ${preset.label}`);
  console.log(`  Permissions: ${paint(preset.names.join(', '), c.cyan)}  (= ${preset.value})\n`);

  const anyInvalid = results.some(({ result }) => result && !result.ok);

  for (const { bot, result } of results) {
    const appId = result?.ok ? result.user.id : bot.applicationId;
    console.log(`  ${paint(`#${bot.index + 1} ${bot.name}`, c.bold)}`);
    console.log(`     target VC : ${bot.vcId}${bot.guildId ? `  (guild ${bot.guildId})` : '  (guild auto-detected)'}`);
    if (!appId) {
      console.log(`     ${paint('no token — cannot derive application ID yet', c.yellow)}`);
    } else {
      console.log(`     invite     : ${buildInviteUrl(appId, preset.value, bot.guildId)}`);
      console.log(`     ${paint('reset token', c.gray)}: ${buildPortalUrl(appId)}`);
    }
    console.log('');
  }

  // --- Verdict --------------------------------------------------------------
  section('Verdict');
  const configured = results.length;
  const working = results.filter(({ result }) => result?.ok).length;

  if (anyInvalid) {
    bad(`${working}/${configured} token(s) valid — fix the invalid ones before deploying.`);
    process.exit(1);
  }
  if (configured > 0 && working === 0 && !offline) {
    bad('No tokens validated. Fill BOT_1_TOKEN…BOT_N_TOKEN in .env and re-run.');
    process.exit(1);
  }

  ok('Configuration looks good. Run `npm start` to launch all bots.');
  console.log('\n  Live status will be available at:  http://localhost:' + settings.port + '/');
  console.log('  Invite links while running       :  http://localhost:' + settings.port + '/invite\n');
}

main().catch((error) => {
  console.error(`\n${paint('Doctor failed:', c.red)} ${utils.describeError(error)}`);
  if (error?.stack) console.error(error.stack);
  process.exit(1);
});