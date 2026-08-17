'use strict';

const MESSAGE_OPEN = 'CALENDAR_PEEK_OPEN';
const MESSAGE_PROCESS_PENDING = 'CALENDAR_PEEK_PROCESS_PENDING';
const MESSAGE_FREEBUSY = 'CALENDAR_PEEK_FREEBUSY';
const MESSAGE_OPEN_OPTIONS = 'CALENDAR_PEEK_OPEN_OPTIONS';
const MESSAGE_AUTH_STATUS = 'CALENDAR_PEEK_AUTH_STATUS';
const MESSAGE_CONNECT_GOOGLE = 'CALENDAR_PEEK_CONNECT_GOOGLE';
const MESSAGE_DISCONNECT_GOOGLE = 'CALENDAR_PEEK_DISCONNECT_GOOGLE';

const PENDING_KEY = 'calendarPeekPending';
const PENDING_TTL_MS = 2 * 60 * 1000;
const EXPIRY_ALARM = 'calendarPeekPendingExpiry';
const GOOGLE_FREEBUSY_SCOPE = 'https://www.googleapis.com/auth/calendar.events.freebusy';
const GOOGLE_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
const GOOGLE_OAUTH_SCOPES = Object.freeze([GOOGLE_FREEBUSY_SCOPE, GOOGLE_EVENTS_SCOPE]);
const GOOGLE_OAUTH_SCOPE = GOOGLE_OAUTH_SCOPES.join(' ');
const GOOGLE_FREEBUSY_URL = 'https://www.googleapis.com/calendar/v3/freeBusy';
const GOOGLE_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars';
const GOOGLE_TOKEN_KEY = 'calendarPeekGoogleToken';
const GOOGLE_TOKEN_EXPIRY_SKEW_MS = 60 * 1000;
const GOOGLE_REQUEST_TIMEOUT_MS = 15000;
const GOOGLE_INTERACTIVE_AUTH_TIMEOUT_MS = readTimeoutOverride('__CALENDAR_PEEK_TEST_INTERACTIVE_AUTH_TIMEOUT_MS', 2 * 60 * 1000);
const MAX_FREEBUSY_RANGE_MS = 3 * 24 * 60 * 60 * 1000;
const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i;

class CalendarPeekError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CalendarPeekError';
    this.code = code;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') {
    return false;
  }

  let task = null;

  switch (message.type) {
    case MESSAGE_OPEN:
      task = openPersonCalendar(message.person, message.accountIndex);
      break;
    case MESSAGE_FREEBUSY:
      task = getAvailability(message);
      break;
    case MESSAGE_OPEN_OPTIONS:
      task = chrome.runtime.openOptionsPage().then(() => ({}));
      break;
    case MESSAGE_AUTH_STATUS:
      task = getGoogleAuthStatus();
      break;
    case MESSAGE_CONNECT_GOOGLE:
      task = connectGoogleCalendar();
      break;
    case MESSAGE_DISCONNECT_GOOGLE:
      task = disconnectGoogleCalendar();
      break;
    default:
      return false;
  }

  Promise.resolve(task)
    .then((result) => sendResponse({ ok: true, ...(result || {}) }))
    .catch((error) => {
      console.error('[Calendar Peek] Request failed.', error);
      sendResponse({
        ok: false,
        code: error instanceof CalendarPeekError ? error.code : 'unexpected_error',
        error: error instanceof Error ? error.message : String(error)
      });
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
    throw new CalendarPeekError('invalid_email', 'A valid coworker email address is required.');
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
      console.debug('[Calendar Peek] Window focus was not available.', error);
    }
  }

  try {
    await chrome.tabs.sendMessage(matchingTab.id, { type: MESSAGE_PROCESS_PENDING });
  } catch (error) {
    console.debug('[Calendar Peek] Calendar is still loading; request remains queued.', error);
  }

  return { tabId: matchingTab.id, reusedTab: true };
}

async function getAvailability(message) {
  const email = normalizeEmail(message && message.person && message.person.email);
  if (!email || !EMAIL_PATTERN.test(email)) {
    throw new CalendarPeekError('invalid_email', 'Slack did not expose a valid coworker email address.');
  }

  const timeMin = normalizeRfc3339(message.timeMin, 'timeMin');
  const timeMax = normalizeRfc3339(message.timeMax, 'timeMax');
  const timeMinMs = Date.parse(timeMin);
  const timeMaxMs = Date.parse(timeMax);

  if (timeMaxMs <= timeMinMs || timeMaxMs - timeMinMs > MAX_FREEBUSY_RANGE_MS) {
    throw new CalendarPeekError('invalid_time_range', 'The requested availability range is invalid.');
  }

  const timeZone = normalizeTimeZone(message.timeZone);
  const interactive = message.interactive === true;
  const requestBody = {
    timeMin,
    timeMax,
    timeZone,
    items: [{ id: email }]
  };

  let token = await getGoogleAccessToken(interactive);
  let apiResult = await requestFreeBusy(token, requestBody);

  if (apiResult.unauthorized) {
    await clearStoredGoogleAccessToken();
    if (interactive) {
      token = await getGoogleAccessToken(true);
      apiResult = await requestFreeBusy(token, requestBody);
    }
  }

  if (apiResult.unauthorized) {
    throw new CalendarPeekError('auth_required', 'Reconnect Google Calendar to check availability.');
  }

  const calendarEntry = findCalendarEntry(apiResult.payload, email);
  if (!calendarEntry) {
    throw new CalendarPeekError('calendar_unavailable', 'Google Calendar did not return availability for this email address.');
  }

  const calendarErrors = Array.isArray(calendarEntry.errors) ? calendarEntry.errors : [];
  if (calendarErrors.length > 0) {
    const reasons = calendarErrors
      .map((entry) => entry && typeof entry.reason === 'string' ? entry.reason : '')
      .filter(Boolean);

    if (reasons.includes('notFound')) {
      throw new CalendarPeekError(
        'calendar_unavailable',
        'This email is not a calendar you can access, or the person has not shared availability with you.'
      );
    }

    throw new CalendarPeekError(
      'calendar_error',
      reasons.length > 0 ? `Google Calendar could not check this calendar (${reasons.join(', ')}).` : 'Google Calendar could not check this calendar.'
    );
  }

  const busy = Array.isArray(calendarEntry.busy)
    ? calendarEntry.busy
      .filter((range) => range && isRfc3339(range.start) && isRfc3339(range.end))
      .map((range) => ({ start: range.start, end: range.end }))
    : [];

  let events = [];
  let eventDetailsAvailable = true;
  let eventDetailsMessage = '';

  try {
    let eventsResult = await requestEvents(token, email, timeMin, timeMax, timeZone);

    if (eventsResult.unauthorized) {
      await clearStoredGoogleAccessToken();
      if (interactive) {
        token = await getGoogleAccessToken(true);
        eventsResult = await requestEvents(token, email, timeMin, timeMax, timeZone);
      }
    }

    if (eventsResult.unauthorized) {
      throw new CalendarPeekError('auth_required', 'Reconnect Google Calendar to show event names.');
    }

    events = normalizeCalendarEvents(eventsResult.payload, timeMinMs, timeMaxMs);
  } catch (error) {
    if (error instanceof CalendarPeekError && error.code === 'auth_required') {
      throw error;
    }

    eventDetailsAvailable = false;
    eventDetailsMessage = describeEventDetailsFallback(error);
  }

  return {
    person: {
      email,
      name: normalizeName(message && message.person && message.person.name)
    },
    timeMin: apiResult.payload.timeMin || timeMin,
    timeMax: apiResult.payload.timeMax || timeMax,
    timeZone,
    busy,
    events,
    eventDetailsAvailable,
    eventDetailsMessage
  };
}

async function getGoogleAuthStatus() {
  const configured = isGoogleOAuthConfigured();
  if (!configured) {
    return { configured: false, connected: false };
  }

  try {
    await getGoogleAccessToken(false);
    return { configured: true, connected: true };
  } catch (error) {
    if (error instanceof CalendarPeekError && error.code === 'auth_required') {
      return { configured: true, connected: false };
    }
    throw error;
  }
}

async function connectGoogleCalendar() {
  const token = await getGoogleAccessToken(true);
  if (!token) {
    throw new CalendarPeekError('auth_failed', 'Google Calendar authorization did not return a token.');
  }
  return { configured: true, connected: true };
}

async function disconnectGoogleCalendar() {
  await clearStoredGoogleAccessToken();
  if (chrome.identity && typeof chrome.identity.clearAllCachedAuthTokens === 'function') {
    await chrome.identity.clearAllCachedAuthTokens();
  }
  return { configured: isGoogleOAuthConfigured(), connected: false };
}

function isGoogleOAuthConfigured() {
  const manifest = chrome.runtime.getManifest();
  const oauth = manifest && manifest.oauth2;
  return Boolean(
    oauth &&
    typeof oauth.client_id === 'string' &&
    oauth.client_id.endsWith('.apps.googleusercontent.com') &&
    Array.isArray(oauth.scopes) &&
    GOOGLE_OAUTH_SCOPES.every((scope) => oauth.scopes.includes(scope))
  );
}

async function getGoogleAccessToken(interactive) {
  if (!isGoogleOAuthConfigured()) {
    throw new CalendarPeekError(
      'oauth_not_configured',
      'One-time Google OAuth setup is required before Slack availability can work.'
    );
  }

  const cachedToken = await readStoredGoogleAccessToken();
  if (cachedToken) {
    return cachedToken;
  }

  if (!interactive) {
    throw new CalendarPeekError('auth_required', 'Connect Google Calendar to check availability.');
  }

  try {
    if (!chrome.identity || typeof chrome.identity.getRedirectURL !== 'function' || typeof chrome.identity.launchWebAuthFlow !== 'function') {
      throw new CalendarPeekError(
        'auth_failed',
        'This browser does not support the Google authorization flow required by Calendar Peek.'
      );
    }

    const authRequest = chrome.identity.launchWebAuthFlow({
      url: buildGoogleAuthorizationUrl(),
      interactive: true
    });
    const result = await withTimeout(
      authRequest,
      GOOGLE_INTERACTIVE_AUTH_TIMEOUT_MS,
      () => new CalendarPeekError(
        'auth_timeout',
        'Google authorization did not finish. Close any abandoned Google authorization window and try again.'
      )
    );
    const tokenResult = parseGoogleAuthRedirect(result);
    await chrome.storage.local.set({
      [GOOGLE_TOKEN_KEY]: {
        accessToken: tokenResult.accessToken,
        expiresAt: tokenResult.expiresAt,
        scope: GOOGLE_OAUTH_SCOPE
      }
    });
    return tokenResult.accessToken;
  } catch (error) {
    if (error instanceof CalendarPeekError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLocaleLowerCase();

    if (
      normalized.includes('bad client id') ||
      normalized.includes('invalid_client') ||
      normalized.includes('redirect_uri_mismatch') ||
      normalized.includes('oauth2 client') ||
      normalized.includes('client id') && normalized.includes('invalid')
    ) {
      throw new CalendarPeekError(
        'oauth_not_configured',
        'The Google OAuth client is missing or does not match this extension ID. Open Calendar Peek setup.'
      );
    }

    if (
      normalized.includes('user did not approve') ||
      normalized.includes('user rejected') ||
      normalized.includes('cancel') ||
      normalized.includes('closed')
    ) {
      throw new CalendarPeekError('auth_cancelled', 'Google Calendar connection was cancelled.');
    }

    throw new CalendarPeekError('auth_failed', message || 'Could not connect Google Calendar.');
  }
}

function buildGoogleAuthorizationUrl() {
  const manifest = chrome.runtime.getManifest();
  const oauth = manifest && manifest.oauth2;
  const redirectUri = chrome.identity.getRedirectURL();
  if (typeof redirectUri !== 'string' || !redirectUri) {
    throw new CalendarPeekError('auth_failed', 'This browser did not provide a Google authorization redirect.');
  }
  const params = new URLSearchParams({
    client_id: oauth.client_id,
    redirect_uri: redirectUri,
    response_type: 'token',
    scope: GOOGLE_OAUTH_SCOPE,
    prompt: 'consent'
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function parseGoogleAuthRedirect(redirectUrl) {
  if (typeof redirectUrl !== 'string' || !redirectUrl) {
    throw new CalendarPeekError('auth_failed', 'Google Calendar authorization did not return a redirect.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(redirectUrl);
  } catch (error) {
    throw new CalendarPeekError('auth_failed', 'Google Calendar authorization returned an invalid redirect.');
  }

  const fragment = new URLSearchParams(parsedUrl.hash.replace(/^#/, ''));
  const query = new URLSearchParams(parsedUrl.search);
  const result = fragment.has('access_token') || fragment.has('error') ? fragment : query;
  const errorCode = result.get('error');

  if (errorCode) {
    const errorDescription = result.get('error_description');
    if (errorCode === 'access_denied') {
      throw new CalendarPeekError('auth_cancelled', 'Google Calendar connection was cancelled.');
    }
    throw new CalendarPeekError(
      'auth_failed',
      errorDescription || `Google authorization failed (${errorCode}).`
    );
  }

  const accessToken = result.get('access_token');
  const expiresIn = Number(result.get('expires_in'));
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new CalendarPeekError('auth_failed', 'Google Calendar authorization did not return a usable token.');
  }

  return {
    accessToken,
    expiresAt: Date.now() + expiresIn * 1000
  };
}

async function readStoredGoogleAccessToken() {
  const stored = await chrome.storage.local.get(GOOGLE_TOKEN_KEY);
  const token = stored && stored[GOOGLE_TOKEN_KEY];
  if (
    !token ||
    typeof token.accessToken !== 'string' ||
    !token.accessToken ||
    !Number.isFinite(token.expiresAt) ||
    token.scope !== GOOGLE_OAUTH_SCOPE ||
    token.expiresAt <= Date.now() + GOOGLE_TOKEN_EXPIRY_SKEW_MS
  ) {
    if (token) {
      await clearStoredGoogleAccessToken();
    }
    return '';
  }

  return token.accessToken;
}

async function clearStoredGoogleAccessToken() {
  await chrome.storage.local.remove(GOOGLE_TOKEN_KEY);
}

async function requestFreeBusy(token, body) {
  return requestGoogleJson(token, GOOGLE_FREEBUSY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function requestEvents(token, calendarId, timeMin, timeMax, timeZone) {
  const url = new URL(`${GOOGLE_EVENTS_URL}/${encodeURIComponent(calendarId)}/events`);
  url.search = new URLSearchParams({
    timeMin,
    timeMax,
    timeZone,
    singleEvents: 'true',
    orderBy: 'startTime',
    showDeleted: 'false',
    maxResults: '2500',
    fields: 'items(id,summary,start,end,status,transparency)'
  }).toString();

  return requestGoogleJson(token, url.toString(), { method: 'GET' });
}

async function requestGoogleJson(token, url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GOOGLE_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...(options || {}),
      headers: {
        ...((options && options.headers) || {}),
        Authorization: `Bearer ${token}`
      },
      signal: controller.signal
    });

    const payload = await response.json().catch(() => ({}));

    if (response.status === 401) {
      return { unauthorized: true, payload };
    }

    if (!response.ok) {
      throw mapGoogleApiError(response.status, payload);
    }

    return { unauthorized: false, payload };
  } catch (error) {
    if (error instanceof CalendarPeekError) {
      throw error;
    }

    if (error && error.name === 'AbortError') {
      throw new CalendarPeekError('network_timeout', 'Google Calendar took too long to respond.');
    }

    throw new CalendarPeekError(
      'network_error',
      error instanceof Error ? error.message : 'Could not reach Google Calendar.'
    );
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeCalendarEvents(payload, rangeStartMs, rangeEndMs) {
  const items = payload && Array.isArray(payload.items) ? payload.items : [];

  return items
    .filter((event) => event && event.status !== 'cancelled')
    .map((event) => {
      const start = parseCalendarEventBoundary(event.start);
      const end = parseCalendarEventBoundary(event.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        return null;
      }

      const title = normalizeEventTitle(event.summary);
      return {
        id: typeof event.id === 'string' ? event.id : '',
        title: title || 'Private event',
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        allDay: Boolean(event.start && event.start.date && !event.start.dateTime),
        isBusy: event.transparency !== 'transparent'
      };
    })
    .filter((event) => {
      if (!event) {
        return false;
      }
      const start = Date.parse(event.start);
      const end = Date.parse(event.end);
      return end > rangeStartMs && start < rangeEndMs;
    });
}

function parseCalendarEventBoundary(boundary) {
  if (!boundary || typeof boundary !== 'object') {
    return Number.NaN;
  }

  if (typeof boundary.dateTime === 'string') {
    return Date.parse(boundary.dateTime);
  }

  if (typeof boundary.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(boundary.date)) {
    return Date.parse(`${boundary.date}T00:00:00`);
  }

  return Number.NaN;
}

function normalizeEventTitle(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function describeEventDetailsFallback(error) {
  if (error instanceof CalendarPeekError && error.code === 'scope_denied') {
    return 'Reconnect Google Calendar to show event names.';
  }

  if (error instanceof CalendarPeekError && (error.code === 'permission_denied' || error.code === 'calendar_unavailable' || error.code === 'google_api_error')) {
    return 'Google shared availability, but not event names for this calendar.';
  }

  return 'Event names are temporarily unavailable. Free/busy is still shown.';
}

function mapGoogleApiError(status, payload) {
  const apiError = payload && payload.error;
  const message = apiError && typeof apiError.message === 'string'
    ? apiError.message
    : `Google Calendar returned HTTP ${status}.`;
  const normalized = message.toLocaleLowerCase();
  const reasons = Array.isArray(apiError && apiError.errors)
    ? apiError.errors.map((entry) => entry && entry.reason).filter(Boolean)
    : [];

  if (
    status === 403 &&
    (
      reasons.includes('accessNotConfigured') ||
      normalized.includes('calendar api has not been used') ||
      normalized.includes('calendar api is disabled') ||
      normalized.includes('access not configured')
    )
  ) {
    return new CalendarPeekError(
      'api_disabled',
      'Enable the Google Calendar API in the OAuth project, then try again.'
    );
  }

  if (status === 403 && (reasons.includes('insufficientPermissions') || normalized.includes('insufficient authentication scopes'))) {
    return new CalendarPeekError(
      'scope_denied',
      'Google did not grant the required Calendar read permission. Disconnect and reconnect Calendar Peek.'
    );
  }

  if (status === 403) {
    return new CalendarPeekError(
      'permission_denied',
      'Google Calendar denied this request. Your Workspace administrator may restrict Calendar API access.'
    );
  }

  if (status === 429) {
    return new CalendarPeekError('rate_limited', 'Google Calendar is temporarily rate-limiting requests.');
  }

  if (status >= 500) {
    return new CalendarPeekError('google_unavailable', 'Google Calendar is temporarily unavailable.');
  }

  return new CalendarPeekError('google_api_error', message);
}

function findCalendarEntry(payload, email) {
  const calendars = payload && payload.calendars;
  if (!calendars || typeof calendars !== 'object') {
    return null;
  }

  if (calendars[email]) {
    return calendars[email];
  }

  const normalizedEmail = email.toLocaleLowerCase();
  const matchingKey = Object.keys(calendars).find((key) => key.toLocaleLowerCase() === normalizedEmail);
  if (matchingKey) {
    return calendars[matchingKey];
  }

  const entries = Object.values(calendars);
  return entries.length === 1 ? entries[0] : null;
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

function withTimeout(value, timeoutMs, createError) {
  let timeoutId;
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(typeof createError === 'function' ? createError() : new Error('Operation timed out.'));
    }, timeoutMs);
  });

  return Promise.race([Promise.resolve(value), timeout])
    .finally(() => clearTimeout(timeoutId));
}

function readTimeoutOverride(name, fallback) {
  const value = globalThis && Number(globalThis[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
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

function normalizeRfc3339(value, fieldName) {
  if (!isRfc3339(value)) {
    throw new CalendarPeekError('invalid_time_range', `${fieldName} must be an RFC3339 timestamp.`);
  }
  return new Date(value).toISOString();
}

function isRfc3339(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function normalizeTimeZone(value) {
  const timeZone = typeof value === 'string' ? value.trim().slice(0, 120) : '';
  if (!timeZone) {
    return 'UTC';
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return timeZone;
  } catch (error) {
    return 'UTC';
  }
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
