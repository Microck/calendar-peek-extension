# Changelog

## 0.2.0

- Added Slack web profile-card detection and a calendar/check action.
- Added an in-Slack free/busy popup with previous, today, and next-day navigation.
- Added current-status and next-useful-free-window summaries.
- Added Google Calendar free/busy API access through Chrome Identity using the narrow `calendar.events.freebusy` scope.
- Added a guided OAuth setup/options page and a command-line manifest helper.
- Added two-minute in-memory availability caching; no Slack token or backend is used.
- Added manifest, service-worker, DST/date, profile-card reuse, and browser rendering tests.

## 0.1.0

- Added one-click coworker calendar opening from Google Workspace profile cards.
- Added a toolbar email fallback.
