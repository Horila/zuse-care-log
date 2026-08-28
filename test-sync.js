/* Self-check for zuse-sync-code.gs.txt (the Google Apps Script backend).
 *
 * Apps Script can't be tested in place — you paste it into Google and hope.
 * So this evaluates the real file under stubbed Google services and a frozen
 * clock, and exercises the parts that quietly misfire: the missed-shot
 * reminder around midnight, and the monthly report's aggregation.
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
  const fetches = [];
  const slept = [];
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
      getRange: (r, c) => ({
        getValue: () => (v[r - 1] || [])[c - 1],
        setNumberFormat: f => { formats.push({ r, c, f }); },
        setValues: rowsIn => {
          while (v.length < r - 1 + rowsIn.length) v.push([]);
          rowsIn.forEach((row, i) => { v[r - 1 + i] = row.slice(); });
        },
      }),
    };
  }
  const mainTab = writableSheet(values);
  // opts.stockRows: [ITEM, IN HAND, UNIT, COUNTING FROM] rows, header added here.
  let stockTab = opts.stockRows
    ? writableSheet([['ITEM', 'IN HAND', 'UNIT', 'COUNTING FROM', 'UPDATED']]
        .concat(opts.stockRows.map(r => r.concat(['x']))))
    : null;

  const stubs = {
    ContentService: {
      MimeType: { JSON: 'json' },
      // Keeps the serialised body reachable so doPost can be asserted on.
      createTextOutput: t => ({ __out: t, setMimeType: function () { return this; } }),
    },
    Date: frozenDate(nowMs),
    Utilities: { formatDate, sleep: () => { slept.push(1); } },
    Session: { getScriptTimeZone: () => 'Europe/London' },
    Logger: { log: () => {} },
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
      getProjectTriggers: () => [],
      newTrigger: () => { throw new Error('trigger creation not exercised'); },
    },
    UrlFetchApp: {
      fetch: () => {
        // opts.geminiSeq lets a test hand back 503 then 200 and watch the retry.
        const step = opts.geminiSeq ? opts.geminiSeq[Math.min(fetches.length, opts.geminiSeq.length - 1)] : null;
        fetches.push(1);
        const code = step ? step.code : (opts.geminiCode === undefined ? 200 : opts.geminiCode);
        const body = step && step.body !== undefined ? step.body
          : (opts.geminiBody === undefined
            ? JSON.stringify({ candidates: [{ content: { parts: [{ text: 'PROSE' }] } }] })
            : opts.geminiBody);
        return { getResponseCode: () => code, getContentText: () => body };
      },
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
             numFrom_, bucket_, buildReportStats_, sendMonthlyReport, askGemini_,
             reportPrompt_, fmtDay_, canonType_, incidentKey_,
             checkStock, readStockTab_, stockForecast_, writeStockTab_, doPost};`;
  const api = new Function(...names, body)(...names.map(n => stubs[n]));
  const post = o => JSON.parse(api.doPost({ postData: { contents: JSON.stringify(
    Object.assign({ secret: 'CHANGE_ME_TO_YOUR_OWN_SECRET' }, o)) } }).__out);
  return { api, mail, props, fetches, slept, events, formats, post, stock: () => stockTab };
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
  ok(/No insulin has ever been logged/.test(mail[0].body), 'says there is no prior shot at all');
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
      'GEMINI_API_KEY': 'keep-me',
    },
  });
  api.cleanupAlertKeys_(({
    getProperties: () => Object.assign({}, props),
    deleteProperty: k => { delete props[k]; },
  }));
  ok('alerted:2026-08-27:night' in props, 'yesterday stays');
  ok(!('alerted:2026-08-01:morning' in props), '27 days old is dropped');
  eq(props['GEMINI_API_KEY'], 'keep-me', 'non-alert properties are untouched');
}

/* ======================== monthly report ======================== */
{
  const { api } = load(at(2026, 8, 28, 12, 0), []);
  eq(api.numFrom_('8 Units'), 8, 'number is split off the unit text');
  eq(api.numFrom_('30 min'), 30, 'same for minutes');
  eq(api.numFrom_('2'), 2, 'plain numbers work');
  eq(api.numFrom_(''), 0, 'blank is zero, not NaN');
  eq(api.numFrom_(null), 0, 'null is zero, not NaN');
  eq(api.numFrom_('lots'), 0, 'unparseable is zero, not NaN');
  eq(api.numFrom_(-1.5), -1.5, 'negatives and decimals survive');
}
{
  // Ten days back is period A; forty days back is period B. Neither window may
  // borrow from the other.
  const now = at(2026, 8, 28, 12, 0);
  const { api } = load(now, [
    [cell(2026, 8, 18), cell(2026, 8, 18, 11, 30), 'Insulin', '8 Units', ''],
    [cell(2026, 8, 18), cell(2026, 8, 18, 23, 30), 'Insulin', '9 Units', ''],
    [cell(2026, 7, 19), cell(2026, 7, 19, 11, 30), 'Insulin', '7 Units', ''],
    [cell(2026, 8, 20), cell(2026, 8, 20, 9, 0), 'Weight', '16.1', ''],
    [cell(2026, 8, 21), cell(2026, 8, 21, 20, 0), 'Was sick', '', 'after supper'],
    [cell(2026, 7, 20), cell(2026, 7, 20, 20, 0), 'Diarrhea', '', ''],
    [cell(2026, 8, 22), cell(2026, 8, 22, 8, 0), 'Urine test', '', 'Ketone: neg'],
    [cell(2026, 1, 5), cell(2026, 1, 5, 8, 0), 'Insulin', '8 Units', ''],
  ]);
  const s = api.buildReportStats_(30);
  ok(/Insulin: 17 over 2 entries/.test(s.text), 'period A totals only period A');
  ok(/was\s+7 over 1 entries/.test(s.text), 'period B is reported alongside');
  ok(/16\.1 kg on 2026-08-20/.test(s.text), 'weigh-ins are listed with dates');
  ok(/A: 1\b/.test(s.text) && /after supper/.test(s.text), 'incident A counted, note kept');
  ok(/B: 1\b/.test(s.text), 'incident B counted separately');
  ok(/Ketone: neg/.test(s.text), 'urine notes carried through');
  ok(!/2026-01-05/.test(s.text), 'an entry older than both windows is excluded');
  ok(!/NaN|undefined|Infinity/.test(s.text), 'no NaN/undefined/Infinity in the figures');
  eq(s.label, '2026-07-29 to 2026-08-28', 'label names the current window');
}
{
  const { api } = load(at(2026, 8, 28, 12, 0), []);
  const s = api.buildReportStats_(30);
  ok(/no weigh-ins/.test(s.text), 'an empty log still produces a readable block');
  ok(!/NaN|undefined/.test(s.text), 'and no NaN/undefined with nothing to report');
}

/* ==================== report delivery paths ==================== */
{
  // Happy path: key present, model answers.
  const { api, mail } = load(at(2026, 8, 28, 12, 0), [
    [cell(2026, 8, 18), cell(2026, 8, 18, 11, 30), 'Insulin', '8 Units', ''],
  ], { props: { GEMINI_API_KEY: 'k' } });
  api.sendMonthlyReport();
  eq(mail.length, 1, 'the report is emailed');
  ok(/^PROSE/.test(mail[0].body), 'the write-up leads');
  ok(/THIS PERIOD/.test(mail[0].body), 'the figures are appended underneath');
}
{
  // No key: still send, with the numbers and an explanation.
  const { api, mail } = load(at(2026, 8, 28, 12, 0), [], {});
  api.sendMonthlyReport();
  eq(mail.length, 1, 'a missing key does not cancel the report');
  ok(/No GEMINI_API_KEY/.test(mail[0].body), 'and it says why there is no write-up');
  ok(/THIS PERIOD/.test(mail[0].body), 'the figures are still there');
}
{
  // API failure: still send, and name the failure.
  const { api, mail } = load(at(2026, 8, 28, 12, 0), [], {
    props: { GEMINI_API_KEY: 'k' }, geminiCode: 429, geminiBody: 'rate limited',
  });
  api.sendMonthlyReport();
  eq(mail.length, 1, 'an API error does not cancel the report');
  ok(/write-up failed/.test(mail[0].body), 'the email admits the write-up failed');
  ok(/429/.test(mail[0].body), 'and carries the status code');
  ok(/THIS PERIOD/.test(mail[0].body), 'the figures survive the failure');
}
{
  // A 200 with no candidates (safety block) must not email an empty report.
  const { api, mail } = load(at(2026, 8, 28, 12, 0), [], {
    props: { GEMINI_API_KEY: 'k' }, geminiBody: JSON.stringify({ candidates: [] }),
  });
  api.sendMonthlyReport();
  eq(mail.length, 1, 'a blocked or empty response still sends the figures');
  ok(/write-up failed/.test(mail[0].body), 'and is reported as a failure');
}
{
  const { api } = load(at(2026, 8, 28, 12, 0), [], { props: { GEMINI_API_KEY: 'k' } });
  const p = api.reportPrompt_({ text: 'FIGURES' });
  ok(/Do NOT suggest, adjust, or comment on insulin doses/.test(p), 'dose advice is forbidden in the prompt');
  ok(/do NOT give clinical advice/i.test(p), 'clinical advice is forbidden in the prompt');
  ok(p.indexOf('FIGURES') !== -1, 'the figures are what it reasons over');
}

/* ============ real-sheet messiness (from an actual monthly report) ============
   The TYPE column has been used as free text for years. The first live run
   split Chicken Slice in two and reported 3 incidents where there were 8. */
{
  const { api } = load(at(2026, 8, 28, 12, 0), []);
  eq(api.canonType_('Chicken Slice \uD83C\uDF57'), 'Chicken Slice', 'emoji stripped off a known type');
  eq(api.canonType_('  canned FOOD '), 'Canned Food', 'case and padding normalised');
  eq(api.canonType_('Treats'), 'Treat', 'plural folded onto the singular');
  eq(api.canonType_('Frontline Wormer'), 'Wormer / Flea', 'old product name folded in');
  eq(api.canonType_('weewee'), 'Wee Wee', 'spacing variant folded in');
  eq(api.canonType_('tummy rumbling'), null, 'a hand-typed note is not a type');
  eq(api.canonType_('diarrhea again \uD83D\uDE15'), null, 'nor is a hand-typed variant of one');
}
{
  const now = at(2026, 8, 28, 12, 0);
  const d = (day) => cell(2026, 8, day);
  const t = (day, h) => cell(2026, 8, day, h, 0);
  const { api } = load(now, [
    // the two spellings that were being counted as different foods
    [d(10), t(10, 9), 'Chicken Slice', '158', ''],
    [d(11), t(11, 9), 'Chicken Slice \uD83C\uDF57', '1202', ''],
    // incidents: one clean, four hand-typed, all real
    [d(12), t(12, 9), 'Diarrhea', '', ''],
    [d(13), t(13, 9), 'diarrhea again \uD83D\uDE15', '', ''],
    [d(14), t(14, 9), 'diarrhea still \uD83D\uDE14', '', ''],
    [d(15), t(15, 9), 'wee we/runny poop', '', ''],
    [d(16), t(16, 9), 'soft poop', '', ''],
    // not incidents, however much they look like one
    [d(17), t(17, 9), 'Wee Wee', '', ''],
    [d(18), t(18, 9), 'wee wee + poop', '', ''],
    // duplicate weigh-in, same day same value
    [d(19), t(19, 9), 'Weight', '16.3', ''],
    [d(19), t(19, 10), 'Weight', '16.3', ''],
    // an incident recorded only in the notes column
    [d(20), t(20, 9), 'Note', '', 'was sick after breakfast'],
  ]);
  const txt = api.buildReportStats_(30).text;

  ok(/Chicken Slice: 1360 over 2 entries/.test(txt),
     'both Chicken Slice spellings add up to one total');
  ok(!/Chicken Slice \uD83C\uDF57:/.test(txt), 'the emoji spelling is not a separate line');

  const inc = txt.match(/  A: (\d+)/);
  eq(inc && inc[1], '6', 'five hand-typed or clean incidents plus the one in a note');
  ok(/diarrhea still/.test(txt), 'a hand-typed diarrhea entry is counted');
  ok(/wee we\/runny poop/.test(txt), 'a runny-poop entry is counted');
  ok(/was sick after breakfast/.test(txt), 'an incident living only in the notes column is caught');

  ok(!/^\s+2026-08-17 — Wee Wee/m.test(txt), 'an ordinary wee wee is not an incident');
  ok(!/wee wee \+ poop/.test(txt.split('INCIDENTS')[1] || ''), 'nor is a normal wee wee + poop');

  eq((txt.match(/16\.3 kg on 2026-08-19/g) || []).length, 1, 'the duplicate weigh-in is reported once');

  ok(!/^  Weight: /m.test(txt), 'Weight is not also totalled as a quantity');
  ok(!/^  Note: /m.test(txt), 'Note is not totalled either');
  ok(/FREE-TEXT ROWS, no matching type \(A\): 5/.test(txt), 'all five hand-typed rows are listed separately');
  ok(!/^  diarrhea again/m.test(txt.split('FREE-TEXT')[0]), 'and never as their own total');
}
{
  // The model that 404'd on the first live run must not creep back.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'zuse-sync-code.gs.txt'), 'utf8');
  ok(!/gemini-2\.5-flash/.test(src), 'the retired gemini-2.5-flash is gone');
  ok(/const GEMINI_MODEL = 'gemini-[\d.]+-flash'/.test(src), 'a concrete flash model is pinned');
  // A busy month is a long write-up. A cap here truncates it mid-sentence.
  ok(!/maxOutputTokens/.test(src), 'no output token cap on the model');
}
{
  // Uncapped, the model can still spend its whole budget thinking and answer
  // with nothing. The email has to say that, not just 'no text'.
  const { api, mail } = load(at(2026, 8, 28, 12, 0), [], {
    props: { GEMINI_API_KEY: 'k' },
    geminiBody: JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS', content: {} }] }),
  });
  api.sendMonthlyReport();
  eq(mail.length, 1, 'an empty answer still emails the figures');
  ok(/MAX_TOKENS/.test(mail[0].body), 'and says the model ran out of room');
}

/* ============ transient API failures (a live run hit HTTP 503) ============
   This job runs once a month. One attempt against a busy model is not enough. */
{
  const { api, mail, fetches, slept } = load(at(2026, 8, 28, 12, 0), [], {
    props: { GEMINI_API_KEY: 'k' },
    geminiSeq: [{ code: 503, body: 'busy' }, { code: 503, body: 'busy' },
                { code: 200 }],
  });
  api.sendMonthlyReport();
  eq(fetches.length, 3, 'retries past two 503s and succeeds on the third');
  eq(slept.length, 2, 'and backs off between attempts');
  eq(mail.length, 1, 'one email');
  ok(/^PROSE/.test(mail[0].body), 'the write-up made it after the retries');
}
{
  const { api, mail, fetches } = load(at(2026, 8, 28, 12, 0), [], {
    props: { GEMINI_API_KEY: 'k' }, geminiCode: 503, geminiBody: 'busy',
  });
  api.sendMonthlyReport();
  eq(fetches.length, 4, 'gives up after four attempts');
  eq(mail.length, 1, 'and still emails the figures');
  ok(/gave up after 4 attempts/.test(mail[0].body), 'saying it gave up');
  ok(/THIS PERIOD/.test(mail[0].body), 'with the numbers intact');
}
{
  // A retired model or a bad key never fixes itself - do not burn four tries.
  const { api, fetches } = load(at(2026, 8, 28, 12, 0), [], {
    props: { GEMINI_API_KEY: 'k' }, geminiCode: 404, geminiBody: 'no such model',
  });
  api.sendMonthlyReport();
  eq(fetches.length, 1, 'a 404 fails immediately without retrying');
}

/* ============ duplicated incidents (the second live run reported 17 for 9) ====
   Unrecognised sheet types are pulled into the app as notes and pushed back as
   type "Note", so the same event sits in the sheet twice. */
{
  const { api } = load(at(2026, 8, 28, 12, 0), []);
  eq(api.incidentKey_('2026-08-11', 'Note', 'diarrhea again \uD83D\uDE15', 'Note'),
     api.incidentKey_('2026-08-11', 'diarrhea again \uD83D\uDE15', '', null),
     'the Note mirror and the original share one identity');
  ok(api.incidentKey_('2026-08-11', 'Note', 'diarrhea', 'Note') !==
     api.incidentKey_('2026-08-12', 'Note', 'diarrhea', 'Note'),
     'but the same words on a different day do not');
}
{
  const d = (day) => cell(2026, 8, day), t = (day, h) => cell(2026, 8, day, h, 0);
  const { api } = load(at(2026, 8, 28, 12, 0), [
    // the exact duplicate pair from the live report
    [d(11), t(11, 9), 'Note', '', 'diarrhea again \uD83D\uDE15'],
    [d(11), t(11, 9), 'diarrhea again \uD83D\uDE15', '', ''],
    // and one where the notes carry the detail on both copies
    [d(12), t(12, 9), 'Note', '', 'diarrhea \uD83D\uDE15: le neg. Sg 1.05'],
    [d(12), t(12, 9), 'diarrhea \uD83D\uDE15', '', 'le neg. Sg 1.05'],
    // a real incident hiding in the note of an unrelated row
    [d(18), t(18, 9), 'Canned Food', '2', 'soft poop, but only runny at the very end'],
    // a clean typed one
    [d(24), t(24, 9), 'Was sick', '', ''],
  ]);
  const txt = api.buildReportStats_(30).text;
  const n = txt.match(/  A: (\d+)/);
  eq(n && n[1], '4', 'six rows, four distinct incidents');
  // Scope the counts to the incident block: an unrecognised row legitimately
  // appears again under FREE-TEXT ROWS, which is not a duplicate.
  const incBlock = txt.split('INCIDENTS')[1].split('URINE')[0];
  eq((incBlock.match(/diarrhea again/g) || []).length, 1, 'the 11 Aug event is listed once');
  eq((incBlock.match(/Sg 1\.05/g) || []).length, 1, 'the 12 Aug event is listed once');
  ok(!/Note: diarrhea/.test(txt), 'the generic "Note:" prefix is never the label');
  ok(/soft poop, but only runny/.test(txt), 'an incident in a note is still reported');
  ok(!/Canned Food: soft poop/.test(txt),
     'and is labelled by the event, not by the row it arrived on');
  // the food row must still count as food
  ok(/Canned Food: 2 over 1 entries/.test(txt), 'that row is also still a feeding');
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

  const f = api.stockForecast_(items[0], api.readRows(), new Date());
  eq(f.left, 20, 'SHARED FIXTURE left: 30 in, 10 used');
  eq(f.rate, 0.5, 'SHARED FIXTURE rate: 0.5 a day');
  eq(f.days, 40, 'SHARED FIXTURE days: 20 left at 0.5 a day');
}
{
  // A sheet spelling the app does not use must still be counted against stock.
  const rows = [];
  for (let d = 15; d <= 28; d++) rows.push([cell(2026, 8, d), cell(2026, 8, d, 11, 30), 'Chicken Slice \uD83C\uDF57', '100', '']);
  const { api } = load(at(2026, 8, 28, 12, 0), rows, {
    stockRows: [['Chicken Slice', 2000, 'g', '15/08/2026']],
  });
  const f = api.stockForecast_(api.readStockTab_()[0], api.readRows(), new Date());
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
  ok(/about 16 units a day/.test(mail[0].body), 'with the burn rate');
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
  const { post, mail } = load(at(2026, 8, 28, 12, 0), [], { props: { GEMINI_API_KEY: 'k' } });
  const r = post({ action: 'report' });
  eq(r.ok, true, 'the report button gets a receipt');
  eq(mail.length, 1, 'and the report is actually sent');
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
  eq(body.trimEnd(), SRC.slice(SRC.indexOf('function doPost(e) {')).trimEnd(),
     'the paste file is byte-for-byte the tail of the real script');
  ok(/Manage deployments/.test(slice), 'and says the web app has to be redeployed');
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
  const f = api.stockForecast_(it, api.readRows(), new Date());
  eq(f.left, 76, 'the forecast works off the pushed baseline');
  eq(f.days, 4, 'and predicts four days');

  eq(api.checkStock(), 1, 'so the morning check finds it low');
  eq(mail.length, 1, 'emails once');
  eq(events.length, 1, 'and books the reminder');
}

console.log(`\n  ${passed} checks passed\n`);
