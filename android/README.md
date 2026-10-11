# Zuse Android app

A plain WebView wrapper (no Gradle, no AndroidX) around
https://horila.github.io/zuse-care-log/zuse-care-log.html, plus a `window.ZuseNative`
bridge for exact-alarm reminders (alarm-stream sound, so they ring on silent), notifications,
Downloads, sharing, and `WalkService`: a location foreground service that keeps a walk going
and auto-ends it at home with the app closed. `SyncJob` syncs with the sheet about every 30 min
with the app closed, by running the page's own sync in a hidden WebView.
Package `io.github.horila.twa`, so it installs over the old PWABuilder app.

## Build

From Git Bash, anywhere:

    bash android/build.sh

Needs Android Studio's JBR (`C:/Program Files/Android/Android Studio/jbr`) and the SDK at
`%LOCALAPPDATA%/Android/Sdk` with `platforms/android-36` and `build-tools/35.0.0`.
Output: `android/out/zuse-care-log-unsigned-aligned.apk`.

## Sign with the real key

Set these and run the build again; it writes and verifies `android/out/zuse-care-log.apk`.
Passwords are read from the environment by apksigner, never put on the command line.

    export ZUSE_KS="$HOME/Downloads/<your keystore>"
    export ZUSE_KEY_ALIAS="<alias>"
    read -s ZUSE_KS_PASS; export ZUSE_KS_PASS
    read -s ZUSE_KEY_PASS; export ZUSE_KEY_PASS
    bash android/build.sh

It must be the same key that signed the installed app, or Android refuses the update.
If the installed app came from the Play Store, it is signed by Google's app-signing key,
not your upload key: sideloading over it will fail; upload this build to Play instead.

## Versions

Bump `--version-code` (and `--version-name`) in `build.sh` on every release you install.
Android refuses a lower versionCode than the installed one. Current: versionCode 4, "3.1". `version()` in
`MainActivity.java` returns the same name; keep them together.

## Your data

WebView storage is separate from Chrome's. The new app starts empty. Before installing:
open the old app, use **Download backup (JSON)**, then restore that file in the new app.
