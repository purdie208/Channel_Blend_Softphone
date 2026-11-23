'use strict';
// Recording names: "<Person> MM-DD-YY (n)" with the sequence continuing per person per day.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { Recorder, shortDate } = require('../src/main/recording/recorder');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbnames-'));
const folder = path.join(dir, 'rec');
const journalPath = path.join(dir, 'journal.json');
const today = shortDate();
const tone = () => new Int16Array(160).fill(1200);

function record(rec, person, frames = 30) {
  rec.start({ folder, extension: '1001', number: '*5551004', person });
  for (let i = 0; i < frames; i++) rec.write(tone(), null);
  return path.basename(rec.stop().wavPath);
}

const rec = new Recorder({ journalPath });
const names = [record(rec, 'Joe Smith'), record(rec, 'Joe Smith'), record(rec, 'Joe Smith')];
assert.deepStrictEqual(names, [1, 2, 3].map(n => `Joe Smith ${today} (${n}).wav`));
console.log('✓', names.join(' | '));

assert.strictEqual(record(rec, 'Ann Lee'), `Ann Lee ${today} (1).wav`);
assert.strictEqual(record(rec, '  joe   smith '), `Joe Smith ${today} (4).wav`, 'continues after switching (case/spaces ignored, spelling kept)');
console.log('✓ switched to Ann Lee (1), back to Joe Smith continues at (4)');

assert.strictEqual(record(rec, 'Bad/Name:Here?'), `Bad Name Here ${today} (1).wav`, 'unsafe characters removed');
assert.ok(/^CB_1001_star5551004_/.test(record(rec, '')), 'no name -> phone-number naming');
console.log('✓ unsafe characters cleaned; blank name falls back to CB_ naming');

// Crash mid-recording: the in-progress .mka holds its number, and is recovered on next start.
rec.start({ folder, extension: '1001', number: '200', person: 'Joe Smith' });
for (let i = 0; i < 60; i++) rec.write(tone(), null);
rec.active.writer.flush(); // simulate the crash (no stop)
assert.ok(fs.existsSync(path.join(folder, `Joe Smith ${today} (5).mka`)));
fs.unlinkSync(journalPath); // even if the journal is lost, the folder scan finds it
const recovered = new Recorder({ journalPath }).recover([folder]);
assert.strictEqual(recovered.length, 1);
assert.strictEqual(path.basename(recovered[0].wavPath), `Joe Smith ${today} (5).wav`);
assert.ok(!fs.existsSync(path.join(folder, `Joe Smith ${today} (5).mka`)));
assert.strictEqual(record(new Recorder({ journalPath }), 'Joe Smith'), `Joe Smith ${today} (6).wav`);
console.log('✓ crashed named recording recovered as (5); next is (6)');

// ---- 1.0.4: naming a recording after it was started without a name ----
const folder2 = path.join(dir, 'late');
const late = new Recorder({ journalPath: path.join(dir, 'j2.json') });
// a) name typed while the recording runs -> applied during the .mka -> .wav conversion
late.start({ folder: folder2, extension: '1001', number: '*5551004', person: '' });
for (let i = 0; i < 30; i++) late.write(tone(), null);
let r = late.stop({ person: 'Joe Smith' });
assert.strictEqual(path.basename(r.wavPath), `Joe Smith ${today} (1).wav`);
assert.ok(r.named && !r.unnamed);
assert.ok(!fs.readdirSync(folder2).some(f => f.startsWith('CB_')), 'no leftover unnamed files');
console.log('✓ name typed during an unnamed recording -> saved as', path.basename(r.wavPath));

// b) a recording started WITH a name keeps it even if the box changes mid-recording
late.start({ folder: folder2, extension: '1001', number: '*5551004', person: 'Joe Smith' });
for (let i = 0; i < 10; i++) late.write(tone(), null);
assert.strictEqual(path.basename(late.stop({ person: 'Someone Else' }).wavPath), `Joe Smith ${today} (2).wav`);

// c) name typed after an unnamed recording finished -> renamed
late.start({ folder: folder2, extension: '1001', number: '*5551017', person: '' });
for (let i = 0; i < 10; i++) late.write(tone(), null);
r = late.stop({ person: '' });
assert.ok(r.unnamed && /^CB_/.test(path.basename(r.wavPath)));
const renamed = late.renameToPerson(r, 'maria garcia');
assert.strictEqual(path.basename(renamed), `maria garcia ${today} (1).wav`);
assert.ok(fs.existsSync(renamed) && !fs.existsSync(r.wavPath));
console.log('✓ finished unnamed recording renamed to', path.basename(renamed));

// d) engine: only the latest unnamed recording can be renamed, and only until the next one starts
const { PhoneEngine } = require('../src/main/engine');
const store = { data: { monitor: { name: '', recent: [] }, recording: { keepMka: false, folder: folder2 } },
  get() { return this.data; }, update(p) { Object.assign(this.data.monitor, (p.monitor || {})); } };
const eng = new PhoneEngine({ store, recorder: late, dataDir: dir });
const toasts = []; eng.on('toast', t => toasts.push(t)); eng._emitState = () => {};
late.start({ folder: folder2, extension: '1001', number: '200', person: '' });
for (let i = 0; i < 10; i++) late.write(tone(), null);
eng._finishRecording();
assert.ok(eng.lastUnnamed, 'remembers the unnamed recording');
const out = eng.commitPerson('Alex Chen');
assert.strictEqual(path.basename(out), `Alex Chen ${today} (1).wav`);
assert.strictEqual(eng.commitPerson('Alex Chen'), null, 'only once');
assert.ok(toasts.some(t => t.title === 'Recording renamed'));
assert.deepStrictEqual(store.data.monitor.recent, ['Alex Chen']);
console.log('✓ engine renames the last unnamed recording once, then stops');

console.log('\nRECORDING NAME TESTS PASSED');
