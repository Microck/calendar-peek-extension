'use strict';

const form = document.querySelector('#person-form');
const emailInput = document.querySelector('#email');
const submitButton = document.querySelector('#submit');
const errorElement = document.querySelector('#error');
const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i;

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorElement.textContent = '';

  const email = emailInput.value.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    errorElement.textContent = 'Enter a valid work email address.';
    emailInput.focus();
    return;
  }

  setBusy(true);
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const accountIndex = getAccountIndex(tabs[0] && tabs[0].url);
    const response = await chrome.runtime.sendMessage({
      type: 'CALENDAR_PEEK_OPEN',
      person: { email, name: '' },
      accountIndex
    });

    if (!response || response.ok !== true) {
      throw new Error(response && response.error ? response.error : 'Could not open Google Calendar.');
    }

    window.close();
  } catch (error) {
    errorElement.textContent = error instanceof Error ? error.message : 'Could not open Google Calendar.';
    setBusy(false);
  }
});

function getAccountIndex(url) {
  const match = String(url || '').match(/\/u\/(\d+)(?:\/|$)/i);
  if (!match) {
    return 0;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 20 ? parsed : 0;
}

function setBusy(isBusy) {
  submitButton.disabled = isBusy;
  emailInput.disabled = isBusy;
  submitButton.lastChild.textContent = isBusy ? ' Opening…' : ' View calendar';
}
