/* Self-check for the pure logic in zuse-care-log.html.
 *
 * The app is one HTML file with no build step and no test framework, so this
 * lifts the named functions straight out of the source and runs them against
 * stub globals. Testing the real source, not a copy, is the whole point —
 * a copied test rots the moment the app changes.
 *
 * Run:  node test-logic.js
 */
const fs = require('fs');
const assert = require('assert');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'zuse-care-log.html'), 'utf8');
const js = src.match(/<script>([\s\S]*)<\/script>/)[1];

/** Pull `function NAME(...){...}` out of the source by brace matching. */
function grab(name) {
  const start = js.indexOf('\nfunction ' + name + '(');
  assert.ok(start !== -1, 'function not found in source: ' + name);
  let i = js.indexOf('{', start), depth = 0;
  for (let j = i; j < js.length; j++) {
    if (js[j] === '{') depth++;
    else if (js[j] === '}') { depth--; if (depth === 0) return js.slice(start, j + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

/** Pull a `const NAME=...` single-line declaration out of the source. */
function grabConst(name) {
  const m = js.match(new RegExp('^const ' + name + '=.*$', 'm'));
  assert.ok(m, 'const not found in source: ' + name);
  return m[0];
}

// --- stub globals the extracted functions close over ---
const T = { insulin: { n: 'Insulin', i: '💉', u: 'units' }, food: { n: 'Canned Food', i: '🥫', u: 'cans' },
            pred: { n: 'Prednisolone', i: '💊', u: 'tablets' }, walk: { n: 'Walk', i: '🦮', u: 'min' },
            weight: { n: 'Weight', i: '⚖️', u: 'kg' }, glucose: { n: 'Glucose', i: '🩸', u: 'mmol/L' },
            sick: { n: 'Was sick', i: '🤢', u: '' }, diarrhea: { n: 'Diarrhea', i: '⚠️', u: '' },
            pee: { n: 'Pee accident', i: '💦', u: '' }, urine: { n: 'Urine test', i: '🧪', u: '' },
            para: { n: 'Paracetamol', u: 'tablets' }, synulox: { n: 'Synulox 250mg', u: 'tablets' },
            samylin: { n: 'Samylin', u: 'tablets' }, cerenia: { n: 'Cerenia 24mg', u: 'tablets' } };
const esc = s => String(s);

const code = [
  grabConst('HOME_RADIUS'), grabConst('LOW_DAYS'),
  'const pad=n=>String(n).padStart(2,"0");',
  'const iso=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;',
  grab('shouldAutoEnd'), grab('haversine'),
  grabConst('isoBack'),
  grab('usedSince'), grab('rateOver'), grab('dailyUse'),
  grab('stockLeft'), grab('stockDetail'), grab('trackedStock'),
  grab('lowStock'), grab('stockLabel'),
  grab('series'), grab('vetSummary'),
].join('\n');

// The extracted code reads free variables `entries` and `cfg`; bind them by
// declaring them inside the same function scope.
const api = new Function('T', 'esc',
  'let entries=[],cfg={gap:12,stock:{}},stockWin=14;\n' + code +
  '\nreturn {shouldAutoEnd,haversine,usedSince,rateOver,dailyUse,stockLeft,stockDetail,' +
  'trackedStock,lowStock,stockLabel,series,vetSummary,' +
  'setWin:w=>{stockWin=w},setState:(e,c)=>{entries=e;cfg=c}};')(T, esc);

const DAY = 864e5;
const dayAgo = n => {
  const d = new Date(Date.now() - n * DAY);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, `${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); passed++; };

/* ---- walk auto-end predicate ---- */
ok(!api.shouldAutoEnd(0, 5, 60e3), 'inside grace period keeps walking');
ok(!api.shouldAutoEnd(400, 10, 600e3), 'far from home keeps walking');
ok(api.shouldAutoEnd(8, 10, 600e3), 'near home past grace ends walk');
ok(!api.shouldAutoEnd(8, 200, 600e3), 'unusable fix never ends walk');
ok(!api.shouldAutoEnd(0, 5, 299999), 'one ms short of grace keeps walking');
ok(api.shouldAutoEnd(0, 5, 300000), 'grace opens at exactly 5 min');
ok(api.shouldAutoEnd(22, 20, 600e3), '22m with a 20m fix is the ceiling');
ok(!api.shouldAutoEnd(23, 20, 600e3), '23m with a 20m fix is out');

/* ---- haversine sanity ---- */
ok(Math.abs(api.haversine(51.5, -0.12, 51.5, -0.12)) < 1e-6, 'zero distance to self');
{
  // 0.001 degrees of latitude is ~111.2 m anywhere on Earth.
  const d = api.haversine(51.5, -0.12, 51.501, -0.12);
  ok(d > 110 && d < 113, `0.001 deg lat is ~111m, got ${d.toFixed(1)}`);
}

/* ---- medicine stock ---- */
{
  // 14 units used per day for 14 days, restocked to 1000 seven days ago.
  const e = [];
  for (let i = 0; i < 20; i++) e.push({ type: 'insulin', date: dayAgo(i), time: '11:30', qty: 8 });
  api.setState(e, { gap: 12, stock: { insulin: { qty: 1000, since: dayAgo(7) } } });
  const s = api.stockLeft('insulin');
  eq(s.left, 1000 - 8 * 8, 'counts the 8 doses on or after the restock date (inclusive)');
  eq(Math.round(s.rate * 100) / 100, 8, 'burn rate is 8 units/day, 14 days inclusive of today');
  eq(s.days, Math.floor((1000 - 64) / 8), 'days left = remaining / daily burn');
}
{
  // A twice-weekly tablet must not read as a daily one: 4 doses in 14 days.
  const e = [0, 3, 7, 10].map(i => ({ type: 'pred', date: dayAgo(i), time: '23:30', qty: 0.5 }));
  api.setState(e, { gap: 12, stock: { pred: { qty: 10, since: dayAgo(14) } } });
  const s = api.stockLeft('pred');
  eq(s.left, 8, '10 minus four 0.5 doses');
  eq(s.rate, 2 / 14, 'divides by 14 days, not by the 4 days that have entries');
  eq(s.days, 56, '8 left at 0.1428/day is 56 days, not 14');
}
{
  // Deleting an entry must correct the count with no extra bookkeeping.
  const e = [{ type: 'food', date: dayAgo(1), time: '11:30', qty: 2 },
             { type: 'food', date: dayAgo(0), time: '11:30', qty: 2 }];
  api.setState(e, { gap: 12, stock: { food: { qty: 30, since: dayAgo(3) } } });
  eq(api.stockLeft('food').left, 26, 'baseline model counts what is there now');
  api.setState([e[0]], { gap: 12, stock: { food: { qty: 30, since: dayAgo(3) } } });
  eq(api.stockLeft('food').left, 28, 'removing an entry puts the stock back');
}
{
  // Entries before the restock date must not be counted against it.
  const e = [{ type: 'food', date: dayAgo(9), time: '11:30', qty: 5 },
             { type: 'food', date: dayAgo(2), time: '11:30', qty: 2 }];
  api.setState(e, { gap: 12, stock: { food: { qty: 30, since: dayAgo(5) } } });
  eq(api.stockLeft('food').left, 28, 'usage before the restock date is ignored');
}
{
  eq(api.stockLeft('insulin'), null, 'untracked type returns null, not a crash');
  api.setState([{ type: 'pred', date: dayAgo(0), time: '11:30', qty: 20 }],
               { gap: 12, stock: { pred: { qty: 10, since: dayAgo(1) } } });
  const low = api.lowStock();
  eq(low.length, 1, 'overdrawn stock is flagged');
  eq(api.stockLabel(low[0]), 'out', 'negative remaining reads as out, not a negative number');
}
{
  // No use in 14 days: days-left is unknowable, and must not divide by zero.
  api.setState([{ type: 'pred', date: dayAgo(40), time: '11:30', qty: 1 }],
               { gap: 12, stock: { pred: { qty: 10, since: dayAgo(60) } } });
  const s = api.stockLeft('pred');
  eq(s.days, null, 'zero burn gives no estimate rather than Infinity');
  eq(api.lowStock().length, 0, 'and does not raise a false low-stock alarm');
}

/* ---- vet summary ---- */
{
  const e = [
    { type: 'insulin', date: dayAgo(1), time: '11:30', qty: 8, note: '' },
    { type: 'insulin', date: dayAgo(1), time: '23:30', qty: 8, note: '' },
    { type: 'food', date: dayAgo(1), time: '11:30', qty: 2, note: '' },
    { type: 'walk', date: dayAgo(1), time: '15:00', qty: 30, note: '' },
    { type: 'weight', date: dayAgo(1), time: '09:00', qty: 16.1, note: '' },
    { type: 'weight', date: dayAgo(40), time: '09:00', qty: 17.3, note: '' },
    { type: 'sick', date: dayAgo(1), time: '20:00', qty: '', note: 'after supper' },
    { type: 'urine', date: dayAgo(1), time: '08:00', qty: '', note: 'Ketone: neg' },
  ];
  api.setState(e, { gap: 12, stock: {} });
  const txt = api.vetSummary(30);
  ok(txt.includes('16.1 kg'), 'reports the latest weight');
  ok(txt.includes('Incidents (1)'), 'counts incidents in range');
  ok(txt.includes('after supper'), 'carries the incident note through');
  ok(txt.includes('Urine tests (1)'), 'lists urine tests');
  ok(/Insulin: 8\.0 units\/day avg over 2 days/.test(txt),
     'averages over the window the log actually covers, not over 30 days');
  ok(!txt.includes('17.3'), 'a weigh-in older than the window is not the baseline');
}
{
  api.setState([], { gap: 12, stock: {} });
  const txt = api.vetSummary(30);
  ok(txt.includes('Nothing logged in this period'), 'an empty log says so instead of printing zeros');
  ok(!/NaN|Infinity|undefined/.test(txt), 'no NaN/Infinity/undefined leaks into the text');
}
{
  // Caught by driving the real app: a weigh-in from outside the window was
  // being reported under a "last 30 days" heading, which reads as recent.
  const e = [{ type: 'weight', date: dayAgo(50), time: '09:00', qty: 17.3, note: '' },
             { type: 'food', date: dayAgo(2), time: '11:30', qty: 2, note: '' }];
  api.setState(e, { gap: 12, stock: {} });
  const txt = api.vetSummary(30);
  ok(/not weighed in this period/.test(txt), 'an out-of-window weigh-in is labelled as such');
  ok(/last was 17\.3 kg on/.test(txt), 'and the older reading is still offered, dated');
  ok(!/^Weight: 17\.3 kg on/m.test(txt), 'it is never presented as a reading from this period');
}
{
  // Only in-window weigh-ins may set the trend.
  const e = [{ type: 'weight', date: dayAgo(50), time: '09:00', qty: 17.3, note: '' },
             { type: 'weight', date: dayAgo(20), time: '09:00', qty: 16.5, note: '' },
             { type: 'weight', date: dayAgo(3), time: '09:00', qty: 16.1, note: '' }];
  api.setState(e, { gap: 12, stock: {} });
  const txt = api.vetSummary(30);
  ok(/Weight: 16\.1 kg on/.test(txt), 'latest in-window reading leads');
  ok(/-0\.4 kg since/.test(txt), 'the change is measured from the oldest in-window reading, not the oldest ever');
  ok(!/17\.3/.test(txt), 'the out-of-window reading is not used as the baseline');
}
{
  api.setState([{ type: 'food', date: dayAgo(2), time: '11:30', qty: 2, note: '' }],
               { gap: 12, stock: {} });
  ok(/Weight: never recorded/.test(api.vetSummary(30)), 'no weigh-ins at all is stated, not omitted');
}
{
  // Every field populated must still be free of NaN.
  const e = [{ type: 'glucose', date: dayAgo(3), time: '10:00', qty: 14.2, note: '' },
             { type: 'pred', date: dayAgo(2), time: '23:30', qty: 0.5, note: '' },
             { type: 'diarrhea', date: dayAgo(2), time: '06:00', qty: '', note: '' },
             { type: 'pee', date: dayAgo(1), time: '03:00', qty: '', note: '' }];
  api.setState(e, { gap: 12, stock: {} });
  const txt = api.vetSummary(30);
  ok(/Glucose: 14\.2 on /.test(txt), 'glucose readings are listed with dates');
  ok(txt.includes('Prednisolone 0.5 tablets'), 'meds totalled with units');
  ok(txt.includes('Incidents (2)'), 'diarrhea and pee both count as incidents');
  ok(!/NaN|Infinity|undefined/.test(txt), 'no NaN/Infinity/undefined with mixed data');
}

/* ---- every getElementById target must actually exist in the markup ---- */
{
  // Cheap, whole-file, and catches the class of typo that only surfaces when a
  // rarely-visited view finally renders.
  const ids = new Set();
  for (const m of src.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1]);
  const wanted = [...new Set([...js.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]))];
  ok(wanted.length > 20, 'the id scan actually found something to check');
  eq(wanted.filter(id => !ids.has(id)).join(', '), '',
     'every getElementById target exists as an id in the HTML');
}

/* ---- the old AudioStore name must be fully retired ---- */
eq(/\bAudioStore\b/.test(js), false, 'no dangling AudioStore references after the rename');

/* ---- the Stock tab's own numbers ---- */
{
  // The shared fixture: 0.5 tablets a day, every day, restocked 20 days ago.
  // test-sync.js asserts the Apps Script reaches the same three numbers from
  // the same shape of data — that pairing is what catches the two drifting.
  const e = [];
  for (let i = 0; i < 20; i++) e.push({ type: 'pred', date: dayAgo(i), time: '11:30', qty: 0.5 });
  api.setState(e, { gap: 12, stock: { pred: { qty: 30, since: dayAgo(20) } } });

  const s = api.stockLeft('pred');
  eq(s.left, 20, 'SHARED FIXTURE left: 30 in, 10 used');
  eq(s.rate, 0.5, 'SHARED FIXTURE rate: 0.5 a day');
  eq(s.days, 40, 'SHARED FIXTURE days: 20 left at 0.5 a day');

  // the window is selectable, and a flat divide means it stays 0.5 either way
  eq(api.stockLeft('pred', 7).rate, 0.5, 'the 7-day window sees the same steady rate');
  eq(api.stockLeft('pred', 30).rate, 20 * 0.5 / 30, 'the 30-day window dilutes across days with no entries');
  eq(api.stockLeft('pred', 30).days, Math.floor(20 / (10 / 30)), 'and predicts further out because of it');
}
{
  // A course that stopped a week ago must not read as "still going".
  const e = [];
  for (let i = 7; i < 21; i++) e.push({ type: 'pred', date: dayAgo(i), time: '11:30', qty: 1 });
  api.setState(e, { gap: 12, stock: { pred: { qty: 10, since: dayAgo(21) } } });
  eq(api.stockLeft('pred', 7).days, null, 'nothing used in the last 7 days means no prediction');
  eq(api.stockLeft('pred', 14).rate, 7 / 14, 'the 14-day window still sees the tail of the course');
}
{
  // Trend: the last week against the last month.
  const e = [];
  for (let i = 0; i < 7; i++) e.push({ type: 'pred', date: dayAgo(i), time: '11:30', qty: 2 });
  for (let i = 7; i < 30; i++) e.push({ type: 'pred', date: dayAgo(i), time: '11:30', qty: 1 });
  api.setState(e, { gap: 12, stock: { pred: { qty: 100, since: dayAgo(30) } } });
  const x = api.stockDetail('pred');
  eq(x.r7, 2, 'the 7-day rate is the recent week');
  eq(x.rPrev, 1, 'the baseline is the seven days before it, not a 30-day average');
  ok(x.r7 > x.rPrev, 'so usage reads as rising');
  eq(x.series.length, 14, 'the bar strip is 14 days long');
  eq(x.series[13], 2, 'ending with today');
  eq(x.used, 37, 'used since restock counts every dose on or after that day');
  ok(x.out instanceof Date, 'a run-out date is produced');
  eq(Math.round((x.out - new Date()) / 864e5), x.days, 'and it is days-left away');
}
{
  // An item with a countdown but no recent use predicts nothing rather than
  // dividing by zero and claiming Infinity days.
  api.setState([], { gap: 12, stock: { pred: { qty: 5, since: dayAgo(3) } } });
  const x = api.stockDetail('pred');
  eq(x.days, null, 'no use logged means no prediction');
  eq(x.out, null, 'and therefore no run-out date');
  eq(x.left, 5, 'but what is in hand is still known');
}
{
  // Stock kept for a type that no longer exists must not crash the tab.
  api.setState([], { gap: 12, stock: { pred: { qty: 5, since: dayAgo(1) }, gone: { qty: 2, since: dayAgo(1) } } });
  eq(api.trackedStock().join(','), 'pred', 'an unknown type is dropped, not rendered');
}

{
  // Flat use must not read as rising just because the log is younger than the
  // comparison window - the reason the baseline is last week, not 30 days.
  const e = [];
  for (let i = 0; i < 20; i++) e.push({ type: 'pred', date: dayAgo(i), time: '11:30', qty: 0.5 });
  api.setState(e, { gap: 12, stock: { pred: { qty: 30, since: dayAgo(20) } } });
  const x = api.stockDetail('pred');
  eq(x.r7, x.rPrev, 'twenty flat days of use show no week-on-week change');
}

console.log(`\n  ${passed} checks passed\n`);
