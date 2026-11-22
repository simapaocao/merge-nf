#!/bin/sh
set -eu
umask 077

usage() {
  printf '%s\n' \
    'Usage: sh deploy/hub.sh <serve|init|backup|restore> [CLI options]' \
    '' \
    'Local (Bun 1.3.14; run from the repository root):' \
    '  bun install --frozen-lockfile' \
    '  bun run --cwd apps/web build' \
    '  DATABASE_PATH=/private/hub.sqlite sh deploy/hub.sh init --username <name>' \
    '  NODE_ENV=production DEV_HTTP=0 PUBLIC_URL=https://hub.example.net BIND_HOST=0.0.0.0 TLS_CERT_FILE=/private/cert.pem TLS_KEY_FILE=/private/key.pem DATABASE_PATH=/private/hub.sqlite sh deploy/hub.sh serve' \
    '  DATABASE_PATH=/private/hub.sqlite sh deploy/hub.sh backup --to /private/config-backup.sqlite' \
    '  DATABASE_PATH=/private/new-hub.sqlite sh deploy/hub.sh restore --from /private/config-backup.sqlite' \
    '' \
    'Container (run from the repository root):' \
    '  Copy deploy/.env.example to deploy/.env, and set your canonical HTTPS PUBLIC_URL.' \
    '  docker compose --env-file deploy/.env -f deploy/compose.yaml build' \
    '  docker compose --env-file deploy/.env -f deploy/compose.yaml run --rm --no-deps hub init --username <name>' \
    '  docker compose --env-file deploy/.env -f deploy/compose.yaml -f deploy/compose.public.yaml up -d' \
    '  docker compose --env-file deploy/.env -f deploy/compose.yaml run --rm --no-deps hub backup --to /data/config-backup.sqlite' \
    '  docker compose --env-file deploy/.env -f deploy/compose.yaml stop hub' \
    '  docker compose --env-file deploy/.env -f deploy/compose.yaml run --rm --no-deps -e DATABASE_PATH=/data/new-hub.sqlite hub restore --from /data/config-backup.sqlite' \
    '  After restore, set DATABASE_PATH=/data/new-hub.sqlite in deploy/.env before restarting hub.' \
    '' \
    'init prompts for a hidden password on an interactive TTY; use --password-file <private-file> otherwise.' \
    'Password files must be regular files, mode 0600 on Unix; never put a password in argv or the image.' \
    'Container password files, if used, require an explicitly supplied read-only private mount.' \
    'The base Compose file publishes no ports; compose.public.yaml explicitly opts in to public HTTP/HTTPS.' \
    'Use fresh named volumes, or arrange existing volume ownership for the image UID before starting.' \
    'Backups contain display configuration and the administrator hash, not session summaries or pairing credentials.' \
    'Keep backups private. Stop the service before restore; choose a NEW DATABASE_PATH and pair all instances again.' \
    'Do not serve a backup directly. Do not remove the named data volume when upgrading.' \
    'Hub and every NF require different hostnames, not merely different ports.' \
    'For LAN/internal TLS, mount a certificate already trusted by every client; do not disable verification.'
}

case "${1:---help}" in
  --help|-h|help)
    usage
    exit 0
    ;;
  serve|init|backup|restore)
    command=$1
    shift
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

# Resolve relative DATABASE_PATH, WEB_DIST and CLI file paths from the repository root.
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
case "$command" in
  serve)
    if [ "$#" -ne 0 ]; then
      printf '%s\n' 'serve takes no arguments; use the server environment variables.' >&2
      exit 2
    fi
    exec bun apps/server/src/main.ts
    ;;
  *)
    exec bun apps/server/src/cli.ts "$command" "$@"
    ;;
esac
