#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
android_outputs="${ANDROID_OUTPUTS_DIR:-$project_root/desktop-app/src-tauri/gen/android/app/build/outputs}"
release_dir="${1:-$project_root/release-assets}"
release_tag="${2:-v0.1.4}"
build_tools_version="${ANDROID_BUILD_TOOLS_VERSION:-35.0.0}"
expected_version_code="${ANDROID_VERSION_CODE:-14}"
expected_version_name="${ANDROID_VERSION_NAME:-${release_tag#v}}"

: "${ANDROID_HOME:=${ANDROID_SDK_ROOT:-}}"
: "${ANDROID_HOME:?ANDROID_HOME or ANDROID_SDK_ROOT is required}"
: "${ANDROID_KEYSTORE_PATH:?ANDROID_KEYSTORE_PATH is required}"
: "${ANDROID_KEYSTORE_PASSWORD:?ANDROID_KEYSTORE_PASSWORD is required}"
: "${ANDROID_KEY_ALIAS:?ANDROID_KEY_ALIAS is required}"
: "${ANDROID_KEY_PASSWORD:?ANDROID_KEY_PASSWORD is required}"

build_tools="$ANDROID_HOME/build-tools/$build_tools_version"
zipalign="$build_tools/zipalign"
apksigner="$build_tools/apksigner"
aapt2="$build_tools/aapt2"

for tool in "$zipalign" "$apksigner" "$aapt2"; do
  if [[ ! -x "$tool" ]]; then
    echo "Android build tool missing: $tool" >&2
    exit 1
  fi
done

unsigned_apk="$(find "$android_outputs" -type f -name '*release-unsigned.apk' -print -quit)"
unsigned_aab="$(find "$android_outputs" -type f -name '*release.aab' -print -quit)"
if [[ -z "$unsigned_apk" || ! -f "$unsigned_apk" ]]; then
  echo "Unsigned release APK was not found under $android_outputs" >&2
  exit 1
fi

mkdir -p "$release_dir"
aligned_apk="$(mktemp "${TMPDIR:-/tmp}/apisaverwriter-aligned.XXXXXX.apk")"
trap 'rm -f "$aligned_apk"' EXIT

apk_name="ApiSaverWriter_${release_tag}_Android_arm64.apk"
apk_path="$release_dir/$apk_name"

"$zipalign" -p -f 4 "$unsigned_apk" "$aligned_apk"
"$apksigner" sign \
  --ks "$ANDROID_KEYSTORE_PATH" \
  --ks-key-alias "$ANDROID_KEY_ALIAS" \
  --ks-pass "env:ANDROID_KEYSTORE_PASSWORD" \
  --key-pass "env:ANDROID_KEY_PASSWORD" \
  --out "$apk_path" \
  "$aligned_apk"

"$zipalign" -c -p 4 "$apk_path"
"$apksigner" verify --verbose --print-certs "$apk_path"
metadata="$($aapt2 dump badging "$apk_path")"
escaped_version_name="${expected_version_name//./\\.}"
printf '%s\n' "$metadata" | grep -E "^package: name='com\.apisaverwriter\.app'.*versionName='${escaped_version_name}'"
printf '%s\n' "$metadata" | grep -E "versionCode='${expected_version_code}'"
unzip -t "$apk_path" >/dev/null

if [[ -n "$unsigned_aab" && -f "$unsigned_aab" ]]; then
  aab_path="$release_dir/ApiSaverWriter_${release_tag}_Android_arm64.aab"
  cp "$unsigned_aab" "$aab_path"
  jarsigner \
    -keystore "$ANDROID_KEYSTORE_PATH" \
    -storepass "$ANDROID_KEYSTORE_PASSWORD" \
    -keypass "$ANDROID_KEY_PASSWORD" \
    -sigalg SHA256withRSA \
    -digestalg SHA-256 \
    "$aab_path" "$ANDROID_KEY_ALIAS"
  # Android App Bundles normally use a self-signed upload certificate. `-strict`
  # treats that expected certificate shape as a chain error, so verification uses
  # jarsigner's signature/integrity exit status without the PKIX strictness check.
  jarsigner -verify -certs "$aab_path"
fi

if find "$release_dir" -maxdepth 1 -type f -name '*unsigned*.apk' | grep -q .; then
  echo "Unsigned APK leaked into release directory" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$apk_path"
else
  shasum -a 256 "$apk_path"
fi
