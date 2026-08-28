# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A PWA for logging a dog's insulin, food, meds and walks, with optional two-way
sync to a Google Sheet backed by an Apps Script web app. No build step, no
`package.json`, no dependencies — `zuse-care-log.html` is opened directly in a
browser, and the tests use only Node's stdlib `assert`.

## Commands

```
node test-logic.js    # pure logic lifted out of zuse-care-log.html (70 checks)
node test-sync.js     # the Apps Script backend under stubbed Google services (168 checks)
```

There is no single-test flag. Both files are flat scripts — comment out blocks
or add a temporary `process.exit()` to narrow a run.

## The tests read the real source, and the formatting is load-bearing

`test-logic.js` does not import anything. It reads `zuse-care-log.html`, takes
the one `<script>` block, and pulls named functions out of it by finding
`\nfunction NAME(` and brace-matching, and consts by `^const NAME=.*$`.
Consequences when editing the app:

- Tested functions must stay at column 0 and keep their names.
- Tested consts must stay on one line with no space before `=`.
- One `<script>` block only.

Reformatting or prettifying the app breaks the tests with "function not found in
source", not a logic failure. The compact style is deliberate.

`test-sync.js` does the same to `zuse-sync-code.gs.txt`, evaluating it under a
frozen clock and fake `SpreadsheetApp`/`MailApp`/`CalendarApp`/`UrlFetchApp`.

## The three .gs.txt files

- `zuse-sync-code.gs.txt` — the whole backend, with `SECRET` as a placeholder.
- `zuse-sync-REPLACE-from-doPost.gs.txt` — identical from `function doPost(e) {`
  (line 35) to the end; its first 34 lines are paste instructions instead of the
  header, `SECRET` and `doGet`. It exists so the user can paste over the bottom
  of their script without touching their own secret.
- `PASTE-INTO-APPS-SCRIPT.gs.txt` — gitignored, a personalised copy with real
  credentials in it. Not source. Do not edit, diff or commit it.

**Any backend change must be applied to both committed files.** `test-sync.js`
exercises `zuse-sync-code.gs.txt` for behaviour, and separately asserts that the
REPLACE file is byte-identical from `function doPost(e) {` onward and carries no
`SECRET` line — so drift fails the suite rather than shipping quietly.

## Apps Script constraints

- No `CalendarApp` call may appear on a `doPost` path. Calendar scope is granted
  by hand-running `installStockAlerts` from the editor; if it were requested on
  the sync path, an ungranted or withdrawn scope would break daily syncing.
- Editing the script requires Deploy → Manage deployments → pencil → Version:
  **New version**. "New deployment" makes a second web app on a new URL. Skipping
  the redeploy makes new actions answer `unknown action`; `syncErr` in the app
  rewrites that one error into these instructions.
- `doPost` actions: `append`, `report`, `stock`. `doGet`: `list`.

## Sync protocol

Dedupe key is `date|time|typeName`, computed identically on both sides. The
sheet stores DD/MM/YYYY and 12-hour times; the app stores ISO dates and 24-hour
times, so `isoFromDmy`/`dmyFromIso` and `to24h`/`fmt12` sit on every boundary.

A sheet row whose type the app doesn't recognise is pulled in as a `note` with
`srcType` set to the original text — that keeps its key matching the sheet, so
it isn't re-pulled on every sync.

Stock levels live in the app and are mirrored to the sheet's `Stock` tab
(`pushStock`) so the daily Apps Script checker can forecast against them.

## Storage and shipping

`Store` falls back through `window.storage` → `localStorage` → an in-memory
object, so the app also works pasted into a sandboxed viewer. Photos go in
IndexedDB under the database name `zuse-audio` — a legacy name kept on purpose so
recordings from the removed vet-audio feature stay readable.

`sw.js` caches stale-while-revalidate, so an update lands on the *next* open.
Bump `CACHE` when shipping or clients keep the old shell.

## Layout of zuse-care-log.html

One 1940-line file: styles 13–208, markup 210–511, script 512–1938.
