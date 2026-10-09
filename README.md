# Multi-Bot 24/7 Voice Stay

Run **many Discord bots from a single Node.js process**, each logging in on its own and
holding a **permanent voice channel connection** so the channel never goes empty.

Adding a 7th, 10th, or 50th bot is a matter of appending one object to `config.json`.
**`index.js` never changes.**

---

## Features

| Feature | Description |
|---|---|
| Multi-instance | One process runs N bots, each with its own token and voice channel |
| Auto-join | Joins the target voice channel on startup |
| Auto-reconnect | Dropped by crash, a Discord restart, or a network blip → rejoins on its own |
| Watchdog | Periodically verifies "is this bot actually still in the channel?" → rejoins if it vanished, moved, or was disconnected |
| Mute / Deaf | Defaults to `true` (saves bandwidth), configurable per bot |
| DAVE E2EE | Discord end-to-end voice encryption, enabled by default |
| Keep-alive HTTP | Express server on port 8080 → keeps free-tier cloud containers from idling out |
| Error isolation | One bot crashing **never** takes down the others |
| Graceful shutdown | `SIGTERM`/`SIGINT` → every bot leaves voice cleanly |
| Config validation | All config errors are collected and reported **at once**, not one per restart |
| Health check CLI | `npm run doctor` → verifies Node version, native dependencies, and tokens live |

### Three layers of protection, each covering the others' blind spots

1. **Discord.js events** — voice state changes (`Disconnected`/`Destroyed`/`Signalling`), gateway shard disconnects.
2. **Watchdog timer** (30s default) — reads `guild.members.me.voice.channelId` to confirm the bot is genuinely in the channel, rather than merely "connected".
3. **Supervisor loop** — failed logins or joins fall back exponentially with jitter, retrying until they succeed.

Each instance also uses a **unique voice `group`** (`afk-<key>-<vcId>`), so bots never fight over a shared connection.

---

## Requirements

- **Node.js ≥ 22.12.0** (required by `@discordjs/voice` 0.19+). Check with `node -v`
- A Discord account, and **one application per bot** in the [Discord Developer Portal](https://discord.com/developers/applications)

---

## Quick start

```bash
cd ~/Projects/DISCORD-BOT

# 1) Install dependencies
npm install

# 2) Prepare the environment
cp .env.example .env

# 3) Add your tokens to .env
#    BOT_1_TOKEN=...  BOT_2_TOKEN=...  etc.
#    Tokens: Developer Portal > Applications > <App> > Bot > Reset Token
#    (a token is shown exactly ONCE)

# 4) Set each vc_id in config.json
#    Enable Developer Mode: Discord > Settings > Advanced > Developer Mode
#    Right-click the channel > Copy ID

# 5) Validate everything
npm run doctor

# 6) Run
npm start
```

The bots log in and join automatically. Open `http://localhost:8080` for a fleet-wide status view.

---

## Adding and removing bots

Add one line to `.env` and one object to `config.json`. **No code changes.**

```jsonc
// config.json → "bots" array
{
  "name": "AcademyBot-7",        // must be unique
  "token": "${BOT_7_TOKEN}",     // resolved from .env
  "vc_id": "1234567890123456789",
  "enabled": true                // false = skipped without being deleted
}
```

Optional per-bot settings:

```jsonc
{
  "name": "AcademyBot-7",
  "token": "${BOT_7_TOKEN}",
  "vc_id": "1234567890123456789",
  "guild_id": "987654321098765432",   // optional; auto-detected when empty
  "enabled": true,
  "selfMute": true,
  "selfDeaf": true,
  "daveEncryption": true,
  "presence": {
    "status": "idle",
    "activities": [{ "name": "AFK in voice", "type": "Playing" }]
  },
  "reconnect": { "maxAttempts": 0, "initialDelay": 2000, "maxDelay": 60000 },
  "watchdog": { "enabled": true, "intervalMs": 30000 }
}
```

Tokens can also be inlined (`"token": "<token>"`) if you'd rather not use `.env`, or
referenced by variable name via `token_env`:

```jsonc
{ "name": "AcademyBot-8", "token_env": "MY_CUSTOM_TOKEN_VAR", "vc_id": "..." }
```

---

## Project layout

```
DISCORD-BOT/
├── index.js              # Entry point: boot, banner, signal handling
├── config.json           # Token → vc_id mapping (6 bots by default)
├── .env.example          # Environment variable template
├── package.json
├── discloud.config       # DisCloud deployment
├── Procfile              # Heroku / Railway / DisCloud deployment
├── src/
│   ├── settings.js       # Loads and validates config.json & .env
│   ├── BotManager.js     # Owns the fleet, aggregates status
│   ├── BotInstance.js    # One bot: login, join, reconnect, watchdog
│   ├── httpServer.js     # Express keep-alive + status endpoints
│   ├── permissions.js    # Permission presets & invite URLs
│   ├── logger.js         # Clean logging (color / JSON)
│   └── utils.js          # Helpers: backoff, sleep, token masking
├── scripts/
│   ├── doctor.js         # Pre-flight checks (npm run doctor)
│   ├── generate-invite.js# Invite link generation (npm run invite)
│   └── list-channels.js  # Voice channel listing (npm run channels)
└── deploy/               # Oracle Cloud + DisCloud guides and templates
```

---

## HTTP endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | HTTP 200 "OK" plus fleet-wide status (text) |
| GET | `/` with `Accept: application/json` | JSON variant |
| GET | `/health` | Compact JSON. **200** when every bot is in voice, **503** when any bot is unhealthy |
| GET | `/bots` | Detailed per-bot JSON |
| GET | `/invite` | Ready-to-use OAuth2 invite link |

Append `?format=json` to `/` or `/invite` to force JSON output.

> `/health` returns **503** whenever a bot hasn't joined voice yet. That's expected during
> startup and makes the endpoint useful as a health monitor. Once every bot reports
> `IN-VOICE`, it returns 200.

---

## Inviting the bots

Fastest route — run `npm run invite`:

```bash
npm run invite                      # minimal preset (ViewChannel + Connect)
npm run invite -- --preset=full     # adds mute/deafen/move-members
npm run invite -- --guild_id=123456789012345678
```

Or boot the bot and open `http://localhost:8080/invite`.

The Application ID is **derived from the token automatically**, so there's no Client ID to copy by hand.

Permissions used:

| Preset | Permissions | Value |
|---|---|---|
| `minimal` (default) | ViewChannel, Connect | `1049600` |
| `recommended` | + MoveMembers, UseEmbeddedActivities | — |
| `full` | + Speak, MuteMembers, DeafenMembers | — |

For pure AFK duty, **`minimal` is enough** — the bot streams no audio, so it never needs `Speak`.

> The bot must **already be in the server** with `Connect` permission before it can enter a voice channel.

---

## Deploying

The project ships with a `Procfile`, `discloud.config`, and a tuned `.gitignore`.

> For **24/7 uptime without sleeping on free-tier cloud**, follow the full guide in
> **[`deploy/README.md`](deploy/README.md)** — Oracle Cloud Always Free with systemd.
> The short version: Discord voice needs persistent WebSocket + UDP, so free tiers that
> suspend idle containers (Render, Koyeb, Replit) **will not work** — the bot drops out of
> voice every time the container sleeps.

### DisCloud
Upload the project; it's detected automatically via `discloud.config`. Add the
**environment variables** (`BOT_1_TOKEN`, etc.) in the DisCloud dashboard. Node.js 22+ is
available by default.

### Railway / Render / Koyeb / Heroku
- Build command: `npm install`
- Start command: `node index.js`
- Add every `BOT_N_TOKEN` as an environment variable
- Railway/Render usually inject `PORT` automatically; `HOST=0.0.0.0` is already the default

### Required in the cloud

| Key | Value |
|---|---|
| `BOT_1_TOKEN` … `BOT_N_TOKEN` | Each bot's token (required) |
| `PORT` | Usually automatic; defaults to `8080` |
| `HOST` | `0.0.0.0` (default, correct for Railway/Render/Fly) |

`config.json` is uploaded as-is — it contains only `vc_id` mappings and `${BOT_N_TOKEN}` placeholders.

---

## Environment variables

Everything is optional except the tokens. See `.env.example` for the full annotated list.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Keep-alive HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error`/`silent` |
| `LOG_FORMAT` | `pretty` | `json` for cloud log aggregators |
| `SELF_MUTE` / `SELF_DEAF` | `true` | Join while muted/deafened |
| `DAVE_ENCRYPTION` | `true` | Discord voice E2EE |
| `LIMIT_CACHE` | `false` | Cap discord.js caches (useful at 50+ bots) |
| `RECONNECT_MAX_ATTEMPTS` | `0` | `0` = retry forever |
| `RECONNECT_INITIAL_DELAY_MS` | `2000` | First retry delay |
| `RECONNECT_MAX_DELAY_MS` | `60000` | Backoff ceiling |
| `RECONNECT_FACTOR` | `1.8` | Exponential factor |
| `RECONNECT_JITTER` | `0.3` | Randomization (0–1) |
| `WATCHDOG_ENABLED` | `true` | Enable the watchdog |
| `WATCHDOG_INTERVAL_MS` | `30000` | Check interval |
| `VOICE_RECOVERY_GRACE_MS` | `20000` | How long the library self-heal is given |
| `VOICE_JOIN_TIMEOUT_MS` | `25000` | Timeout waiting for `Ready` |
| `STARTUP_STAGGER_MS` | `1500` | Gap between instances at startup |
| `SUMMARY_INTERVAL_MS` | `0` | Periodic status summary interval |
| `ENABLE_INVITE_ENDPOINT` | `true` | Enable `/invite` |

---

## Commands

```bash
npm start       # Run all bots
npm run dev     # Run with auto-reload (node --watch)
npm run doctor  # Pre-flight: Node, dependencies, config, live token check
npm run invite  # Generate an OAuth2 invite link
npm run channels# List voice channels and their IDs (bot must be invited)
```

`npm run doctor` checks:
1. Node.js version compatibility
2. Presence of libsodium / DAVE / FFmpeg
3. `config.json` + `.env` validity
4. **Tokens validated live against `discord.com/api/v10/users/@me`**
5. Invite link readiness

Exit code `0` = safe to deploy, `1` = problems found.

### Finding `vc_id` without manual copy-paste

```bash
npm run invite                 # 1) invite one bot to the server first
npm run channels               # 2) the invited bot lists every voice channel
```

`npm run channels` prints each channel's name, a ready-to-paste `vc_id`, and a
`joinable` column flagging channels that bot can't enter yet.

Options: `--token=BOT_2_TOKEN` (look through another bot's view), `--guild_id=<ID>` (limit to
one server), `--json` (machine-readable output).

---

## Troubleshooting

**`An invalid token was provided`**
The token is wrong or was reset. Open the [Developer Portal](https://discord.com/developers/applications) → your app → Bot → **Reset Token** → copy the new one → update `.env`.

**`Voice channel ... was not found` / `bot is not a member of the server`**
- The bot hasn't been invited → use the link from `npm run invite`
- Wrong `vc_id` → enable Developer Mode, right-click the channel → Copy ID
- Missing `View Channel` permission on that channel

**`Timed out ... waiting for the voice connection to become Ready`**
- `Connect` wasn't granted → re-invite with the correct preset
- That bot is **already sitting in another channel using the same token**. Discord permits only one session per token. Give each bot its own token.

**The bot keeps getting disconnected from the channel**
- Channel moves or kicks when the VC is full → make sure the account has no channel limit
- The cloud platform is restarting an idle container → keep the HTTP endpoint enabled and point your monitor at `/health`
- Discord voice rate limits → raise `STARTUP_STAGGER_MS`

**`No enabled bots found`**
Every entry is `enabled: false`, or the `bots` array is empty.

**Config errors at startup**
All problems are reported together, so you don't fix them one restart at a time:

```
Invalid configuration in /path/config.json:
  - #3 ("AcademyBot-3"): token is empty. Provide "token" or "token_env"...
  - #7 ("AcademyBot-7"): "vc_id" must be a Discord snowflake ID (digits only), got "abc"
  - Duplicate bot name "AcademyBot-1" (entries #1 and #8). Names must be unique.
```

---

## Design notes

**Why `libsodium-wrappers`?**
`@discordjs/voice` 0.19 uses DAVE (Discord's E2EE voice protocol), which requires libsodium.
The library detects it automatically; without it, voice connections fail. `npm run doctor` verifies this.

**Why no audio player?**
An AFK bot only needs a live *connection* — it never plays audio. No `AudioResource` is created, so there's no `AudioPlayer` to maintain. That saves CPU and RAM.

**Why only two intents?**
Just `Guilds` and `GuildVoiceStates`. Both are **non-privileged**, so there's no privileged-intent toggle to flip in the Developer Portal, and far less memory overhead.

**Why a watchdog?**
Discord doesn't always emit an event when a bot is silently removed from a channel. The watchdog compares the discord.js cache (`guild.members.me.voice.channelId`) against `vc_id` — this is what catches the "gateway says connected, but the bot is actually gone" case.

**Why a unique `group` per instance?**
`@discordjs/voice` registers connections by `group`. Without a unique group, several bots in the same guild and channel can stomp on each other's connection.

---

## License

MIT