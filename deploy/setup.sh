#!/usr/bin/env bash
#
# deploy/setup.sh — pasang AcademyBot di server Linux (Oracle Cloud Always Free
#                   atau VPS mana pun) sebagai service systemd.
#
# Dijalankan sebagai root, dari dalam checkout repo:
#
#     sudo bash deploy/setup.sh
#     sudo bash deploy/setup.sh --repo https://github.com/USER/REPO.git
#
# Idempoten: aman dijalankan berulang kali.
#
# Yang dikerjakan:
#   1. Pastikan Node.js >= 22.12 (dari NodeSource bila perlu)
#   2. Tambah swap 1 GB bila RAM < 2 GB (mesin Oracle sering cuma 1 GB)
#   3. Buat user sistem `academybot` tanpa login
#   4. Salin repo ke /opt/academybot (tanpa node_modules dan tanpa .env)
#   5. npm ci --omit=dev
#   6. Buat .env dari template bila belum ada (mode 600)
#   7. Pasang + enable + start service systemd
#
# Tidak perlu port masuk dari internet: voice Discord itu koneksi OUTBOUND.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/academybot}"
SERVICE_NAME="academybot"
SERVICE_USER="${SERVICE_USER:-academybot}"
SERVICE_GROUP="${SERVICE_USER}"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
UNIT_SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/${SERVICE_NAME}.service"
ENV_TEMPLATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.template"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=12
REPO_URL=""
REPO_REF=""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
if [[ ! -t 1 || -n "${NO_COLOR:-}" ]]; then BOLD=""; GREEN=""; YELLOW=""; RED=""; RESET=""; fi

step()  { printf '\n%s==>%s %s%s%s\n' "$BOLD" "$RESET" "$BOLD" "$*" "$RESET"; }
info()  { printf '    %s\n' "$*"; }
ok()    { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn()  { printf '    %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die()   { printf '\n%sERROR:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

# Node >= 22.12.0
node_is_supported() {
  command -v node >/dev/null 2>&1 || return 1
  local v major minor
  v="$(node --version 2>/dev/null | sed 's/^v//')" || return 1
  major="${v%%.*}"
  minor="$(printf '%s' "$v" | cut -d. -f2)"
  [[ "$major" -gt "$MIN_NODE_MAJOR" ]] && return 0
  [[ "$major" -eq "$MIN_NODE_MAJOR" && "$minor" -ge "$MIN_NODE_MINOR" ]] && return 0
  return 1
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --repo) REPO_URL="${2:-}"; shift 2 ;;
      --repo=*) REPO_URL="${1#*=}"; shift ;;
      --ref) REPO_REF="${2:-}"; shift 2 ;;
      --ref=*) REPO_REF="${1#*=}"; shift ;;
      --dir) APP_DIR="${2:-}"; shift 2 ;;
      --dir=*) APP_DIR="${1#*=}"; shift ;;
      -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
      *) die "Argumen tidak dikenal: $1 (coba --help)" ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# 0) Pre-flight
# ---------------------------------------------------------------------------
parse_args "$@"

[[ "${EUID}" -eq 0 ]] || die "Harus dijalankan sebagai root. Coba: sudo bash $0 ${*:+${*}}"
[[ -f /etc/os-release ]] || die "/etc/os-release tidak ditemukan — sistem tidak didukung."
# shellcheck disable=SC1091
. /etc/os-release
info "sistem  : ${PRETTY_NAME:-unknown} ($(uname -m))"
info "app dir : ${APP_DIR}"

SRC_DIR="$(pwd)"
if [[ -n "$REPO_URL" ]]; then
  info "source  : clone dari ${REPO_URL}"
elif [[ -f "$SRC_DIR/index.js" && -f "$SRC_DIR/package.json" ]]; then
  info "source  : repo lokal ${SRC_DIR}"
else
  die "Tidak menemukan repo di ${SRC_DIR}. Jalankan dari dalam repo, atau pakai --repo <url>."
fi

command -v systemctl >/dev/null 2>&1 || die "systemd tidak tersedia. Skrip ini butuh Ubuntu/Debian dengan systemd."

# Hentikan service lama dulu supaya tidak ada proses yang memegang port 8080
# atau sempat memakai token yang sama (dua proses = saling tendang voice session).
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  step "Menghentikan service lama"
  systemctl stop "$SERVICE_NAME"
  sleep 3
  ok "service lama dihentikan"
fi

# ---------------------------------------------------------------------------
# 1) Node.js
# ---------------------------------------------------------------------------
step "Memeriksa Node.js"
if node_is_supported; then
  ok "Node.js $(node --version) sudah memenuhi syarat"
else
  info "Node.js lama atau tidak ada — memasang Node.js ${MIN_NODE_MAJOR}.x dari NodeSource"
  command -v curl >/dev/null 2>&1 || die "curl belum terpasang. Jalankan: apt-get install -y curl"
  curl -fsSL "https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | bash -
  apt-get install -y --no-install-recommends nodejs
  node_is_supported || die "Node.js terpasang tapi versinya masih salah: $(node --version 2>/dev/null || echo 'tidak ada')"
  ok "Node.js $(node --version) terpasang"
fi
# ExecStart di unit file memakai /usr/bin/node secara hardcode.
[ "$(command -v node)" = "/usr/bin/node" ] || warn "node ada di $(command -v node), bukan /usr/bin/node — unit systemd akan disesuaikan."

# ---------------------------------------------------------------------------
# 2) Swap (mesin Oracle free tier sering cuma 1 GB RAM)
# ---------------------------------------------------------------------------
step "Memeriksa memori"
TOTAL_MB="$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)"
info "RAM total: ${TOTAL_MB} MB"
if [[ "$TOTAL_MB" -lt 2048 ]]; then
  if swapon --show=NAME --noheadings | grep -q .; then
    ok "swap sudah aktif"
  else
    warn "RAM < 2 GB — membuat swap 1 GB (mencegah OOM saat npm ci)"
    fallocate -l 1G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=1024
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -q '/swapfile' /etc/fstab || printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
    ok "swap 1 GB aktif"
  fi
else
  ok "RAM cukup, skip swap"
fi

# ---------------------------------------------------------------------------
# 3) User sistem
# ---------------------------------------------------------------------------
step "Menyiapkan user ${SERVICE_USER}"
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  ok "user ${SERVICE_USER} sudah ada"
else
  useradd --system --create-home --home-dir "/home/${SERVICE_USER}" --shell /usr/sbin/nologin "$SERVICE_USER"
  ok "user ${SERVICE_USER} dibuat (login dinonaktifkan)"
fi
id -g "$SERVICE_GROUP" >/dev/null 2>&1 || groupadd --system "$SERVICE_GROUP"

# ---------------------------------------------------------------------------
# 4) Salin source
# ---------------------------------------------------------------------------
step "Menyalin aplikasi ke ${APP_DIR}"
TMP_CLONE="$(mktemp -d)"
cleanup() { rm -rf "$TMP_CLONE"; }
trap cleanup EXIT

if [[ -n "$REPO_URL" ]]; then
  command -v git >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y --no-install-recommends git; }
  git clone --depth 1 "${REPO_URL}" "$TMP_CLONE/src" ${REPO_REF:+--branch "$REPO_REF"}
  SRC_DIR="$TMP_CLONE/src"
fi

mkdir -p "$APP_DIR"
# .env sengaja TIDAK ikut tersalin: file itu berisi token dan harus bertahan
# saat update. Node_modules juga di-exclude lalu dibangun ulang oleh npm ci.
tar -C "$SRC_DIR" \
    --exclude=./node_modules \
    --exclude=./.env \
    --exclude=./deploy/.env \
    -cf - . | tar -C "$APP_DIR" -xf -
ok "source tersalin ($(find "$APP_DIR" -maxdepth 1 -type f | wc -l) file di root)"

# ---------------------------------------------------------------------------
# 5) Dependency
# ---------------------------------------------------------------------------
step "Memasang dependency"
cd "$APP_DIR"
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi
ok "$(node -e "const d=require('./package.json').dependencies;console.log(Object.keys(d).length)") dependency terpasang"

# ---------------------------------------------------------------------------
# 6) .env
# ---------------------------------------------------------------------------
step "Menyiapkan file .env"
if [[ -f "$APP_DIR/.env" ]]; then
  ok ".env sudah ada — tidak ditimpa (token aman)"
else
  [[ -f "$ENV_TEMPLATE" ]] || die "Template tidak ditemukan: $ENV_TEMPLATE"
  cp "$ENV_TEMPLATE" "$APP_DIR/.env"
  ok ".env dibuat dari template — SEKARANG ISI TOKENNYA"
fi
chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "$APP_DIR"
chmod 700 "$APP_DIR"
chmod 600 "$APP_DIR/.env"
ok "izin file: dir 700, .env 600, pemilik ${SERVICE_USER}"

# ---------------------------------------------------------------------------
# 7) systemd
# ---------------------------------------------------------------------------
step "Memasang service systemd"
[[ -f "$UNIT_SOURCE" ]] || die "Unit file tidak ditemukan: $UNIT_SOURCE"
install -m 0644 "$UNIT_SOURCE" "$UNIT_PATH"

if [[ "$(command -v node)" != "/usr/bin/node" ]]; then
  sed -i "s|^ExecStart=.*|ExecStart=$(command -v node) index.js|" "$UNIT_PATH"
  warn "ExecStart disesuaikan ke $(command -v node)"
fi

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
ok "service terpasang & enabled (auto-start saat reboot)"

systemctl restart "$SERVICE_NAME"
sleep 5

if systemctl is-active --quiet "$SERVICE_NAME"; then
  ok "service berjalan"
else
  warn "service TIDAK berjalan. 30 baris log terakhir:"
  journalctl -u "$SERVICE_NAME" -n 30 --no-pager | sed 's/^/    /'
  exit 1
fi

# ---------------------------------------------------------------------------
# 8) Verifikasi
# ---------------------------------------------------------------------------
step "Memverifikasi"
sleep 10
HEALTH="$(curl -fsS --max-time 5 "http://127.0.0.1:${PORT:-8080}/health" 2>/dev/null || true)"

if [[ -n "$HEALTH" ]]; then
  ok "endpoint /health menjawab"
  printf '    %s\n' "$HEALTH"
else
  warn "endpoint /health belum menjawab (bot mungkin masih Starting)."
fi

if grep -qE '^\s*BOT_1_TOKEN=.+' "$APP_DIR/.env" 2>/dev/null; then
  ok "BOT_1_TOKEN terisi"
else
  warn "Token masih kosong — bot akan retry tanpa henti dan tidak akan masuk voice."
fi

BOT_COUNT="$(node -e "
  const {loadSettings}=require('./src/settings');
  process.env.CONFIG_FILE=process.env.CONFIG_FILE||'config.json';
  console.log(loadSettings({requireTokens:false}).bots.length);
" 2>/dev/null || echo '?')"

printf '\n%s%sLANGKAH BERIKUTNYA%s\n' "$BOLD" "$GREEN" "$RESET"
printf '  1. Isi token di server:\n'
printf '       %snano %s/.env%s\n' "$BOLD" "$APP_DIR" "$RESET"
printf '       Isi BOT_1_TOKEN .. BOT_6_TOKEN (%s bot terkonfigurasi).\n' "$BOT_COUNT"
printf '  2. Restart service:\n'
printf '       %ssystemctl restart %s%s\n' "$BOLD" "$SERVICE_NAME" "$RESET"
printf '  3. Pantau log sampai 6 bot "In voice":\n'
printf '       %sjournalctl -u %s -f%s\n' "$BOLD" "$SERVICE_NAME" "$RESET"
printf '  4. Cek status cepat:\n'
printf '       %scurl -s localhost:%s/health | jq%s\n' "$BOLD" "${PORT:-8080}" "$RESET"
printf '\n _URL_ : https://localhost:8080/  (SSH tunnel: ssh -L 8080:localhost:8080 <server>)\n\n'
