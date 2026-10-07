# Multi-Bot 24/7 Voice Channel Stay

Menjalankan **banyak bot Discord dalam satu proses Node.js**, masing-masing otomatis login lalu **standby permanen di Voice Channel** supaya channel tidak pernah kosong/mati.

Menambah bot ke-7, ke-10, atau ke-50 cukup dengan menambah satu objek di `config.json`. **`index.js` tidak pernah berubah.**

---

## 1. Fitur

| Fitur | Keterangan |
|---|---|
| Multi-instance | Satu proses menjalankan N bot, masing-masing dengan token & VC sendiri |
| Auto join | Otomatis masuk ke Voice Channel target saat start |
| Auto reconnect | Putus karena crash / restart Discord / gangguan jaringan → join ulang otomatis |
| Watchdog | Cek berkala "apakah bot benar-benar masih di VC?" → join ulang bila hilang/dipindah/di-kick |
| Mute / Deaf | Default `true` (hemat bandwidth), configurable per bot |
| DAVE E2EE | Enkripsi voice end-to-end Discord, aktif secara default |
| Keep-alive HTTP | Server Express di port 8080 → mencegah container di-sleep di cloud gratisan |
| Isolasi error | Satu bot crash **tidak** menjatuhkan bot lain |
| Graceful shutdown | `SIGTERM`/`SIGINT` → semua bot keluar VC dengan rapi |
| Validasi config | Error config dikumpulkan **semua sekaligus**, bukan satu per satu |
| Health check CLI | `npm run doctor` → cek versi Node, dependency native, dan token secara live |

### Lapis proteksi (3 lapis, saling menutupi)

1. **Discord.js events** — voice state change (`Disconnected`/`Destroyed`/`Signalling`), gateway shard disconnect.
2. **Watchdog timer** (default 30 detik) — memakai `guild.members.me.voice.channelId` untuk memastikan bot benar-benar masih di channel, bukan cuma "terhubung".
3. **Supervisor loop** — login/join gagal → exponential backoff + jitter, retry sampai berhasil.

Setiap instance juga memakai **voice `group` unik** (`afk-bot-N-<vcId>`), sehingga bot tidak pernah saling berebut connection yang sama.

---

## 2. Requirements

- **Node.js ≥ 22.12.0** (disyaratkan oleh `@discordjs/voice` 0.19+). Cek: `node -v`
- Akun Discord, dan **1 application per bot** di [Discord Developer Portal](https://discord.com/developers/applications)

---

## 3. Cara pakai (lokal)

```bash
cd ~/Projects/DISCORD-BOT

# 1) Install dependency
npm install

# 2) Siapkan environment
cp .env.example .env

# 3) Isi token di .env
#    BOT_1_TOKEN=...  BOT_2_TOKEN=...  dst.
#    Token: Developer Portal > Applications > <App> > Bot > Reset Token
#    (token hanya ditampilkan SATU KALI)

# 4) Isi vc_id di config.json
#    Cara cepat: Discord > Settings > Advanced > Developer Mode (ON)
#    Klik kanan channel > Copy ID

# 5) Validasi Everything
npm run doctor

# 6) Jalankan
npm start
```

Bot otomatis login dan join. Buka `http://localhost:8080` untuk melihat status seluruh bot.

---

## 4. Menambah / mengurangi bot

Tambah 1 baris di `.env` dan 1 objek di `config.json`. **Kode tidak diubah.**

```jsonc
// config.json → array "bots"
{
  "name": "AFK Bot 7",          // WAJIB unik
  "token": "${BOT_7_TOKEN}",   // dibaca dari .env
  "vc_id": "1234567890123456789",
  "enabled": true              // false = skip tanpa dihapus
}
```

Opsi tambahan per bot (semua opsional):

```jsonc
{
  "name": "AFK Bot 7",
  "token": "${BOT_7_TOKEN}",
  "vc_id": "1234567890123456789",
  "guild_id": "987654321098765432",   // opsional; auto-detect bila kosong
  "enabled": true,
  "selfMute": true,
  "selfDeaf": true,
  "daveEncryption": true,
  "presence": {
    "status": "idle",
    "activities": [{ "name": "AFK di voice", "type": "Playing" }]
  },
  "reconnect": { "maxAttempts": 0, "initialDelay": 2000, "maxDelay": 60000 },
  "watchdog": { "enabled": true, "intervalMs": 30000 }
}
```

Token juga bisa ditulis langsung (`"token": "MTA4..."`) jika tidak ingin memakai `.env`, atau pakai `token_env`:

```jsonc
{ "name": "AFK Bot 8", "token_env": "MY_CUSTOM_TOKEN_VAR", "vc_id": "..." }
```

---

## 5. Struktur project

```
DISCORD-BOT/
├── index.js              # Entry point: boot, banner, signal handling
├── config.json           # Mapping token -> vc_id (6 bot default)
├── .env.example          # Template environment variables
├── package.json
├── discloud.config       # Deployment DisCloud
├── Procfile               # Deployment Heroku/Railway/DisCloud
├── src/
│   ├── settings.js       # Load + validasi config.json & .env
│   ├── BotManager.js     # Kelola seluruh fleet, agregasi status
│   ├── BotInstance.js    # 1 bot: login, join, reconnect, watchdog
│   ├── httpServer.js     # Express keep-alive + status endpoint
│   ├── permissions.js    # Permission preset & invite URL
│   ├── logger.js         # Logging rapi (warna / JSON)
│   └── utils.js          # Helper: backoff, sleep, masking token
└── scripts/
    ├── doctor.js         # Pre-flight check (npm run doctor)
    └── generate-invite.js# Generate link invite (npm run invite)
```

---

## 6. HTTP Endpoint

| Method | Path | Fungsi |
|---|---|---|
| GET | `/` | HTTP 200 "OK" + status seluruh bot (teks) |
| GET | `/` + `Accept: application/json` | Versi JSON |
| GET | `/health` | JSON ringkas. **200** jika semua bot di VC, **503** bila ada yang bermasalah |
| GET | `/bots` | JSON detail per bot |
| GET | `/invite` | Link invite OAuth2 siap pakai |

Tambahkan `?format=json` pada `/` atau `/invite` untuk memaksa output JSON.

> Endpoint `/health` mengembalikan **503** saat ada bot yang belum masuk voice. Itu normal saat startup, dan justru berguna sebagai health monitor. Jika semua bot sudah `IN-VOICE`, hasilnya 200.

---

## 7. Invite bot ke server

Cara tercepat — jalankan `npm run invite`:

```bash
npm run invite                      # preset minimal (ViewChannel + Connect)
npm run invite -- --preset=full     # tambah izin mute/deafen/move members
npm run invite -- --guild_id=123456789012345678
```

Atau boot bot lalu buka `http://localhost:8080/invite`.

Application ID **diturunkan otomatis dari token**, jadi tidak perlu menyalin Client ID secara manual.

Permission yang dipakai:

| Preset | Permissions | Nilai |
|---|---|---|
| `minimal` (default) | ViewChannel, Connect | `1049600` |
| `recommended` | + MoveMembers, UseEmbeddedActivities | — |
| `full` | + Speak, MuteMembers, DeafenMembers | — |

Untuk bot AFK murni, **`minimal` sudah cukup** — bot tidak melakukan streaming audio, jadi tidak butuh izin `Speak`.

> Bot **harus sudah ada di server** dengan izin `Connect` untuk bisa masuk Voice Channel.

---

## 8. Deploy ke cloud

Project sudah siap upload: ada `Procfile`, `discloud.config`, dan `.gitignore`.

> Untuk **24/7 tanpa sleep di cloud gratis**, ikuti panduan lengkap di
> **[`deploy/README.md`](deploy/README.md)** — Oracle Cloud Always Free dengan
> systemd. Ringkasnya: voice Discord butuh WebSocket + UDP persisten, jadi
> platform free tier yang me-suspend container (Render, Koyeb, Replit) TIDAK
> bisa dipakai — bot akan keluar dari voice channel setiap container tidur.

### DisCloud
Upload project → otomatis terdeteksi dari `discloud.config`. Tambahkan **Environment Variables** (`BOT_1_TOKEN`, dst.) di dashboard DisCloud. Node.js 22+ tersedia secara default.

### Railway / Render / Koyeb / Heroku
- Build command: `npm install`
- Start command: `node index.js`
- Tambahkan semua `BOT_N_TOKEN` sebagai environment variables
- Railway/Render biasanya inject `PORT` otomatis; `HOST=0.0.0.0` sudah jadi default

### Yang WAJIB diisi di cloud

| Key | Nilai |
|---|---|
| `BOT_1_TOKEN` … `BOT_N_TOKEN` | Token masing-masing bot (wajib) |
| `PORT` | Usually auto; default `8080` |
| `HOST` | `0.0.0.0` (default, benar untuk Railway/Render/Fly) |

File `config.json` ikut ter-upload — isinya hanya mapping `vc_id` dan placeholder `${BOT_N_TOKEN}`.

---

## 9. Environment variables

Semua opsional kecuali token. Lihat `.env.example` untuk daftar lengkap + komentar.

| Variable | Default | Fungsi |
|---|---|---|
| `PORT` | `8080` | Port HTTP keep-alive |
| `HOST` | `0.0.0.0` | Bind address |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error`/`silent` |
| `LOG_FORMAT` | `pretty` | `json` untuk log aggregator cloud |
| `SELF_MUTE` / `SELF_DEAF` | `true` | Join dalam keadaan mute/deaf |
| `DAVE_ENCRYPTION` | `true` | Voice E2EE Discord |
| `LIMIT_CACHE` | `false` | Batasi cache discord.js (untuk 50+ bot) |
| `RECONNECT_MAX_ATTEMPTS` | `0` | `0` = retry selamanya |
| `RECONNECT_INITIAL_DELAY_MS` | `2000` | Delay retry pertama |
| `RECONNECT_MAX_DELAY_MS` | `60000` | Batas atas backoff |
| `RECONNECT_FACTOR` | `1.8` | Faktor exponential |
| `RECONNECT_JITTER` | `0.3` | Randomisasi (0–1) |
| `WATCHDOG_ENABLED` | `true` | Aktifkan watchdog |
| `WATCHDOG_INTERVAL_MS` | `30000` | Interval cek |
| `VOICE_RECOVERY_GRACE_MS` | `20000` | Waktu tunggu library self-heal |
| `VOICE_JOIN_TIMEOUT_MS` | `25000` | Batas tunggu status `Ready` |
| `STARTUP_STAGGER_MS` | `1500` | Jarak antar instance saat start |
| `SUMMARY_INTERVAL_MS` | `0` | Cetak ringkasan periodik |
| `ENABLE_INVITE_ENDPOINT` | `true` | Aktifkan `/invite` |

---

## 10. Commands

```bash
npm start       # Jalankan semua bot
npm run dev     # Jalankan dengan auto-reload (node --watch)
npm run doctor  # Pre-flight check: Node, dependency, config, token live
npm run invite  # Generate link invite OAuth2
npm run channels # Daftar voice channel + ID-nya (butuh bot sudah di-invite)
```

`npm run doctor` memeriksa:
1. Kompatibilitas versi Node.js
2. Keberadaan libsodium / DAVE / FFmpeg
3. Validasi `config.json` + `.env`
4. **Token dicek live ke `discord.com/api/v10/users/@me`**
5. Link invite siap pakai

Exit code `0` = aman deploy, `1` = ada masalah.

### Menemukan `vc_id` tanpa copy-paste manual

```bash
npm run invite                 # 1) invite satu bot dulu ke server
npm run channels               # 2) bot yang di-invite akan listing semua voice channel
```

`npm run channels` mencetak nama channel, `vc_id` yang bisa langsung disalin, dan
kolom `joinable` — channel yang belum bisa dimasuki bot tersebut.

Opsi: `--token=BOT_2_TOKEN` (lihat lewat akun bot lain), `--guild_id=<ID>` (batasi
satu server), `--json` (output untuk tooling).

---

## 11. Troubleshooting

**`An invalid token was provided`**
Token salah / sudah di-reset. Buka [Developer Portal](https://discord.com/developers/applications) → app Anda → Bot → **Reset Token** → salin yang baru → update `.env`.

**`Voice channel ... was not found` / `bot is not a member of the server`**
- Bot belum di-invite ke server → pakai link dari `npm run invite`
- `vc_id` salah → nyalakan Developer Mode, klik kanan channel → Copy ID
- Permission `View Channel` belum diberikan di channel tersebut

**`Timed out ... waiting for the voice connection to become Ready`**
- `Connect` belum diberikan → invite ulang dengan preset yang benar
- Bot sudah **duduk di channel lain** dengan **token yang sama**. Discord hanya mengizinkan satu sesi per token. Beri setiap bot token sendiri.

**Bot tetap kicked dari channel**
-/channel move/ kicks saat VC penuh → pastikan user tidak punya batas channel
- Cloud platform me-restart karena container idle → pastikan endpoint HTTP aktif dan monitor diarahkan ke `/health`
- Rate limit voice Discord → naikkan `STARTUP_STAGGER_MS`

**`No enabled bots found`**
Semua entri `enabled: false`, atau array `bots` kosong.

**Config error saat start**
Semua masalah config ditampilkan sekaligus, tidak perlu diperbaiki satu per satu:

```
Invalid configuration in /path/config.json:
  - #3 ("AFK Bot 3"): token is empty. Provide "token" or "token_env"...
  - #7 ("AFK Bot 7"): "vc_id" must be a Discord snowflake ID (digits only), got "abc"
  - Duplicate bot name "AFK Bot 1" (entries #1 and #8). Names must be unique.
```

---

## 12. Catatan teknis

**Kenapa `libsodium-wrappers`?**
`@discordjs/voice` 0.19 memakai protokol DAVE (Enkripsi voice E2EE Discord) yang membutuhkan libsodium. Library akan mendeteksinya otomatis; tanpa ini, voice connection gagal. `npm run doctor` memverifikasinya.

**Kenapa tidak ada audio player?**
Bot AFK hanya perlu *connection* yang hidup — tidak perlu memutar suara. Tidak ada `AudioResource` yang dibuat, jadi tidak ada `AudioPlayer` yang perlu di-maintain. Ini menghemat CPU dan RAM.

**Kenapa hanya 2 intents?**
Hanya `Guilds` + `GuildVoiceStates`. Keduanya **non-privileged**, jadi tidak perlu mengaktifkan toggle intent di Developer Portal. jauh lebih hemat.

**Kenapa perlu watchdog?**
Discord tidak selalu mengirim event saat bot diam-diam dikeluarkan dari channel. Watchdog membandingkan cache discord.js (`guild.members.me.voice.channelId`) dengan `vc_id` — inilah yang menangkap kasus "gateway bilang terhubung, tapi bot sebenarnya sudah tidak ada di channel".

**Kenapa `group` unik per instance?**
`@discordjs/voice` meng-register connection berdasarkan `group`. Tanpa group unik, beberapa bot di guild+channel yang sama bisa saling menabrakkan connection-nya.