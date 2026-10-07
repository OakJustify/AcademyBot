#!/usr/bin/env node
'use strict';

/**
 * scripts/list-channels.js  —  `npm run channels`
 * ---------------------------------------------------------------------------
 * Discovers the real voice-channel IDs inside every server a bot has been
 * invited to, so you never have to copy an ID by hand again.
 *
 * Flow:
 *   1. Invite one bot to your server (link from `npm run invite`).
 *   2. Run this script — it asks Discord which guilds that bot is in, then
 *      lists every voice/stage channel with its snowflake ID.
 *   3. Paste the IDs you want into the "vc_id" fields in config.json.
 *
 * Usage:
 *   npm run channels
 *   npm run channels -- --token=BOT_2_TOKEN     # inspect via another bot
 *   npm run channels -- --guild_id=1234567890   # limit to one server
 *   npm run channels -- --json                  # machine-readable output
 *
 * Notes:
 *   - Reads only via the bot token; nothing is ever written or modified.
 *   - A bot can only see channels in servers it has been invited to, so the
 *     "joinable" column is accurate for that specific bot account.
 */

const { loadDotEnv } = require('../src/settings');
const utils = require('../src/utils');

const DISCORD_API = 'https://discord.com/api/v10';
const USER_AGENT = 'DiscordBot (MultiBotAFK, 1.0.0)';

/** Channel types that can host a voice connection. */
const VOICE_TYPES = new Map([
  [2, 'Voice'],
  [13, 'Stage'],
]);

const args = process.argv.slice(2);
const flag = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
};

const asJson = args.includes('--json');
const tokenKey = flag('token') || 'BOT_1_TOKEN';
const guildFilter = flag('guild_id');

const c = {
  reset: '[0m',
  bold: '[1m',
  dim: '[90m',
  green: '[32m',
  yellow: '[33m',
  cyan: '[36m',
};
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (text, code) => (color ? `${code}${text}${c.reset}` : text);

/** Minimal authenticated GET against Discord's REST API. */
async function apiGet(path, token) {
  const response = await fetch(`${DISCORD_API}${path}`, {
    headers: { Authorization: `Bot ${token}`, 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });

  if (response.status === 401) throw new Error('401 Unauthorized — token is invalid. Re-run `npm run doctor`.');
  if (response.status === 403) throw new Error('403 Forbidden — the token lacks access to this resource.');
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} on ${path}`);

  return response.json();
}

/** Does the bot itself have ViewChannel + Connect on this channel? */
function joinableFor(botMember, channel) {
  if (!botMember?.permissions) return false;
  const VIEW_CHANNEL = 1 << 10; // 1024
  const CONNECT = 1 << 20; // 1048576
  const granted = BigInt(botMember.permissions);
  const explicit = channel.permission_overwrites?.find((o) => o.id === channel.guild_id);
  if (explicit) {
    const deny = BigInt(explicit.deny ?? 0);
    const allow = BigInt(explicit.allow ?? 0);
    return ((granted & ~deny & CONNECT) === CONNECT) && ((granted & ~deny & VIEW_CHANNEL) === VIEW_CHANNEL) && (allow & CONNECT) === CONNECT;
  }
  return (granted & CONNECT) === CONNECT && (granted & VIEW_CHANNEL) === VIEW_CHANNEL;
}

async function main() {
  loadDotEnv();

  const token = String(process.env[tokenKey] ?? '').trim();
  if (!token) {
    console.error(`Environment variable ${tokenKey} is empty. Fill it in .env first (see .env.example).`);
    process.exit(1);
  }

  const me = await apiGet('/users/@me', token);
  const guilds = await apiGet('/users/@me/guilds', token);

  const targets = guildFilter ? guilds.filter((g) => g.id === guildFilter) : guilds;

  if (targets.length === 0) {
    console.error(
      guildFilter
        ? `This bot is not in a server with ID ${guildFilter}. It is currently in: ${guilds.map((g) => g.name).join(', ') || '(none)'}`
        : 'This bot has not joined any server yet. Invite it first: npm run invite',
    );
    process.exit(1);
  }

  const report = [];
  for (const guild of targets) {
    let channels = [];
    try {
      channels = await apiGet(`/guilds/${guild.id}/channels`, token);
    } catch (error) {
      console.error(paint(`  ! could not read channels of "${guild.name}": ${error.message}`, c.yellow));
      continue;
    }

    const member = await apiGet(`/guilds/${guild.id}/members/${me.id}`, token).catch(() => null);
    const voice = channels
      .filter((ch) => VOICE_TYPES.has(ch.type))
      .map((ch) => ({
        guild_id: guild.id,
        guild_name: guild.name,
        channel_id: ch.id,
        channel_name: ch.name,
        type: VOICE_TYPES.get(ch.type),
        joinable: joinableFor(member, ch),
      }))
      .sort((a, b) => a.channel_name.localeCompare(b.channel_name));

    report.push({ ...voice, guild_name: guild.name });
  }

  const flat = report.flat();

  if (asJson) {
    console.log(JSON.stringify({ bot: { name: me.username, id: me.id }, guilds: report }, null, 2));
    return;
  }

  const line = '='.repeat(74);
  console.log(line);
  console.log(' VOICE CHANNEL DISCOVERY — Multi-Bot 24/7 Voice Channel Stay');
  console.log(` Bot account   : ${me.username}#${me.discriminator} (${me.id}) via ${tokenKey}`);
  console.log(` Servers       : ${targets.length}`);
  console.log(` Voice channels: ${flat.length}`);
  console.log(line);

  if (flat.length === 0) {
    console.log('\n No voice or stage channels found in these servers.\n');
    console.log(line);
    return;
  }

  let currentGuild = null;
  for (const entry of flat) {
    if (entry.guild_id !== currentGuild) {
      currentGuild = entry.guild_id;
      console.log(`\n ${paint(currentGuild, c.bold)}  (guild_id: ${entry.guild_id})`);
    }
    const mark = entry.joinable
      ? paint('joinable', c.green)
      : paint('no-access', c.yellow);
    console.log(`   ${mark}  ${entry.type.padEnd(5)}  ${entry.channel_name}`);
    console.log(`     ${paint('vc_id: ' + entry.channel_id, c.cyan)}`);
  }

  console.log(`\n${line}`);
  console.log(' Next steps:');
  console.log('   1. Copy the vc_id you want for each bot.');
  console.log('   2. Paste it into config.json → bots[].vc_id');
  console.log('   3. Run `npm run doctor`, then `npm start`.');
  if (flat.some((e) => !e.joinable)) {
    console.log('');
    console.log(paint(' Note: channels marked "no-access" need the bot invited with', c.yellow));
    console.log(paint(' "View Channel" + "Connect" permissions — re-run `npm run invite`.', c.yellow));
  }
  console.log(line);
  console.log('');
}

main().catch((error) => {
  console.error(utils.describeError(error));
  process.exit(1);
});
