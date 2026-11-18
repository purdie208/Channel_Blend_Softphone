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
console.log('\nRECORDING NAME TESTS PASSED');
