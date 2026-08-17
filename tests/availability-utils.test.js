'use strict';

const assert = require('node:assert/strict');

process.env.TZ = 'Europe/Madrid';
require('../src/availability-utils.js');

const utils = globalThis.CalendarPeekAvailability;

assert.equal(utils.toDateKey(new Date(2026, 7, 17, 12, 0)), '2026-08-17');
assert.equal(utils.shiftDateKey('2026-02-28', 1), '2026-03-01');
assert.equal(utils.shiftDateKey('2028-02-28', 1), '2028-02-29');
assert.equal(utils.shiftDateKey('2026-01-01', -1), '2025-12-31');

const springForward = utils.createLocalDayRange('2026-03-29');
assert.equal((springForward.endMs - springForward.startMs) / (60 * 60 * 1000), 23);

const fallBack = utils.createLocalDayRange('2026-10-25');
assert.equal((fallBack.endMs - fallBack.startMs) / (60 * 60 * 1000), 25);

const rangeStart = Date.parse('2026-08-17T08:00:00.000Z');
const rangeEnd = Date.parse('2026-08-17T18:00:00.000Z');
const merged = utils.mergeBusyRanges([
  { start: '2026-08-17T07:30:00.000Z', end: '2026-08-17T09:00:00.000Z' },
  { start: '2026-08-17T08:45:00.000Z', end: '2026-08-17T10:00:00.000Z' },
  { start: '2026-08-17T13:00:00.000Z', end: '2026-08-17T14:00:00.000Z' },
  { start: 'invalid', end: '2026-08-17T15:00:00.000Z' }
], rangeStart, rangeEnd);

assert.deepEqual(merged, [
  { startMs: rangeStart, endMs: Date.parse('2026-08-17T10:00:00.000Z') },
  { startMs: Date.parse('2026-08-17T13:00:00.000Z'), endMs: Date.parse('2026-08-17T14:00:00.000Z') }
]);

const free = utils.computeFreeRanges(merged, rangeStart, rangeEnd);
assert.deepEqual(free, [
  { startMs: Date.parse('2026-08-17T10:00:00.000Z'), endMs: Date.parse('2026-08-17T13:00:00.000Z') },
  { startMs: Date.parse('2026-08-17T14:00:00.000Z'), endMs: rangeEnd }
]);

assert.equal(utils.minutesBetween(rangeStart, Date.parse('2026-08-17T09:30:00.000Z')), 90);
assert.equal(utils.clamp(15, 0, 10), 10);

console.log('availability-utils: all tests passed');
