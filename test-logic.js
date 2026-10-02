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
            samylin: { n: 'Samylin', u: 'tablets' }, cerenia: { n: 'Cerenia 24mg', u: 'tablets' },
            syringe: { n: 'Syringes', i: '💉', u: 'syringes', s: 1 },
            dose: { n: 'Dose change', i: '📈', u: 'units' } };
const esc = s => String(s);
// The real TYPE_ALIASES spans lines, so grabConst can't lift it; a few entries do.
const TYPE_ALIASES = { 'insulin': 'insulin', 'canned food': 'food', 'dose change': 'dose' };

const code = [
  grabConst('HOME_RADIUS'), grabConst('LOW_DAYS'), grabConst('LOW_DAYS_OVERRIDE'),
  'const pad=n=>String(n).padStart(2,"0");',
  'const iso=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;',
  grab('shouldAutoEnd'), grab('haversine'),
  grabConst('BOTTLE'), grabConst('LOW_LEFT'), grabConst('PER_SHOT'), grabConst('FIXED_RATE'), grabConst('isoBack'),
  grab('usedSince'), grab('rateOver'), grab('dailyUse'),
  grab('stockLeft'), grab('stockDetail'), grab('trackedStock'), grab('mergeStockRow'),
  grabConst('isLowStock'), grab('lowStock'), grab('stockLabel'),
  grab('series'), grab('vetSummary'),
  grabConst('syncErr'),
  grabConst('LOGGABLE'), grab('ts'), grab('isoFromDmy'), grab('to24h'), grab('typeKeyFromSheetType'),
  grab('keyOf'), grab('tombKey'), grab('syncPull'), grab('syncPush'), grab('applyTombs'),
  grab('routineWin'), grab('currentRoutine'), grab('routineDone'),
  grab('dmyFromIso'), grab('fmt12'), grab('formatQtySheet'), grab('tripleOf'), grabConst('rowOf'),
  grab('sheetNote'), grab('carerOf'),
  grab('fixQueue'), grab('queueUpd'), grab('forget'), grab('revive'),
].join('\n');

// The extracted code reads free variables `entries` and `cfg`; bind them by
// declaring them inside the same function scope.
const api = new Function('T', 'esc', 'TYPE_ALIASES',
  'let entries=[],cfg={gap:12,stock:{}},stockWin=14;const saveCfg=()=>{};\n' + code +
  '\nreturn {shouldAutoEnd,haversine,usedSince,rateOver,dailyUse,stockLeft,stockDetail,' +
  'trackedStock,mergeStockRow,lowStock,stockLabel,series,vetSummary,syncErr,isoBack,' +
  'syncPull,syncPush,applyTombs,currentRoutine,routineDone,forget,revive,queueUpd,sheetNote,carerOf,typeKeyFromSheetType,' +
  'setWin:w=>{stockWin=w},setState:(e,c)=>{entries=e;cfg=c},getState:()=>({entries,cfg})};')(T, esc, TYPE_ALIASES);

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
  // cerenia carries no FIXED_RATE, so this still exercises the real burn-rate divide.
  const e = [];
  for (let i = 0; i < 20; i++) e.push({ type: 'cerenia', date: dayAgo(i), time: '11:30', qty: 8 });
  api.setState(e, { gap: 12, stock: { cerenia: { qty: 1000, since: dayAgo(7) } } });
  const s = api.stockLeft('cerenia');
  eq(s.left, 1000 - 8 * 8, 'counts the 8 doses on or after the restock date (inclusive)');
  eq(Math.round(s.rate * 100) / 100, 8, 'burn rate is 8 units/day, 14 days inclusive of today');
  eq(s.days, Math.floor((1000 - 64) / 8), 'days left = remaining / daily burn');
}
{
  // A twice-weekly tablet must not read as a daily one: 4 doses in 14 days.
  // synulox carries no FIXED_RATE, so this still exercises the window divide.
  const e = [0, 3, 7, 10].map(i => ({ type: 'synulox', date: dayAgo(i), time: '23:30', qty: 0.5 }));
  api.setState(e, { gap: 12, stock: { synulox: { qty: 10, since: dayAgo(14) } } });
  const s = api.stockLeft('synulox');
  eq(s.left, 8, '10 minus four 0.5 doses');
  eq(s.rate, 2 / 14, 'divides by 14 days, not by the 4 days that have entries');
  eq(s.days, 56, '8 left at 0.1428/day is 56 days, not 14');
}
{
  // Zuse takes these six on a fixed routine, so their rate must not move just
  // because nothing was logged - FIXED_RATE wins over real (zero) usage.
  const fixed = { insulin: 17, pred: 0.5, samylin: 2, syringe: 2, para: 1, food: 4 };
  Object.keys(fixed).forEach(t => {
    api.setState([], { gap: 12, stock: { [t]: { qty: 100, since: dayAgo(5) } } });
    eq(api.stockLeft(t).rate, fixed[t], `${t}: rate is fixed at ${fixed[t]}/day with nothing logged`);
    eq(api.stockLeft(t).days, Math.floor(100 / fixed[t]), `${t}: days-left uses the fixed rate`);
  });
}
{
  /* THE SHARED FIXTURE for the per-day box — test-sync.js reaches the same
     three numbers from the same data on the script side. */
  const e = [];
  for (let i = 0; i < 20; i++) e.push({ type: 'pred', date: dayAgo(i), time: '11:30', qty: 0.5 });
  api.setState(e, { gap: 12, stock: { pred: { qty: 30, since: dayAgo(20), perDay: 1 } } });
  const s = api.stockLeft('pred');
  eq(s.left, 20, 'SHARED FIXTURE perDay left: 30 in, 10 used');
  eq(s.rate, 1, 'SHARED FIXTURE perDay rate: the box beats the fixed 0.5');
  eq(s.days, 20, 'SHARED FIXTURE perDay days: 20 left at 1 a day');
}
{
  // The per-day box beats all three other sources, and anything that is not a
  // positive number means "automatic" rather than a rate of zero.
  const e = [];
  for (let i = 0; i < 14; i++) e.push({ type: 'cerenia', date: dayAgo(i), time: '11:30', qty: 8 });
  api.setState(e, { gap: 12, stock: { cerenia: { qty: 100, since: dayAgo(0), perDay: 4 } } });
  eq(api.stockLeft('cerenia').rate, 4, 'beats real usage (8/day) where there is no fixed rate');
  eq(api.stockLeft('cerenia').days, 23, '92 left at 4 a day');   // 100 minus today's dose of 8
  for (const bad of [0, '', null, undefined, 'abc', -3]) {
    api.setState(e, { gap: 12, stock: { cerenia: { qty: 100, since: dayAgo(0), perDay: bad } } });
    eq(api.stockLeft('cerenia').rate, 8, `perDay ${JSON.stringify(bad)} falls back to real usage`);
  }
  api.setState([], { gap: 12, stock: { pred: { qty: 100, since: dayAgo(1), perDay: '3' } } });
  eq(api.stockLeft('pred').rate, 3, 'a number typed as text still counts');
  api.setState([], { gap: 12, stock: { pred: { qty: 100, since: dayAgo(1), perDay: 0 } } });
  eq(api.stockLeft('pred').rate, 0.5, 'and clearing it falls back to the fixed routine');
}
{
  // Syringes are spent per insulin shot, but a typed rate still wins over that.
  const e = [0, 1, 2].flatMap(i => [{ type: 'insulin', date: dayAgo(i), time: '11:30', qty: 8 },
                                   { type: 'insulin', date: dayAgo(i), time: '23:30', qty: 8 }]);
  api.setState(e, { gap: 12, stock: { syringe: { qty: 60, since: dayAgo(30), perDay: 3 } } });
  eq(api.stockLeft('syringe').rate, 3, 'the typed rate beats the fixed two a day');
  eq(api.stockLeft('syringe').left, 54, 'but the count still spends one per insulin shot');
}
{
  // The rate feeds the same predicate as everything else, so "running low"
  // follows the box. pred warns at 15 days: 20 tablets is 40 days at the fixed
  // 0.5 a day, 6 days at 3 a day.
  api.setState([], { gap: 12, stock: { pred: { qty: 20, since: dayAgo(0) } } });
  eq(api.lowStock().length, 0, 'plenty of days at the fixed rate is not low');
  api.setState([], { gap: 12, stock: { pred: { qty: 20, since: dayAgo(0), perDay: 3 } } });
  eq(api.lowStock().length, 1, 'the same amount at a typed 3 a day is');
  eq(api.lowStock()[0].days, 6, 'with the days the box implies');
}
{
  // Merging a Stock-tab row with the local baseline.
  const m = api.mergeStockRow;
  const local = { qty: 10, since: '2026-08-10', perDay: 2, vetSkip: '2026-08-10' };
  let r = m(local, { qty: 99, since: '15/08/2026', perDay: 0 }, '2026-08-15');
  eq(r.qty, 99, 'a newer baseline replaces the amount');
  eq(r.since, '2026-08-15', 'and the date');
  eq(r.perDay, 2, 'but a blank sheet rate keeps the local per-day');
  eq(r.vetSkip, undefined, 'and drops the old restock cycle marker, as before');
  r = m(local, { qty: 99, since: '15/08/2026', perDay: 5 }, '2026-08-15');
  eq(r.perDay, 5, 'a rate on the sheet wins');
  r = m(local, { qty: 99, since: '01/08/2026', perDay: 0 }, '2026-08-01');
  eq(r.qty, 10, 'an older sheet baseline leaves the amount alone');
  eq(r.vetSkip, '2026-08-10', 'and the rest of the local record');
  r = m(local, { qty: 99, since: '01/08/2026', perDay: 7 }, '2026-08-01');
  eq(r.qty, 10, 'a rate on an old row still leaves the amount alone');
  eq(r.perDay, 7, 'yet the rate is adopted');
  eq(local.perDay, 2, 'the local record is never mutated in place');
  r = m(undefined, { qty: 4, since: '01/08/2026', perDay: 1.5 }, '2026-08-01');
  eq(r.qty, 4, 'a first-seen item comes in');
  eq(r.perDay, 1.5, 'with its rate');
  r = m(undefined, { qty: 4, since: '01/08/2026' }, '2026-08-01');
  eq('perDay' in r, false, 'an old script that sends no rate leaves none behind');

  // An edit the sheet has not acknowledged (pdDirty) must beat a stale sheet
  // figure - a failed push, or a sync already in flight, must not undo it.
  const dirty = { qty: 10, since: '2026-08-10', perDay: 4, pdDirty: 1 };
  r = m(dirty, { qty: 10, since: '10/08/2026', perDay: 2 }, '2026-08-10');
  eq(r.perDay, 4, 'a pending edit beats the stale figure on the sheet');
  eq(r.pdDirty, 1, 'and stays pending until the push lands');
  r = m({ qty: 10, since: '2026-08-10', pdDirty: 1 }, { qty: 10, since: '10/08/2026', perDay: 3 }, '2026-08-10');
  eq('perDay' in r, false, 'a pending clear is not resurrected from the sheet');
  eq(r.pdDirty, 1, 'and is still pending');
  r = m(dirty, { qty: 99, since: '15/08/2026', perDay: 2 }, '2026-08-15');
  eq(r.qty, 99, 'a newer restock elsewhere still lands');
  eq(r.perDay, 4, 'without costing the pending per-day edit');
  eq(r.pdDirty, 1, 'or its flag');
  r = m({ qty: 10, since: '2026-08-10', perDay: 4 }, { qty: 10, since: '10/08/2026', perDay: 2 }, '2026-08-10');
  eq(r.perDay, 2, 'once acknowledged, the sheet is the source again');
  eq('pdDirty' in r, false, 'with nothing pending');
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
  // pred has a FIXED_RATE, so even a stale single dose still yields a days
  // estimate off the fixed rate - it must still not raise a false alarm.
  api.setState([{ type: 'pred', date: dayAgo(40), time: '11:30', qty: 1 }],
               { gap: 12, stock: { pred: { qty: 10, since: dayAgo(60) } } });
  const s = api.stockLeft('pred');
  eq(s.days, 18, '9 left (10 minus the one stale dose) at the fixed 0.5/day');
  eq(api.lowStock().length, 0, 'and does not raise a false low-stock alarm');
}
{
  // synulox has no FIXED_RATE, so zero real usage must still avoid dividing by zero.
  api.setState([{ type: 'synulox', date: dayAgo(40), time: '11:30', qty: 1 }],
               { gap: 12, stock: { synulox: { qty: 10, since: dayAgo(60) } } });
  const s = api.stockLeft('synulox');
  eq(s.days, null, 'zero burn gives no estimate rather than Infinity');
  eq(api.lowStock().length, 0, 'and does not raise a false low-stock alarm');
}

/* ---- syringes: counted per insulin shot, never logged ---- */
{
  // Two shots a day for 14 days is 28 syringes, whatever the units per shot.
  const e = [];
  for (let i = 0; i < 14; i++) {
    e.push({ type: 'insulin', date: dayAgo(i), time: '11:30', qty: 8 });
    e.push({ type: 'insulin', date: dayAgo(i), time: '23:30', qty: 8 });
  }
  api.setState(e, { gap: 12, stock: { syringe: { qty: 100, since: dayAgo(13) } } });
  const s = api.stockLeft('syringe');
  eq(s.left, 72, 'one syringe per shot, not one per unit');
  eq(s.rate, 2, 'two a day');
  eq(s.days, 36, '72 left at 2 a day');
  eq(api.dailyUse('syringe', 14)[13], 2, 'the daily bars count shots, not units');
  // Under a week of supply is the ordinary rule, and syringes use it.
  api.setState(e, { gap: 12, stock: { syringe: { qty: 22, since: dayAgo(13) } } });
  const low = api.lowStock();
  eq(low.length, 1, '22 in, 28 used - flagged');
  eq(api.stockLabel(low[0]), 'out', 'and reads as out');
  api.setState(e, { gap: 12, stock: { syringe: { qty: 40, since: dayAgo(13) } } });
  eq(api.lowStock().length, 1, '12 left at 2 a day is 6 days, inside the 7-day warning');
  api.setState(e, { gap: 12, stock: { syringe: { qty: 60, since: dayAgo(13) } } });
  eq(api.lowStock().length, 0, '32 left is 16 days, so nothing to say');
  // Syringes get a longer runway (15 days, not 7) so the vet-reorder email at
  // day 10 has a "running out" warning ahead of it, not after it.
  api.setState(e, { gap: 12, stock: { syringe: { qty: 52, since: dayAgo(13) } } });
  eq(api.lowStock().length, 1, '24 left at 2 a day is 12 days: past the ordinary 7-day rule, inside the 15-day override');
}

/* ---- LOW_DAYS_OVERRIDE is per-type, not global ---- */
{
  // pred (fixed 0.5/day) at 6 left is 12 days: inside its 15-day override.
  const e = [];
  for (let i = 0; i < 14; i++) e.push({ type: 'pred', date: dayAgo(i), time: '09:00', qty: 1 });
  api.setState(e, { gap: 12, stock: { pred: { qty: 20, since: dayAgo(13) } } });
  eq(api.lowStock().length, 1, 'prednisolone: 6 left at the fixed 0.5/day is 12 days, inside its 15-day override');

  // para (fixed 1/day) at 12 left is 12 days: outside the ordinary 7-day rule,
  // which has no override of its own.
  const e2 = e.map(x => Object.assign({}, x, { type: 'para' }));
  api.setState(e2, { gap: 12, stock: { para: { qty: 26, since: dayAgo(13) } } });
  eq(api.lowStock().length, 0, 'paracetamol has no override: 12 days is outside the ordinary 7-day rule');
}

/* ---- insulin warns on a bottle in hand, not on a week of supply ---- */
{
  const e = [];
  for (let i = 0; i < 14; i++) e.push({ type: 'insulin', date: dayAgo(i), time: '11:30', qty: 8 });
  // 500 in, 112 used: 388 left. At the fixed 17/day that is 22 days - a
  // week's rule would say nothing, and by then there would be no time to
  // order a bottle.
  api.setState(e, { gap: 12, stock: { insulin: { qty: 500, since: dayAgo(13) } } });
  const low = api.lowStock();
  eq(low.length, 1, 'under one bottle is low however many days that is');
  eq(low[0].days, 22, 'even with three weeks of supply left');
  eq(api.stockLabel(low[0]), '388 units left · 1 bottle',
     'the label says the bottle, since a 22-day countdown under "running low" reads as a bug');
  api.setState(e, { gap: 12, stock: { insulin: { qty: 1000, since: dayAgo(13) } } });
  eq(api.lowStock().length, 0, '888 left is more than a bottle, so nothing is said');
  api.setState(e, { gap: 12, stock: { insulin: { qty: 112, since: dayAgo(13) } } });
  eq(api.stockLabel(Object.assign({ t: 'insulin' }, api.stockLeft('insulin'))), 'out',
     'nothing left still reads as out, not as 0 bottles');
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

  // pred's rate is fixed, so the window can't move it - real usage would have
  // diluted at 30 days, but FIXED_RATE wins regardless.
  eq(api.stockLeft('pred', 7).rate, 0.5, 'the 7-day window sees the same fixed rate');
  eq(api.stockLeft('pred', 30).rate, 0.5, 'so does the 30-day window');
}
{
  // synulox has no FIXED_RATE, so the window-divide behaviour still applies
  // to it: the flat rate stays 0.5 either way when use is steady...
  const e = [];
  for (let i = 0; i < 20; i++) e.push({ type: 'synulox', date: dayAgo(i), time: '11:30', qty: 0.5 });
  api.setState(e, { gap: 12, stock: { synulox: { qty: 30, since: dayAgo(20) } } });
  eq(api.stockLeft('synulox', 7).rate, 0.5, 'the 7-day window sees the same steady rate');
  eq(api.stockLeft('synulox', 30).rate, 20 * 0.5 / 30, 'the 30-day window dilutes across days with no entries');
  eq(api.stockLeft('synulox', 30).days, Math.floor(20 / (10 / 30)), 'and predicts further out because of it');
}
{
  // ...and a course that stopped a week ago must not read as "still going".
  const e = [];
  for (let i = 7; i < 21; i++) e.push({ type: 'synulox', date: dayAgo(i), time: '11:30', qty: 1 });
  api.setState(e, { gap: 12, stock: { synulox: { qty: 10, since: dayAgo(21) } } });
  eq(api.stockLeft('synulox', 7).days, null, 'nothing used in the last 7 days means no prediction');
  eq(api.stockLeft('synulox', 14).rate, 7 / 14, 'the 14-day window still sees the tail of the course');
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
  // An item with no FIXED_RATE and a countdown but no recent use predicts
  // nothing rather than dividing by zero and claiming Infinity days.
  api.setState([], { gap: 12, stock: { synulox: { qty: 5, since: dayAgo(3) } } });
  const x = api.stockDetail('synulox');
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

{
  // The one server error the user can act on: an older deployment does not know
  // an action the app has since gained, and "unknown action" says nothing about
  // what to do. Every other error is passed through untouched.
  ok(/Manage deployments/.test(api.syncErr('unknown action')), 'a stale deployment is spelled out');
  eq(api.syncErr('unauthorized'), 'unauthorized', 'any other error is left alone');
  ok(api.syncErr('unknown action').length > 90, 'and is long enough to get the 9s toast');
}

/* ---- sync: the push window is a local date ---- */
{
  // 00:30 local on 1 July. The server reads from local midnight 30 days back
  // (1 June), so the push must start no earlier than that. The old UTC date,
  // taken at 00:30 BST, was still 30 June and reached back to 31 May: rows the
  // server never returned, pushed again as "missing" every sync in that hour.
  const now = new Date(2026, 6, 1, 0, 30);
  const cut = api.isoBack(29, now);
  eq(cut, '2026-06-02', 'the cutoff is the local date, a day inside the server window');
  const e = [{ date: '2026-05-31', time: '23:50', type: 'walk' }, { date: '2026-06-01', time: '00:10', type: 'walk' },
             { date: '2026-06-02', time: '00:10', type: 'walk' }, { date: '2026-07-01', time: '00:05', type: 'insulin' },
             { date: '2026-07-01', time: '00:20', type: 'food' }];
  const sheet = new Set(['2026-07-01|00:20|Canned Food']);
  eq(api.syncPush(e, sheet, cut).map(x => x.date + ' ' + x.time).join(','), '2026-06-02 00:10,2026-07-01 00:05',
     'pushes only in-window entries the sheet did not return');
}

/* ---- sync: tombstones ---- */
{
  // Rows deleted here are not pulled straight back; a duplicated sheet row still comes in once.
  const rows = [{ key: '2026-07-01|11:30|Insulin' }, { key: '2026-07-01|11:30|Canned Food' },
                { key: '2026-07-01|11:30|Canned Food' }, { key: '2026-07-01|09:00|Old Med  💊' },
                { key: '2026-07-01|23:40|Insulin' }];
  const pulled = api.syncPull(rows, new Set(['2026-07-01|11:30|Insulin']),
    { '2026-07-01|09:00|old med': '2026-07-01', '2026-07-01|23:40|insulin': '2026-07-01' });
  eq(pulled.map(r => r.key).join(','), '2026-07-01|11:30|Canned Food', 'tombstoned keys are skipped, case and emoji aside');
}
{
  // The script's tombstones arrive as sheet triples (type text lowercased, as
  // sent). They drop the local copy, except one this phone re-logged.
  api.setState([
    { id: 'a', date: '2026-07-01', time: '23:40', type: 'insulin', qty: 8 },
    { id: 'b', date: '2026-07-01', time: '09:00', type: 'note', srcType: 'Old  Med 💊' },
    { id: 'c', date: '2026-07-01', time: '11:30', type: 'food', qty: 2 },
    { id: 'd', date: '2026-07-02', time: '11:30', type: 'food', qty: 2, relog: 1 },
  ], {});
  const n = api.applyTombs([{ date: '01/07/2026', time: '11:40 pm', type: 'Insulin' },
                            { date: '01/07/2026', time: '9:00 am', type: 'old med' },
                            { date: '02/07/2026', time: '11:30 am', type: 'Canned Food' },
                            { date: '', time: '11:30 am', type: 'Walk' }]);
  const st = api.getState();
  eq(n, 2, 'a known and an unknown type are both matched');
  eq(st.entries.map(e => e.id).join(','), 'c,d', 'leaving the untouched entry and the re-logged one');
  eq(Object.keys(st.cfg.tomb).sort().join(','), '2026-07-01|09:00|old med,2026-07-01|23:40|insulin',
     'the dropped keys are remembered so the pull skips them');
  eq(api.syncPull([{ key: '2026-07-01|23:40|Insulin' }], new Set(), st.cfg.tomb).length, 0,
     'and the sheet row is not pulled back in the same sync');
  api.setState([{ id: 'x', date: '2026-07-01', time: '11:30', type: 'food' }], {});
  eq(api.applyTombs(undefined), 0, 'an old script with no tomb field changes nothing');
  // An alias only the script knows ("Treats" -> "Treat") comes back as the text the app sent.
  api.setState([{ id: 't', date: '2026-07-01', time: '08:00', type: 'note', srcType: 'Treats' }], {});
  eq(api.applyTombs([{ date: '01/07/2026', time: '8:00 am', type: 'treats' }]), 1, 'a srcType note matches its own tomb');
  // Emoji before the type, and an alias the app knows only without its emoji.
  api.setState([{ id: 'p', date: '2026-07-01', time: '08:00', type: 'note', srcType: '💉 Insulin' },
                { id: 'f', date: '2026-07-01', time: '09:00', type: 'note', srcType: 'Fleeing 🐛' }], {});
  eq(api.applyTombs([{ date: '01/07/2026', time: '8:00 am', type: 'insulin' },
                     { date: '01/07/2026', time: '9:00 am', type: 'fleeing' }]), 2, 'decorated srcType notes match their tombs');
  eq(api.syncPull([{ key: '2026-07-01|08:00|💉 Insulin' }], new Set(), api.getState().cfg.tomb).length, 0,
     'and the decorated sheet row is not pulled back');
}
{
  // A pulled unknown-type row keeps its sheet qty inside a composed note; an
  // update would blank QTY and overwrite NOTES with that composite, so none is sent.
  const c = { syncUrl: 'u', syncKey: 'k' };
  api.setState([], c);
  api.queueUpd({ id: 's', date: '2026-07-01', time: '08:00', type: 'note', qty: '', note: 'Treats: x (2)', srcType: 'Treats' });
  eq(c.fixQ ? c.fixQ.upd.length : 0, 0, 'no update is queued for a srcType note');
}

{
  // Delete, then re-log the same minute before any sync: the row is still on
  // the sheet, so the queued delete becomes an update of it.
  const c = { syncUrl: 'u', syncKey: 'k' };
  const old = { id: 'a', date: '2026-07-01', time: '23:40', type: 'insulin', qty: 8, note: '' };
  api.setState([], c);
  api.forget(old);
  eq(c.fixQ.del.length, 1, 'a delete is queued for the sheet');
  eq(c.fixQ.del[0].time, '11:40 pm', 'as the sheet triple the push sends');
  eq(c.tomb['2026-07-01|23:40|insulin'], '2026-07-01', 'and tombstoned locally');
  const neu = { id: 'b', date: '2026-07-01', time: '23:40', type: 'insulin', qty: 6, note: '' };
  api.revive(neu);
  eq(c.fixQ.del.length, 0, 're-logging cancels the queued delete');
  eq(c.fixQ.upd.map(u => u.qty).join(), '6 Units', 'and rewrites the row with the new amount');
  eq('2026-07-01|23:40|insulin' in c.tomb, false, 'the tombstone is lifted');
  eq(neu.relog, 1, "and the entry ignores the script's tombstone until it is pushed");
  api.queueUpd(Object.assign({}, neu, { qty: 7 }));
  eq(c.fixQ.upd.map(u => u.qty).join(), '7 Units', 'a second edit replaces the first');
  api.forget(neu);
  eq(c.fixQ.upd.length + ':' + c.fixQ.del.length, '0:1', 'and a delete drops pending edits of that row');
  api.forget(neu);
  eq(c.fixQ.del.length, 1, 'deleting twice queues once');
  const off = {};
  api.setState([], off);
  api.forget(old);
  eq(off.fixQ, undefined, 'without sync set up nothing is queued');
}

/* ---- UTC calendar dates are gone from the app ---- */
eq(/toISOString\(\)\.slice\(0,\s*10\)/.test(js), false, 'no UTC date where a local calendar date is meant');

/* ---- routine checklist across midnight ---- */
{
  // Morning round 08:00-19:00, night round 19:00 to 08:00 the next day.
  const c = { amTime: '11:30', pmTime: '23:30', am: [['food', 2], ['insulin', 8]], pm: [['food', 2], ['insulin', 8]] };
  const at = (d, h, m) => new Date(2026, 6, d, h, m);
  const round = (date, time) => [{ date, time, type: 'food' }, { date, time, type: 'insulin' }];
  api.setState(round('2026-07-14', '19:45'), c);
  eq(api.currentRoutine(at(14, 19, 45)), 'pm', '19:45 is the night round');
  eq(api.routineDone('pm', at(14, 19, 45)).join(), 'true,true', 'an early night round counts');
  api.setState(round('2026-07-14', '23:40'), c);
  eq(api.currentRoutine(at(15, 0, 10)), 'pm', '00:10 is still the same night');
  eq(api.routineDone('pm', at(15, 0, 10)).join(), 'true,true', 'a round at 23:40 still counts at 00:10');
  eq(api.routineDone('pm', at(15, 10, 0)).join(), 'true,true', 'a stale night button next morning sees the night just gone');
  api.setState(round('2026-07-15', '00:05'), c);
  eq(api.routineDone('pm', at(15, 23, 30)).join(), 'false,false', 'a round at 00:05 does not count for the next night');
  eq(api.currentRoutine(at(15, 7, 59)), 'pm', '07:59 is the night round');
  eq(api.currentRoutine(at(15, 8, 0)), 'am', '08:00 opens the morning');
  api.setState(round('2026-07-14', '11:30'), c);
  eq(api.routineDone('am', at(15, 11, 0)).join(), 'false,false', "yesterday's morning is not today's");
  eq(api.routineDone('am', at(14, 18, 59)).join(), 'true,true', 'but counts all its own day');
}

/* ---- who logged it: the carer rides on the pushed note ---- */
{
  eq(api.sheetNote({ note: 'fresh bottle', by: 'R' }), 'fresh bottle · R', 'a carer is appended to the note');
  eq(api.sheetNote({ note: '', by: 'R' }), '· R', 'and stands alone on an empty one');
  eq(api.sheetNote({ note: 'fresh bottle' }), 'fresh bottle', 'no carer, note unchanged');
  eq(api.sheetNote({}), '', 'nothing at all is blank');
  for (const e of [{ note: 'fresh bottle', by: 'Ruth Ann' }, { note: '', by: 'R' }])
    eq(api.carerOf({ note: api.sheetNote(e) }), e.by, `a pulled note gives the carer back (${JSON.stringify(e.note)})`);
  eq(api.carerOf({ note: 'x', by: 'H' }), 'H', 'a local entry names its own carer');
  eq(api.carerOf({ note: 'fresh bottle' }), '', 'a plain note names nobody');
  const c = { syncUrl: 'u', syncKey: 'k' };
  api.setState([], c);
  api.queueUpd({ date: '2026-07-01', time: '23:40', type: 'insulin', qty: 8, note: 'x', by: 'R' });
  eq(c.fixQ.upd[0].notes, 'x · R', 'an edit rewrites the row with the same note the push sent');
  eq((js.match(/notes:sheetNote\(e\)/g) || []).length, 2, 'the push and the fix queue share one note helper');
}

/* ---- dose history type ---- */
eq(api.typeKeyFromSheetType('Dose change'), 'dose', 'a dose change row comes back as a dose');
eq(api.typeKeyFromSheetType('Insulin'), 'insulin', 'and insulin is still insulin');

console.log(`\n  ${passed} checks passed\n`);
