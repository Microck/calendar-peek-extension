'use strict';

(() => {
  if (globalThis.CalendarPeekAvailability) {
    return;
  }

  const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
  const MINUTE_MS = 60 * 1000;

  function parseDateKey(dateKey) {
    const match = String(dateKey || '').match(DATE_KEY_PATTERN);
    if (!match) {
      return null;
    }

    const year = Number.parseInt(match[1], 10);
    const month = Number.parseInt(match[2], 10);
    const day = Number.parseInt(match[3], 10);
    const date = new Date(year, month - 1, day, 12, 0, 0, 0);

    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day
    ) {
      return null;
    }

    return { year, month, day, date };
  }

  function toDateKey(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      return '';
    }

    return [
      String(date.getFullYear()).padStart(4, '0'),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')
    ].join('-');
  }

  function shiftDateKey(dateKey, days) {
    const parsed = parseDateKey(dateKey);
    if (!parsed) {
      return '';
    }

    const shifted = new Date(parsed.year, parsed.month - 1, parsed.day + Number(days || 0), 12, 0, 0, 0);
    return toDateKey(shifted);
  }

  function createLocalDayRange(dateKey) {
    const parsed = parseDateKey(dateKey);
    if (!parsed) {
      throw new Error('Invalid date key.');
    }

    const start = new Date(parsed.year, parsed.month - 1, parsed.day, 0, 0, 0, 0);
    const end = new Date(parsed.year, parsed.month - 1, parsed.day + 1, 0, 0, 0, 0);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

    return {
      dateKey,
      start,
      end,
      startMs: start.getTime(),
      endMs: end.getTime(),
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      timeZone
    };
  }

  function localDateAtMinutes(dateKey, minutesFromMidnight) {
    const parsed = parseDateKey(dateKey);
    if (!parsed) {
      return new Date(Number.NaN);
    }

    return new Date(parsed.year, parsed.month - 1, parsed.day, 0, Number(minutesFromMidnight || 0), 0, 0);
  }

  function mergeBusyRanges(rawRanges, rangeStartMs, rangeEndMs) {
    const startBoundary = Number(rangeStartMs);
    const endBoundary = Number(rangeEndMs);
    if (!Number.isFinite(startBoundary) || !Number.isFinite(endBoundary) || endBoundary <= startBoundary) {
      return [];
    }

    const normalized = (Array.isArray(rawRanges) ? rawRanges : [])
      .map((range) => {
        const startMs = Date.parse(range && range.start);
        const endMs = Date.parse(range && range.end);
        return {
          startMs: Math.max(startBoundary, startMs),
          endMs: Math.min(endBoundary, endMs)
        };
      })
      .filter((range) => Number.isFinite(range.startMs) && Number.isFinite(range.endMs) && range.endMs > range.startMs)
      .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);

    const merged = [];
    for (const range of normalized) {
      const previous = merged[merged.length - 1];
      if (!previous || range.startMs > previous.endMs) {
        merged.push({ ...range });
      } else {
        previous.endMs = Math.max(previous.endMs, range.endMs);
      }
    }

    return merged;
  }

  function computeFreeRanges(mergedBusy, rangeStartMs, rangeEndMs) {
    const startBoundary = Number(rangeStartMs);
    const endBoundary = Number(rangeEndMs);
    if (!Number.isFinite(startBoundary) || !Number.isFinite(endBoundary) || endBoundary <= startBoundary) {
      return [];
    }

    const busy = mergeBusyRanges(
      (Array.isArray(mergedBusy) ? mergedBusy : []).map((range) => ({
        start: new Date(range.startMs).toISOString(),
        end: new Date(range.endMs).toISOString()
      })),
      startBoundary,
      endBoundary
    );

    const free = [];
    let cursor = startBoundary;
    for (const range of busy) {
      if (range.startMs > cursor) {
        free.push({ startMs: cursor, endMs: range.startMs });
      }
      cursor = Math.max(cursor, range.endMs);
    }

    if (cursor < endBoundary) {
      free.push({ startMs: cursor, endMs: endBoundary });
    }

    return free;
  }

  function minutesBetween(startMs, endMs) {
    return Math.max(0, Math.round((Number(endMs) - Number(startMs)) / MINUTE_MS));
  }

  function formatClock(value, locale) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      return '';
    }

    return new Intl.DateTimeFormat(locale || undefined, {
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  }

  function formatDateLabel(dateKey, locale) {
    const parsed = parseDateKey(dateKey);
    if (!parsed) {
      return '';
    }

    return new Intl.DateTimeFormat(locale || undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    }).format(parsed.date);
  }

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(Number(value), Number(minimum)), Number(maximum));
  }

  globalThis.CalendarPeekAvailability = Object.freeze({
    MINUTE_MS,
    clamp,
    computeFreeRanges,
    createLocalDayRange,
    formatClock,
    formatDateLabel,
    localDateAtMinutes,
    mergeBusyRanges,
    minutesBetween,
    parseDateKey,
    shiftDateKey,
    toDateKey
  });
})();
