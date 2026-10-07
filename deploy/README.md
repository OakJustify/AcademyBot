# Deploy ke Oracle Cloud Always Free

Panduan lengkap menjalankan 6 bot ini **24/7 tanpa sleep** di Oracle Cloud
Always Free. Semua otomatis: boot → login → masuk voice channel → reconnect
sendiri kalau jatuh.

> **Kenapa Oracle, bukan Render/Railway/Fly?**
> Voice Discord butuh **WebSocket + UDP persisten**. Platform free tier yang
> umum (Render, Koyeb, Replit) me-*suspend* container setelah 15–60 menit idle
> — bot akan keluar dari voice channel setiap kali container itu tidur. Oracle
> Always Free adalah **VM asli yang tidak pernah tidur**, jadi ini satu-satunya
> opsi gratis yang benar-benar 24/7.

Kebutuhan bot ini diukur: **127 MB RAM + ~10% dari satu core** untuk 6 bot.
Jadi kuota Always Free (1–12 GB) jauh lebih dari cukup.

---

## Ringkas

| | |
|---|---|
| Shape | `VM.Standard.A1.Flex` (ARM Ampere) — **1 OCPU / 2 GB** minimum |
| Image | Ubuntu 24.04 (Canonical) |
| Ingress | **Tidak ada yang perlu dibuka.** Default VCN sudah cukup |
| Port lokal | 8080 (bind `127.0.0.1`) |
| Biaya | $0 selamanya |

---

## Bagian 1 — Siapkan akun & kunci SSH (di laptop kamu)

**1.1** Daftar di <https://www.oracle.com/cloud/free/> dan pilih **Home Region**.
Catatan: Always Free hanya bisa dipakai di **home region**, jadi pilih
dekat lokasi kamu (Jakarta/Singapore lebih cepat dari US).

**1.2** Buat pasangan kunci SSH (jika belum punya):

```bash
ssh-keygen -t ed25519 -C "academybot-oracle"
# Enter untuk default path: ~/.ssh/id_ed25519
# Passphrase: bebas (lebih aman pakai pass phrase)
```

**1.3** Siapkan repo ini untuk di-clone dari server. Pilih salah satu:

```bash
# Opsi A — GitHub (gratis)
git remote add origin https://github.com/<user>/DISCORD-BOT.git
git push -u origin main

# Opsi B — tanpa GitHub: nanti cukup jalankan setup.sh dari folder lokal
#     (lihat "Alternatif: tanpa git" di bawah)
```

> ⚠️ Repo ini **tidak pernah** berisi token — `.env` ada di `.gitignore` dan
> sudah diverifikasi tidak ikut ter-commit. Aman di-push ke publik.

---

## Bagian 2 — Buat VM di Oracle

Di **Compute → Instances → Create instance**:

| Field | Nilai |
|---|---|
| **Shape** | `VM.Standard.A1.Flex` (Flexible) |
| OCPU / RAM | **1 OCPU, 2 GB** (atau sampai 2 OCPU / 12 GB) |
| **Image** | `Canonical Ubuntu 24.04` |
| Shape config | Flexible — sisakan alasan untuk instance kedua |
| Boot volume | 50 GB (Always Free memberi 200 GB) |
| Networking | VCN default yang dibuat otomatis, **biarkan ingress default** |
| SSH keys | **Paste public key** `cat ~/.ssh/id_ed25519.pub` |

Klik **Create**, tunggu sampai status `RUNNING`, lalu catat **Public IP**.

### Gagal "Out of host capacity"

Ini hal paling sering terjadi di Oracle Always Free — dan itu bukan salahmu.

1. Ganti **Availability Domain** (klik Edit → Boot volume → AD lain), atau
2. Coba lagi beberapa saat (kapasitas dilepas berkala), atau
3. Ganti region — tapi **harus daftar tenancy baru** dari awal, jadi pakai
   region yang sejak awal free tier-nya tersedia.

Kalau tidak bisa dapat A1 sama sekali, alternatif AMD `VM.Standard.E2.1.Micro`
(2 × 1 GB) **kurang cocok**: CPU-nya cuma 1/8 OCPU per instance, sementara bot
kita butuh ~10% satu core. Akan sering tersendat.

---

## Bagian 3 — Deploy

### 3.1 Masuk ke server

```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@<PUBLIC_IP>
```

User-nya `ubuntu`, bukan root.

### 3.2 Deploy (satu blok perintah)

```bash
sudo apt-get update -qq
sudo apt-get install -y -qq git curl
git clone https://github.com/<user>/DISCORD-BOT.git
cd DISCORD-BOT
sudo bash deploy/setup.sh
```

`setup.sh` akan menjalankan semuanya: pasang Node.js 22, tambah swap, buat
user sistem, pasang service systemd, jalankan.

> **ARM64 aman?** Ya. Semua dependency murni JS/WebAssembly —
> `libsodium-wrappers` (DAVE encryption) adalah WASM, dan FFmpeg yang
> dicek `doctor` **tidak** dibutuhkan untuk bot AFK. Jadi tidak ada
> kompilasi native di ARM.

### 3.3 Isi token

```bash
sudo nano /opt/academybot/.env
```

Isi 6 baris (token hanya tampil **sekali** setelah Reset Token di Developer
Portal; kalau masih kosong di sini berarti belum diisi):

```
BOT_1_TOKEN=<BOT_TOKEN_DISINI>
BOT_2_TOKEN=...
BOT_3_TOKEN=...
BOT_4_TOKEN=...
BOT_5_TOKEN=...
BOT_6_TOKEN=...
```

`vc_id` dan `guild_id` **sudah terisi** di `config.json` (music‑1 … music‑6),
jadi tidak perlu diubah di server.

### 3.4 Jalankan & verifikasi

```bash
sudo systemctl restart academybot
sudo journalctl -u academybot -f
```

Yang diharapkan, berurutan dalam ~15 detik:

```
[AcademyBot-1] Gateway ready • user=AcademyBot-1#7592
[AcademyBot-1] In voice ✓ channel=1555179982135885824 • muted • deafened
...
[AcademyBot-6] In voice ✓ channel=1556336368983220254 • muted • deafened
```

Lalu cek:

```bash
curl -s localhost:8080/health | jq
# { "status": "healthy", "total": 6, "online": 6, "in_voice": 6, "reconnecting": 0 }

curl -s localhost:8080/bots | jq '.bots[] | {name, in_voice, voice_state, reconnects}'
```

`in_voice: 6` + `status: healthy` = siap.

---

## Bagian 4 — Operasional harian

```bash
sudo systemctl status academybot      # status singkat
sudo systemctl restart academybot     # restart
sudo systemctl stop academybot        # stop (bot leave voice channel dgn rapi)
sudo journalctl -u academybot -f      # log live
sudo journalctl -u academybot -o cat -f   # log tanpa prefix systemd
```

Untuk log JSON (enak di-parse), ubah `LOG_FORMAT=json` di
`/opt/academybot/.env` lalu `sudo systemctl restart academybot`.

Bot akan otomatis start lagi setelah reboot — tidak perlu login SSH.

### Update kode

Kalau repo di-push ke GitHub:

```bash
cd /opt/academybot && sudo bash deploy/update.sh
```

### Kalau mau lihat status dari browser

Server tidak membuka port ke internet. Pakai SSH tunnel dari laptop:

```bash
ssh -i ~/.ssh/id_ed25519 -L 8080:127.0.0.1:8080 ubuntu@<PUBLIC_IP>
# lalu buka http://localhost:8080/  di browser
```

---

## Troubleshooting

**`status: degraded`, `in_voice` kurang dari 6**
Lihat penyebabnya per bot:
```bash
curl -s localhost:8080/bots | jq '.bots[] | select(.in_voice==false) | {name, last_error}'
```
Bot otomatis retry, jadi sering kali cukup menunggu 1–2 menit.

**`EADDRINUSE` di log**
Ada proses bot lain masih jalan di port yang sama:
```bash
sudo ss -ltnp | grep 8080
```
**Penting:** dua proses dengan token yang sama akan saling menendang *voice
session* sehingga bot terus-terusan terdorong keluar. Pastikan hanya satu
instance per set token.

**`401` / `An invalid token was provided`**
Token salah atau sudah di-reset di Developer Portal. Update `.env`, lalu
`sudo systemctl restart academybot`.

**Bot masuk channel tapi langsung keluar**
Cek permission bot di channel tersebut harus ada `View Channel` + `Connect`.
Verifikasi dengan script discovery (jalankan dari laptop):
```bash
npm run channels -- --token=BOT_1_TOKEN
```

**Service tidak mau start sama sekali**
```bash
sudo systemctl status academybot
sudo journalctl -u academybot -n 50 --no-pager
```
Penyebab paling umum: `.env` belum diisi (service tetap start, tapi bot tidak
bisa login) atau `node` tidak ada di `/usr/bin/node` (lihat `ExecStart` di
`/etc/systemd/system/academybot.service`).

---

## Catatan biaya & akun

- Selalu **pasang budget alarm** setelah akun aktif, meski Always Free tidak
  boleh ditagih: `Billing & Cost Management → Budgets → Create budget $1`.
  Ini hanya peringatan, tapi berguna sebagai pagar pengaman.
- Free Trial $300 berlaku 30 hari; setelahnya akun otomatis jadi **Always
  Free** dan seluruh resource Always Free **tidak pernah direklam**.
- June 2026: kuota Ampere A1 dipangkas dari 4 OCPU/24 GB jadi **2 OCPU/12 GB**.
  Kalau instance kamu pernah dikonfigurasi lebih besar, resize ke
  1–2 OCPU / ≤12 GB.
- Jangan upgrade ke Pay‑As‑You‑Go kecuali memang punya anggaran; dengan Always
  Free saja tagihan selalu $0.

---

## Alternatif: tanpa git

Kalau tidak mau pakai GitHub, salin repo ke server dari laptop:

```bash
# dari laptop — .env ikut terbawa supaya token tidak perlu diketik ulang
tar -czf academybot.tgz --exclude=node_modules DISCORD-BOT/
scp academybot.tgz ubuntu@<PUBLIC_IP>:/tmp/

# lalu di server
ssh -i ~/.ssh/id_ed25519 ubuntu@<PUBLIC_IP>
cd /tmp && tar -xzf academybot.tgz && cd DISCORD-BOT
sudo bash deploy/setup.sh

# HAPUS arsipnya — isinya berisi token plaintext
rm -f /tmp/academybot.tgz
```

`setup.sh` menyalin ke `/opt/academybot` dengan `chmod 600` untuk `.env`, dan
selama update file itu tidak pernah ditimpa. Token tidak pernah menyentuh git.

> ⚠️ `academybot.tgz` berisi 6 token dalam bentuk plaintext. Jangan pernah
> commit atau membagikan file itu, dan hapus setelah deploy (perintah di atas).
