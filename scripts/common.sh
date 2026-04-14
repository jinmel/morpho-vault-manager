#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$ROOT_DIR/.tmp"

log() {
  printf '[vault-manager] %s\n' "$*" >&2
}

die() {
  printf '[vault-manager] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || die "missing required command: $cmd"
}

ensure_tmp_dirs() {
  mkdir -p "$TMP_DIR/runtime" "$TMP_DIR/logs"
}
