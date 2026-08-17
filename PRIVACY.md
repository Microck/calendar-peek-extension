# Privacy

Calendar Peek does not collect, sell, or share personal data with the extension developer or any third-party backend.

The extension does not use analytics, advertising, trackers, remote scripts, or external servers.

## Google Workspace profile-card feature

When you click the Calendar Peek icon on a Google Workspace profile card, the coworker's email address and optional display name are stored in `chrome.storage.local` only long enough to hand the request to Google Calendar. Each request expires after two minutes and is removed after use.

## Slack availability feature

Calendar Peek reads a coworker's email address only when it is already visible in the Slack web profile available to you. It does not use a Slack token or call the Slack API.

After you explicitly authorize Google Calendar, Calendar Peek sends the selected coworker's email address, the selected day's start/end timestamps, and your browser time zone directly to Google's official Calendar free/busy and read-only events endpoints. Google returns busy start/end intervals plus event names and start/end times when your account can view them. Calendar Peek does not request descriptions, attendees, locations, or calendar-editing access. Google may redact details for private or restricted events.

Availability responses are cached only in the Slack tab's memory for up to two minutes. They are not written to extension storage.

The Google OAuth access token is stored in extension-local storage until it expires so Chromium browsers can reuse the authorization. Calendar Peek does not send the token anywhere except to Google's API in the request authorization header, and it removes the stored token when you disconnect or Google rejects it.

All visibility is enforced by Google Calendar and your Google Workspace administrator. Calendar Peek cannot bypass calendar sharing permissions.
