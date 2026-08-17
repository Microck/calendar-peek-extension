# Calendar Peek

A small, open-source Chrome/Edge extension for checking a coworker's Google Calendar availability from Google Workspace or Slack.

![Calendar Peek Slack availability popup](docs/calendar-peek-slack.png)

## What it does

### Google Workspace

Click a coworker's avatar or name in Gmail, Calendar, Drive, Docs, Meet, Chat, or Contacts. Calendar Peek adds a calendar button that opens Google Calendar's native **Search for people** flow.

The toolbar popup is also available as a fallback. Enter a work email and click **View calendar**.

### Slack

On `app.slack.com` or another `*.slack.com` web URL:

1. Open a coworker's profile.
2. Click the Calendar Peek button if Slack exposes their email address.
3. Use the popup to see event names, timeframes, busy blocks, and free windows.
4. Move between previous, today, and next, or open the day in Google Calendar.

This works in Slack's browser app only. It does not use a Slack app, Slack token, backend, or analytics.

## Limitations

- Slack must show the coworker's email in the profile UI.
- The email must match a Google Calendar identifier you can access.
- Google Calendar and Workspace sharing settings still apply. Calendar Peek cannot bypass them.
- Google and Slack are changing single-page apps. UI changes may require updates to `src/slack.js`, `src/profile-card.js`, or `src/calendar.js`.

## Install locally

1. Open `chrome://extensions` in Chrome, Edge, Brave, or another Chromium browser.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Refresh open Google Workspace and Slack tabs.

The fixed development extension ID is:

```text
pcdcgkbgimicaioepjbghpmmjadeghej
```

## Google OAuth setup

The Google Workspace profile-card feature does not need OAuth. The Slack availability popup does, because Google requires an authorized OAuth client for Calendar API access.

Follow [`SETUP_GOOGLE_OAUTH.md`](SETUP_GOOGLE_OAUTH.md), or open **Extension options** after loading the extension. The setup page can patch the selected `manifest.json` for you.

Calendar Peek requests these read-only scopes:

```text
https://www.googleapis.com/auth/calendar.events.freebusy
https://www.googleapis.com/auth/calendar.events.readonly
```

The first checks availability. The second reads event titles and times from calendars your account can already access. No descriptions, attendees, locations, or calendar editing access are requested.

## Privacy and permissions

- No analytics, advertising, trackers, remote scripts, or external servers.
- No Slack API access or Slack tokens.
- Slack profile data is read only from the page already visible to you.
- Calendar requests go directly from the extension to Google's official Calendar API.
- Google receives the selected coworker's email, selected time range, and browser time zone for the requested queries.
- Private or restricted events may appear as a generic busy block.
- Availability results stay in memory for up to two minutes while the Slack tab is open.
- The Google Workspace handoff stores a pending email/name in `chrome.storage.local` for up to two minutes.

Manifest permissions are used for:

- `identity`: Google OAuth after explicit authorization.
- `storage`: temporarily queue a coworker for Google Calendar.
- `tabs`: open or focus Google Calendar.
- `alarms`: remove an expired Calendar handoff.
- Google Workspace hosts: detect profiles and use Calendar's native people search.
- Slack hosts: detect profiles and add the availability button.
- `www.googleapis.com`: call the read-only Calendar API endpoints.

See [`PRIVACY.md`](PRIVACY.md) for the short privacy statement.

## Development

```bash
node --check background.js src/*.js popup/*.js options/*.js
node tests/manifest.test.js
node tests/availability-utils.test.js
node tests/background.test.js
node tests/run-browser-smoke.js
```

The browser smoke test uses an isolated Slack profile fixture. It checks button injection, profile reuse, popup rendering, event titles, and free/busy blocks without connecting to a real account.

## Project structure

```text
manifest.json       Extension manifest
background.js       Service worker
src/                Calendar, Slack, profile, and shared logic
popup/              Toolbar popup
options/            OAuth setup page
tools/              OAuth configuration helper
tests/              Unit and browser smoke tests
icons/              Extension icons
```

## License

MIT
