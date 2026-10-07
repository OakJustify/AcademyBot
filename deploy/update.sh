#!/usr/bin/env bash
#
# deploy/update.sh — tarik perubahan terbaru dari git lalu restart service.
#
#     sudo bash deploy/update.sh
#
# Aman untuk dijalankan berulang kali. File .env TIDAK pernah ditimpa.
#
# Kalau /opt/academybot bukan git clone (mis. karena setup.sh dijalankan dari
# folder hasil upload/copy), skrip ini akan menjatuhkan ke jalur manual dan
# memberi perintahnya.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/academybot}"
SERVICE_NAME="academybot"

BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
if [[ ! -t 1 || -n "${NO_COLOR:-}" ]]; then BOLD=""; GREEN=""; YELLOW=""; RED=""; RESET=""; fi

step() { printf '\n%s==>%s %s%s%s\n' "$BOLD" "$RESET" "$BOLD" "$*" "$RESET"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '    %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die()  { printf '\n%sERROR:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || die "Harus root: sudo bash $0"
[[ -d "$APP_DIR" ]] || die "Direktori ${APP_DIR} tidak ada. Jalankan setup.sh dulu."

if [[ ! -d "$APP_DIR/.git" ]]; then
  step "Bukan git clone"
  warn "${APP_DIR} tidak punya .git — tidak bisa 'git pull'."
  info "Jalankan ulang: sudo bash deploy/setup.sh   (file .env tetap dipertahankan)"
  exit 1
fi

BRANCH="$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"

step "Menghentikan service"
systemctl stop "$SERVICE_NAME" 2>/dev/null || true
sleep 3
ok "dihentikan (penting: dua proses dengan token sama akan saling tendang voice session)"

step "Menarik perubahan (branch ${BRANCH})"
if git -C "$APP_DIR" pull --ff-only; then
  ok "ter-update ke $(git -C "$APP_DIR" rev-parse --short HEAD)"
else
  warn "git pull gagal."
  info "Perbaiki manual di ${APP_DIR}, atau jalankan:"
  info "  git -C ${APP_DIR} fetch --all && git -C ${APP_DIR} reset --hard origin/${BRANCH}"
  die "update dibatalkan"
fi

step "Memasang ulang dependency"
cd "$APP_DIR"
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi
ok "dependency sinkron"

# Pastikan izin file tetap benar setelah git menulis ulang file.
chown -R "${SERVICE_USER:-academybot}:${SERVICE_USER:-academybot}" "$APP_DIR"
chmod 600 "$APP_DIR/.env" 2>/dev/null || true

step "Menjalankan service"
systemctl restart "$SERVICE_NAME"
sleep 12

if systemctl is-active --quiet "$SERVICE_NAME"; then
  ok "service berjalan"
else
  warn "service tidak jalan. 30 baris log terakhir:"
  journalctl -u "$SERVICE_NAME" -n 30 --no-pager | sed 's/^/    /'
  exit 1
fi

HEALTH="$(curl -fsS --max-time 5 "http://127.0.0.1:8080/health" 2>/dev/null || true)"
[[ -n "$HEALTH" ]] && { ok "/health:"; printf '    %s\n' "$HEALTH"; } || warn "/health belum menjawab"

printf '\n%s%sSelesai.%s Pantau: journalctl -u %s -f\n\n' "$BOLD" "$GREEN" "$RESET" "$SERVICE_NAME"
