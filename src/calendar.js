'use strict';

(() => {
  if (window.top !== window || !globalThis.CalendarPeek) {
    return;
  }

  const PENDING_KEY = 'calendarPeekPending';
  const MESSAGE_PROCESS_PENDING = 'CALENDAR_PEEK_PROCESS_PENDING';
  const MAX_WAIT_MS = 15000;
  const POLL_MS = 250;

  const PEOPLE_SEARCH_HINTS = [
    'search for people',
    'find people',
    'buscar personas',
    'cerca persones',
    'rechercher des personnes',
    'nach personen suchen',
    'cerca persone',
    'pesquisar pessoas',
    'mensen zoeken',
    'wyszukaj osoby',
    'sök efter personer',
    'søg efter personer',
    'søk etter personer',
    'hae henkilöitä',
    'hledat lidi',
    'caută persoane',
    'kişi ara',
    'ユーザーを検索',
    '사용자 검색',
    '搜尋使用者',
    '搜索人员'
  ];

  const MENU_HINTS = [
    'main menu',
    'menu principal',
    'menú principal',
    'hauptmenü',
    'menu principale',
    'menu principal',
    'hoofdmenu',
    'główne menu',
    'huvudmeny',
    'hovedmenu',
    'päävalikko',
    'hlavní nabídka',
    'ana menü'
  ];

  let processing = false;
  let retryTimer = null;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== MESSAGE_PROCESS_PENDING) {
      return false;
    }

    void processPendingRequest();
    sendResponse({ ok: true });
    return false;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[PENDING_KEY] && changes[PENDING_KEY].newValue) {
      scheduleProcessing(100);
    }
  });

  scheduleProcessing(500);

  function scheduleProcessing(delayMs) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      void processPendingRequest();
    }, delayMs);
  }

  async function processPendingRequest() {
    if (processing) {
      return;
    }

    processing = true;
    try {
      const stored = await chrome.storage.local.get(PENDING_KEY);
      const pending = stored[PENDING_KEY];
      if (!isUsablePendingRequest(pending)) {
        if (pending) {
          await chrome.storage.local.remove(PENDING_KEY);
        }
        return;
      }

      const currentAccountIndex = globalThis.CalendarPeek.getAccountIndex();
      if (Number(pending.accountIndex) !== currentAccountIndex) {
        return;
      }

      const searchInput = await findPeopleSearchInput();
      if (!searchInput) {
        showToast('Could not find Google Calendar’s “Search for people” box.', 'error');
        return;
      }

      fillSearchInput(searchInput, pending.email);
      const selected = await selectMatchingPerson(searchInput, pending);

      if (!selected) {
        showToast(`Select ${pending.name || pending.email} from the open results.`, 'error');
        return;
      }

      await chrome.storage.local.remove(PENDING_KEY);
      showToast(`Showing ${pending.name || pending.email}`, 'success');
    } catch (error) {
      console.error('[Calendar Peek] Could not display the coworker calendar.', error);
      showToast(error instanceof Error ? error.message : 'Could not display the coworker calendar.', 'error');
    } finally {
      processing = false;
    }
  }

  function isUsablePendingRequest(pending) {
    return Boolean(
      pending &&
      typeof pending.email === 'string' &&
      pending.email.includes('@') &&
      typeof pending.expiresAt === 'number' &&
      pending.expiresAt > Date.now()
    );
  }

  async function findPeopleSearchInput() {
    const existing = locatePeopleSearchInput();
    if (existing) {
      return existing;
    }

    expandMainMenu();
    return waitFor(locatePeopleSearchInput, MAX_WAIT_MS);
  }

  function locatePeopleSearchInput() {
    const candidates = [...document.querySelectorAll('input, [contenteditable="true"][role="combobox"]')]
      .filter(globalThis.CalendarPeek.isVisible);

    const scored = candidates
      .map((element) => ({ element, score: scorePeopleSearchInput(element) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.length > 0 ? scored[0].element : null;
  }

  function scorePeopleSearchInput(element) {
    const text = [
      element.getAttribute('aria-label'),
      element.getAttribute('placeholder'),
      element.getAttribute('title'),
      element.getAttribute('data-placeholder'),
      element.parentElement && element.parentElement.textContent
    ]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase();

    let score = 0;
    if (PEOPLE_SEARCH_HINTS.some((hint) => text.includes(hint))) {
      score += 100;
    }

    if (element.getAttribute('role') === 'combobox' || element.getAttribute('aria-autocomplete') === 'list') {
      score += 10;
    }

    const rect = element.getBoundingClientRect();
    if (rect.left < Math.min(window.innerWidth * 0.45, 520)) {
      score += 8;
    }

    const topSearchTerms = ['search calendar', 'search in calendar', 'buscar en calendar', 'rechercher dans agenda'];
    if (topSearchTerms.some((term) => text.includes(term))) {
      score -= 100;
    }

    return score;
  }

  function expandMainMenu() {
    const buttons = [...document.querySelectorAll('button, [role="button"]')]
      .filter(globalThis.CalendarPeek.isVisible)
      .filter((button) => {
        const label = [
          button.getAttribute('aria-label'),
          button.getAttribute('title'),
          button.textContent
        ]
          .filter(Boolean)
          .join(' ')
          .toLocaleLowerCase();

        if (!MENU_HINTS.some((hint) => label.includes(hint))) {
          return false;
        }

        const rect = button.getBoundingClientRect();
        return rect.left < 160 && rect.top < 120;
      });

    if (buttons[0]) {
      buttons[0].click();
    }
  }

  function fillSearchInput(input, email) {
    input.focus();

    if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
      if (descriptor && typeof descriptor.set === 'function') {
        descriptor.set.call(input, email);
      } else {
        input.value = email;
      }
    } else {
      input.textContent = email;
    }

    try {
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertText',
        data: email
      }));
    } catch (error) {
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }

    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  async function selectMatchingPerson(searchInput, pending) {
    const exactMatch = await waitFor(() => locateMatchingOption(searchInput, pending), 8000);
    if (exactMatch) {
      exactMatch.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      exactMatch.click();
      return true;
    }

    // Searching by a full email normally makes the first result unambiguous.
    searchInput.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      code: 'ArrowDown',
      keyCode: 40,
      which: 40,
      bubbles: true,
      cancelable: true
    }));
    searchInput.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    }));

    return true;
  }

  function locateMatchingOption(searchInput, pending) {
    const email = pending.email.toLocaleLowerCase();
    const name = String(pending.name || '').toLocaleLowerCase();
    const selectors = [
      '[role="option"]',
      '[role="listbox"] [role="menuitem"]',
      '[data-email]',
      '[email]'
    ];

    const options = [...document.querySelectorAll(selectors.join(','))]
      .filter(globalThis.CalendarPeek.isVisible)
      .filter((element) => element !== searchInput && !element.contains(searchInput));

    const scored = options
      .map((element) => {
        const haystack = [
          element.textContent,
          element.getAttribute('aria-label'),
          element.getAttribute('title'),
          element.getAttribute('data-email'),
          element.getAttribute('email')
        ]
          .filter(Boolean)
          .join(' ')
          .toLocaleLowerCase();

        let score = 0;
        if (haystack.includes(email)) {
          score += 100;
        }
        if (name && haystack.includes(name)) {
          score += 25;
        }
        if (element.getAttribute('role') === 'option') {
          score += 5;
        }
        return { element, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.length > 0 ? scored[0].element : null;
  }

  async function waitFor(getValue, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const value = getValue();
      if (value) {
        return value;
      }
      await delay(POLL_MS);
    }
    return null;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function showToast(message, type) {
    document.querySelectorAll('.calendar-peek-toast').forEach((toast) => toast.remove());

    const toast = document.createElement('div');
    toast.className = `calendar-peek-toast calendar-peek-toast--${type}`;
    toast.setAttribute('role', 'status');
    toast.textContent = message;
    document.documentElement.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('calendar-peek-toast--visible'));
    setTimeout(() => {
      toast.classList.remove('calendar-peek-toast--visible');
      setTimeout(() => toast.remove(), 200);
    }, 3200);
  }
})();
