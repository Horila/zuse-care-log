# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A PWA for logging a dog's insulin, food, meds and walks, with optional two-way
sync to a Google Sheet backed by an Apps Script web app. No build step, no
`package.json`, no dependencies — `zuse-care-log.html` is one self-contained file,
and the tests use only Node's stdlib `assert`.

## Commands

```
node test-logic.js    # pure logic lifted out of zuse-care-log.html (83 checks)
node test-sync.js     # the Apps Script backend under stubbed Google services (183 checks)
```

There is no single-test flag. Both files are flat scripts — comment out blocks
or add a temporary `process.exit()` to narrow a run.

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
| `TYPE_ALIASES` | `KNOWN_TYPES` | sheet type text |
| `LOW_LEFT` | `STOCK_LOW_LEFT` | display name (`Insulin`) |
| `PER_SHOT` | `STOCK_PER_ROW` | display name (`Syringes`) |
| `LOW_DAYS` | `STOCK_LOW_DAYS` | — |
| `VET_REORDER` (array of type ids) | `VET_REORDER` (object of qty/unit) | display name (`Prednisolone`, `Syringes`) |

The script side keys off the display name because that is what `pushStock` writes
into the Stock tab's ITEM column, and what `canonType_` normalises sheet rows to.

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
  rewrites that one error into these instructions. A change that adds no `doPost`
  action needs only a save — the daily trigger runs saved head code.
- `doPost` actions: `append`, `report`, `stock`, `skipVetOrder`. `doGet`: `list`.

## Sync protocol

Dedupe key is `date|time|typeName`, computed identically on both sides. The
sheet stores DD/MM/YYYY and 12-hour times; the app stores ISO dates and 24-hour
times, so `isoFromDmy`/`dmyFromIso` and `to24h`/`fmt12` sit on every boundary.

A sheet row whose type the app doesn't recognise is pulled in as a `note` with
`srcType` set to the original text — that keeps its key matching the sheet, so
it isn't re-pulled on every sync.

## The type table `T`

`T` is the single registry of everything the app knows: display name, icon, CSS
colour var, unit, default quantity. Adding a key to it surfaces that type in four
pickers at once — the routine editor, the sheet-name matcher, the log sheet's
type `<select>`, and the all-types tile grid.

Types flagged `s:1` are **stock-only**: counted, never logged. All four pickers go
through `LOGGABLE()`, which filters them out. `syringe` is the only one today.

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

Rates divide by a fixed window, never by "days that happen to have an entry" —
the latter reads a twice-weekly tablet as a daily one and halves the estimate.

## Storage

`Store` falls back through `window.storage` → `localStorage` → an in-memory
object, so the app also works pasted into a sandboxed viewer. Photos go in
IndexedDB under the database name `zuse-audio` — a legacy name kept on purpose so
recordings from the removed vet-audio feature stay readable.

## Layout of zuse-care-log.html

One 1940-line file: styles 13–208, markup 210–511, script 512–1938.
