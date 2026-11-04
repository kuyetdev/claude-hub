import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '../hub/db.ts';
import { getResetSchedule, nextWeeklyReset, saveResetSchedule } from '../hub/schedule.ts';

test('tính reset tuần theo ngày, giờ và múi giờ hub', () => {
  const schedule = { dayOfWeek: 4, time: '00:00', timezone: 'Asia/Ho_Chi_Minh' }; // Thứ năm
  assert.equal(nextWeeklyReset(Date.parse('2026-11-04T10:00:00Z'), schedule), '2026-11-04T17:00:00.000Z');
  assert.equal(nextWeeklyReset(Date.parse('2026-11-04T17:00:00Z'), schedule), '2026-11-11T17:00:00.000Z');
});

test('lưu và kiểm tra lịch reset', () => {
  const db = openDatabase(':memory:');
  try {
    assert.throws(() => saveResetSchedule(db, { dayOfWeek: 8, time: '25:00' }, 'Asia/Ho_Chi_Minh'), /INVALID_SCHEDULE/);
    assert.deepEqual(saveResetSchedule(db, { dayOfWeek: 1, time: '08:30' }, 'Asia/Ho_Chi_Minh'), { dayOfWeek: 1, time: '08:30', timezone: 'Asia/Ho_Chi_Minh' });
    assert.deepEqual(getResetSchedule(db), { dayOfWeek: 1, time: '08:30', timezone: 'Asia/Ho_Chi_Minh' });
  } finally { db.close(); }
});
