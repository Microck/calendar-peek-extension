# Google OAuth setup for Slack availability

Calendar Peek can add its button to Slack without a Slack app. To read availability and event names, Google requires an OAuth client with the extension's fixed redirect URI.

## Extension ID

```text
pcdcgkbgimicaioepjbghpmmjadeghej
```

The public `key` in `manifest.json` keeps this ID stable when the extension is loaded unpacked.

## Setup

1. Open Google Cloud Console and create or select a project.
2. Enable the **Google Calendar API**.
3. Configure the OAuth consent screen.
   - For a Google Workspace project, **Internal** is usually simplest.
   - For an External app in testing, add your Google account as a test user.
4. Create an OAuth client with application type **Web application**.
5. Add this exact authorized redirect URI:

   ```text
   https://pcdcgkbgimicaioepjbghpmmjadeghej.chromiumapp.org/
   ```

6. Copy the generated client ID. Do not put the client secret in the extension.
7. Add the client ID to `manifest.json` using either method below.
8. Reload Calendar Peek at `chrome://extensions`.
9. Open Calendar Peek's **Details → Extension options**, then click **Connect Google Calendar**.

### Guided file update

Load Calendar Peek once, open its options page, paste the client ID, and click **Choose manifest.json and apply**. Select the `manifest.json` inside the extracted Calendar Peek folder.

### Command-line update

From the extracted extension folder:

```bash
python3 tools/configure-oauth.py YOUR_CLIENT_ID.apps.googleusercontent.com
```

### Manual manifest block

Add this top-level property to `manifest.json`:

```json
"oauth2": {
  "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "scopes": [
    "https://www.googleapis.com/auth/calendar.events.freebusy",
    "https://www.googleapis.com/auth/calendar.events.readonly"
  ]
}
```

## Scope and data

Calendar Peek requests these read-only scopes:

```text
https://www.googleapis.com/auth/calendar.events.freebusy
https://www.googleapis.com/auth/calendar.events.readonly
```

The Slack popup sends the selected coworker's visible email address, the selected day's time range, and your browser time zone directly to Google's Calendar API. It receives busy start/end intervals and event names/start/end times when Google permits them. It does not request descriptions, attendees, locations, or editing access. Private or restricted events can still appear as generic Busy blocks.

## Common errors

- **OAuth client not configured:** the `oauth2` block is missing from the loaded manifest, or the extension has not been reloaded.
- **Redirect URI mismatch:** use a **Web application** client and register the exact `chromiumapp.org` URI for this extension.
- **Calendar API disabled:** enable Google Calendar API in the same Google Cloud project as the OAuth client.
- **Unverified app:** use an Internal Workspace consent screen or add your account as a test user while developing.
- **Calendar unavailable:** Slack's email differs from the coworker's Google Calendar address, or Google does not permit you to view that calendar's availability.
