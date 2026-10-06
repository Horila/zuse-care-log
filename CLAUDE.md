# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A PWA for logging a dog's insulin, food, meds and walks, with optional two-way
sync to a Google Sheet backed by an Apps Script web app. No build step, no
`package.json`, no dependencies — `zuse-care-log.html` is one self-contained file,
and the tests use only Node's stdlib `assert`.

## Commands

```
node test-logic.js    # pure logic lifted out of zuse-care-log.html (233 checks)
node test-sync.js     # the Apps Script backend under stubbed Google services (324 checks)
```

There is no single-test flag. Both files are flat scripts — comment out blocks
or add a temporary `process.exit()` to narrow a run.

The working tree is LF but `core.autocrlf=true`, so anything that makes git
rewrite files (`git stash` + `pop`, a checkout) leaves them CRLF and
`test-sync.js` dies at its "paste file keeps its instruction header" check, which
looks for `' */\n\n'`. Don't stash here; if it happens, `sed -i 's/\r$//'` the
modified files back to LF.

## Editing the file is not shipping it

The user does not open this folder. They run the installed PWA, served by GitHub
Pages from `origin/master`. A change is invisible to them until it is committed
**and pushed**; a saved working tree reaches nobody. Assume this whenever they
report "I can't see the change" — check `git status` and `git log origin/master`
before looking for a bug.

Even after a push there is a second delay: `sw.js` is stale-while-revalidate, so
the first open renders the cached shell and fetches the new one behind it. The
change appears on the *next* open. Bump `CACHE` in `sw.js` when shipping anything
in the app shell, and tell the user to open it twice.

## The tests read the real source, and the formatting is load-bearing

`test-logic.js` does not import anything. It reads `zuse-care-log.html`, takes
the one `<script>` block, and pulls named functions out of it by finding
`\nfunction NAME(` and brace-matching, and consts by `^const NAME=.*$`.
Consequences when editing the app:

- Tested functions must stay at column 0 and keep their names.
- Tested consts must stay on one line with no space before `=`.
- One `<script>` block only.
- A tested function that starts referencing a new const needs that const added
  to the `code` array in `test-logic.js`, or **every** check dies with
  "X is not defined" — a harness failure, not a logic one.
- The stub `T` near the top of `test-logic.js` is not the real table. A new type
  must be added there too, or tests touching it pass vacuously.

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

**Any backend change must be applied to both committed files.** Regenerate the
REPLACE file rather than hand-editing it twice:

```
head -34 zuse-sync-REPLACE-from-doPost.gs.txt > /tmp/h
sed -n '/^function doPost(e) {/,$p' zuse-sync-code.gs.txt > /tmp/b
cat /tmp/h /tmp/b > zuse-sync-REPLACE-from-doPost.gs.txt
```

`test-sync.js` exercises `zuse-sync-code.gs.txt` for behaviour, and separately
asserts the REPLACE file is byte-identical from `function doPost(e) {` onward and
carries no `SECRET` line — so drift fails the suite rather than shipping quietly.

Note for the user when handing them a backend change: `ALERT_EMAIL` sits *below*
the cut line, so pasting the REPLACE file blanks it. `checkStock()` opens with
`if (!ALERT_EMAIL) return 0;` — they get zero alerts, silently, with no error.
This silences the vet-reorder email too, not just the self-reminder and the
calendar event — it's one on/off switch for everything `checkStock` does. Tell
them to copy the address out first and put it back before saving.

## Constants that must move together

Nothing enforces these across the app/script boundary; a mismatch is silent.

| App (`zuse-care-log.html`) | Script (`zuse-sync-code.gs.txt`) | Keyed by |
|---|---|---|
| `TYPE_ALIASES` | `KNOWN_TYPES` (`dose change` also in `NOT_A_TOTAL`) | sheet type text |
| `LOW_LEFT` | `STOCK_LOW_LEFT` | display name (`Insulin`) |
| `PER_SHOT` | `STOCK_PER_ROW` | display name (`Syringes`) |
| `LOW_DAYS` | `STOCK_LOW_DAYS` | — |
| `VET_REORDER` (array of type ids) | `VET_REORDER` (object of qty/subjectLabel/phrase) | display name (`Prednisolone`, `Syringes`) |
| `FIXED_RATE` | `STOCK_FIXED_RATE` | display name (`Insulin`, `Prednisolone`, `Syringes`, `Paracetamol`, `Samylin`, `Canned Food`) |

The script side keys off the display name because that is what `pushStock` writes
into the Stock tab's ITEM column, and what `canonType_` normalises sheet rows to.

`FIXED_RATE`/`STOCK_FIXED_RATE` override the days-left calculation for six items
Zuse takes on a fixed routine (Samylin 2/day, Prednisolone 0.5/day, Insulin 17
units/day, Syringes 2/day, Paracetamol 1/day, Canned Food 4/day), on both the app
and the backend, so a missed log entry never reads as a changed burn rate. Every
other stockable item still derives its rate from real logged usage.

`LOW_DAYS_OVERRIDE` (app-only) widens the "running out" warning window per type
(Prednisolone and Syringes show at 15 days instead of 7) so it fires ahead of the
script's own `VET_REORDER_DAYS` (10) vet-reorder email — no script-side mirror
needed, since it only changes what the app displays, not what gets emailed.

## Apps Script constraints

- No `CalendarApp` call may appear on a `doPost` path. Calendar scope is granted
  by hand-running `installStockAlerts` from the editor; if it were requested on
  the sync path, an ungranted or withdrawn scope would break daily syncing.
- Editing the script requires Deploy → Manage deployments → pencil → Version:
  **New version**. "New deployment" makes a second web app on a new URL. Skipping
  the redeploy makes new actions answer `unknown action`; `syncErr` in the app
  rewrites that one error into these instructions. Only code the daily trigger
  alone runs (`checkStock`, `stockForecast_`, the email and calendar helpers)
  needs just a save — the trigger runs saved head code. Anything on a `doPost` or
  `doGet` path, including `writeStockTab_` and `readStockTab_`, runs from the
  *deployed* version and needs the redeploy even when no action is added. Skip it
  and nothing errors: the old code keeps writing the old columns, silently.
- `doPost` actions: `append`, `report`, `stock`, `skipVetOrder`, `fix`. `doGet`: `list`.
  `doGet` is a one-liner calling `handleGet_`, which lives below the REPLACE cut
  line; a script from before that needs its `doGet` swapped by hand once, or
  `list` never returns `tomb` (nothing errors, deletes just never spread).

## Sync protocol

Dedupe key is `date|time|typeName`, computed identically on both sides. The
sheet stores DD/MM/YYYY and 12-hour times; the app stores ISO dates and 24-hour
times, so `isoFromDmy`/`dmyFromIso` and `to24h`/`fmt12` sit on every boundary.

A sheet row whose type the app doesn't recognise is pulled in as a `note` with
`srcType` set to the original text — that keeps its key matching the sheet, so
it isn't re-pulled on every sync.

Deletes and edits: `removeEntry`/`saveEntry` record the old key in `cfg.tomb`
(lowercased `tombKey` → entry date, pruned after 31 days) so the pull skips it,
and queue a sheet triple (`tripleOf`) in `cfg.fixQ` — `del` for a delete or a
key-changing edit, `upd` for a same-key qty/note edit. The next sync sends the
queue as `fix`; the script clears that row's TYPE/QTY/NOTES (never the row, so
carry-forward dates hold) and keeps a `tomb:` Script Property that `list`
returns as `tomb` (keyed on the lowercased type text the app sent, not
`canonType_`, so a `srcType` note still matches), which `applyTombs` uses to
drop the entry on other phones. A `srcType` note never sends `upd`: its qty sits
inside the composed note.
Re-logging a key lifts its tombstone (`revive`). An old deployment answering
`unknown action` keeps the queue. Ceiling: two same-type entries in one minute
share a key.

Who logged it: `cfg.carer` (per device, kept across a backup restore) becomes
`e.by` on new entries, and `sheetNote` appends it to the pushed NOTES as
`note · NAME` — one helper for both the `append` rows and `fixQ.upd`, so they
agree. `carerOf` reads it back for the double-dose guard.

## The type table `T`

`T` is the single registry of everything the app knows: display name, icon, CSS
colour var, unit, default quantity. Adding a key to it surfaces that type in four
pickers at once — the routine editor, the sheet-name matcher, the log sheet's
type `<select>`, and the all-types tile grid.

Types flagged `s:1` are **stock-only**: counted, never logged. All four pickers go
through `LOGGABLE()`, which filters them out. `syringe` is the only one today.
`LOGGABLE()` also drops `h:1` (a hidden custom item); `typeKeyFromSheetType`
does not, so a hidden item's sheet rows still pull in as itself.

### Custom items

The user adds their own types (Log tab "+ New item", Setup → Your items) into
`cfg.customTypes` (`{c_<slug>:{n,i,c,u,d,stk?,h?}}`), merged into `T` by
`mergeCustomTypes()` after `load()` and after a restore. `cleanType` gates both
the form and a backup (no `<>&"|`, colour from `COLOURS`, name needs an ASCII
letter/digit or `tombKey` collapses it); `nameClash` rejects a built-in name or
a `TYPE_ALIASES` key. They sync under `T[k].n` like any type.
- The name locks once an entry uses it (a rename changes every sync key).
- Delete only when unused (it also leaves routines and `cfg.stock`); otherwise
  it can only be hidden, so no entry is orphaned.
- `adoptSrcType` rewrites matching `srcType` notes to the item's exact spelling
  on save, or a case difference re-pulls and re-pushes those rows.
- `stk` adds it to the "+ Track stock for…" list (`STOCKABLE` plus `stk` keys).
  Ceiling: the script's `canonType_` only knows `KNOWN_TYPES`, so
  `stockForecast_` counts zero use for a custom item: its emails, calendar event
  and vet reorder only see a typed per-day figure.

## The stock model

Stock is a restock baseline, not a running counter: remaining = the amount you
entered, minus everything logged on or after that date. Edits, deletions and
sheet pulls all correct themselves, and no logging path has to know stock exists.

Two wrinkles worth knowing before touching it:

- **Derived usage.** `PER_SHOT` maps a stock item to another type whose *entry
  count* spends it — a syringe goes with every insulin shot regardless of units.
  `usedSince` and `dailyUse` both branch on it; so does `stockForecast_` on the
  script side, via `STOCK_PER_ROW`.
- **Two low rules.** `isLowStock` is the one predicate the warning card, the
  countdown card and `lowStock()` all share: a fixed amount left where `LOW_LEFT`
  names one (insulin, at 400 units — one bottle), days of supply otherwise.
  Because the amount rule can fire with no recent use, a low item can have
  `days === null`; the email and calendar paths on the script side must both
  survive that.
- **A third, separate email.** Prednisolone and Syringes also trigger a vet
  reorder email at `VET_REORDER_DAYS` (10) days of supply, entirely apart from
  `isLowStock`/`STOCK_LOW_DAYS` (7) — a `stock:` key gates the self-reminder,
  a `vetorder:` key gates the vet email, and cancelling one (`skipVetOrder`)
  never touches the other. `LOW_DAYS_OVERRIDE` just widens when the app's own
  "running out" UI calls these two items low (15 days), so the warning shows
  up before the vet email fires, not after.
- **The per-day box.** Each Stock card has a "units/day" box that stores
  `cfg.stock[t].perDay`. It beats `FIXED_RATE` and real usage in `stockLeft`
  (order: box, fixed routine, logged use); empty or non-positive means automatic.
  It is mirrored to the Stock tab's sixth column, `PER DAY` (blank = automatic),
  and `stockForecast_` reads it first, so the morning email, calendar event and
  vet reorder agree with the app. `readStockTab_` reads a missing or blank cell as
  0, because the daily trigger may meet a five-column tab from before the column
  existed. Shipping it needs the Apps Script redeploy (see above), or `PER DAY`
  never reaches the sheet and the app and the emails silently disagree.
  - Sync: an edit sets `pdDirty` and runs `syncNow()`, not a bare `pushStock` —
    a bare push would write this device's baseline over a newer restock made
    elsewhere, and the daily check could then email the vet on stale data.
    `mergeStockRow` lets a dirty local figure beat the sheet, so a failed push or
    a sync already in flight cannot revert it; `pushStock` clears the flag once
    the sheet acknowledges the same figure. Otherwise a non-blank sheet value
    wins and a blank one keeps the local value.
  - Ceiling: a blank cell cannot be told from an older app that never sent the
    column, so a *clear* does not spread. Another device still holding a figure
    pushes it back and the clear is undone; clear it on each device.
  - A restock keeps both `perDay` and `pdDirty` (the in-hand box's `onchange`
    copies them across).

Rates divide by a fixed window, never by "days that happen to have an entry" —
the latter reads a twice-weekly tablet as a daily one and halves the estimate.

## The Android app bridge (`window.ZuseNative`)

A native Android build (`android/`, written separately) injects `ZuseNative`;
`const NAT` is it or null, and every use is a no-op without it, so the PWA and
the TWA are unchanged. Contract: `version`, `setPlan(json)`, `notify(id,title,body)`,
`notifPermission`/`requestNotifPermission`, `exactAlarms`/`openExactAlarmSettings`,
`saveFile(name,mime,text)` (returns "" or an error), `share(text)`, `openExternal(url)`.
- `notifPlan(now)` (pure, tested) returns `[{id,at,title,body}]` for 14 days:
  feeding reminders at `cfg.feedAm`/`feedPm` (skipped when that round is done),
  missed-shot alerts at shot + 30 min (`notifMiss`, via `routineWin`), and the
  10:00 alert on the day a tracked item crosses its `isLowStock` line
  (`notifStock`). Ids are stable; the native side replaces its whole plan.
- `pushNotifPlan()` (1s debounce) runs at the end of `renderAll`, on settings
  changes and on becoming visible; `notifOn:false` sends an empty plan.
  `notifyLow()` notifies an already-low item once per restock (`stock[t].notified`).
- With `NAT`: `dl` saves through `saveFile` and toasts itself (pass the success
  text as its 4th arg), `shareVetSummary` uses `share`, `target=_blank` links go
  to `openExternal`, and the "Install on your phone" section is hidden.

## Storage

`Store` falls back through `window.storage` → `localStorage` → an in-memory
object, so the app also works pasted into a sandboxed viewer. Photos go in
IndexedDB under the database name `zuse-audio` — a legacy name kept on purpose so
recordings from the removed vet-audio feature stay readable.

## Layout of zuse-care-log.html

One ~2574-line file: styles 13–210, markup 212–608, script 609–2572.

## Other files at the root

- `index.html` — a one-line meta-refresh to `zuse-care-log.html`, so GitHub
  Pages' default document (the bare repo URL) still opens the app.
- `manifest.json` — PWA metadata (name, icons, display mode) for "Add to
  Home Screen"; not something behaviour changes touch.
- `.well-known/assetlinks.json`, `.nojekyll` — see "The Android app" below.

## The Android app

The user also has this site packaged as an Android app: a Trusted Web
Activity built with PWABuilder (`io.github.horila.twa`). It wraps this same
site. A change here reaches the Android app too, on the same push-then-cache
delay as the PWA. A native WebView build is being added in `android/`; see "The
Android app bridge" above.

This repo (`zuse-care-log`) is a GitHub Pages project page. It serves under
`https://horila.github.io/zuse-care-log/`, not the domain root. Android
checks Digital Asset Links (the file that lets the app run without a
browser bar) at the domain root. The copy that matters for verification
lives in a separate repo, `horila.github.io`, which serves
`https://horila.github.io/.well-known/assetlinks.json`.

This repo also carries its own copy at `.well-known/assetlinks.json`. It
serves at `https://horila.github.io/zuse-care-log/.well-known/assetlinks.json`.
Keep both copies in sync if the fingerprint or package name ever changes.
`.nojekyll` exists in both repos because GitHub Pages' default Jekyll build
skips dot-folders like `.well-known` otherwise.

The signing keystore and the Play Store package stay in the user's local
Downloads folder, gitignored, in neither repo.
