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

/** Permission bitfields this bot actually needs to sit idle in a channel. */
const VIEW_CHANNEL = 1n << 10n; // 1024
const CONNECT = 1n << 20n; // 1048576
const ADMINISTRATOR = 1n << 3n; // 8 — bypasses all channel overwrites

/**
 * Resolve a member's effective permissions in a channel.
 *
 * Two Discord quirks this has to work around:
 *   1. `GET /guilds/{id}/members/{user_id}` does NOT return a computed
 *      `permissions` field, so the guild-level baseline is rebuilt here from
 *      @everyone plus every role the member holds — exactly how Discord does it.
 *   2. ADMINISTRATOR bypasses every channel overwrite, so it short-circuits.
 *
 * Otherwise the documented order applies: @everyone overwrite -> role overwrites
 * (highest position first) -> member-specific overwrite, denies before allows.
 */
function effectivePermissions(guild, member, channel) {
  const everyoneRoleId = guild.id;
  const roles = guild.roles ?? [];
  const roleById = new Map(roles.map((role) => [role.id, role]));
  const rolePosition = new Map(roles.map((role) => [role.id, role.position ?? 0]));
  const memberRoleIds = member.roles ?? [];
  const userId = member.user?.id ?? member.id;

  let permissions = BigInt(roleById.get(everyoneRoleId)?.permissions ?? 0);
  for (const roleId of memberRoleIds) {
    permissions |= BigInt(roleById.get(roleId)?.permissions ?? 0);
  }

  if ((permissions & ADMINISTRATOR) === ADMINISTRATOR) return permissions;

  const overwrites = new Map((channel.permission_overwrites ?? []).map((o) => [o.id, o]));
  const apply = (overwrite) => {
    if (!overwrite) return;
    permissions &= ~BigInt(overwrite.deny ?? 0);
    permissions |= BigInt(overwrite.allow ?? 0);
  };

  apply(overwrites.get(everyoneRoleId));

  // Highest-positioned role wins, so sort descending.
  const sorted = [...memberRoleIds].sort((a, b) => (rolePosition.get(b) ?? 0) - (rolePosition.get(a) ?? 0));
  for (const roleId of sorted) apply(overwrites.get(roleId));

  apply(overwrites.get(userId));

  return permissions;
}

/** Can this specific bot account view the channel and connect to it? */
function resolveAccess(guild, member, channel) {
  if (!member) return { can_view: false, can_connect: false, joinable: false, administrator: false };

  const permissions = effectivePermissions(guild, member, channel);
  const canView = (permissions & VIEW_CHANNEL) === VIEW_CHANNEL;
  const canConnect = (permissions & CONNECT) === CONNECT;

  return {
    can_view: canView,
    can_connect: canConnect,
    joinable: canView && canConnect,
    administrator: (permissions & ADMINISTRATOR) === ADMINISTRATOR,
  };
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

    // Full guild object is required: the `roles` array carries role positions,
    // which decide overwrite precedence.
    const fullGuild = await apiGet(`/guilds/${guild.id}`, token).catch(() => guild);
    const member = await apiGet(`/guilds/${guild.id}/members/${me.id}`, token).catch(() => null);
    const voice = channels
      .filter((ch) => VOICE_TYPES.has(ch.type))
      .map((ch) => ({ channel_id: ch.id, channel_name: ch.name, type: VOICE_TYPES.get(ch.type), ...resolveAccess(fullGuild, member, ch) }))
      .sort((a, b) => a.channel_name.localeCompare(b.channel_name));

    report.push({
      guild_id: guild.id,
      guild_name: guild.name,
      administrator: member ? resolveAccess(fullGuild, member, channels[0] ?? {}).administrator : false,
      channels: voice,
    });
  }

  const flat = report.flatMap((guild) => guild.channels);

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

  for (const guild of report) {
    console.log(`\n ${paint(guild.guild_name, c.bold)}  (guild_id: ${guild.guild_id})`);
    if (guild.administrator) {
      console.log(` ${paint('bot has ADMINISTRATOR here — every channel below is accessible', c.dim)}`);
    }
    for (const entry of guild.channels) {
      const mark = entry.joinable
        ? paint('joinable ', c.green)
        : paint(`${entry.can_view ? 'no-connect' : 'no-view   '}${entry.can_connect ? '' : '/no-connect'}`, c.yellow);
      console.log(`   ${mark}  ${entry.type.padEnd(5)}  ${entry.channel_name}`);
      console.log(`     ${paint('vc_id: ' + entry.channel_id, c.cyan)}`);
    }
  }

  console.log(`\n${line}`);
  console.log(' Next steps:');
  console.log('   1. Copy the vc_id you want for each bot.');
  console.log('   2. Paste it into config.json → bots[].vc_id');
  console.log('   3. Run `npm run doctor`, then `npm start`.');
  if (flat.some((e) => !e.joinable)) {
    console.log('');
    console.log(paint(' Note: "no-view" / "no-connect" means the bot cannot use that channel.', c.yellow));
    console.log(paint(' Fix it in Discord: channel settings → Permissions → add the bot role.', c.yellow));
  }
  console.log(line);
  console.log('');
}

main().catch((error) => {
  console.error(utils.describeError(error));
  process.exit(1);
});
