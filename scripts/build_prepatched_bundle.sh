#!/usr/bin/env bash
set -euo pipefail

UPSTREAM_URL="${UPSTREAM_URL:-https://persistent.oaistatic.com/codex-app-prod/Codex.dmg}"
DMG_PATH="${DMG_PATH:-Codex.dmg}"
WORK_DIR="${WORK_DIR:-work/prepatched}"
OUTPUT_DIR="${OUTPUT_DIR:-.}"
PKGBUILD_PATH="${PKGBUILD_PATH:-PKGBUILD}"
PKGVER_CANDIDATE="${PKGVER_CANDIDATE:-}"
CODEX_ELECTRON_TARGET="${CODEX_ELECTRON_TARGET:-}"
PATCH_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/patch_codex_main.js"

NODE_PTY_VER="1.1.0"
BETTER_SQLITE3_VER="12.4.6"
NODE_ADDON_API_PTY_VER="7.1.1"
NODE_ADDON_API_BSQL_VER="8.5.0"

if [[ -z "$CODEX_ELECTRON_TARGET" ]]; then
  echo "CODEX_ELECTRON_TARGET is required (example: 40.2.0)" >&2
  exit 1
fi

if [[ ! -f "$PKGBUILD_PATH" ]]; then
  echo "Missing PKGBUILD at $PKGBUILD_PATH" >&2
  exit 1
fi

if [[ ! -f "$PATCH_SCRIPT" ]]; then
  echo "Missing patch script at $PATCH_SCRIPT" >&2
  exit 1
fi

current_pkgver="$(awk -F= '/^pkgver=/{print $2; exit}' "$PKGBUILD_PATH")"
if [[ -z "$current_pkgver" ]]; then
  echo "Failed to parse pkgver from $PKGBUILD_PATH" >&2
  exit 1
fi

pkgver="$current_pkgver"
if [[ -n "$PKGVER_CANDIDATE" ]]; then
  pkgver="$PKGVER_CANDIDATE"
fi

mkdir -p "$WORK_DIR" "$OUTPUT_DIR"

download_if_missing() {
  local url="$1"
  local out="$2"
  if [[ -f "$out" ]]; then
    return 0
  fi
  local tmp="${out}.tmp"
  rm -f "$tmp"
  curl -fL --retry 3 --retry-delay 2 "$url" -o "$tmp"
  mv "$tmp" "$out"
}

download_if_missing "$UPSTREAM_URL" "$DMG_PATH"

upstream_sha256="$(sha256sum "$DMG_PATH" | awk '{print $1}')"
short_sha="${upstream_sha256:0:12}"
bundle_name="codex-desktop-prepatched-${pkgver}-${short_sha}-x86_64.tar.gz"
bundle_path="${OUTPUT_DIR}/${bundle_name}"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

codex_dmg_dir="$WORK_DIR/codex-dmg"
payload_root="$WORK_DIR/payload"
mkdir -p "$payload_root/resources"

7z x -y "$DMG_PATH" -o"$codex_dmg_dir" >/dev/null

codex_resources="$codex_dmg_dir/Codex Installer/Codex.app/Contents/Resources"
if [[ ! -f "$codex_resources/app.asar" || ! -d "$codex_resources/app.asar.unpacked" ]]; then
  echo "Failed to locate app.asar payload in DMG extraction output." >&2
  exit 1
fi

install -Dm644 "$codex_resources/app.asar" "$payload_root/resources/app.asar"
cp -a "$codex_resources/app.asar.unpacked" "$payload_root/resources/"

asar_path="$payload_root/resources/app.asar"
asar_unpack_dir="$WORK_DIR/app.asar-extracted"
npm_cache_dir="$WORK_DIR/.npm-cache"
asar_cli=(npx --yes "@electron/asar@4.0.1")

rm -rf "$asar_unpack_dir"
mkdir -p "$npm_cache_dir"

NPM_CONFIG_CACHE="$npm_cache_dir" "${asar_cli[@]}" extract "$asar_path" "$asar_unpack_dir"
if ! node "$PATCH_SCRIPT" "$asar_unpack_dir"; then
  echo "WARNING: semantic patch step failed; repacking bundle with extracted app.asar contents." >&2
fi
rm -f "$asar_path"
NPM_CONFIG_CACHE="$npm_cache_dir" "${asar_cli[@]}" pack --unpack-dir 'node_modules' "$asar_unpack_dir" "$asar_path"
rm -rf "$asar_unpack_dir"

download_if_missing "https://registry.npmjs.org/node-pty/-/node-pty-${NODE_PTY_VER}.tgz" "node-pty-${NODE_PTY_VER}.tgz"
download_if_missing "https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-${BETTER_SQLITE3_VER}.tgz" "better-sqlite3-${BETTER_SQLITE3_VER}.tgz"
download_if_missing "https://registry.npmjs.org/node-addon-api/-/node-addon-api-${NODE_ADDON_API_PTY_VER}.tgz" "node-addon-api-${NODE_ADDON_API_PTY_VER}.tgz"
download_if_missing "https://registry.npmjs.org/node-addon-api/-/node-addon-api-${NODE_ADDON_API_BSQL_VER}.tgz" "node-addon-api-${NODE_ADDON_API_BSQL_VER}.tgz"

nodepty_src="$WORK_DIR/nodepty-src"
bsql_src="$WORK_DIR/bsql-src"

mkdir -p "$nodepty_src" "$bsql_src"
bsdtar -xf "node-pty-${NODE_PTY_VER}.tgz" -C "$nodepty_src" --strip-components=1
mkdir -p "$nodepty_src/node_modules/node-addon-api"
bsdtar -xf "node-addon-api-${NODE_ADDON_API_PTY_VER}.tgz" -C "$nodepty_src/node_modules/node-addon-api" --strip-components=1

bsdtar -xf "better-sqlite3-${BETTER_SQLITE3_VER}.tgz" -C "$bsql_src" --strip-components=1
mkdir -p "$bsql_src/node_modules/node-addon-api"
bsdtar -xf "node-addon-api-${NODE_ADDON_API_BSQL_VER}.tgz" -C "$bsql_src/node_modules/node-addon-api" --strip-components=1

gyp_env=(
  PYTHON="${PYTHON:-/usr/bin/python3}"
  npm_config_runtime=electron
  npm_config_target="$CODEX_ELECTRON_TARGET"
  npm_config_disturl=https://electronjs.org/headers
  npm_config_build_from_source=true
)

(cd "$nodepty_src" && env "${gyp_env[@]}" node-gyp rebuild -j max)
(cd "$bsql_src" && env "${gyp_env[@]}" node-gyp rebuild -j max)

install -Dm755 "$nodepty_src/build/Release/pty.node" \
  "$payload_root/resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node"
install -Dm755 "$bsql_src/build/Release/better_sqlite3.node" \
  "$payload_root/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node"

rm -f "$bundle_path"
tar -C "$payload_root" -czf "$bundle_path" resources

bundle_sha256="$(sha256sum "$bundle_path" | awk '{print $1}')"

printf 'bundle_name=%s\n' "$bundle_name"
printf 'bundle_path=%s\n' "$bundle_path"
printf 'bundle_sha256=%s\n' "$bundle_sha256"
printf 'pkgver=%s\n' "$pkgver"
printf 'upstream_sha256=%s\n' "$upstream_sha256"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    printf 'bundle_name=%s\n' "$bundle_name"
    printf 'bundle_path=%s\n' "$bundle_path"
    printf 'bundle_sha256=%s\n' "$bundle_sha256"
    printf 'pkgver=%s\n' "$pkgver"
    printf 'upstream_sha256=%s\n' "$upstream_sha256"
  } >> "$GITHUB_OUTPUT"
fi
