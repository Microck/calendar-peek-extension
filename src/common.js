'use strict';

(() => {
  if (globalThis.CalendarPeek) {
    return;
  }

  const MESSAGE_OPEN = 'CALENDAR_PEEK_OPEN';
  const EMAIL_PATTERN = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/gi;

  function normalizeEmail(value) {
    if (typeof value !== 'string') {
      return '';
    }

    return value.trim().replace(/^mailto:/i, '').split('?')[0].toLowerCase();
  }

  function extractEmails(value) {
    if (typeof value !== 'string' || !value) {
      return [];
    }

    const matches = value.match(EMAIL_PATTERN) || [];
    return [...new Set(matches.map(normalizeEmail).filter(Boolean))];
  }

  function getAccountIndex(url = location.href) {
    const match = String(url).match(/\/u\/(\d+)(?:\/|$)/i);
    if (!match) {
      return 0;
    }

    const parsed = Number.parseInt(match[1], 10);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 20 ? parsed : 0;
  }

  function isVisible(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1 && rect.bottom >= 0 && rect.right >= 0;
  }

  function normalizeWhitespace(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  }

  async function openPersonCalendar(person) {
    const email = normalizeEmail(person && person.email);
    const name = normalizeWhitespace(person && person.name);

    if (!email) {
      throw new Error('No coworker email address was found.');
    }

    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_OPEN,
      person: { email, name },
      accountIndex: getAccountIndex()
    });

    if (!response || response.ok !== true) {
      throw new Error(response && response.error ? response.error : 'Could not open Google Calendar.');
    }

    return response;
  }

  globalThis.CalendarPeek = Object.freeze({
    extractEmails,
    getAccountIndex,
    isVisible,
    normalizeEmail,
    normalizeWhitespace,
    openPersonCalendar
  });
})();
