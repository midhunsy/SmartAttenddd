import assert from 'node:assert/strict';
import {
  addDays,
  evaluateBreakCompliance,
  evaluateOverallBreakCompliance,
  isOvernightShift,
  isValidDate,
  parseTimeToMinutes,
  rangesOverlap,
  resolveAttendanceDateForShift,
  type BreakConfigRow,
} from '../server/schedule.ts';

function config(overrides: Partial<BreakConfigRow> = {}): BreakConfigRow {
  return {
    config_id: 'cfg1',
    company_id: 'cmp1',
    scope_type: 'company',
    scope_id: null,
    break_type: 'mandatory',
    duration_minutes: 30,
    window_start: '12:00',
    window_end: '14:00',
    max_duration_minutes: 60,
    is_active: 1,
    ...overrides,
  };
}

assert.equal(isValidDate('2026-02-28'), true);
assert.equal(isValidDate('2026-02-30'), false);
assert.equal(addDays('2026-03-01', -1), '2026-02-28');
assert.equal(parseTimeToMinutes('22:30'), 1350);
assert.equal(isOvernightShift({ start_time: '22:00', end_time: '06:00' }), true);
assert.equal(isOvernightShift({ start_time: '09:00', end_time: '18:00' }), false);

assert.equal(rangesOverlap('2026-01-01', '2026-01-10', '2026-01-10', '2026-01-15'), true);
assert.equal(rangesOverlap('2026-01-01', '2026-01-10', '2026-01-11', '2026-01-15'), false);

const lunchStart = new Date(2026, 0, 1, 12, 15).toISOString();
const lunchEnd = new Date(2026, 0, 1, 12, 50).toISOString();
const lateStart = new Date(2026, 0, 1, 15, 0).toISOString();
const lateEnd = new Date(2026, 0, 1, 15, 35).toISOString();

assert.equal(evaluateBreakCompliance(config(), 35, lunchStart, lunchEnd), 'completed');
assert.equal(evaluateBreakCompliance(config(), 20, lunchStart, lunchEnd), 'incomplete');
assert.equal(evaluateBreakCompliance(config(), 35, lateStart, lateEnd), 'incomplete');
assert.equal(
  evaluateBreakCompliance(config({ break_type: 'optional' }), 35, lunchStart, lunchEnd),
  'completed'
);
assert.equal(
  evaluateBreakCompliance(config({ break_type: 'optional' }), 5, lateStart, lateEnd),
  'outside_rules'
);
assert.equal(
  evaluateBreakCompliance(config({ break_type: 'flexible', window_start: null, window_end: null }), 45, lateStart, lateEnd),
  'completed'
);
assert.equal(
  evaluateBreakCompliance(config({ break_type: 'flexible' }), 45, lateStart, lateEnd),
  'outside_rules'
);
assert.equal(evaluateBreakCompliance(null, 35, lunchStart, lunchEnd), 'unconfigured');

assert.equal(
  evaluateOverallBreakCompliance(config(), 30, 'incomplete'),
  'completed'
);
assert.equal(evaluateOverallBreakCompliance(config(), 0, null), 'incomplete');
assert.equal(
  evaluateOverallBreakCompliance(config({ break_type: 'flexible' }), 0, null),
  'not_taken'
);
assert.equal(
  evaluateOverallBreakCompliance(config({ break_type: 'optional' }), 0, null),
  'not_applicable'
);
assert.equal(
  evaluateOverallBreakCompliance(config({ break_type: 'optional' }), 35, 'completed'),
  'completed'
);
assert.equal(
  evaluateOverallBreakCompliance(config({ break_type: 'optional' }), 5, 'outside_rules'),
  'outside_rules'
);

const overnightShift = { start_time: '22:00', end_time: '06:00' };
assert.equal(
  resolveAttendanceDateForShift(overnightShift, new Date(2026, 0, 1, 1, 0)),
  '2025-12-31'
);
assert.equal(
  resolveAttendanceDateForShift(overnightShift, new Date(2026, 0, 1, 10, 0)),
  '2026-01-01'
);

console.log('ALL SCHEDULE UNIT TESTS PASSED SUCCESSFULLY.');
