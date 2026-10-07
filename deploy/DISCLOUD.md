# Deploy ke DisCloud

Panduan menjalankan 6 bot ini di DisCloud.

> ## ⚠️ Wajib baca dulu: Free plan DisCloud TIDAK bisa dipakai
>
> | | |
> |---|---|
> | RAM DisCloud **Free** | **100 MB** |
> | RAM yang dibutuhkan bot ini | **~104 MB** (terukur, 6/6 masuk voice) |
> | Plan yang bisa | **Gold (1 GB)** atau lebih besar |
>
> Aplikasi yang melewati alokasi RAM akan **dipaksa dimatikan** oleh DisCloud.
>
> Selain itu, DisCloud free punya **anti-ghost app policy**: aplikasi idle
> dimatikan setelah beberapa hari untuk menghemat sumber daya.
>
> Rekomendasi: pakai **Gold 1 GB**. Bot ini hanya memakai ~10% dari RAM itu.
> Alternatif tanpa bayar: hosting di [**Oracle Cloud Always Free**](README.md)
> (tapi butuh kartu kredit).

---

## Yang perlu disiapkan

1. Akun **DisCloud** + kode untuk boot bot **AcademyBot-1** (Application ID
   `1557269865511784448`)
2. Plan Gold (atau lebih besar) — set RAM **1024**
3. Project sudah membawa `discloud.config` yang benar, jadi konfigurasi minim

---

## Cara deploy

### 1. Upload project

Upload folder project ini (zip) lewat dashboard DisCloud, atau pakai CLI:

```bash
# DisCloud CLI (jika terpasang)
discloud login
discloud upload

# atau lewat ekstensi VS Code: "DisCloud" > Upload
```

Pastikan **file `.env` ikut terupload** — DisCloud membaca token dari sana.
Kalau upload lewat `.gitignore`, `.env` otomatis ikut karena diabaikan git.

### 2. Isi Environment Variables di dashboard

**Settings → Variables → Add**, tambahkan:

| Key | Value |
|---|---|
| `BOT_1_TOKEN` | token dari Developer Portal |
| `BOT_2_TOKEN` | … |
| `BOT_3_TOKEN` | … |
| `BOT_4_TOKEN` | … |
| `BOT_5_TOKEN` | … |
| `BOT_6_TOKEN` | … |
| `HTTP_ENABLED` | `false` |
| `SELF_MUTE` | `true` |
| `SELF_DEAF` | `true` |
| `RECONNECT_MAX_ATTEMPTS` | `0` |
| `LOG_LEVEL` | `info` |

> `HTTP_ENABLED=false` wajib. Di DisCloud tidak ada HTTP health check, jadi
> Express hanya buang-buang RAM. Hemat ~3 MB.
>
> Token **tidak pernah** ditulis di `config.json` — file itu hanya berisi
> `vc_id` dan `guild_id` yang tidak sensitif.

### 3. Start

Klik **Start**. Di halaman bot, isi **Application ID**: `1557269865511784448`

Log yang benar (dalam ~15 detik):

```
INFO  [http] (dilewati karena HTTP_ENABLED=false)
INFO  [AcademyBot-1] Gateway ready • user=AcademyBot-1#7592
INFO  [AcademyBot-1] In voice ✓ channel=1555179982135885824 • muted • deafened
...
INFO  [AcademyBot-6] In voice ✓ channel=1556336368983220254 • muted • deafened
```

Kalau muncul `Fatal startup error` — cek log DisCloud untuk pesan lengkapnya.

---

## Menghemat RAM (opsional)

Kalau RAM-nya masih ketat, pakai mode ramping. Di dashboard ubah **Start
Command** (atau edit `discloud.config`):

```
npm run start:lean
```

Apa bedanya: `node --max-old-space-size=96 --max-semi-space-size=1 index.js`

Terukur:

| Start command | HTTP | RSS | 6 bot di voice |
|---|---|---|---|
| `npm start` | aktif | 122 MB | ✅ |
| `npm start` | `HTTP_ENABLED=false` | 122 MB | ✅ |
| `npm run start:lean` | `HTTP_ENABLED=false` | **104 MB** | ✅ |
| `npm run start:lean` | `HTTP_ENABLED=false` + heap 72 | 105 MB | ❌ 5/6 |

`start:lean` memaksa GC lebih agresif — RAM turun ~15%. Jangan turunkan
heap di bawah 96 MB: di 72 MB satu bot gagal join (terbukti).

---

## Troubleshooting

**`FATAL: ... engine node >=22.12.0`** (atau error versi lain)
DisCloud menjalankan Node versi lama. `discloud.config` sudah diset
`"version": "22"` — pastikan file itu ikut terupload. Kalau plan kamu tidak
menawarkan Node 22, pilih plan lain.

**Bot berulang reconnect / `Failed to stay in voice`**
Cek permission di channel: harus ada `View Channel` + `Connect` untuk role
bot. Verifikasi dari laptop:
```bash
npm run channels -- --token=BOT_1_TOKEN
```

**`Insufficient RAM` / aplikasi mati mendadak**
Aplikasi kena limit RAM. Naikkan RAM di dashboard, atau pastikan
`HTTP_ENABLED=false` sudah aktif.

**Semua bot offline setelah beberapa hari**
Itu **anti-ghost policy** milik DisCloud Free. Tidak ada setting yang
mengatasinya — wajib pakai plan berbayar.

**Token invalid setelah upload ulang**
`.env` tidak ikut terupload. Cek daftar Variables di dashboard.

---

## Catatan

- DisCloud **tidak** membaca `Procfile` (itu format Heroku/Render). Yang
  dipakai adalah `discloud.config`.
- **Auto Restart hanya tersedia di plan Platinum ke atas.** Di Gold, kalau
  proses crash kamu harus klik Start manual. Ini penting untuk target "24/7":
  script sudah retry sendiri selama prosesnya hidup, tapi kalau prosesnya
  mati total tidak ada yang menghidupkan kembali.- Karena `HTTP_ENABLED=false`, `HOST` dan `PORT` tidak relevan di DisCloud —
  tidak ada port yang perlu dibuka.
