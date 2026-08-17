'use strict';

const FREEBUSY_SCOPE = 'https://www.googleapis.com/auth/calendar.events.freebusy';
const EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
const CLIENT_ID_PATTERN = /^\d{6,}-[a-z0-9_-]+\.apps\.googleusercontent\.com$/i;
const STATUS_MESSAGE_TIMEOUT_MS = readDurationOverride('__CALENDAR_PEEK_TEST_STATUS_TIMEOUT_MS', 8000);
const DISCONNECT_MESSAGE_TIMEOUT_MS = readDurationOverride('__CALENDAR_PEEK_TEST_DISCONNECT_TIMEOUT_MS', 15000);
const CONNECT_MESSAGE_TIMEOUT_MS = readDurationOverride('__CALENDAR_PEEK_TEST_CONNECT_TIMEOUT_MS', 2 * 60 * 1000);

const extensionIdElement = document.querySelector('#extension-id');
const redirectHostElement = document.querySelector('[data-redirect-host]');
const copyExtensionIdButton = document.querySelector('#copy-extension-id');
const clientIdInput = document.querySelector('#client-id');
const clientIdError = document.querySelector('#client-id-error');
const patchManifestButton = document.querySelector('#patch-manifest');
const copyOAuthBlockButton = document.querySelector('#copy-oauth-block');
const patchResult = document.querySelector('#patch-result');
const oauthPreview = document.querySelector('#oauth-preview');
const statusDot = document.querySelector('#status-dot');
const statusTitle = document.querySelector('#status-title');
const statusDetail = document.querySelector('#status-detail');
const connectButton = document.querySelector('#connect');
const disconnectButton = document.querySelector('#disconnect');
const retryStatusButton = document.querySelector('#retry-status');
const reloadOptionsButton = document.querySelector('#reload-options');

let statusRequestSequence = 0;
let lastStatusCheckStartedAt = 0;

const runtimeId = readRuntimeId();
extensionIdElement.textContent = runtimeId || 'Unavailable - reload this page';
if (redirectHostElement) {
  redirectHostElement.textContent = runtimeId || 'your-extension-id';
}
updatePreview();
void refreshStatus();

copyExtensionIdButton.addEventListener('click', async () => {
  const extensionId = readRuntimeId();
  if (!extensionId) {
    showStaleContextStatus();
    return;
  }
  await copyText(extensionId);
  temporarilyRelabel(copyExtensionIdButton, 'Copied');
});

clientIdInput.addEventListener('input', () => {
  clientIdError.textContent = '';
  patchResult.textContent = '';
  patchResult.className = 'helper';
  updatePreview();
});

copyOAuthBlockButton.addEventListener('click', async () => {
  const clientId = getValidatedClientId();
  if (!clientId) {
    return;
  }
  await copyText(JSON.stringify(createOAuthBlock(clientId), null, 2));
  temporarilyRelabel(copyOAuthBlockButton, 'Copied');
});

patchManifestButton.addEventListener('click', async () => {
  const clientId = getValidatedClientId();
  if (!clientId) {
    return;
  }

  if (typeof window.showOpenFilePicker !== 'function') {
    patchResult.textContent = 'This browser does not expose the file picker here. Use “Copy manifest block” and edit manifest.json manually.';
    patchResult.className = 'helper error';
    return;
  }

  setPatchBusy(true);
  patchResult.textContent = '';
  patchResult.className = 'helper';

  try {
    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [{
        description: 'Calendar Peek manifest',
        accept: { 'application/json': ['.json'] }
      }]
    });

    const file = await handle.getFile();
    const manifest = JSON.parse(await file.text());
    if (manifest.manifest_version !== 3 || manifest.name !== 'Calendar Peek') {
      throw new Error('That file does not appear to be Calendar Peek’s manifest.json.');
    }

    manifest.oauth2 = createOAuthBlock(clientId).oauth2;
    const writable = await handle.createWritable();
    await writable.write(`${JSON.stringify(manifest, null, 2)}\n`);
    await writable.close();

    patchResult.textContent = 'manifest.json updated. Reload Calendar Peek at chrome://extensions, then refresh or reopen this setup tab before clicking Connect Google Calendar.';
    patchResult.className = 'helper success';
  } catch (error) {
    if (error && error.name === 'AbortError') {
      patchResult.textContent = 'No file was changed.';
      patchResult.className = 'helper';
    } else {
      patchResult.textContent = error instanceof Error ? error.message : 'Could not update manifest.json.';
      patchResult.className = 'helper error';
    }
  } finally {
    setPatchBusy(false);
  }
});

connectButton.addEventListener('click', async () => {
  hideRecoveryActions();
  setStatusBusy(true, 'Opening Google authorization…');
  try {
    const response = await sendRuntimeMessage(
      { type: 'CALENDAR_PEEK_CONNECT_GOOGLE' },
      CONNECT_MESSAGE_TIMEOUT_MS,
      'Google authorization did not finish. Close any abandoned Google authorization window and try again.'
    );
    if (!response || response.ok !== true) {
      throw new Error(response && response.error ? response.error : 'Could not connect Google Calendar.');
    }
    await refreshStatus();
  } catch (error) {
    handleRuntimeError(error, 'Google connection failed');
    connectButton.hidden = false;
    disconnectButton.hidden = true;
  }
});

disconnectButton.addEventListener('click', async () => {
  hideRecoveryActions();
  setStatusBusy(true, 'Disconnecting…');
  try {
    const response = await sendRuntimeMessage(
      { type: 'CALENDAR_PEEK_DISCONNECT_GOOGLE' },
      DISCONNECT_MESSAGE_TIMEOUT_MS,
      'Calendar Peek did not finish disconnecting. Check again.'
    );
    if (!response || response.ok !== true) {
      throw new Error(response && response.error ? response.error : 'Could not disconnect Google Calendar.');
    }
    await refreshStatus();
  } catch (error) {
    handleRuntimeError(error, 'Could not disconnect');
  }
});

retryStatusButton.addEventListener('click', () => {
  void refreshStatus();
});

reloadOptionsButton.addEventListener('click', () => {
  window.location.reload();
});

window.addEventListener('focus', handlePageResume);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    handlePageResume();
  }
});

async function refreshStatus() {
  lastStatusCheckStartedAt = Date.now();
  const requestSequence = ++statusRequestSequence;
  hideRecoveryActions();
  setStatusBusy(true, 'Checking setup…');

  try {
    const response = await sendRuntimeMessage(
      { type: 'CALENDAR_PEEK_AUTH_STATUS' },
      STATUS_MESSAGE_TIMEOUT_MS,
      'The setup check timed out. The extension may have been reloaded while this tab was open.'
    );

    if (requestSequence !== statusRequestSequence) {
      return;
    }

    if (!response || response.ok !== true) {
      throw new Error(response && response.error ? response.error : 'Could not read setup status.');
    }

    if (!response.configured) {
      setStatus('warning', 'OAuth client not configured', 'Complete the three steps below. Google authorization is not attempted until you click Connect.');
      connectButton.hidden = true;
      disconnectButton.hidden = true;
      return;
    }

    if (!response.connected) {
      setStatus('warning', 'Ready to connect', 'The OAuth client is configured. Connect Google Calendar once, then availability will open directly in Slack.');
      connectButton.hidden = false;
      disconnectButton.hidden = true;
      return;
    }

    setStatus('ready', 'Google Calendar connected', 'Calendar Peek can request event names and free/busy blocks for calendars your Google account is allowed to access.');
    connectButton.hidden = true;
    disconnectButton.hidden = false;
  } catch (error) {
    if (requestSequence !== statusRequestSequence) {
      return;
    }
    handleRuntimeError(error, 'Could not check setup');
    connectButton.hidden = true;
    disconnectButton.hidden = true;
  }
}

function handlePageResume() {
  if (!readRuntimeId()) {
    window.location.reload();
    return;
  }

  if (Date.now() - lastStatusCheckStartedAt > 1000) {
    void refreshStatus();
  }
}

function createOAuthBlock(clientId) {
  return {
    oauth2: {
      client_id: clientId,
      scopes: [FREEBUSY_SCOPE, EVENTS_SCOPE]
    }
  };
}

function getValidatedClientId() {
  const clientId = clientIdInput.value.trim();
  if (!CLIENT_ID_PATTERN.test(clientId)) {
    clientIdError.textContent = 'Paste the Google OAuth client ID ending in .apps.googleusercontent.com.';
    clientIdInput.focus();
    return '';
  }
  clientIdError.textContent = '';
  return clientId;
}

function updatePreview() {
  const value = clientIdInput.value.trim() || '1234567890-example.apps.googleusercontent.com';
  oauthPreview.textContent = JSON.stringify(createOAuthBlock(value), null, 2);
}

function setStatus(kind, title, detail) {
  statusDot.className = `status-dot ${kind}`;
  statusTitle.textContent = title;
  statusDetail.textContent = detail;
  connectButton.disabled = false;
  disconnectButton.disabled = false;
  retryStatusButton.disabled = false;
  reloadOptionsButton.disabled = false;
}

function setStatusBusy(isBusy, title) {
  statusDot.className = 'status-dot';
  statusTitle.textContent = title;
  statusDetail.textContent = '';
  connectButton.disabled = isBusy;
  disconnectButton.disabled = isBusy;
  retryStatusButton.disabled = isBusy;
  reloadOptionsButton.disabled = false;
}

function handleRuntimeError(error, fallbackTitle) {
  if (isStaleContextError(error)) {
    showStaleContextStatus();
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  setStatus('error', fallbackTitle, message);
  retryStatusButton.hidden = false;
  reloadOptionsButton.hidden = false;
}

function showStaleContextStatus() {
  setStatus(
    'error',
    'Setup page needs to be reloaded',
    'Calendar Peek was reloaded or updated while this tab was open. Reload this setup page, then the current manifest and OAuth configuration will be checked again.'
  );
  connectButton.hidden = true;
  disconnectButton.hidden = true;
  retryStatusButton.hidden = true;
  reloadOptionsButton.hidden = false;
}

function hideRecoveryActions() {
  retryStatusButton.hidden = true;
  reloadOptionsButton.hidden = true;
}

function readDurationOverride(name, fallback) {
  const value = Number(globalThis && globalThis[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readRuntimeId() {
  try {
    return globalThis.chrome && chrome.runtime && typeof chrome.runtime.id === 'string'
      ? chrome.runtime.id
      : '';
  } catch {
    return '';
  }
}

function isStaleContextError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  const normalized = message.toLocaleLowerCase();
  return (
    !readRuntimeId() ||
    normalized.includes('extension context invalidated') ||
    normalized.includes('context invalidated') ||
    normalized.includes('message port closed') ||
    normalized.includes('receiving end does not exist')
  );
}

function sendRuntimeMessage(message, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    if (!readRuntimeId()) {
      reject(new Error('Extension context invalidated. Reload this setup page.'));
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (settled) {
          return;
        }

        let lastError;
        try {
          lastError = chrome.runtime.lastError;
        } catch (error) {
          settled = true;
          clearTimeout(timer);
          reject(error);
          return;
        }

        settled = true;
        clearTimeout(timer);
        if (lastError) {
          reject(new Error(lastError.message || 'Calendar Peek’s service worker did not respond.'));
          return;
        }

        resolve(response);
      });
    } catch (error) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    }
  });
}

function setPatchBusy(isBusy) {
  patchManifestButton.disabled = isBusy;
  clientIdInput.disabled = isBusy;
  patchManifestButton.textContent = isBusy ? 'Updating…' : 'Choose manifest.json and apply';
}

async function copyText(value) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch (error) {
      console.debug('[Calendar Peek] Clipboard API was unavailable; using the fallback.', error);
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) {
    throw new Error('Could not copy to the clipboard.');
  }
}

function temporarilyRelabel(button, label) {
  const original = button.textContent;
  button.textContent = label;
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}
