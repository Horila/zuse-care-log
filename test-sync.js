/* Self-check for zuse-sync-code.gs.txt (the Google Apps Script backend).
 *
 * Apps Script can't be tested in place — you paste it into Google and hope.
 * So this evaluates the real file under stubbed Google services and a frozen
 * clock, and exercises the parts that quietly misfire: the missed-shot
 * reminder around midnight, and the stock forecast.
 *
 * Run:  node test-sync.js
 */
const fs = require('fs');
const assert = require('assert');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'zuse-sync-code.gs.txt'), 'utf8');

/* ---- minimal Utilities.formatDate, covering only the patterns we use ---- */
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const p2 = n => String(n).padStart(2, '0');
function formatDate(d, tz, pat) {
  const h12 = d.getHours() % 12 || 12;
  return pat
    .replace('yyyy', d.getFullYear())
    .replace('MMM', MON[d.getMonth()])
    .replace('MM', p2(d.getMonth() + 1))
    .replace('dd', p2(d.getDate()))
    .replace('EEE', DOW[d.getDay()])
    .replace('h:mm a', `${h12}:${p2(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`)
    .replace(/\bd\b/, d.getDate());
}

/** A Date whose no-arg constructor and .now() are frozen at `nowMs`. */
function frozenDate(nowMs) {
  return class extends Date {
    constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); }
    static now() { return nowMs; }
  };
}

/**
 * Load the script with the clock frozen and a fake sheet behind it.
 * `rows` are [dateCell, timeCell, type, qty, notes] — dateCell/timeCell may be
 * Date objects, exactly as a real spreadsheet hands them over.
 */
function load(nowMs, rows, opts) {
  opts = opts || {};
  const mail = [];
  const triggers = { deleted: [], created: [] };
  const locks = [];
  const props = Object.assign({}, opts.props || {});
  const values = [['header'], ['header']].concat(
    rows.map(r => ['', r[0], r[1], r[2], r[3] === undefined ? '' : r[3], r[4] || ''])
  );
  const events = [];
  const formats = [];

  /** A sheet that can be cleared and written to, so writeStockTab_ is exercised
   *  for real rather than mocked away. */
  function writableSheet(initial) {
    let v = initial.map(r => r.slice());
    return {
      getDataRange: () => ({ getValues: () => v }),
      clear: () => { v = []; },
      getLastRow: () => v.length,
      getRange: (r, c, nr, nc) => ({
        getValue: () => (v[r - 1] || [])[c - 1],
        getValues: () => v.slice(r - 1, r - 1 + nr).map(row => { row = row.slice(c - 1, c - 1 + nc); while (row.length < nc) row.push(''); return row; }),
        setNumberFormat: f => { formats.push({ r, c, f }); },
        setValues: rowsIn => {
          while (v.length < r - 1 + rowsIn.length) v.push([]);
          // Merge at column c, so a partial write (cols 4-6 of a row) leaves the rest alone.
          rowsIn.forEach((row, i) => { const t = (v[r - 1 + i] || []).slice(); row.forEach((x, j) => { t[c - 1 + j] = x; }); v[r - 1 + i] = t; });
        },
      }),
    };
  }
  const mainTab = writableSheet(values);
  // opts.stockRows: [ITEM, IN HAND, UNIT, COUNTING FROM, PER DAY?] rows, header
  // added here. A row with no fifth element is a tab from before PER DAY existed:
  // five columns, no sixth at all.
  let stockTab = opts.stockRows
    ? writableSheet([['ITEM', 'IN HAND', 'UNIT', 'COUNTING FROM', 'UPDATED']]
        .concat(opts.stockRows.map(r => r.slice(0, 4).concat(['x'], r.slice(4)))))
    : null;

  const stubs = {
    ContentService: {
      MimeType: { JSON: 'json' },
      // Keeps the serialised body reachable so doPost can be asserted on.
      createTextOutput: t => ({ __out: t, setMimeType: function () { return this; } }),
    },
    Date: frozenDate(nowMs),
    Utilities: { formatDate },
    Session: { getScriptTimeZone: () => 'Europe/London' },
    Logger: { log: () => {} },
    LockService: { getScriptLock: () => ({ waitLock: () => { locks.push('wait'); }, releaseLock: () => { locks.push('release'); } }) },
    MailApp: { sendEmail: (to, subject, body) => mail.push({ to, subject, body }) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: k => { delete props[k]; },
        getProperties: () => Object.assign({}, props),
      }),
    },
    ScriptApp: {
      // opts.triggers: handler names already installed. Only the everyMinutes chain is stubbed.
      getProjectTriggers: () => (opts.triggers || []).map(h => ({ getHandlerFunction: () => h })),
      deleteTrigger: tr => { triggers.deleted.push(tr.getHandlerFunction()); },
      newTrigger: h => ({ timeBased: () => ({ everyMinutes: m => ({ create: () => { triggers.created.push(h + '@' + m); } }) }) }),
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        // Name-aware: the Stock tab is a different sheet, and is absent until
        // the app has synced at least once.
        getSheetByName: n => (n === 'Stock' ? stockTab : mainTab),
        insertSheet: () => (stockTab = writableSheet([])),
      }),
    },
    CalendarApp: {
      getDefaultCalendar: () => {
        // opts.calendarFails stands in for the scope never having been granted.
        if (opts.calendarFails) throw new Error('no calendar scope');
        return {
          getEventsForDay: (d, o) => events.filter(ev =>
            ev.title === (o && o.search) && ev.when.toDateString() === d.toDateString()),
          createEvent: (title, when, end, o) => {
            const ev = { title, when, end, options: o, reminders: [] };
            events.push(ev);
            return { addPopupReminder: m => ev.reminders.push(m) };
          },
        };
      },
    },
  };

  // Test-only: the shipped file leaves ALERT_EMAIL blank so a fresh paste never
  // mails a stranger. Fill it in so the alert paths are reachable here.
  const src = SRC.replace("const ALERT_EMAIL = '';", "const ALERT_EMAIL = 'owner@example.com';");

  const names = Object.keys(stubs);
  const body = src + `
    ;return {readRows, parseRowDate_, slotsToCheck_, checkShotDue, cleanupAlertKeys_,
             numFrom_, fmtDay_, canonType_, installReminders,
             checkStock, readStockTab_, stockForecast_, writeStockTab_, doPost, doGet};`;
  const api = new Function(...names, body)(...names.map(n => stubs[n]));
  const post = o => JSON.parse(api.doPost({ postData: { contents: JSON.stringify(
    Object.assign({ secret: 'CHANGE_ME_TO_YOUR_OWN_SECRET' }, o)) } }).__out);
  return { api, mail, props, triggers, events, formats, locks, post, stock: () => stockTab, sheet: () => mainTab };
}

const at = (y, m, d, h, mi) => new Date(y, m - 1, d, h, mi, 0).getTime();
const cell = (y, m, d, h, mi) => new Date(y, m - 1, d, h === undefined ? 0 : h, mi === undefined ? 0 : mi, 0);

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); passed++; };

/* ================= readRows -> parseRowDate_ round trip ================= */
{
  // A real sheet hands back Date objects; formatDate_/formatTime_ stringify
  // them, and parseRowDate_ has to turn them back into the same instant.
  const { api } = load(at(2026, 8, 28, 12, 0), [
    [cell(2026, 8, 28), cell(2026, 8, 28, 11, 30), 'Insulin', '8 Units', ''],
  ]);
  const rows = api.readRows();
  eq(rows.length, 1, 'one data row read past the two header rows');
  eq(rows[0].date, '28/08/2026', 'date cell formatted dd/MM/yyyy');
  eq(rows[0].time, '11:30 am', 'time cell formatted h:mm a, lowercased');
  const back = api.parseRowDate_(rows[0].date, rows[0].time);
  eq(back.getTime(), at(2026, 8, 28, 11, 30), 'round trips to the same instant');
}
{
  const { api } = load(at(2026, 8, 28, 12, 0), []);
  eq(api.parseRowDate_('28/08/2026', '12:00 am').getHours(), 0, 'midnight is 12am, not 12:00');
  eq(api.parseRowDate_('28/08/2026', '12:30 pm').getHours(), 12, 'noon is 12pm, not 24:00');
  eq(api.parseRowDate_('28/08/2026', '11:30 pm').getHours(), 23, 'pm adds twelve');
  eq(api.parseRowDate_('rubbish', '11:30 am'), null, 'unparseable date is null, not NaN');
  eq(api.parseRowDate_('28/08/2026', 'noonish'), null, 'unparseable time is null, not NaN');
}

/* ========================= slot selection ========================= */
// AM_TIME 11:30, PM_TIME 23:30, GRACE_MIN 30, ALERT_WINDOW_H 5.
{
  const s = load(at(2026, 8, 28, 11, 45), []).api.slotsToCheck_(new Date(at(2026, 8, 28, 11, 45)));
  eq(s.length, 0, '15 min late is still inside the grace period');
}
{
  const s = load(at(2026, 8, 28, 12, 5), []).api.slotsToCheck_(new Date(at(2026, 8, 28, 12, 5)));
  eq(s.length, 1, '35 min late raises exactly one slot');
  eq(s[0].name, 'morning', 'and it is the morning slot');
  eq(s[0].key, '2026-08-28:morning', 'keyed by the slot date, not by now');
}
{
  const s = load(at(2026, 8, 28, 17, 0), []).api.slotsToCheck_(new Date(at(2026, 8, 28, 17, 0)));
  eq(s.length, 0, '5.5h late is past the window — stop nagging');
}
{
  // The one that matters: 00:15, chasing last night's 23:30 shot from the far
  // side of midnight. "Today" has already rolled over.
  const s = load(at(2026, 8, 29, 0, 15), []).api.slotsToCheck_(new Date(at(2026, 8, 29, 0, 15)));
  eq(s.length, 1, 'a slot before midnight is still reachable after it');
  eq(s[0].name, 'night', 'and it is the night slot');
  eq(s[0].key, '2026-08-28:night', 'dated to the 28th, the day the shot was due');
}
{
  const s = load(at(2026, 8, 29, 4, 45), []).api.slotsToCheck_(new Date(at(2026, 8, 29, 4, 45)));
  eq(s.length, 0, "5h15m after last night's slot, it drops out again");
}

/* ===================== checkShotDue end to end ===================== */
{
  const { api, mail, props } = load(at(2026, 8, 28, 12, 5), []);
  api.checkShotDue();
  eq(mail.length, 1, 'nothing logged, morning shot overdue: one email');
  ok(/morning insulin not logged/.test(mail[0].subject), 'subject names the slot');
  ok(/No insulin logged in the last two days/.test(mail[0].body), 'says there is no recent shot at all');
  eq(props['alerted:2026-08-28:morning'], '1', 'the slot is marked as alerted');
  api.checkShotDue();
  eq(mail.length, 1, 'a second run 15 min later does not email again');
}
{
  const { api, mail } = load(at(2026, 8, 28, 12, 5), [
    [cell(2026, 8, 28), cell(2026, 8, 28, 11, 35), 'Insulin', '8 Units', ''],
  ]);
  api.checkShotDue();
  eq(mail.length, 0, 'a shot logged five minutes late is not chased');
}
{
  // LOOKBACK_H is 2: a shot given early still covers the slot.
  const { api, mail } = load(at(2026, 8, 28, 12, 5), [
    [cell(2026, 8, 28), cell(2026, 8, 28, 10, 0), 'Insulin', '8 Units', ''],
  ]);
  api.checkShotDue();
  eq(mail.length, 0, '90 min early still counts as covering the slot');
}
{
  const { api, mail } = load(at(2026, 8, 28, 12, 5), [
    [cell(2026, 8, 28), cell(2026, 8, 28, 8, 0), 'Insulin', '8 Units', ''],
  ]);
  api.checkShotDue();
  eq(mail.length, 1, '3.5h early is a different shot, not this slot');
  ok(/Last insulin logged/.test(mail[0].body), 'and the email says when the last one was');
}
{
  // Yesterday's night shot, chased after midnight.
  const { api, mail } = load(at(2026, 8, 29, 0, 15), [
    [cell(2026, 8, 28), cell(2026, 8, 28, 11, 30), 'Insulin', '8 Units', ''],
  ]);
  api.checkShotDue();
  eq(mail.length, 1, 'the morning shot does not cover the night slot');
  ok(/night insulin not logged/.test(mail[0].subject), 'chases the night slot after midnight');
}
{
  const { api, mail } = load(at(2026, 8, 29, 0, 15), [
    [cell(2026, 8, 28), cell(2026, 8, 28, 23, 40), 'Insulin', '8 Units', ''],
  ]);
  api.checkShotDue();
  eq(mail.length, 0, 'a shot at 23:40 covers the 23:30 slot from after midnight');
}
{
  // Types other than insulin must never satisfy the check.
  const { api, mail } = load(at(2026, 8, 28, 12, 5), [
    [cell(2026, 8, 28), cell(2026, 8, 28, 11, 30), 'Canned Food', '2', ''],
  ]);
  api.checkShotDue();
  eq(mail.length, 1, 'logging food does not count as logging insulin');
}

/* ==================== alert key housekeeping ==================== */
{
  const { api, props } = load(at(2026, 8, 28, 12, 0), [], {
    props: {
      'alerted:2026-08-27:night': '1',
      'alerted:2026-08-01:morning': '1',
      'SOME_OTHER_KEY': 'keep-me',
    },
  });
  api.cleanupAlertKeys_(({
    getProperties: () => Object.assign({}, props),
    deleteProperty: k => { delete props[k]; },
  }));
  ok('alerted:2026-08-27:night' in props, 'yesterday stays');
  ok(!('alerted:2026-08-01:morning' in props), '27 days old is dropped');
  eq(props['SOME_OTHER_KEY'], 'keep-me', 'non-alert properties are untouched');
}

/* ============ stock: what is left, and when it runs out ==================== */
{
  // No Stock tab yet (nobody has synced since the update). This runs every
  // morning on a trigger, so failing here would email an error every day.
  const { api, mail } = load(at(2026, 8, 28, 8, 0), []);
  eq(api.readStockTab_().length, 0, 'a missing Stock tab reads as empty');
  eq(api.checkStock(), 0, 'and the daily check does nothing rather than throwing');
  eq(mail.length, 0, 'no email');
}
{
  /* THE SHARED FIXTURE — test-logic.js asserts the app reaches these same
     three numbers from the same shape of data. Both implementations of the
     stock model have to agree; this pair is what catches them drifting. */
  const rows = [];
  for (let d = 9; d <= 28; d++) rows.push([cell(2026, 8, d), cell(2026, 8, d, 11, 30), 'Prednisolone', '0.5', '']);
  const { api } = load(at(2026, 8, 28, 12, 0), rows, {
    stockRows: [['Prednisolone', 30, 'tablets', '08/08/2026']],
  });
  const items = api.readStockTab_();
  eq(items.length, 1, 'the Stock tab is read');
  eq(items[0].name, 'Prednisolone', 'by canonical name');

  const f = api.stockForecast_(items[0], api.readRows(), new Date(at(2026, 8, 28, 12, 0)));
  eq(f.left, 20, 'SHARED FIXTURE left: 30 in, 10 used');
  eq(f.rate, 0.5, 'SHARED FIXTURE rate: 0.5 a day');
  eq(f.days, 40, 'SHARED FIXTURE days: 20 left at 0.5 a day');
}
{
  /* THE SHARED FIXTURE for the per-day box — test-logic.js asserts the app
     reaches these same three numbers from the same shape of data. */
  const rows = [];
  for (let d = 9; d <= 28; d++) rows.push([cell(2026, 8, d), cell(2026, 8, d, 11, 30), 'Prednisolone', '0.5', '']);
  const { api } = load(at(2026, 8, 28, 12, 0), rows, {
    stockRows: [['Prednisolone', 30, 'tablets', '08/08/2026', 1]],
  });
  const it = api.readStockTab_()[0];
  eq(it.perDay, 1, 'the PER DAY column is read');
  const f = api.stockForecast_(it, api.readRows(), new Date(at(2026, 8, 28, 12, 0)));
  eq(f.left, 20, 'SHARED FIXTURE perDay left: 30 in, 10 used');
  eq(f.rate, 1, 'SHARED FIXTURE perDay rate: the box beats the fixed 0.5');
  eq(f.days, 20, 'SHARED FIXTURE perDay days: 20 left at 1 a day');
}
{
  // A Stock tab written before the PER DAY column existed has five columns.
  // The daily trigger reads it before the app has pushed again, so a missing
  // sixth cell must mean "no override", not NaN or a throw.
  const { api } = load(at(2026, 8, 28, 12, 0), [], {
    stockRows: [['Prednisolone', 30, 'tablets', '08/08/2026'], ['Insulin', 100, 'units', '08/08/2026', '']],
  });
  const items = api.readStockTab_();
  eq(items[0].perDay, 0, 'a five-column row reads as no per-day figure');
  eq(items[1].perDay, 0, 'and so does a blank cell');
  const now = new Date(at(2026, 8, 28, 12, 0));
  eq(api.stockForecast_(items[0], api.readRows(), now).rate, 0.5, 'so the fixed routine still applies');
  eq(api.stockForecast_(items[1], api.readRows(), now).rate, 17, 'for every item');
}
{
  // Not-a-number and negative figures are as good as blank: never a zero or
  // negative burn rate, which would read as "lasts forever".
  const { api } = load(at(2026, 8, 28, 12, 0), [], {
    stockRows: [['Prednisolone', 30, 'tablets', '08/08/2026', 'lots'], ['Insulin', 100, 'units', '08/08/2026', -2]],
  });
  const now = new Date(at(2026, 8, 28, 12, 0));
  const items = api.readStockTab_();
  eq(api.stockForecast_(items[0], api.readRows(), now).rate, 0.5, 'text falls back to the fixed rate');
  eq(api.stockForecast_(items[1], api.readRows(), now).rate, 17, 'and so does a negative');
}
{
  // The morning check follows the typed rate, for the email and the calendar.
  // Insulin, 100 left with a per-day of 25: 4 days, not the fixed 17's 5.
  const { api, mail, events } = load(at(2026, 8, 28, 12, 0), [], {
    stockRows: [['Insulin', 100, 'units', '15/08/2026', 25]],
  });
  eq(api.checkStock(), 1, 'low on the bottle rule');
  ok(/about 25 units a day/.test(mail[0].body), 'the email quotes the typed rate');
  ok(/4 days/.test(mail[0].body), 'and the days it implies');
  eq(events[0].when.getDate(), 1, 'the calendar event lands 4 days out, on 1 Sep');
}
{
  // The vet-reorder email is on days of supply too, so it must move with the box.
  // 60 syringes lasts 30 days at the fixed 2 a day, so nothing is sent...
  const { api, mail } = load(at(2026, 8, 28, 12, 0), [], {
    stockRows: [['Syringes', 60, 'syringes', '28/08/2026']],
  });
  eq(api.checkStock(), 0, 'thirty days out is quiet');
  eq(mail.length, 0, 'no email');
  // ...but at a typed 8 a day it is 7 days, inside VET_REORDER_DAYS (10).
  const b = load(at(2026, 8, 28, 12, 0), [], {
    stockRows: [['Syringes', 60, 'syringes', '28/08/2026', 8]],
  });
  eq(b.api.checkStock(), 2, 'the self-reminder and the vet reorder both fire');
  eq(b.mail[1].to, 'hellopoole@natterjacksvet.com', 'the vet is asked to reorder');
}
{
  // A sheet spelling the app does not use must still be counted against stock.
  const rows = [];
  for (let d = 15; d <= 28; d++) rows.push([cell(2026, 8, d), cell(2026, 8, d, 11, 30), 'Chicken Slice \uD83C\uDF57', '100', '']);
  const { api } = load(at(2026, 8, 28, 12, 0), rows, {
    stockRows: [['Chicken Slice', 2000, 'g', '15/08/2026']],
  });
  const f = api.stockForecast_(api.readStockTab_()[0], api.readRows(), new Date(at(2026, 8, 28, 12, 0)));
  eq(f.used, 1400, 'the emoji spelling counts against the plain one');
  eq(f.left, 600, 'so what is left is right');
}
{
  // Under a week of supply: email now, calendar event for the day it goes.
  const rows = [];
  for (let d = 15; d <= 28; d++) rows.push([cell(2026, 8, d), cell(2026, 8, d, 11, 30), 'Insulin', '16', '']);
  const { api, mail, events, props } = load(at(2026, 8, 28, 12, 0), rows, {
    stockRows: [['Insulin', 300, 'units', '15/08/2026']],
  });
  eq(api.checkStock(), 1, 'one item is low');
  eq(mail.length, 1, 'and it is emailed');
  ok(/running low on Insulin/.test(mail[0].subject), 'the subject names it');
  ok(/76 units left/.test(mail[0].body), '300 in, 224 used');
  ok(/about 17 units a day/.test(mail[0].body), 'with the fixed daily rate, not the logged 16/day');
  ok(/4 days/.test(mail[0].body), 'and the days left');

  eq(events.length, 1, 'a calendar reminder is created');
  eq(events[0].title, 'Zuse: Insulin runs out', 'named plainly');
  eq(events[0].when.getDate(), 1, 'on 1 Sep, four days out');
  eq(events[0].when.getHours(), 9, 'at 9am');
  eq(events[0].reminders[0], 0, 'with a popup at the time, so it reaches the phone');

  // Never twice for the same restock.
  eq(api.checkStock(), 0, 'a second run that morning says nothing');
  eq(mail.length, 1, 'no second email');
  ok(Object.keys(props).some(k => k.indexOf('stock:Insulin|') === 0), 'the cycle is remembered');
}
{
  // Restocking moves the "counting from" date, which must let it speak again.
  const rows = [];
  for (let d = 15; d <= 28; d++) rows.push([cell(2026, 8, d), cell(2026, 8, d, 11, 30), 'Insulin', '16', '']);
  const { api, mail, props } = load(at(2026, 8, 28, 12, 0), rows, {
    stockRows: [['Insulin', 300, 'units', '15/08/2026']],
    props: { 'stock:Insulin|20/08/2026': '1' },
  });
  api.checkStock();
  eq(mail.length, 1, 'the key from a previous restock does not silence it');
  ok(!('stock:Insulin|20/08/2026' in props), 'and that stale key is cleared out');
}
{
  // Plenty in hand: silence.
  const rows = [];
  for (let d = 15; d <= 28; d++) rows.push([cell(2026, 8, d), cell(2026, 8, d, 11, 30), 'Insulin', '16', '']);
  const { api, mail, events } = load(at(2026, 8, 28, 12, 0), rows, {
    stockRows: [['Insulin', 3000, 'units', '15/08/2026']],
  });
  eq(api.checkStock(), 0, 'over a week of supply says nothing');
  eq(mail.length + events.length, 0, 'no email, no event');
}
{
  // The calendar scope may never have been granted. The email still has to go.
  const rows = [];
  for (let d = 15; d <= 28; d++) rows.push([cell(2026, 8, d), cell(2026, 8, d, 11, 30), 'Insulin', '16', '']);
  const { api, mail, events } = load(at(2026, 8, 28, 12, 0), rows, {
    stockRows: [['Insulin', 300, 'units', '15/08/2026']], calendarFails: true,
  });
  eq(api.checkStock(), 1, 'still reports the low item');
  eq(mail.length, 1, 'the email survives a calendar failure');
  eq(events.length, 0, 'only the reminder is lost');
}
{
  // Syringes are never a row of their own: one is spent per Insulin row, so the
  // burn rate is a count of shots and has nothing to do with the units column.
  const rows = [];
  for (let d = 15; d <= 28; d++) {
    rows.push([cell(2026, 8, d), cell(2026, 8, d, 11, 30), 'Insulin', '16', '']);
    rows.push([cell(2026, 8, d), cell(2026, 8, d, 23, 30), 'Insulin', '16', '']);
  }
  const { api, mail, events } = load(at(2026, 8, 28, 12, 0), rows, {
    stockRows: [['Syringes', 40, 'syringes', '15/08/2026']],
  });
  const f = api.stockForecast_(api.readStockTab_()[0], api.readRows(), new Date(at(2026, 8, 28, 12, 0)));
  eq(f.used, 28, '28 shots is 28 syringes, not 448');
  eq(f.rate, 2, 'two a day');
  eq(f.left, 12, '40 in, 28 used');
  eq(f.days, 6, 'six days left');
  // Six days trips both the ordinary week-of-supply self-email and, since
  // Syringes is in VET_REORDER and 6 <= VET_REORDER_DAYS (10), the vet email.
  eq(api.checkStock(), 2, 'the self-reminder and the vet reorder both fire');
  eq(mail.length, 2, 'two separate emails');
  ok(/running low on Syringes/.test(mail[0].subject), 'the self-reminder names them, and goes out first');
  eq(mail[1].to, 'hellopoole@natterjacksvet.com', 'the vet email goes to the vet, not the owner');
  ok(/Zuse Mihai U40 Syringes reorder request/.test(mail[1].subject), 'and says what it is');
  ok(/order in 60 U40 Syringes/.test(mail[1].body), 'asking for the fixed reorder amount');
  ok(/07496 751 666/.test(mail[1].body), 'and to call this number when ready');
  eq(events.length, 1, 'only the self-reminder gets a calendar event');
}
{
  // Insulin is bought by the bottle, so days of supply is the wrong alarm: at
  // the fixed 17 units a day, 388 left is 22 days away and still the last bottle.
  const rows = [];
  for (let d = 15; d <= 28; d++) rows.push([cell(2026, 8, d), cell(2026, 8, d, 11, 30), 'Insulin', '8', '']);
  const { api, mail } = load(at(2026, 8, 28, 12, 0), rows, {
    stockRows: [['Insulin', 500, 'units', '15/08/2026']],
  });
  const f = api.stockForecast_(api.readStockTab_()[0], api.readRows(), new Date(at(2026, 8, 28, 12, 0)));
  eq(f.days, 22, 'a week-of-supply rule would say nothing for another 15 days');
  eq(api.checkStock(), 1, 'the bottle rule speaks up now, while there is time to order');
  ok(/388 units left/.test(mail[0].body), 'and says what is left');
}
{
  // Insulin has a FIXED_RATE, so even with nothing logged in a fortnight the
  // bottle rule still gets a real days estimate instead of "no estimate".
  const { api, mail, events } = load(at(2026, 8, 28, 12, 0), [], {
    stockRows: [['Insulin', 100, 'units', '15/08/2026']],
  });
  eq(api.checkStock(), 1, 'a bottle rule fires on the fixed rate with nothing logged');
  ok(/about 17 units a day/.test(mail[0].body), 'the fixed rate stands in for real usage');
  ok(/5 days/.test(mail[0].body), '100 left at 17\\/day is 5 days');
  eq(events.length, 1, 'and a calendar reminder can now be made for that day');
}

/* ============ the two new POST actions ==================================== */
{
  const { api, post, stock, formats } = load(at(2026, 8, 28, 12, 0), []);
  const r = post({ action: 'stock', items: [
    { name: 'Prednisolone', qty: 12, unit: 'tablets', since: '20/08/2026' },
    { name: 'Insulin', qty: 300, unit: 'units', since: '15/08/2026' },
  ] });
  eq(r.saved, 2, 'both items are written');
  const v = stock().getDataRange().getValues();
  eq(v[0][0], 'ITEM', 'the tab gets a header');
  eq(v[1][0], 'Prednisolone', 'then the rows');
  eq(v[2][1], 300, 'quantities land as numbers, not text');
  // and the round trip reads back as the same thing
  eq(api.readStockTab_()[0].qty, 12, 'what was written is what is read');
  eq(api.readStockTab_()[1].since, '15/08/2026', 'dates survive the round trip');
  // A fresh tab has no format history, so an unpinned dd/MM/yyyy string is at
  // the mercy of the spreadsheet's locale: 05/08 could come back as 8 May.
  ok(formats.some(f => f.c === 4 && f.f === '@'),
     'the COUNTING FROM column is pinned to text before anything is written');
}
{
  // The per-day figure goes up with the stock and comes back on the same row.
  const { api, post, stock } = load(at(2026, 8, 28, 12, 0), []);
  post({ action: 'stock', items: [
    { name: 'Prednisolone', qty: 12, unit: 'tablets', since: '20/08/2026', perDay: 1 },
    { name: 'Insulin', qty: 300, unit: 'units', since: '15/08/2026', perDay: 0 },
    { name: 'Samylin', qty: 5, unit: 'tablets', since: '15/08/2026' },
  ] });
  const v = stock().getDataRange().getValues();
  eq(v[0][5], 'PER DAY', 'the tab gets a sixth column');
  eq(v[1][5], 1, 'a typed figure is stored as a number');
  eq(v[2][5], '', 'zero is stored blank, meaning automatic');
  eq(v[3][5], '', 'and so is a row from an app that sends none');
  eq(v[1].length, 6, 'every row has all six columns');
  const back = api.readStockTab_();
  eq(back[0].perDay, 1, 'the figure round-trips');
  eq(back[1].perDay, 0, 'blank reads back as no override');
}
{
  // Re-pushing must replace, never append: stale items would go on alerting.
  const { post, stock } = load(at(2026, 8, 28, 12, 0), [], {
    stockRows: [['Insulin', 300, 'units', '15/08/2026'], ['Carrot', 9, '', '01/08/2026']],
  });
  post({ action: 'stock', items: [{ name: 'Insulin', qty: 400, unit: 'units', since: '28/08/2026' }] });
  const v = stock().getDataRange().getValues();
  eq(v.length, 2, 'the dropped item is gone, not left behind');
  eq(v[1][1], 400, 'and the kept one is updated');
}
{
  const { post } = load(at(2026, 8, 28, 12, 0), []);
  eq(post({ action: 'nonsense' }).error, 'unknown action', 'anything else is refused');
  eq(JSON.parse(load(at(2026, 8, 28, 12, 0), []).api.doPost(
    { postData: { contents: '{"action":"stock"}' } }).__out).error,
    'unauthorized', 'and the secret is still required');
}
{
  /* Syncing is used every day; the calendar scope may not be granted for weeks.
     No doPost path may touch CalendarApp, or an ungranted scope would break it. */
  const { post, stock } = load(at(2026, 8, 28, 12, 0), [], { calendarFails: true });
  eq(post({ action: 'stock', items: [{ name: 'Insulin', qty: 5, unit: 'units', since: '28/08/2026' }] }).saved,
     1, 'pushing stock works with no calendar access');
  eq(post({ action: 'append', rows: [] }).added, 0, 'so does appending');
  eq(stock().getDataRange().getValues().length, 2, 'and the tab was really written');
}

/* ============ vet reorder email: Prednisolone and Syringes, day 10 ======== */
{
  // 0.5 a day, restocked at 12: 7 used over the 14-day window leaves 5, which
  // at 0.5 a day is exactly 10 days - the vet threshold. 10 is well outside
  // the ordinary 7-day self-reminder rule, so only the vet email should go.
  const rows = [];
  for (let d = 15; d <= 28; d++) rows.push([cell(2026, 8, d), cell(2026, 8, d, 9, 0), 'Prednisolone', '0.5', '']);
  const { api, mail, events, props } = load(at(2026, 8, 28, 12, 0), rows, {
    stockRows: [['Prednisolone', 12, 'tablets', '15/08/2026']],
  });
  eq(api.checkStock(), 1, 'the vet reorder fires even though the self-reminder rule would not');
  eq(mail.length, 1, 'one email');
  eq(mail[0].to, 'hellopoole@natterjacksvet.com', 'to the vet');
  ok(/Zuse Mihai Prednisolone reorder request/.test(mail[0].subject), 'naming the item');
  ok(/order in 30 Prednisolone tablets/.test(mail[0].body), 'asking for the fixed reorder amount');
  ok(/07496 751 666/.test(mail[0].body), 'and to call this number when ready');
  eq(events.length, 0, 'the vet email gets no calendar reminder, that is the self-reminder\'s job');

  eq(api.checkStock(), 0, 'a second run the same day sends nothing more');
  eq(mail.length, 1, 'no second vet email');
  ok(Object.keys(props).some(k => k.indexOf('vetorder:Prednisolone|') === 0), 'the cycle is remembered');
}
{
  // Restocking moves "counting from", which must let the vet email fire again,
  // exactly like the existing stock: key does for the self-reminder.
  const rows = [];
  for (let d = 15; d <= 28; d++) rows.push([cell(2026, 8, d), cell(2026, 8, d, 9, 0), 'Prednisolone', '0.5', '']);
  const { api, mail, props } = load(at(2026, 8, 28, 12, 0), rows, {
    stockRows: [['Prednisolone', 12, 'tablets', '15/08/2026']],
    props: { 'vetorder:Prednisolone|20/08/2026': '1' },
  });
  api.checkStock();
  eq(mail.length, 1, 'the key from a previous restock does not silence the vet email');
  ok(!('vetorder:Prednisolone|20/08/2026' in props), 'and that stale key is cleared out');
}
{
  // One tablet more in hand pushes it to 12 days: past the vet threshold, and
  // still well past the ordinary 7-day self-reminder rule too.
  const rows = [];
  for (let d = 15; d <= 28; d++) rows.push([cell(2026, 8, d), cell(2026, 8, d, 9, 0), 'Prednisolone', '0.5', '']);
  const { api, mail } = load(at(2026, 8, 28, 12, 0), rows, {
    stockRows: [['Prednisolone', 13, 'tablets', '15/08/2026']],
  });
  eq(api.checkStock(), 0, '12 days of supply is outside the 10-day vet rule');
  eq(mail.length, 0, 'no email at all');
}

/* ============ cancelling one cycle's vet email ============================ */
{
  // The cancel button sets the same dedupe key checkStock checks, so it works
  // whether clicked before or after the threshold is actually reached.
  const rows = [];
  for (let d = 15; d <= 28; d++) rows.push([cell(2026, 8, d), cell(2026, 8, d, 9, 0), 'Prednisolone', '0.5', '']);
  const { api, mail, post } = load(at(2026, 8, 28, 12, 0), rows, {
    stockRows: [['Prednisolone', 12, 'tablets', '15/08/2026']],
  });
  eq(post({ action: 'skipVetOrder', name: 'Prednisolone', since: '15/08/2026' }).ok, true,
     'cancelling is acknowledged');
  eq(api.checkStock(), 0, 'the vet email this cycle is suppressed');
  eq(mail.length, 0, 'nothing is sent');
}
{
  // Cancelling the vet email must not touch the separate self-reminder path.
  const rows = [];
  for (let d = 15; d <= 28; d++) {
    rows.push([cell(2026, 8, d), cell(2026, 8, d, 9, 0), 'Prednisolone', '0.5', '']);
    rows.push([cell(2026, 8, d), cell(2026, 8, d, 11, 30), 'Insulin', '16', '']);
  }
  const { api, mail, post } = load(at(2026, 8, 28, 12, 0), rows, {
    stockRows: [['Prednisolone', 12, 'tablets', '15/08/2026'], ['Insulin', 300, 'units', '15/08/2026']],
  });
  post({ action: 'skipVetOrder', name: 'Prednisolone', since: '15/08/2026' });
  eq(api.checkStock(), 1, 'the unrelated low-insulin self-reminder still fires');
  eq(mail.length, 1, 'only the self-reminder email, the vet email stayed cancelled');
  ok(/running low on Insulin/.test(mail[0].subject), 'and it is the right one');
}
{
  const { post } = load(at(2026, 8, 28, 12, 0), []);
  eq(post({ action: 'skipVetOrder', name: 'Prednisolone' }).error, 'missing name/since',
     'since is required');
  eq(post({ action: 'skipVetOrder', since: '15/08/2026' }).error, 'missing name/since',
     'name is required');
}

{
  /* The user pastes zuse-sync-REPLACE-from-doPost.gs.txt over the bottom of
     their live script. If it drifts from the source, they paste stale code and
     have no way of knowing. It also must never carry a SECRET line, or the
     paste would overwrite theirs and silently break syncing. */
  const slice = fs.readFileSync(path.join(__dirname, 'zuse-sync-REPLACE-from-doPost.gs.txt'), 'utf8');
  // The FIRST header break only - the script below it has banners of its own.
  const cut = slice.indexOf(' */\n\n');
  const body = cut === -1 ? undefined : slice.slice(cut + 5);
  ok(body !== undefined, 'the paste file keeps its instruction header');
  ok(!/^const SECRET/m.test(slice), 'and never carries a SECRET line');
  ok(/Manage deployments/.test(slice), 'and says the web app has to be redeployed');
  // That it matches the real script byte-for-byte is asserted at the end of
  // this file, where a failure can name the line that drifted.
}

{
  /* The whole chain in one go: the app pushes, the sheet stores, the morning
     check reads it back and forecasts. Each half is tested above; this is the
     join, where a date that stopped being a string would go unnoticed. */
  const rows = [];
  for (let d = 15; d <= 28; d++) rows.push([cell(2026, 8, d), cell(2026, 8, d, 11, 30), 'Insulin', '16', '']);
  const { api, post, mail, events } = load(at(2026, 8, 28, 8, 0), rows);
  eq(post({ action: 'stock', items: [
    { name: 'Insulin', qty: 300, unit: 'units', since: '15/08/2026' },
  ] }).saved, 1, 'the app pushes one item');

  const it = api.readStockTab_()[0];
  eq(it.since, '15/08/2026', 'and it reads back as the string that was written');
  const f = api.stockForecast_(it, api.readRows(), new Date(at(2026, 8, 28, 8, 0)));
  eq(f.left, 76, 'the forecast works off the pushed baseline');
  eq(f.days, 4, 'and predicts four days');

  eq(api.checkStock(), 1, 'so the morning check finds it low');
  eq(mail.length, 1, 'emails once');
  eq(events.length, 1, 'and books the reminder');
}

{
  /* The backend lives in two committed files, and only zuse-sync-code.gs.txt is
     exercised by the tests above. Everything from "function doPost(e) {" onward
     has to be byte-identical in both, or someone edits one file, ships the
     other, and the paste file is quietly stale. The check above allows trailing
     whitespace to differ; this one does not, and when it fails it says which
     line went first instead of printing two entire scripts at you. */
  const REPLACE_NAME = 'zuse-sync-REPLACE-from-doPost.gs.txt';
  const replaceSrc = fs.readFileSync(path.join(__dirname, REPLACE_NAME), 'utf8');
  const iSrc = SRC.indexOf('\nfunction doPost(e) {');
  const iRep = replaceSrc.indexOf('\nfunction doPost(e) {');
  ok(iSrc !== -1, 'doPost not found in zuse-sync-code.gs.txt');
  ok(iRep !== -1, `doPost not found in ${REPLACE_NAME}`);
  const tailA = SRC.slice(iSrc);
  const tailB = replaceSrc.slice(iRep);
  // Line numbers are counted within the sliced tail, line 1 being the blank
  // line that precedes "function doPost(e) {" in both files.
  const linesA = tailA.split('\n');
  const linesB = tailB.split('\n');
  let firstDiff = 0;
  while (firstDiff < Math.max(linesA.length, linesB.length)
         && linesA[firstDiff] === linesB[firstDiff]) firstDiff++;
  eq(tailA === tailB, true,
     `the two .gs.txt files have drifted and must be updated together — `
     + `zuse-sync-code.gs.txt and ${REPLACE_NAME} first differ at line `
     + `${firstDiff + 1} of the doPost tail: `
     + `${JSON.stringify(linesA[firstDiff])} vs ${JSON.stringify(linesB[firstDiff])}`);
}

/* ================= windowed read: only the last N days leave the sheet ================= */
{
  const t = load(at(2026, 8, 28, 12, 0), [
    [cell(2026, 6, 1), cell(2026, 6, 1, 8, 0), 'Insulin', '8 Units', ''],
    ['', cell(2026, 6, 1, 9, 0), 'Food', '1', 'old continuation'],
    [cell(2026, 8, 10), cell(2026, 8, 10, 8, 0), 'Insulin', '8 Units', ''],
    ['', cell(2026, 8, 10, 9, 0), 'Food', '1', 'kept continuation'],
    [cell(2026, 8, 28), cell(2026, 8, 28, 8, 0), 'Insulin', '8 Units', ''],
  ]);
  const rows = t.api.readRows(30);
  eq(rows.length, 3, 'windowed read drops the old date and its blank-date continuation');
  eq(rows[1].date, '10/08/2026', 'a continuation row inside the window keeps its carried date');
  eq(t.api.readRows().length, 5, 'no argument still reads everything, for the stock forecast');
  eq(load(at(2026, 8, 28, 12, 0), []).api.readRows(30).length, 0, 'empty sheet is fine');
  const g = JSON.parse(t.api.doGet({ parameter: { secret: 'CHANGE_ME_TO_YOUR_OWN_SECRET' } }).__out);
  eq(g.rows.length, 3, 'doGet list serves the 30-day window');
  eq(JSON.parse(t.api.doGet({ parameter: { secret: 'CHANGE_ME_TO_YOUR_OWN_SECRET', days: '0' } }).__out).rows.length, 5, 'days=0 serves the whole sheet');
}

/* ================= readRows: an old-dated block at the bottom hides nothing ================= */
{
  // appendRows puts anything the app pushes at the very bottom, so a stale push
  // leaves old dates BELOW current ones. Walking up must skip them, not stop.
  const NOW = at(2026, 8, 28, 12, 0);
  const rows = [
    [cell(2026, 8, 10), cell(2026, 8, 10, 8, 0), 'Insulin', '8 Units', ''],
    ['', cell(2026, 8, 10, 9, 0), 'Canned Food', '2', ''],
    [cell(2026, 8, 28), cell(2026, 8, 28, 8, 0), 'Insulin', '8 Units', ''],
    [cell(2026, 6, 1), cell(2026, 6, 1, 8, 0), 'Insulin', '8 Units', ''],
    ['', cell(2026, 6, 1, 9, 0), 'Canned Food', '2', 'old continuation'],
    [cell(2026, 6, 2), cell(2026, 6, 2, 8, 0), 'Insulin', '8 Units', ''],
  ];
  const t = load(NOW, rows);
  const got = t.api.readRows(30);
  eq(got.length, 3, 'in-window rows above an old-dated block are still returned');
  ok(got.every(r => !/\/06\//.test(r.date)), 'and the stale block, continuation rows included, is left out');
  eq(got[1].date, '10/08/2026', 'carried dates inside the window survive');
  eq(t.api.readRows().length, 6, 'no argument still returns every row');
  // The ceiling: more than 200 consecutive stale dated rows stops the walk.
  const many = rows.slice(0, 3);
  for (let i = 0; i < 250; i++) many.push([cell(2026, 6, 1 + (i % 28)), cell(2026, 6, 1, 8, 0), 'Walk', '10', '']);
  eq(load(NOW, many).api.readRows(30).length, 0, 'but the walk is bounded: a 250-row stale block does hide what is above it');
}

/* ================= 'fix' action: cross-device delete and update ================= */
{
  const NOW = at(2026, 8, 28, 12, 0), SECRET = 'CHANGE_ME_TO_YOUR_OWN_SECRET';
  const mk = () => load(NOW, [
    [cell(2026, 8, 27), cell(2026, 8, 27, 8, 0), 'Insulin', '8 Units', ''],          // sheet row 3
    ['', cell(2026, 8, 27, 9, 0), 'Canned Food', '2', 'a'],                           // row 4, date blank
    ['', cell(2026, 8, 27, 10, 0), 'Walk', '15', ''],                                 // row 5, date blank
    [cell(2026, 8, 28), cell(2026, 8, 28, 8, 0), 'Insulin', '8 Units', ''],          // row 6
    ['', cell(2026, 8, 28, 9, 0), 'Canned Food', '2', ''],                            // row 7
  ], { calendarFails: true });
  const key = (d, tm, ty) => ({ date: d, time: tm, type: ty });
  const listOf = t => JSON.parse(t.api.doGet({ parameter: { secret: SECRET } }).__out);

  {
    const t = mk();
    const r = t.post({ action: 'fix', del: [key('27/08/2026', '9:00 am', 'Canned Food')] });
    eq(r.ok, true, 'fix answers ok');
    eq(r.deleted, 1, 'one row cleared');
    eq(r.updated, 0, 'nothing updated');
    const v = t.sheet().getDataRange().getValues();
    eq([v[3][3], v[3][4], v[3][5]].join('|'), '||', 'TYPE, QTY and NOTES are cleared');
    eq(v[3][1], '', 'the DATE cell is never touched');
    eq(v.length, 7, 'and the row itself is not removed');
    const rows = t.api.readRows(30);
    eq(rows.length, 4, 'the cleared row reads back as gone');
    const walk = rows.find(x => x.type === 'Walk');
    eq(walk.date, '27/08/2026', 'carry-forward: the row after the cleared one still reads the right date');
    eq(rows.find(x => x.date === '28/08/2026').time, '8:00 am', 'and the next day is intact');
    eq(t.locks.join(), 'wait,release', 'fix runs inside the script lock');
    ok('tomb:27/08/2026|9:00 am|canned food' in t.props, 'a tombstone is recorded under the lowercased type');
    eq(t.props['tomb:27/08/2026|9:00 am|canned food'], String(NOW), 'valued with the time of the delete');
    eq(JSON.stringify(listOf(t).tomb), JSON.stringify([key('27/08/2026', '9:00 am', 'canned food')]), 'list returns it');
    eq(listOf(t).rows.length, 4, 'and the list rows no longer include the deleted one');
    ok(!('row' in listOf(t).rows[0]), 'list rows keep their old shape');
  }
  {
    // The first row of a day is the one that carries the date: clearing it must
    // not re-date the rows under it.
    const t = mk();
    t.post({ action: 'fix', del: [key('27/08/2026', '8:00 am', 'Insulin')] });
    const rows = t.api.readRows(30);
    eq(rows[0].date, '27/08/2026', 'clearing a day-leading row leaves its date cell for the rows below');
    eq(rows[0].type, 'Canned Food', 'and they keep that date');
  }
  {
    const t = mk();
    const r = t.post({ action: 'fix', upd: [
      { date: '28/08/2026', time: '8:00 am', type: 'INSULIN ', qty: '9 Units', notes: 'vet said 9' },
      { date: '28/08/2026', time: '3:33 pm', type: 'Insulin', qty: '1 Units', notes: 'no such row' },
    ] });
    eq(r.updated, 1, 'update is matched by key (type case-insensitive); a miss is ignored');
    eq(r.deleted, 0, 'no deletes');
    const v = t.sheet().getDataRange().getValues();
    eq(v[5][4], '9 Units', 'QTY updated');
    eq(v[5][5], 'vet said 9', 'NOTES updated');
    eq(v[5][3], 'Insulin', 'TYPE left alone');
    eq(v[2][4], '8 Units', 'other rows untouched');
    eq(Object.keys(t.props).filter(k => k.indexOf('tomb:') === 0).length, 0, 'an update records no tombstone');
  }
  {
    // Two rows share one key (same type, same minute): only the first is touched.
    const dup = () => load(NOW, [
      [cell(2026, 8, 28), cell(2026, 8, 28, 9, 0), 'Canned Food', '1', 'first'],
      ['', cell(2026, 8, 28, 9, 0), 'Canned Food', '1', 'second'],
    ]);
    const t = dup();
    const r = t.post({ action: 'fix', del: [key('28/08/2026', '9:00 am', 'Canned Food')] });
    eq(r.deleted, 1, 'duplicate keys: one clear');
    const v = t.sheet().getDataRange().getValues();
    eq(v[2][3], '', 'the first match is cleared');
    eq(v[3][3], 'Canned Food', 'the second is left');
    const u = dup();
    u.post({ action: 'fix', upd: [{ date: '28/08/2026', time: '9:00 am', type: 'Canned Food', qty: '5', notes: 'x' }] });
    eq(u.sheet().getDataRange().getValues()[2][4], '5', 'update hits the first');
    eq(u.sheet().getDataRange().getValues()[3][4], '1', 'and only the first');
  }
  {
    // Two queued edits of one entry: the last write must land, not the first.
    const t = mk();
    const k = { date: '28/08/2026', time: '8:00 am', type: 'Insulin' };
    const r = t.post({ action: 'fix', upd: [Object.assign({ qty: '9 Units', notes: 'one' }, k), Object.assign({ qty: '10 Units', notes: 'two' }, k)] });
    eq(r.updated, 2, 'both edits are applied');
    const v = t.sheet().getDataRange().getValues();
    eq(v[5][4] + '|' + v[5][5], '10 Units|two', 'the later edit of the same key wins');
  }
  {
    // A phone may hold an entry the sheet never got, so the tombstone is kept anyway.
    const t = mk();
    const r = t.post({ action: 'fix', del: [key('27/08/2026', '4:44 pm', 'Walk'), key('01/01/2020', '8:00 am', 'Insulin')] });
    eq(r.deleted, 0, 'nothing matched, nothing cleared');
    ok('tomb:27/08/2026|4:44 pm|walk' in t.props, 'but the tombstone is still recorded');
    ok('tomb:01/01/2020|8:00 am|insulin' in t.props, 'even for a row outside the scanned window');
  }
  {
    // Rows older than 31 days are not scanned.
    const t = load(NOW, [[cell(2026, 7, 20), cell(2026, 7, 20, 8, 0), 'Insulin', '8 Units', '']]);
    eq(t.post({ action: 'fix', del: [key('20/07/2026', '8:00 am', 'Insulin')] }).deleted, 0, 'a 39-day-old row is out of reach');
    eq(t.sheet().getDataRange().getValues()[2][3], 'Insulin', 'and is untouched');
  }
  {
    // A deliberate re-log revives the entry.
    const t = mk();
    t.post({ action: 'fix', del: [key('28/08/2026', '9:00 am', 'Canned Food')] });
    eq(listOf(t).tomb.length, 1, 'tombstoned');
    eq(t.post({ action: 'append', rows: [{ date: '28/08/2026', time: '9:00 am', type: 'Canned Food', qty: '2', notes: '' }] }).added, 1, 're-appended');
    eq(listOf(t).tomb.length, 0, 'the append clears the tombstone');
    ok(!('tomb:28/08/2026|9:00 am|canned food' in t.props), 'from the properties too');
    // An append of something else leaves other tombstones alone.
    t.post({ action: 'fix', del: [key('28/08/2026', '9:00 am', 'Canned Food')] });
    t.post({ action: 'append', rows: [{ date: '28/08/2026', time: '9:01 am', type: 'Canned Food', qty: '2', notes: '' }] });
    eq(listOf(t).tomb.length, 1, 'an unrelated append does not revive it');
  }
  {
    // An alias the app does not know ("Treats") lives there as a note with srcType
    // "Treats", but canonType_ makes it "Treat": the tomb must keep the app's text.
    const t = load(NOW, [[cell(2026, 8, 27), cell(2026, 8, 27, 8, 0), 'Treats', '2', '']]);
    eq(t.post({ action: 'fix', del: [key('27/08/2026', '8:00 am', 'Treats')] }).deleted, 1, 'an alias row is still matched by its canon type');
    eq(JSON.stringify(listOf(t).tomb), JSON.stringify([key('27/08/2026', '8:00 am', 'treats')]), 'its tomb carries the text the app sent, not the canon name');
  }
  {
    // Pruned at 31 days, by fix and by list.
    const old = String(NOW - 32 * 864e5), fresh = String(NOW - 5 * 864e5);
    const props = { 'tomb:01/07/2026|8:00 am|Insulin': old, 'tomb:23/08/2026|8:00 am|Insulin': fresh, 'stock:Insulin|01/08/2026': '1' };
    const a = load(NOW, [], { props: Object.assign({}, props) });
    eq(listOf(a).tomb.length, 1, 'list shows only the live tombstone');
    ok(!('tomb:01/07/2026|8:00 am|Insulin' in a.props), 'and prunes the stale one');
    ok('stock:Insulin|01/08/2026' in a.props, 'other keys are untouched');
    const b = load(NOW, [], { props: Object.assign({}, props) });
    b.post({ action: 'fix', del: [] });
    ok(!('tomb:01/07/2026|8:00 am|Insulin' in b.props), 'fix prunes too');
    ok('tomb:23/08/2026|8:00 am|Insulin' in b.props, 'and keeps the fresh one');
  }
  {
    const t = mk();
    const r = JSON.parse(t.api.doPost({ postData: { contents: JSON.stringify({ secret: 'wrong', action: 'fix', del: [key('27/08/2026', '9:00 am', 'Canned Food')] }) } }).__out);
    eq(r.error, 'unauthorized', 'a wrong secret is refused');
    eq(t.sheet().getDataRange().getValues()[3][3], 'Canned Food', 'and nothing was cleared');
    eq(Object.keys(t.props).length, 0, 'or recorded');
    eq(t.post({ action: 'fix' }).ok, true, 'a fix with no lists is a harmless no-op');
  }
}

/* ============ shot times follow the app (stored), falling back to the constants ============ */
{
  const NOW = at(2026, 8, 28, 10, 45);
  const t = load(NOW, []);
  eq(t.api.slotsToCheck_(new Date(NOW)).length, 0, 'fallback: with nothing stored the 11:30 constant rules');
  t.post({ action: 'stock', items: [], amTime: '10:00', pmTime: '22:15' });
  eq(t.props.SHOT_AM_TIME, '10:00', 'the stock push stores the morning time');
  eq(t.props.SHOT_PM_TIME, '22:15', 'and the night time');
  const s = t.api.slotsToCheck_(new Date(NOW));
  eq(s.length, 1, 'stored: the 10:00 slot is now 45 min late');
  eq(s[0].hhmm, '10:00', 'and it carries the stored time');
  t.post({ action: 'stock', items: [], amTime: 'junk', pmTime: '25:99' });
  eq(t.props.SHOT_AM_TIME, '10:00', 'a malformed time is ignored');
  eq(t.props.SHOT_PM_TIME, '22:15', 'including an impossible one');
  t.post({ action: 'stock', items: [] });
  eq(t.props.SHOT_AM_TIME, '10:00', 'an older app that sends neither leaves them as they were');
  const m = load(at(2026, 8, 28, 12, 5), [], { props: { SHOT_AM_TIME: '10:00' } });
  m.api.checkShotDue();
  eq(m.mail.length, 1, 'checkShotDue chases the stored time');
  ok(/due at 10:00/.test(m.mail[0].body), 'and names it');
}
{
  const rows = [[cell(2026, 8, 20), cell(2026, 8, 20, 8, 0), 'Insulin', '16', '']];
  const t = load(at(2026, 8, 28, 12, 0), rows, {
    stockRows: [['Insulin', 300, 'units', '15/08/2026'], ['Carrot', 9, '', '01/08/2026']],
    props: { SHOT_AM_TIME: '10:00', SHOT_PM_TIME: '22:15', 'tomb:27/08/2026|9:00 am|Walk': String(at(2026, 8, 28, 12, 0)), 'stock:Gone|01/01/2020': '1' },
  });
  t.api.checkStock();
  ok(!('stock:Gone|01/01/2020' in t.props), 'the stock cleanup still runs');
  eq(t.props.SHOT_AM_TIME + t.props.SHOT_PM_TIME, '10:0022:15', 'but never deletes the stored shot times');
  ok('tomb:27/08/2026|9:00 am|Walk' in t.props, 'or a tombstone');
  t.api.cleanupAlertKeys_({ getProperties: () => Object.assign({}, t.props), deleteProperty: k => { delete t.props[k]; } });
  eq(t.props.SHOT_AM_TIME + t.props.SHOT_PM_TIME, '10:0022:15', 'nor does the alert cleanup');
}

/* ================= checkShotDue reads two days, not the whole sheet ================= */
{
  const { api, mail } = load(at(2026, 8, 28, 12, 5), [
    [cell(2026, 8, 20), cell(2026, 8, 20, 11, 30), 'Insulin', '8 Units', ''],
  ]);
  api.checkShotDue();
  eq(mail.length, 1, 'an insulin row a week old does not cover today');
  ok(/No insulin logged in the last two days/.test(mail[0].body), 'and it is not quoted as the last shot (only two days are read)');
}
{
  const { api, mail } = load(at(2026, 8, 28, 12, 5), [
    [cell(2026, 8, 27), cell(2026, 8, 27, 8, 0), 'Insulin', '8 Units', ''],
  ]);
  api.checkShotDue();
  ok(/Last insulin logged: Thu 27 Aug, 8:00 AM/.test(mail[0].body), "yesterday's shot is still quoted");
}

/* ================= KNOWN_TYPES: dose change, and the app's other spellings ================= */
{
  const { api } = load(at(2026, 8, 28, 12, 0), []);
  eq(api.canonType_('Dose change'), 'Dose change', 'a dose change is a known type');
  eq(api.canonType_('fleeing'), 'Wormer / Flea', 'fleeing');
  eq(api.canonType_('fleaing'), 'Wormer / Flea', 'fleaing');
  eq(api.canonType_('worming'), 'Wormer / Flea', 'worming');
  eq(api.canonType_('sick'), 'Was sick', 'sick');
  eq(api.canonType_('Low sugar'), 'Low sugar', 'low sugar');
}

/* ================= the monthly AI report is gone; the shot check runs every 30 minutes ================= */
{
  const { api, post, triggers } = load(at(2026, 8, 28, 12, 0), [], { triggers: ['checkShotDue', 'sendMonthlyReport', 'checkStock'] });
  eq(post({ action: 'report' }).error, 'unknown action', 'the report action is refused like any unknown one');
  ok(!/Gemini|GEMINI|UrlFetchApp/.test(SRC), 'nothing in the script calls out to a model any more');
  api.installReminders();
  eq(triggers.deleted.join(), 'checkShotDue,sendMonthlyReport', 'installReminders clears its own trigger and the dead monthly one, not the stock check');
  eq(triggers.created.join(), 'checkShotDue@30', 'and checks every 30 minutes: nothing is reported before the 30-minute grace anyway');
}

/* ================= writes are serialised by the script lock ================= */
{
  const t = load(at(2026, 8, 28, 12, 0), []);
  t.post({ action: 'append', rows: [{ date: '28/08/2026', time: '8:00 am', type: 'Insulin', qty: '8 Units', notes: '' }] });
  eq(t.locks.join(), 'wait,release', 'append takes and releases the lock');
  t.post({ action: 'stock', items: [] });
  eq(t.locks.join(), 'wait,release,wait,release', 'stock takes and releases the lock');
}

console.log(`\n  ${passed} checks passed\n`);
