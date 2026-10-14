#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DESKTOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
REPOSITORY_ROOT="$(cd "$DESKTOP_ROOT/.." && pwd -P)"
OUTPUT_ROOT="$REPOSITORY_ROOT/dist/desktop/macos"
MODE="${1:-development}"

[[ "$(uname -s)" == "Darwin" ]] || { echo "error: macOS verification requires Darwin" >&2; exit 1; }
case "$(uname -m)" in
  arm64) EXPECTED_ARCH="arm64" ;;
  x86_64) EXPECTED_ARCH="x86_64" ;;
  *) echo "error: supported macOS architectures are arm64 and x64" >&2; exit 1 ;;
esac
[[ "$MODE" == "development" || "$MODE" == "release" ]] || { echo "error: verification mode must be development or release" >&2; exit 1; }
for dependency in node file lipo hdiutil ditto unzip shasum; do
  command -v "$dependency" >/dev/null || { echo "error: missing verification dependency: $dependency" >&2; exit 1; }
done
[[ -d "$OUTPUT_ROOT" ]] || { echo "error: macOS artifact output is missing" >&2; exit 1; }
[[ -f "$OUTPUT_ROOT/SHA256SUMS" ]] || { echo "error: SHA256SUMS is missing" >&2; exit 1; }

apps=()
while IFS= read -r -d '' candidate; do apps+=("$candidate"); done < <(
  find "$OUTPUT_ROOT" -maxdepth 3 -type d -name Shensi.app -print0
)
dmgs=()
while IFS= read -r -d '' candidate; do dmgs+=("$candidate"); done < <(
  find "$OUTPUT_ROOT" -maxdepth 1 -type f -name 'Shensi-*.dmg' -print0
)
zips=()
while IFS= read -r -d '' candidate; do zips+=("$candidate"); done < <(
  find "$OUTPUT_ROOT" -maxdepth 1 -type f -name 'Shensi-*.zip' -print0
)
[[ ${#apps[@]} -eq 1 ]] || { echo "error: expected one unpacked Shensi.app" >&2; exit 1; }
[[ ${#dmgs[@]} -eq 1 ]] || { echo "error: expected one DMG" >&2; exit 1; }
[[ ${#zips[@]} -eq 1 ]] || { echo "error: expected one ZIP" >&2; exit 1; }
APP_PATH="${apps[0]}"
DMG_PATH="${dmgs[0]}"
ZIP_PATH="${zips[0]}"

verify_architectures() {
  local bundle="$1"
  local count=0
  while IFS= read -r -d '' candidate; do
    if file -b "$candidate" | grep -q 'Mach-O'; then
      count=$((count + 1))
      lipo -archs "$candidate" | tr ' ' '\n' | grep -Fx "$EXPECTED_ARCH" >/dev/null \
        || { echo "error: architecture mismatch: $candidate" >&2; exit 1; }
    fi
  done < <(find "$bundle" -type f -print0)
  [[ $count -gt 0 ]] || { echo "error: no Mach-O files found in app" >&2; exit 1; }
}

verify_release_security() {
  local bundle="$1"
  node "$SCRIPT_DIR/macos-signature-policy.mjs" app "$bundle"
  /usr/sbin/spctl --assess --type execute --verbose=2 "$bundle"
  /usr/bin/xcrun stapler validate --verbose "$bundle"
}

(
  cd "$OUTPUT_ROOT"
  shasum -a 256 -c SHA256SUMS
)
unzip -tq "$ZIP_PATH" >/dev/null
node "$SCRIPT_DIR/verify-package.mjs" "$APP_PATH" "$MODE"
verify_architectures "$APP_PATH"

TEMPORARY_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/shensi-artifact-verify.XXXXXX")"
MOUNT_POINT="$TEMPORARY_ROOT/dmg"
ZIP_ROOT="$TEMPORARY_ROOT/zip"
mkdir -p "$MOUNT_POINT" "$ZIP_ROOT"
mounted=0
cleanup() {
  if [[ $mounted -eq 1 ]]; then hdiutil detach "$MOUNT_POINT" -quiet || true; fi
  rm -rf "$TEMPORARY_ROOT"
}
trap cleanup EXIT

ditto -x -k "$ZIP_PATH" "$ZIP_ROOT"
[[ -d "$ZIP_ROOT/Shensi.app" ]] || { echo "error: ZIP does not contain Shensi.app at its root" >&2; exit 1; }
node "$SCRIPT_DIR/verify-package.mjs" "$ZIP_ROOT/Shensi.app" "$MODE"
verify_architectures "$ZIP_ROOT/Shensi.app"

hdiutil attach "$DMG_PATH" -nobrowse -readonly -mountpoint "$MOUNT_POINT" -quiet
mounted=1
[[ -d "$MOUNT_POINT/Shensi.app" ]] || { echo "error: DMG does not contain Shensi.app" >&2; exit 1; }
node "$SCRIPT_DIR/verify-package.mjs" "$MOUNT_POINT/Shensi.app" "$MODE"
verify_architectures "$MOUNT_POINT/Shensi.app"

if [[ "$MODE" == "release" ]]; then
  verify_release_security "$APP_PATH"
  verify_release_security "$ZIP_ROOT/Shensi.app"
  verify_release_security "$MOUNT_POINT/Shensi.app"
  node "$SCRIPT_DIR/macos-signature-policy.mjs" app-and-dmg "$APP_PATH" "$DMG_PATH"
  /usr/sbin/spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG_PATH"
  /usr/bin/xcrun stapler validate --verbose "$DMG_PATH"
fi

hdiutil detach "$MOUNT_POINT" -quiet
mounted=0
echo "{\"ok\":true,\"mode\":\"$MODE\",\"architecture\":\"$EXPECTED_ARCH\"}"
