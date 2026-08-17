# Calendar Peek

Calendar Peek is a small, open-source Chrome/Edge extension for seeing a coworker's Google Calendar availability with one click.

## Features

### Google Workspace profile cards

1. Click a coworker's avatar or name in Gmail, Google Calendar, Drive, Docs, Meet, Chat, or Contacts.
2. A blue calendar icon appears on the visible profile card.
3. Click it to open Google Calendar and select that coworker through Google's native **Search for people** control.

The toolbar popup is a simple fallback: enter a coworker's work email and click **View calendar**.

### Slack web availability popup

1. Open Slack in the browser at `app.slack.com` or another `*.slack.com` web URL.
2. Click a coworker's name or avatar to open their profile.
3. If Slack exposes a valid email address in the profile, Calendar Peek adds a calendar/check icon beside the profile controls.
4. Click the icon to open a compact popup inside Slack.
5. The popup shows event names, exact timeframes, busy blocks, and free windows for the selected day, with previous/today/next navigation and an optional **Open in Google Calendar** link.

No Slack app, Slack token, backend server, or analytics is used.

## Important limitations

- Slack integration works in the browser, not inside Slack's native desktop or mobile applications.
- Slack must make the coworker's email visible to you in the profile UI. If the email is hidden, Calendar Peek cannot resolve the Google calendar without a separate Slack app/API integration.
- The Slack email must match a Google Calendar identifier you can access.
- Google Calendar and your Workspace administrator still enforce all sharing permissions. Calendar Peek cannot bypass them.
- Slack and Google Workspace are frequently changing single-page applications. Future UI updates may require selector adjustments in `src/slack.js`, `src/profile-card.js`, or `src/calendar.js`.

## Install locally

1. Extract the project.
2. Open `chrome://extensions` in Chrome, Edge, Brave, or another Chromium browser.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the extracted `calendar-peek-extension` folder.
6. Refresh any already-open Google Workspace and Slack tabs once.

The extension's fixed development ID is:

```text
pcdcgkbgimicaioepjbghpmmjadeghej
```

## One-time Google OAuth setup for Slack

The original Google Workspace profile-card feature does not require OAuth. The in-Slack free/busy popup does, because Google's Calendar API requires an authorized OAuth client.

Follow [`SETUP_GOOGLE_OAUTH.md`](SETUP_GOOGLE_OAUTH.md), or open Calendar Peek's **Extension options** after loading it. The setup page can patch the selected source `manifest.json` for you.

Calendar Peek requests these read-only scopes:

```text
https://www.googleapis.com/auth/calendar.events.freebusy
https://www.googleapis.com/auth/calendar.events.readonly
```

The first scope permits availability checks. The second permits reading event names and start/end times on calendars your Google account can already access. Calendar Peek does not request descriptions, attendees, locations, or calendar editing access.

## Privacy and permissions

- No analytics, advertising, trackers, remote scripts, or external servers.
- No Slack API access or Slack tokens.
- Slack profile data is read only from the page already visible to you.
- Availability requests go directly from the extension to Google's Calendar API.
- The selected coworker's email, selected time range, and browser time zone are sent to Google for the free/busy and event queries.
- Google returns busy start/end intervals and the event fields needed to show titles and timeframes. Google may hide details for private or restricted events, in which case Calendar Peek shows a generic busy label.
- Availability results are cached in memory for up to two minutes while the Slack tab remains open.
- The older Google Workspace handoff stores a pending email/name in `chrome.storage.local` for at most two minutes while it opens Calendar.

Manifest permissions:

- `alarms`: delete an unused Google Calendar handoff after two minutes.
- `identity`: run Google OAuth after explicit user authorization.
- `storage`: briefly queue a coworker for the native Google Calendar view.
- `tabs`: open or focus Google Calendar.
- Google Workspace hosts: detect visible profile cards and automate the native Calendar people search.
- Slack hosts: detect a visible coworker profile and add the availability button.
- `www.googleapis.com`: call the official Google Calendar free/busy and read-only events endpoints.

See [`PRIVACY.md`](PRIVACY.md) for the concise privacy statement.

## Project structure

```text
calendar-peek-extension/
├── manifest.json
├── background.js
├── src/
│   ├── availability-utils.js
│   ├── calendar.js
│   ├── common.js
│   ├── profile-card.js
│   ├── slack.js
│   └── styles.css
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── options/
│   ├── options.html
│   ├── options.css
│   └── options.js
├── tools/
│   └── configure-oauth.py
├── tests/
├── icons/
├── SETUP_GOOGLE_OAUTH.md
├── PRIVACY.md
├── CHANGELOG.md
└── LICENSE
```

## Development checks

```bash
node --check background.js src/*.js popup/*.js options/*.js
node tests/manifest.test.js
node tests/availability-utils.test.js
node tests/background.test.js
node tests/run-browser-smoke.js
```

The browser smoke test uses an isolated Slack profile-card fixture. It verifies button injection, profile-card reuse, popup rendering, event titles, and free/busy blocks without connecting to a real Slack or Google account.

## License

MIT
