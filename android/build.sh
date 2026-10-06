#!/usr/bin/env bash
# Builds the Zuse Android app without Gradle. Run from Git Bash: bash android/build.sh
# Output: android/out/zuse-care-log-unsigned-aligned.apk
# Signed:  android/out/zuse-care-log.apk when ZUSE_KS, ZUSE_KS_PASS, ZUSE_KEY_ALIAS, ZUSE_KEY_PASS are set.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SDK="${ANDROID_HOME:-$LOCALAPPDATA/Android/Sdk}"
BT="$SDK/build-tools/35.0.0"
JAR="$SDK/platforms/android-36/android.jar"
export PATH="/c/Program Files/Android/Android Studio/jbr/bin:$PATH"
OUT=out   # relative on purpose: the repo path has spaces, and find output is word-split
TMP=out/build

cd "$HERE"
rm -rf "$TMP"; mkdir -p "$TMP/gen" "$TMP/classes" "$TMP/dex"

echo "== aapt2 compile/link"
"$BT/aapt2.exe" compile --dir res -o "$TMP/res.zip"
"$BT/aapt2.exe" link -I "$JAR" --manifest AndroidManifest.xml -o "$TMP/base.apk" \
  --min-sdk-version 24 --target-sdk-version 35 --version-code 2 --version-name 2.0 \
  --java "$TMP/gen" "$TMP/res.zip"

echo "== javac"
javac --release 17 -cp "$JAR" -d "$TMP/classes" -Xlint:-options \
  $(find src "$TMP/gen" -name '*.java')

echo "== d8"
"$BT/d8.bat" --release --min-api 24 --lib "$JAR" --output "$TMP/dex" $(find "$TMP/classes" -name '*.class')

echo "== package"
(cd "$TMP/dex" && "$BT/aapt.exe" add ../base.apk classes.dex >/dev/null)
"$BT/zipalign.exe" -f -p 4 "$TMP/base.apk" "$OUT/zuse-care-log-unsigned-aligned.apk"
echo "built $OUT/zuse-care-log-unsigned-aligned.apk"

if [[ -n "${ZUSE_KS:-}" && -n "${ZUSE_KS_PASS:-}" && -n "${ZUSE_KEY_ALIAS:-}" && -n "${ZUSE_KEY_PASS:-}" ]]; then
  echo "== sign"
  "$BT/apksigner.bat" sign --ks "$ZUSE_KS" --ks-key-alias "$ZUSE_KEY_ALIAS" \
    --ks-pass env:ZUSE_KS_PASS --key-pass env:ZUSE_KEY_PASS \
    --out "$OUT/zuse-care-log.apk" "$OUT/zuse-care-log-unsigned-aligned.apk"
  "$BT/apksigner.bat" verify "$OUT/zuse-care-log.apk"
  echo "signed $OUT/zuse-care-log.apk"
fi
