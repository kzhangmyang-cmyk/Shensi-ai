#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DESKTOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
REPOSITORY_ROOT="$(cd "$DESKTOP_ROOT/.." && pwd -P)"
OUTPUT_ROOT="$REPOSITORY_ROOT/dist/desktop/macos"
MODE="${1:-development}"

[[ "$(uname -s)" == "Darwin" ]] || { echo "error: macOS packaging requires Darwin" >&2; exit 1; }
case "$(uname -m)" in
  arm64) ARCH="arm64" ;;
  x86_64) ARCH="x64" ;;
  *) echo "error: supported macOS architectures are arm64 and x64" >&2; exit 1 ;;
esac
for dependency in node pnpm uv xcrun hdiutil ditto shasum; do
  command -v "$dependency" >/dev/null || { echo "error: missing packaging dependency: $dependency" >&2; exit 1; }
done

export SHENSI_PACKAGE_MODE="$MODE"
node "$SCRIPT_DIR/check-package-environment.mjs" "$MODE"
if [[ "$MODE" == "development" ]]; then
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  BUILDER_CONFIG="electron-builder.yml"
else
  BUILDER_CONFIG="electron-builder.release.yml"
fi

case "$OUTPUT_ROOT" in
  "$REPOSITORY_ROOT/dist/desktop/macos") ;;
  *) echo "error: refusing to clean an unexpected output directory" >&2; exit 1 ;;
esac
rm -rf "$OUTPUT_ROOT"
mkdir -p "$OUTPUT_ROOT"

node "$SCRIPT_DIR/generate-macos-icon.mjs"
pnpm --dir "$REPOSITORY_ROOT" desktop:build
node "$SCRIPT_DIR/write-runtime-config.mjs"
pnpm --dir "$DESKTOP_ROOT" exec electron-builder --config "$BUILDER_CONFIG" --mac dmg zip "--$ARCH"

(
  cd "$OUTPUT_ROOT"
  artifacts=()
  while IFS= read -r -d '' artifact; do artifacts+=("$artifact"); done < <(
    find . -maxdepth 1 -type f \( -name '*.dmg' -o -name '*.zip' \) -print0 | sort -z
  )
  [[ ${#artifacts[@]} -eq 2 ]] || { echo "error: expected exactly one DMG and one ZIP" >&2; exit 1; }
  : > SHA256SUMS
  for artifact in "${artifacts[@]}"; do
    shasum -a 256 "${artifact#./}" >> SHA256SUMS
  done
)

bash "$SCRIPT_DIR/verify-macos-artifacts.sh" "$MODE"
