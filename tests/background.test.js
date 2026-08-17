'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FREEBUSY_SCOPE = 'https://www.googleapis.com/auth/calendar.events.freebusy';
const EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
const OAUTH_SCOPE = [FREEBUSY_SCOPE, EVENTS_SCOPE].join(' ');

function createHarness() {
  const listeners = {};
  const storage = {};
  const webAuthFlowCalls = [];
  const webAuthFlowResponses = [];
  const fetchCalls = [];
  const createdTabs = [];
  const manifest = {
    manifest_version: 3,
    name: 'Calendar Peek'
  };
  let fetchHandler = async () => {
    throw new Error('Unexpected fetch call.');
  };

  const event = (name) => ({
    addListener(listener) {
      listeners[name] = listener;
    }
  });

  const chrome = {
    alarms: {
      clear: async () => true,
      create: async () => {},
      onAlarm: event('alarm')
    },
    identity: {
      clearAllCachedAuthTokens: async () => {
        delete storage.calendarPeekGoogleToken;
      },
      getRedirectURL: () => 'https://test-extension.chromiumapp.org/',
      launchWebAuthFlow: async (details) => {
        webAuthFlowCalls.push(details);
        if (webAuthFlowResponses.length === 0) {
          throw new Error('Unexpected launchWebAuthFlow call.');
        }
        const next = webAuthFlowResponses.shift();
        if (next instanceof Error) {
          throw next;
        }
        return next;
      }
    },
    runtime: {
      getManifest: () => manifest,
      onInstalled: event('installed'),
      onMessage: event('message'),
      openOptionsPage: async () => {}
    },
    storage: {
      local: {
        get: async (key) => ({ [key]: storage[key] }),
        remove: async (key) => {
          delete storage[key];
        },
        set: async (entries) => {
          Object.assign(storage, entries);
        }
      }
    },
    tabs: {
      create: async (details) => {
        createdTabs.push(details);
        return { id: 99, url: details.url };
      },
      query: async () => [],
      sendMessage: async () => {},
      update: async () => ({})
    },
    windows: {
      update: async () => ({})
    }
  };

  const context = vm.createContext({
    AbortController,
    Date,
    Error,
    Intl,
    JSON,
    Math,
    Object,
    Promise,
    RegExp,
    String,
    URL,
    URLSearchParams,
    chrome,
    console: { ...console, error() {} },
    fetch: async (...args) => {
      fetchCalls.push(args);
      return fetchHandler(...args);
    },
    setTimeout,
    clearTimeout
  });

  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'background.js' });

  async function send(message) {
    assert.equal(typeof listeners.message, 'function', 'Background message listener was not installed.');
    return await new Promise((resolve, reject) => {
      const keepAlive = listeners.message(message, {}, resolve);
      if (keepAlive !== true) {
        reject(new Error('Background listener did not keep the response channel open.'));
      }
    });
  }

  return {
    createdTabs,
    fetchCalls,
    manifest,
    webAuthFlowCalls,
    webAuthFlowResponses,
    send,
    setFetchHandler(handler) {
      fetchHandler = handler;
    },
    storage
  };
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    }
  };
}

async function run() {
  const harness = createHarness();

  const unconfigured = await harness.send({
    type: 'CALENDAR_PEEK_FREEBUSY',
    person: { email: 'alex@example.com', name: 'Alex' },
    timeMin: '2026-08-17T00:00:00.000Z',
    timeMax: '2026-08-18T00:00:00.000Z',
    timeZone: 'Europe/Madrid'
  });
  assert.equal(unconfigured.ok, false);
  assert.equal(unconfigured.code, 'oauth_not_configured');
  assert.equal(harness.fetchCalls.length, 0);

  harness.manifest.oauth2 = {
    client_id: '123-example.apps.googleusercontent.com',
    scopes: [FREEBUSY_SCOPE, EVENTS_SCOPE]
  };

  const authRedirect = `https://test-extension.chromiumapp.org/#access_token=token-one&token_type=Bearer&expires_in=3600&scope=${encodeURIComponent(OAUTH_SCOPE)}`;
  harness.webAuthFlowResponses.push(authRedirect);
  const connected = await harness.send({ type: 'CALENDAR_PEEK_CONNECT_GOOGLE' });
  assert.equal(connected.ok, true);
  assert.equal(harness.webAuthFlowCalls.length, 1);
  assert.equal(harness.webAuthFlowCalls[0].interactive, true);
  const authUrl = new URL(harness.webAuthFlowCalls[0].url);
  assert.equal(authUrl.searchParams.get('client_id'), '123-example.apps.googleusercontent.com');
  assert.equal(authUrl.searchParams.get('redirect_uri'), 'https://test-extension.chromiumapp.org/');
  assert.equal(authUrl.searchParams.get('response_type'), 'token');
  assert.equal(authUrl.searchParams.get('scope'), OAUTH_SCOPE);

  harness.setFetchHandler(async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer token-one');
    if (url === 'https://www.googleapis.com/calendar/v3/freeBusy') {
      assert.equal(options.method, 'POST');
      const body = JSON.parse(options.body);
      assert.deepEqual(body.items, [{ id: 'alex@example.com' }]);
      assert.equal(body.timeZone, 'Europe/Madrid');
      return jsonResponse(200, {
        timeMin: body.timeMin,
        timeMax: body.timeMax,
        calendars: {
          'alex@example.com': {
            busy: [
              { start: '2026-08-17T08:00:00.000Z', end: '2026-08-17T09:00:00.000Z' }
            ]
          }
        }
      });
    }

    const eventUrl = new URL(url);
    assert.equal(eventUrl.pathname, '/calendar/v3/calendars/alex%40example.com/events');
    assert.equal(eventUrl.searchParams.get('timeZone'), 'Europe/Madrid');
    assert.equal(eventUrl.searchParams.get('singleEvents'), 'true');
    assert.equal(eventUrl.searchParams.get('orderBy'), 'startTime');
    assert.equal(eventUrl.searchParams.get('maxResults'), '2500');
    const pageToken = eventUrl.searchParams.get('pageToken');
    if (!pageToken) {
      return jsonResponse(200, {
        nextPageToken: 'page-two',
        items: [
          {
            id: 'event-1',
            summary: 'Design review',
            start: { dateTime: '2026-08-17T08:00:00.000Z' },
            end: { dateTime: '2026-08-17T09:00:00.000Z' },
            status: 'confirmed'
          }
        ]
      });
    }
    assert.equal(pageToken, 'page-two');
    return jsonResponse(200, {
      items: [
        {
          id: 'event-2',
          summary: 'Planning session',
          start: { dateTime: '2026-08-17T10:00:00.000Z' },
          end: { dateTime: '2026-08-17T11:00:00.000Z' },
          status: 'confirmed'
        }
      ]
    });
  });

  const success = await harness.send({
    type: 'CALENDAR_PEEK_FREEBUSY',
    person: { email: 'Alex@Example.com', name: 'Alex' },
    timeMin: '2026-08-17T00:00:00.000Z',
    timeMax: '2026-08-18T00:00:00.000Z',
    timeZone: 'Europe/Madrid'
  });
  assert.equal(success.ok, true);
  assert.equal(success.person.email, 'alex@example.com');
  assert.deepEqual(JSON.parse(JSON.stringify(success.busy)), [
    { start: '2026-08-17T08:00:00.000Z', end: '2026-08-17T09:00:00.000Z' }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(success.events)), [
    {
      id: 'event-1',
      title: 'Design review',
      start: '2026-08-17T08:00:00.000Z',
      end: '2026-08-17T09:00:00.000Z',
      allDay: false,
      isBusy: true
    },
    {
      id: 'event-2',
      title: 'Planning session',
      start: '2026-08-17T10:00:00.000Z',
      end: '2026-08-17T11:00:00.000Z',
      allDay: false,
      isBusy: true
    }
  ]);
  assert.equal(success.eventDetailsAvailable, true);

  harness.setFetchHandler(async (url) => {
    if (url === 'https://www.googleapis.com/calendar/v3/freeBusy') {
      return jsonResponse(200, {
        calendars: {
          'alex@example.com': {
            busy: [
              { start: '2026-08-17T08:00:00.000Z', end: '2026-08-17T09:00:00.000Z' }
            ]
          }
        }
      });
    }
    return jsonResponse(403, {
      error: {
        message: 'Insufficient Permission',
        errors: [{ reason: 'insufficientPermissions' }]
      }
    });
  });
  const metadataDenied = await harness.send({
    type: 'CALENDAR_PEEK_FREEBUSY',
    person: { email: 'alex@example.com' },
    timeMin: '2026-08-17T00:00:00.000Z',
    timeMax: '2026-08-18T00:00:00.000Z',
    timeZone: 'Europe/Madrid'
  });
  assert.equal(metadataDenied.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(metadataDenied.events)), []);
  assert.equal(metadataDenied.eventDetailsAvailable, false);
  assert.equal(metadataDenied.eventDetailsMessage, 'Reconnect Google Calendar to show event names.');

  let fetchAttempt = 0;
  harness.storage.calendarPeekGoogleToken = {
    accessToken: 'expired-token',
    expiresAt: Date.now() + 60 * 60 * 1000,
    scope: OAUTH_SCOPE
  };
  harness.webAuthFlowResponses.push(
    'https://test-extension.chromiumapp.org/#access_token=fresh-token&token_type=Bearer&expires_in=3600'
  );
  harness.setFetchHandler(async (url, options) => {
    fetchAttempt += 1;
    if (fetchAttempt === 1) {
      assert.equal(url, 'https://www.googleapis.com/calendar/v3/freeBusy');
      assert.equal(options.headers.Authorization, 'Bearer expired-token');
      return jsonResponse(401, { error: { message: 'Invalid credentials' } });
    }
    assert.equal(options.headers.Authorization, 'Bearer fresh-token');
    if (fetchAttempt === 2) {
      assert.equal(url, 'https://www.googleapis.com/calendar/v3/freeBusy');
      return jsonResponse(200, {
        calendars: { 'alex@example.com': { busy: [] } }
      });
    }
    assert.match(url, /\/calendar\/v3\/calendars\/alex%40example\.com\/events/);
    return jsonResponse(200, { items: [] });
  });

  const retried = await harness.send({
    type: 'CALENDAR_PEEK_FREEBUSY',
    person: { email: 'alex@example.com' },
    timeMin: '2026-08-17T00:00:00.000Z',
    timeMax: '2026-08-18T00:00:00.000Z',
    timeZone: 'Europe/Madrid',
    interactive: true
  });
  assert.equal(retried.ok, true);
  assert.equal(harness.webAuthFlowCalls.length, 2);
  assert.equal(fetchAttempt, 3);

  harness.storage.calendarPeekGoogleToken = {
    accessToken: 'token-not-found',
    expiresAt: Date.now() + 60 * 60 * 1000,
    scope: OAUTH_SCOPE
  };
  harness.setFetchHandler(async () => jsonResponse(200, {
    calendars: {
      'alex@example.com': {
        errors: [{ domain: 'calendar', reason: 'notFound' }],
        busy: []
      }
    }
  }));
  const unavailable = await harness.send({
    type: 'CALENDAR_PEEK_FREEBUSY',
    person: { email: 'alex@example.com' },
    timeMin: '2026-08-17T00:00:00.000Z',
    timeMax: '2026-08-18T00:00:00.000Z',
    timeZone: 'Europe/Madrid'
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.code, 'calendar_unavailable');

  const opened = await harness.send({
    type: 'CALENDAR_PEEK_OPEN',
    person: { email: 'alex@example.com', name: 'Alex' },
    accountIndex: 0
  });
  assert.equal(opened.ok, true);
  assert.equal(harness.createdTabs.at(-1).url, 'https://calendar.google.com/calendar/u/0/r');
  assert.equal(harness.storage.calendarPeekPending.email, 'alex@example.com');

  console.log('background service worker: all tests passed');
}

run().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
