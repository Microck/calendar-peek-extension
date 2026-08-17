'use strict';

const MESSAGE_OPEN = 'CALENDAR_PEEK_OPEN';
const MESSAGE_PROCESS_PENDING = 'CALENDAR_PEEK_PROCESS_PENDING';
const PENDING_KEY = 'calendarPeekPending';
const PENDING_TTL_MS = 2 * 60 * 1000;
const EXPIRY_ALARM = 'calendarPeekPendingExpiry';
const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== MESSAGE_OPEN) {
    return false;
  }

  openPersonCalendar(message.person, message.accountIndex)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      console.error('[Calendar Peek] Could not open coworker calendar.', error);
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });

  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  void reconcilePendingRequest();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === EXPIRY_ALARM) {
    void removeExpiredPendingRequest();
  }
});

void reconcilePendingRequest();

async function openPersonCalendar(person, rawAccountIndex) {
  const email = normalizeEmail(person && person.email);
  const name = normalizeName(person && person.name);

  if (!email || !EMAIL_PATTERN.test(email)) {
    throw new Error('A valid coworker email address is required.');
  }

  const accountIndex = normalizeAccountIndex(rawAccountIndex);
  const pending = {
    email,
    name,
    accountIndex,
    createdAt: Date.now(),
    expiresAt: Date.now() + PENDING_TTL_MS
  };

  await chrome.storage.local.set({ [PENDING_KEY]: pending });
  await chrome.alarms.create(EXPIRY_ALARM, { when: pending.expiresAt });

  const targetUrl = `https://calendar.google.com/calendar/u/${accountIndex}/r`;
  const calendarTabs = await chrome.tabs.query({ url: 'https://calendar.google.com/*' });
  const matchingTab = chooseCalendarTab(calendarTabs, accountIndex);

  if (!matchingTab || typeof matchingTab.id !== 'number') {
    const createdTab = await chrome.tabs.create({ url: targetUrl, active: true });
    return { tabId: createdTab.id, reusedTab: false };
  }

  await chrome.tabs.update(matchingTab.id, { active: true });

  if (typeof matchingTab.windowId === 'number') {
    try {
      await chrome.windows.update(matchingTab.windowId, { focused: true });
    } catch (error) {
      // Focusing the tab is enough if the browser declines the window focus request.
      console.debug('[Calendar Peek] Window focus was not available.', error);
    }
  }

  try {
    await chrome.tabs.sendMessage(matchingTab.id, { type: MESSAGE_PROCESS_PENDING });
  } catch (error) {
    // The content script will process the stored request when Calendar finishes loading.
    console.debug('[Calendar Peek] Calendar is still loading; request remains queued.', error);
  }

  return { tabId: matchingTab.id, reusedTab: true };
}

function chooseCalendarTab(tabs, accountIndex) {
  const accountNeedle = `/calendar/u/${accountIndex}/`;
  const exact = tabs.find((tab) => typeof tab.url === 'string' && tab.url.includes(accountNeedle));
  if (exact) {
    return exact;
  }

  if (accountIndex === 0) {
    return tabs.find((tab) => {
      if (typeof tab.url !== 'string') {
        return false;
      }
      return /calendar\.google\.com\/calendar\/(?:r|b\/0\/r)(?:[/?#]|$)/i.test(tab.url);
    }) || null;
  }

  return null;
}

function normalizeEmail(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().replace(/^mailto:/i, '').split('?')[0].toLowerCase();
}

function normalizeName(value) {
  return typeof value === 'string' ? value.trim().slice(0, 160) : '';
}

function normalizeAccountIndex(value) {
  const parsed = Number.parseInt(String(value ?? '0'), 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 20 ? parsed : 0;
}

async function reconcilePendingRequest() {
  const stored = await chrome.storage.local.get(PENDING_KEY);
  const pending = stored[PENDING_KEY];

  if (!pending || typeof pending.expiresAt !== 'number' || pending.expiresAt <= Date.now()) {
    await chrome.storage.local.remove(PENDING_KEY);
    await chrome.alarms.clear(EXPIRY_ALARM);
    return;
  }

  await chrome.alarms.create(EXPIRY_ALARM, { when: pending.expiresAt });
}

async function removeExpiredPendingRequest() {
  const stored = await chrome.storage.local.get(PENDING_KEY);
  const pending = stored[PENDING_KEY];
  if (!pending || typeof pending.expiresAt !== 'number' || pending.expiresAt <= Date.now()) {
    await chrome.storage.local.remove(PENDING_KEY);
    await chrome.alarms.clear(EXPIRY_ALARM);
  }
}
