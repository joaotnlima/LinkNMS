import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeCalendar, isWorkingDay, snapForward, nextWorkingDay, shiftWorkingDays,
  durationWd, spanFinish, spanStart, workingDaysDelta,
} from './calendar.mjs';

// 2026-09-21 is a Monday.
const cal = makeCalendar({
  work_days: [1, 2, 3, 4, 5],
  holidays: ['2026-10-05'],                        // PT Implantação da República (Monday)
  closures: [{ from: '2026-09-28', to: '2026-09-29' }],
});

describe('working days', () => {
  test('weekends, holidays and closures are not working days', () => {
    assert.equal(isWorkingDay(cal, '2026-09-21'), true);
    assert.equal(isWorkingDay(cal, '2026-09-26'), false); // Saturday
    assert.equal(isWorkingDay(cal, '2026-10-05'), false); // holiday
    assert.equal(isWorkingDay(cal, '2026-09-28'), false); // closure
    assert.equal(isWorkingDay(cal, '2026-09-30'), true);  // day after closure
  });

  test('empty work week is rejected', () => {
    assert.throws(() => makeCalendar({ work_days: [9] }), /no working days/);
  });

  test('snap and next skip non-working stretches', () => {
    assert.equal(snapForward(cal, '2026-09-26'), '2026-09-30'); // Sat → skip Sun + closure
    assert.equal(nextWorkingDay(cal, '2026-09-25'), '2026-09-30');
    assert.equal(nextWorkingDay(cal, '2026-10-02'), '2026-10-06'); // Fri → skip weekend + holiday
  });

  test('shift moves in working days, both directions', () => {
    assert.equal(shiftWorkingDays(cal, '2026-09-21', 4), '2026-09-25');
    assert.equal(shiftWorkingDays(cal, '2026-09-25', 1), '2026-09-30');
    assert.equal(shiftWorkingDays(cal, '2026-09-30', -1), '2026-09-25');
    assert.equal(shiftWorkingDays(cal, '2026-09-21', 0), '2026-09-21');
  });

  test('duration is inclusive of both ends', () => {
    assert.equal(durationWd(cal, '2026-09-21', '2026-09-25'), 5);
    assert.equal(durationWd(cal, '2026-09-25', '2026-09-30'), 2); // Fri + Wed
    assert.equal(durationWd(cal, '2026-09-22', '2026-09-21'), 0);
  });

  test('spanFinish and spanStart are inverses at fixed duration', () => {
    const finish = spanFinish(cal, '2026-09-24', 4); // Thu,Fri,Wed,Thu
    assert.equal(finish, '2026-10-01');
    assert.equal(spanStart(cal, finish, 4), '2026-09-24');
    assert.equal(spanFinish(cal, '2026-09-21', 1), '2026-09-21');
  });

  test('workingDaysDelta is signed and skips non-working days', () => {
    assert.equal(workingDaysDelta(cal, '2026-09-21', '2026-09-25'), 4);
    assert.equal(workingDaysDelta(cal, '2026-09-25', '2026-09-21'), -4);
    assert.equal(workingDaysDelta(cal, '2026-09-25', '2026-09-30'), 1);
    assert.equal(workingDaysDelta(cal, '2026-09-21', '2026-09-21'), 0);
  });
});
