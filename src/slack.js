'use strict';

(() => {
  if (
    window.top !== window ||
    !globalThis.CalendarPeek ||
    !globalThis.CalendarPeekAvailability
  ) {
    return;
  }

  const utils = globalThis.CalendarPeekAvailability;
  const BUTTON_HOST_ATTRIBUTE = 'data-calendar-peek-slack-button';
  const BUTTON_NAME_ATTRIBUTE = 'data-calendar-peek-person-name';
  const POPOVER_HOST_ATTRIBUTE = 'data-calendar-peek-slack-popover';
  const RUNTIME_ATTRIBUTE = 'data-calendar-peek-slack-runtime';
  const POSITION_ATTRIBUTE = 'data-calendar-peek-slack-positioned';
  const CACHE_TTL_MS = 2 * 60 * 1000;
  const MIN_USEFUL_FREE_MS = 30 * utils.MINUTE_MS;

  if (document.documentElement.hasAttribute(RUNTIME_ATTRIBUTE)) {
    return;
  }
  document.documentElement.setAttribute(RUNTIME_ATTRIBUTE, '0.2.1');

  const PROFILE_SELECTORS = [
    '[data-qa="profile-card"]',
    '[data-qa="profile_card"]',
    '[data-qa="member-profile"]',
    '[data-qa="member_profile"]',
    '[data-qa="member_profile_card"]',
    '[data-qa*="profile-card"]',
    '[data-qa*="profile_card"]',
    '[data-qa*="member-profile"]',
    '[data-qa*="member_profile"]',
    '[role="dialog"]',
    '[aria-modal="true"]',
    'aside'
  ].join(',');

  const PROFILE_HINT_PATTERN = /\b(profile|member|person|user|contact|people|details)\b/i;
  const PROFILE_ACTION_PATTERN = /\b(message|call|huddle|more|actions|status|local time|timezone)\b/i;
  const GENERIC_NAME_PATTERN = /^(profile|member profile|contact information|details|about|more actions|message|call|huddle|close|calendar|availability)$/i;
  const availabilityCache = new Map();

  let scanTimer = null;
  let activePopover = null;

  const observer = new MutationObserver((mutations) => {
    if (mutations.some(isRelevantMutation)) {
      scheduleScan();
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-hidden', 'style', 'class', 'data-qa', 'data-theme', 'data-color-scheme', 'data-sk-theme']
  });

  document.addEventListener('click', handleDocumentClick, true);
  document.addEventListener('focusin', () => scheduleScan(100), true);
  window.addEventListener('hashchange', () => scheduleScan(100));
  window.addEventListener('popstate', () => scheduleScan(100));
  scheduleScan(300);

  function isRelevantMutation(mutation) {
    if (mutation.type === 'attributes') {
      const target = mutation.target;
      if (!(target instanceof Element)) {
        return true;
      }
      if (target.closest(`[${BUTTON_HOST_ATTRIBUTE}], [${POPOVER_HOST_ATTRIBUTE}]`)) {
        return false;
      }
      if (mutation.attributeName === 'style' && target.hasAttribute(POSITION_ATTRIBUTE)) {
        return false;
      }
      return true;
    }

    return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => {
      return !(node instanceof Element) || !node.matches(`[${BUTTON_HOST_ATTRIBUTE}], [${POPOVER_HOST_ATTRIBUTE}]`);
    });
  }

  function handleDocumentClick(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (path.some((node) => node instanceof Element && (
      node.hasAttribute(BUTTON_HOST_ATTRIBUTE) ||
      node.hasAttribute(POPOVER_HOST_ATTRIBUTE)
    ))) {
      return;
    }

    scheduleScan(180);
  }

  function scheduleScan(delayMs = 120) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanForProfileCards, delayMs);
  }

  function scanForProfileCards() {
    cleanupDuplicateAvailabilityButtons();
    const candidates = collectProfileCandidates();
    removeStaleAvailabilityButtons(candidates);
    let activeCardFound = false;

    for (const card of candidates) {
      const person = extractPerson(card);
      if (!person.email) {
        continue;
      }

      activeCardFound = true;
      const existing = [...card.querySelectorAll(`[${BUTTON_HOST_ATTRIBUTE}]`)]
        .find((button) => button.getAttribute(BUTTON_HOST_ATTRIBUTE) === person.email) || null;

      if (existing) {
        const existingEmail = existing.getAttribute(BUTTON_HOST_ATTRIBUTE) || '';
        const existingName = existing.getAttribute(BUTTON_NAME_ATTRIBUTE) || '';
        if (existingEmail === person.email && existingName === person.name) {
          existing.setAttribute('data-theme', detectSlackTheme(card));
          continue;
        }
        existing.remove();
      }

      attachAvailabilityButton(card, person);
    }

    cleanupDuplicateAvailabilityButtons();

    if (activePopover && activePopover.card.isConnected) {
      activePopover.host.setAttribute('data-theme', detectSlackTheme(activePopover.card));
    }

    if (
      activePopover &&
      (
        !activePopover.anchor.isConnected ||
        !activePopover.card.isConnected ||
        !isPlausibleProfileCard(activePopover.card) ||
        !activeCardFound
      )
    ) {
      activePopover.close();
    }
  }

  function cleanupDuplicateAvailabilityButtons() {
    const buttonsByEmail = new Map();

    for (const button of document.querySelectorAll(`[${BUTTON_HOST_ATTRIBUTE}]`)) {
      const email = button.getAttribute(BUTTON_HOST_ATTRIBUTE);
      if (!email) {
        continue;
      }

      const buttons = buttonsByEmail.get(email) || [];
      buttons.push(button);
      buttonsByEmail.set(email, buttons);
    }

    for (const buttons of buttonsByEmail.values()) {
      const keep = buttons.reduce((best, button) => {
        if (!best) {
          return button;
        }
        return getProfileCardArea(button.parentElement) > getProfileCardArea(best.parentElement)
          ? button
          : best;
      }, null);

      for (const button of buttons) {
        if (button !== keep) {
          button.remove();
        }
      }
    }
  }

  function removeStaleAvailabilityButtons(candidates) {
    for (const button of document.querySelectorAll(`[${BUTTON_HOST_ATTRIBUTE}]`)) {
      const email = button.getAttribute(BUTTON_HOST_ATTRIBUTE);
      const belongsToCurrentCard = candidates.some((card) => {
        return card.contains(button) && extractEmail(card) === email;
      });

      if (!belongsToCurrentCard) {
        button.remove();
      }
    }
  }

  function collectProfileCandidates() {
    const candidates = new Set();

    for (const element of document.querySelectorAll(PROFILE_SELECTORS)) {
      if (isPlausibleProfileCard(element)) {
        candidates.add(element);
      }
    }

    const emailSignals = document.querySelectorAll(
      'a[href^="mailto:"], [data-email], [data-user-email], [data-member-email], [data-clipboard-text*="@"]'
    );

    for (const signal of [...emailSignals].slice(0, 300)) {
      if (!globalThis.CalendarPeek.isVisible(signal)) {
        continue;
      }
      const ancestor = findProfileAncestor(signal);
      if (ancestor) {
        candidates.add(ancestor);
      }
    }

    const bestByEmail = new Map();
    for (const card of candidates) {
      const email = extractEmail(card);
      if (!email) {
        continue;
      }

      const current = bestByEmail.get(email);
      if (!current || getProfileCardArea(card) > getProfileCardArea(current)) {
        bestByEmail.set(email, card);
      }
    }

    return [...bestByEmail.values()];
  }

  function getProfileCardArea(card) {
    const rect = card.getBoundingClientRect();
    return rect.width * rect.height;
  }

  function findProfileAncestor(start) {
    let current = start;
    for (let depth = 0; current && depth < 14; depth += 1, current = current.parentElement) {
      if (isPlausibleProfileCard(current)) {
        return current;
      }
    }
    return null;
  }

  function isPlausibleProfileCard(element) {
    if (!(element instanceof HTMLElement) || !globalThis.CalendarPeek.isVisible(element)) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (
      rect.width < 230 ||
      rect.height < 100 ||
      rect.width > Math.min(980, window.innerWidth) ||
      rect.height > Math.max(1100, window.innerHeight * 1.4)
    ) {
      return false;
    }

    if (!extractEmail(element)) {
      return false;
    }

    const signalText = getProfileSignalText(element);
    const role = element.getAttribute('role');
    const hasProfileHint = PROFILE_HINT_PATTERN.test(signalText);
    const hasProfileAction = PROFILE_ACTION_PATTERN.test(signalText);
    const hasAvatar = Boolean(element.querySelector('img, [data-qa*="avatar"], [class*="avatar"]'));
    const isDialog = role === 'dialog' || element.getAttribute('aria-modal') === 'true';
    const isRightPanel = rect.width <= 620 && rect.right >= window.innerWidth * 0.82 && rect.height >= 220;

    return hasProfileHint || isRightPanel || (isDialog && hasAvatar && hasProfileAction);
  }

  function getProfileSignalText(element) {
    const values = [
      element.getAttribute('data-qa'),
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.id,
      typeof element.className === 'string' ? element.className : ''
    ];

    for (const descendant of [...element.querySelectorAll('[data-qa], [aria-label], [title]')].slice(0, 160)) {
      values.push(
        descendant.getAttribute('data-qa'),
        descendant.getAttribute('aria-label'),
        descendant.getAttribute('title')
      );
    }

    return values.filter(Boolean).join(' ');
  }

  function extractPerson(card) {
    const email = extractEmail(card);
    if (!email) {
      return { email: '', name: '', avatarUrl: '' };
    }

    const avatarUrl = extractAvatarUrl(card);

    const nameSelectors = [
      '[data-qa="member_profile_name"]',
      '[data-qa="profile_name"]',
      '[data-qa*="member-profile-name"]',
      '[data-qa*="member_profile_name"]',
      '[data-qa*="profile-name"]',
      '[data-qa*="profile_name"]',
      '[class*="member_profile__name__text"]',
      '[role="heading"]',
      'h1',
      'h2',
      'h3'
    ];

    for (const selector of nameSelectors) {
      for (const element of card.querySelectorAll(selector)) {
        const values = [
          element.textContent,
          element.getAttribute('aria-label'),
          element.getAttribute('title'),
          element.getAttribute('alt')
        ];
        const name = values
          .map(globalThis.CalendarPeek.normalizeWhitespace)
          .find((value) => isPlausibleName(value, email));
        if (name) {
          return { email, name, avatarUrl };
        }
      }
    }

    const lines = String(card.innerText || card.textContent || '')
      .split(/\n+/)
      .map(globalThis.CalendarPeek.normalizeWhitespace)
      .filter((line) => isPlausibleName(line, email));

    return { email, name: lines[0] || '', avatarUrl };
  }

  function isPlausibleName(value, email) {
    if (!value || value.length < 2 || value.length > 120) {
      return false;
    }
    if (value.toLocaleLowerCase().includes(email) || value.includes('@')) {
      return false;
    }
    if (GENERIC_NAME_PATTERN.test(value)) {
      return false;
    }
    if (/^(profile|user|member)\s+(photo|avatar)\b/i.test(value)) {
      return false;
    }
    if (/^(online|away|active|inactive|local time|timezone|email|phone|title)\b/i.test(value)) {
      return false;
    }
    return true;
  }

  function extractEmail(card) {
    const mailLink = card.querySelector('a[href^="mailto:"]');
    if (mailLink) {
      const email = globalThis.CalendarPeek.normalizeEmail(mailLink.getAttribute('href'));
      if (email) {
        return email;
      }
    }

    const selectors = [
      '[data-email]',
      '[data-user-email]',
      '[data-member-email]',
      '[data-clipboard-text]',
      '[email]',
      '[aria-label]',
      '[title]',
      '[href]',
      '[value]'
    ].join(',');

    for (const element of [...card.querySelectorAll(selectors)].slice(0, 320)) {
      if (element.closest(`[${POPOVER_HOST_ATTRIBUTE}]`)) {
        continue;
      }

      const values = [
        element.getAttribute('data-email'),
        element.getAttribute('data-user-email'),
        element.getAttribute('data-member-email'),
        element.getAttribute('data-clipboard-text'),
        element.getAttribute('email'),
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.getAttribute('href'),
        element.getAttribute('value')
      ];

      for (const value of values) {
        const emails = globalThis.CalendarPeek.extractEmails(value || '');
        if (emails[0]) {
          return emails[0];
        }
      }
    }

    const text = String(card.innerText || card.textContent || '').slice(0, 50000);
    return globalThis.CalendarPeek.extractEmails(text)[0] || '';
  }

  function extractAvatarUrl(card) {
    const images = [...card.querySelectorAll('img')]
      .filter((image) => globalThis.CalendarPeek.isVisible(image))
      .sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        return (rightRect.width * rightRect.height) - (leftRect.width * leftRect.height);
      });

    for (const image of images) {
      const candidates = [
        image.currentSrc,
        image.src,
        image.getAttribute('src'),
        image.getAttribute('data-src'),
        image.getAttribute('data-original'),
        image.getAttribute('data-lazy-src')
      ];
      const url = candidates.map(normalizeImageUrl).find(Boolean);
      if (url) {
        return url;
      }
    }

    return '';
  }

  function normalizeImageUrl(value) {
    if (typeof value !== 'string' || !value.trim()) {
      return '';
    }

    try {
      const parsed = new URL(value.trim(), location.href);
      if (['http:', 'https:', 'blob:'].includes(parsed.protocol)) {
        return parsed.href;
      }
      if (parsed.protocol === 'data:' && /^data:image\//i.test(value.trim())) {
        return value.trim();
      }
    } catch {
      return '';
    }

    return '';
  }

  function detectSlackTheme(card) {
    const explicitTheme = [...getThemeElements(card)]
      .map((element) => [
        element.getAttribute('data-theme'),
        element.getAttribute('data-color-scheme'),
        element.getAttribute('data-sk-theme'),
        typeof element.className === 'string' ? element.className : ''
      ].filter(Boolean).join(' '))
      .find((value) => /\b(?:dark|night|midnight)\b|dark[_-]?theme|theme[_-]?dark/i.test(value));

    if (explicitTheme) {
      return 'dark';
    }

    const explicitLightTheme = [...getThemeElements(card)]
      .map((element) => [
        element.getAttribute('data-theme'),
        element.getAttribute('data-color-scheme'),
        element.getAttribute('data-sk-theme'),
        typeof element.className === 'string' ? element.className : ''
      ].filter(Boolean).join(' '))
      .find((value) => /\b(?:light|day)\b|light[_-]?theme|theme[_-]?light/i.test(value));

    if (explicitLightTheme) {
      return 'light';
    }

    for (const element of getThemeElements(card)) {
      const color = parseCssColor(getComputedStyle(element).backgroundColor);
      if (color && color.alpha > 0.85) {
        return getRelativeLuminance(color) < 0.42 ? 'dark' : 'light';
      }
    }

    return globalThis.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  function getThemeElements(card) {
    const elements = [];
    for (let current = card; current && elements.length < 8; current = current.parentElement) {
      elements.push(current);
    }
    elements.push(document.body, document.documentElement);
    return [...new Set(elements.filter(Boolean))];
  }

  function parseCssColor(value) {
    const match = String(value || '').match(/^rgba?\(([^)]+)\)$/i);
    if (!match) {
      return null;
    }

    const parts = match[1].split(',').map((part) => Number.parseFloat(part.trim()));
    if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) {
      return null;
    }

    return {
      red: Math.max(0, Math.min(255, parts[0])),
      green: Math.max(0, Math.min(255, parts[1])),
      blue: Math.max(0, Math.min(255, parts[2])),
      alpha: Number.isFinite(parts[3]) ? Math.max(0, Math.min(1, parts[3])) : 1
    };
  }

  function getRelativeLuminance(color) {
    const channels = [color.red, color.green, color.blue].map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.03928
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  function attachAvailabilityButton(card, person) {
    const host = createAvailabilityButton(person, card);
    const currentPosition = getComputedStyle(card).position;
    if (currentPosition === 'static') {
      card.style.setProperty('position', 'relative', 'important');
      card.setAttribute(POSITION_ATTRIBUTE, 'true');
    }

    host.style.setProperty('position', 'absolute', 'important');
    host.style.setProperty('top', '12px', 'important');
    host.style.setProperty('right', '52px', 'important');
    card.appendChild(host);
  }

  function createAvailabilityButton(person, card) {
    const host = document.createElement('span');
    host.setAttribute(BUTTON_HOST_ATTRIBUTE, person.email);
    host.setAttribute(BUTTON_NAME_ATTRIBUTE, person.name);
    host.setAttribute('data-theme', detectSlackTheme(card));
    host.style.setProperty('display', 'block', 'important');
    host.style.setProperty('height', '34px', 'important');
    host.style.setProperty('width', '34px', 'important');
    host.style.setProperty('z-index', '2147483646', 'important');

    const shadow = host.attachShadow({ mode: 'open' });
    const label = person.name
      ? `View ${person.name}’s availability`
      : `View ${person.email} availability`;

    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          --cp-button-surface: #ffffff;
          --cp-button-border: #c7c9cc;
          --cp-button-hover: #f8f8f8;
          --cp-button-icon: #1264a3;
          --cp-button-focus: #1264a3;
        }
        :host([data-theme="dark"]) {
          --cp-button-surface: #2f3136;
          --cp-button-border: #565856;
          --cp-button-hover: #3f4147;
          --cp-button-icon: #36c5f0;
          --cp-button-focus: #36c5f0;
        }
        button {
          align-items: center;
          background: var(--cp-button-surface);
          border: 1px solid var(--cp-button-border);
          border-radius: 8px;
          box-shadow: 0 1px 3px rgba(29, 28, 29, 0.18);
          box-sizing: border-box;
          color: var(--cp-button-icon);
          cursor: pointer;
          display: inline-flex;
          height: 34px;
          justify-content: center;
          margin: 0;
          padding: 0;
          width: 34px;
        }
        button:hover { background: var(--cp-button-hover); border-color: var(--cp-button-icon); }
        button:focus-visible { outline: 2px solid var(--cp-button-focus); outline-offset: 2px; }
        button:active { transform: translateY(1px); }
        svg { display: block; height: 19px; width: 19px; }
      </style>
      <button type="button" aria-label="${escapeAttribute(label)}" title="${escapeAttribute(label)}">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path fill="currentColor" d="M7 2a1 1 0 0 1 1 1v1h8V3a1 1 0 1 1 2 0v1h1a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h1V3a1 1 0 0 1 1-1Zm12 8H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1Zm-2.3 2.8a1 1 0 0 1 0 1.4l-4 4a1 1 0 0 1-1.4 0l-2-2a1 1 0 1 1 1.4-1.4l1.3 1.3 3.3-3.3a1 1 0 0 1 1.4 0Z"/>
        </svg>
      </button>`;

    const button = shadow.querySelector('button');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showAvailabilityPopover(person, host, card);
    });

    return host;
  }

  function showAvailabilityPopover(person, anchor, card) {
    if (activePopover) {
      activePopover.close();
    }

    const host = document.createElement('div');
    host.setAttribute(POPOVER_HOST_ATTRIBUTE, 'true');
    host.setAttribute('data-theme', detectSlackTheme(card));
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('z-index', '2147483647', 'important');
    host.style.setProperty('width', '380px', 'important');
    host.style.setProperty('max-width', 'calc(100vw - 24px)', 'important');

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = createPopoverMarkup();
    document.documentElement.appendChild(host);

    const state = {
      anchor,
      card,
      close: null,
      dateKey: utils.toDateKey(new Date()),
      host,
      manualPosition: null,
      person,
      requestSerial: 0,
      reposition: null,
      shadow
    };

    const close = () => {
      if (activePopover !== state) {
        host.remove();
        return;
      }
      document.removeEventListener('pointerdown', handleOutsidePointerDown, true);
      document.removeEventListener('keydown', handleEscape, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      host.remove();
      activePopover = null;
    };

    function handleOutsidePointerDown(event) {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      if (path.includes(host) || path.includes(anchor)) {
        return;
      }
      close();
    }

    function handleEscape(event) {
      if (event.key === 'Escape') {
        close();
      }
    }

    function reposition() {
      if (state.manualPosition) {
        state.manualPosition = positionPopoverAt(
          host,
          state.manualPosition.left,
          state.manualPosition.top
        );
        return;
      }
      positionPopover(host, anchor, card);
    }

    state.close = close;
    state.reposition = reposition;
    activePopover = state;

    const nameElement = shadow.querySelector('[data-role="person-name"]');
    const emailElement = shadow.querySelector('[data-role="person-email"]');
    const avatarElement = shadow.querySelector('[data-role="person-avatar"]');
    const dragHandle = shadow.querySelector('[data-role="drag-handle"]');
    let dragState = null;
    nameElement.textContent = person.name || person.email;
    emailElement.textContent = person.email;
    renderAvatar(avatarElement, person);

    function beginDrag(event) {
      if (event.button !== 0 || (event.target instanceof Element && event.target.closest('button'))) {
        return;
      }

      const rect = host.getBoundingClientRect();
      dragState = {
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        pointerId: event.pointerId
      };
      dragHandle.classList.add('is-dragging');
      if (event.isTrusted) {
        dragHandle.setPointerCapture?.(event.pointerId);
      }
      event.preventDefault();
    }

    function moveDrag(event) {
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }

      state.manualPosition = positionPopoverAt(
        host,
        event.clientX - dragState.offsetX,
        event.clientY - dragState.offsetY
      );
      event.preventDefault();
    }

    function endDrag(event) {
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }

      if (event.isTrusted) {
        dragHandle.releasePointerCapture?.(event.pointerId);
      }
      dragHandle.classList.remove('is-dragging');
      dragState = null;
    }

    function nudgePopover(event) {
      const deltas = {
        ArrowDown: { x: 0, y: 24 },
        ArrowLeft: { x: -24, y: 0 },
        ArrowRight: { x: 24, y: 0 },
        ArrowUp: { x: 0, y: -24 }
      };
      const delta = deltas[event.key];
      if (!delta) {
        return;
      }

      const rect = host.getBoundingClientRect();
      const current = state.manualPosition || { left: rect.left, top: rect.top };
      state.manualPosition = positionPopoverAt(
        host,
        current.left + delta.x,
        current.top + delta.y
      );
      event.preventDefault();
    }

    dragHandle.addEventListener('pointerdown', beginDrag);
    dragHandle.addEventListener('pointermove', moveDrag);
    dragHandle.addEventListener('pointerup', endDrag);
    dragHandle.addEventListener('pointercancel', endDrag);
    dragHandle.addEventListener('keydown', nudgePopover);

    shadow.querySelector('[data-action="close"]').addEventListener('click', close);
    shadow.querySelector('[data-action="previous-day"]').addEventListener('click', () => {
      state.dateKey = utils.shiftDateKey(state.dateKey, -1);
      void loadAvailability(state, false);
    });
    shadow.querySelector('[data-action="next-day"]').addEventListener('click', () => {
      state.dateKey = utils.shiftDateKey(state.dateKey, 1);
      void loadAvailability(state, false);
    });
    shadow.querySelector('[data-action="today"]').addEventListener('click', () => {
      state.dateKey = utils.toDateKey(new Date());
      void loadAvailability(state, false);
    });
    shadow.querySelector('[data-action="open-calendar"]').addEventListener('click', async () => {
      try {
        await globalThis.CalendarPeek.openPersonCalendar(person);
      } catch (error) {
        renderErrorState(state, error instanceof Error ? error.message : 'Could not open Google Calendar.');
      }
    });

    document.addEventListener('pointerdown', handleOutsidePointerDown, true);
    document.addEventListener('keydown', handleEscape, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);

    requestAnimationFrame(() => {
      reposition();
      const closeButton = shadow.querySelector('[data-action="close"]');
      if (closeButton) {
        closeButton.focus({ preventScroll: true });
      }
    });

    void loadAvailability(state, false);
  }

  function renderAvatar(container, person) {
    container.replaceChildren();
    container.classList.remove('avatar--fallback');

    if (person.avatarUrl) {
      const image = document.createElement('img');
      image.alt = '';
      image.decoding = 'async';
      image.src = person.avatarUrl;
      image.addEventListener('error', () => {
        container.replaceChildren();
        container.classList.add('avatar--fallback');
        container.textContent = getInitials(person.name || person.email);
      }, { once: true });
      container.appendChild(image);
      return;
    }

    container.classList.add('avatar--fallback');
    container.textContent = getInitials(person.name || person.email);
  }

  async function loadAvailability(state, interactive) {
    if (activePopover !== state) {
      return;
    }

    const requestSerial = ++state.requestSerial;
    updateDateLabel(state);
    renderLoadingState(state, interactive ? 'Connecting Google Calendar…' : 'Checking availability…');

    const range = utils.createLocalDayRange(state.dateKey);
    const cacheKey = `${state.person.email}|${state.dateKey}|${range.timeZone}`;
    const cached = availabilityCache.get(cacheKey);

    if (!interactive && cached && Date.now() - cached.storedAt < CACHE_TTL_MS) {
      renderTimeline(state, cached.response);
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'CALENDAR_PEEK_FREEBUSY',
        person: state.person,
        timeMin: range.timeMin,
        timeMax: range.timeMax,
        timeZone: range.timeZone,
        interactive
      });

      if (activePopover !== state || requestSerial !== state.requestSerial) {
        return;
      }

      if (!response || response.ok !== true) {
        renderResponseError(state, response || {});
        return;
      }

      availabilityCache.set(cacheKey, { response, storedAt: Date.now() });
      renderTimeline(state, response);
    } catch (error) {
      if (activePopover !== state || requestSerial !== state.requestSerial) {
        return;
      }
      renderErrorState(
        state,
        error instanceof Error ? error.message : 'Calendar Peek could not reach the extension service worker.'
      );
    }
  }

  function renderResponseError(state, response) {
    const code = response.code || 'unexpected_error';
    const message = response.error || 'Could not check availability.';

    if (code === 'oauth_not_configured') {
      renderSetupState(state, message);
      return;
    }

    if (code === 'auth_required' || code === 'auth_cancelled' || code === 'auth_failed' || code === 'auth_timeout') {
      renderConnectState(state, message);
      return;
    }

    renderErrorState(state, message);
  }

  function renderLoadingState(state, message) {
    const container = state.shadow.querySelector('[data-role="content"]');
    container.replaceChildren();

    const loading = document.createElement('div');
    loading.className = 'state-card state-card--loading';
    loading.innerHTML = `
      <span class="spinner" aria-hidden="true"></span>
      <div>
        <strong>${escapeHtml(message)}</strong>
        <span>Event names and availability time ranges are requested.</span>
      </div>`;
    container.appendChild(loading);
  }

  function renderConnectState(state, message) {
    const container = state.shadow.querySelector('[data-role="content"]');
    container.replaceChildren();

    const card = document.createElement('div');
    card.className = 'state-card';
    card.innerHTML = `
      <div class="state-icon" aria-hidden="true">G</div>
      <div class="state-copy">
        <strong>Connect Google Calendar</strong>
        <span>${escapeHtml(message)}</span>
        <small>Calendar Peek asks for read-only access to event names, times, and availability on calendars you can already access.</small>
      </div>
      <button class="primary-button" type="button">Connect</button>`;

    card.querySelector('button').addEventListener('click', () => {
      void loadAvailability(state, true);
    });
    container.appendChild(card);
  }

  function renderSetupState(state, message) {
    const container = state.shadow.querySelector('[data-role="content"]');
    container.replaceChildren();

    const card = document.createElement('div');
    card.className = 'state-card';
    card.innerHTML = `
      <div class="state-icon state-icon--setup" aria-hidden="true">⚙</div>
      <div class="state-copy">
        <strong>One-time OAuth setup</strong>
        <span>${escapeHtml(message)}</span>
        <small>The extension includes a guided setup page and keeps a stable extension ID.</small>
      </div>
      <button class="primary-button" type="button">Open setup</button>`;

    card.querySelector('button').addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'CALENDAR_PEEK_OPEN_OPTIONS' });
    });
    container.appendChild(card);
  }

  function renderErrorState(state, message) {
    const container = state.shadow.querySelector('[data-role="content"]');
    container.replaceChildren();

    const card = document.createElement('div');
    card.className = 'state-card state-card--error';
    card.innerHTML = `
      <div class="state-icon state-icon--error" aria-hidden="true">!</div>
      <div class="state-copy">
        <strong>Availability unavailable</strong>
        <span>${escapeHtml(message)}</span>
      </div>
      <button class="secondary-button" type="button">Retry</button>`;

    card.querySelector('button').addEventListener('click', () => {
      void loadAvailability(state, false);
    });
    container.appendChild(card);
  }

  function renderTimeline(state, response) {
    const container = state.shadow.querySelector('[data-role="content"]');
    container.replaceChildren();

    const dayRange = utils.createLocalDayRange(state.dateKey);
    const displayBounds = calculateDisplayBounds(state.dateKey, response.busy || []);
    const displayStart = utils.localDateAtMinutes(state.dateKey, displayBounds.startMinute);
    const displayEnd = utils.localDateAtMinutes(state.dateKey, displayBounds.endMinute);
    const displayStartMs = displayStart.getTime();
    const displayEndMs = displayEnd.getTime();
    const mergedBusy = utils.mergeBusyRanges(response.busy || [], displayStartMs, displayEndMs);
    const displayEvents = normalizeEventRanges(response.events || [], displayStartMs, displayEndMs);
    const freeRanges = utils.computeFreeRanges(mergedBusy, displayStartMs, displayEndMs);
    const hourHeight = 54;
    const durationHours = Math.max(1, (displayEndMs - displayStartMs) / (60 * utils.MINUTE_MS));
    const timelineHeight = Math.max(220, Math.round(durationHours * hourHeight));

    const summary = document.createElement('div');
    summary.className = 'availability-summary';
    summary.innerHTML = `
      <div>
        <strong data-role="summary-headline"></strong>
        <span data-role="summary-detail"></span>
      </div>
      <div class="legend" aria-label="Calendar legend">
        <span><i class="legend-free"></i>Free</span>
        <span><i class="legend-busy"></i>Busy</span>
      </div>`;

    const summaryText = describeAvailability(
      state.dateKey,
      mergedBusy,
      freeRanges,
      displayStartMs,
      displayEndMs
    );
    summary.querySelector('[data-role="summary-headline"]').textContent = summaryText.headline;
    summary.querySelector('[data-role="summary-detail"]').textContent = summaryText.detail;

    const scroll = document.createElement('div');
    scroll.className = 'timeline-scroll';
    const timeline = document.createElement('div');
    timeline.className = 'timeline';
    timeline.style.height = `${timelineHeight}px`;
    timeline.setAttribute('aria-label', `${state.person.name || state.person.email} availability for ${utils.formatDateLabel(state.dateKey)}`);

    const totalMs = displayEndMs - displayStartMs;
    const hours = Math.ceil(durationHours);
    for (let index = 0; index <= hours; index += 1) {
      const timeMs = displayStartMs + index * 60 * utils.MINUTE_MS;
      if (timeMs > displayEndMs + 1000) {
        break;
      }

      const top = ((timeMs - displayStartMs) / totalMs) * timelineHeight;
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${top}px`;

      const label = document.createElement('span');
      label.className = 'hour-label';
      label.textContent = utils.formatClock(timeMs);
      line.appendChild(label);
      timeline.appendChild(line);
    }

    for (const event of displayEvents) {
      renderTimelineBlock(
        timeline,
        event,
        displayStartMs,
        totalMs,
        timelineHeight,
        event.isBusy ? 'Busy' : 'Free'
      );
    }

    for (const range of mergedBusy) {
      const hasNamedEvent = displayEvents.some((event) => {
        return event.isBusy && event.startMs < range.endMs && event.endMs > range.startMs;
      });
      if (!hasNamedEvent) {
        renderTimelineBlock(
          timeline,
          range,
          displayStartMs,
          totalMs,
          timelineHeight,
          'Busy',
          'Busy'
        );
      }
    }

    const todayKey = utils.toDateKey(new Date());
    const now = Date.now();
    if (state.dateKey === todayKey && now >= displayStartMs && now <= displayEndMs) {
      const top = ((now - displayStartMs) / totalMs) * timelineHeight;
      const nowLine = document.createElement('div');
      nowLine.className = 'now-line';
      nowLine.style.top = `${top}px`;
      nowLine.innerHTML = '<span>Now</span>';
      timeline.appendChild(nowLine);
    }

    if (mergedBusy.length === 0 && displayEvents.every((event) => !event.isBusy)) {
      const empty = document.createElement('div');
      empty.className = 'all-free';
      empty.textContent = `No busy blocks between ${utils.formatClock(displayStartMs)} and ${utils.formatClock(displayEndMs)}.`;
      timeline.appendChild(empty);
    }

    scroll.appendChild(timeline);

    const content = [summary];
    if (response.eventDetailsAvailable === false) {
      const notice = document.createElement('div');
      notice.className = 'event-notice';
      notice.textContent = response.eventDetailsMessage || 'Event names are unavailable. Free/busy is still shown.';
      content.push(notice);
    }
    content.push(
      scroll,
      createRangeList(state, mergedBusy, freeRanges, displayEvents)
    );
    container.append(...content);

    const targetScroll = calculateInitialScroll(
      state.dateKey,
      displayStartMs,
      displayEndMs,
      timelineHeight,
      mergedBusy
    );
    requestAnimationFrame(() => {
      scroll.scrollTop = targetScroll;
      state.reposition?.();
    });

    const footerNote = state.shadow.querySelector('[data-role="footer-note"]');
    footerNote.textContent = `${response.timeZone || dayRange.timeZone} · Event names + free/busy`;
  }

  function renderTimelineBlock(timeline, range, displayStartMs, totalMs, timelineHeight, state, fallbackTitle) {
    const top = ((range.startMs - displayStartMs) / totalMs) * timelineHeight;
    const height = Math.max(8, ((range.endMs - range.startMs) / totalMs) * timelineHeight);
    const title = range.title || fallbackTitle || state;
    const block = document.createElement('div');
    const isCompact = height < 38;
    block.className = `busy-block event-block${state === 'Free' ? ' event-block--free' : ''}${isCompact ? ' event-block--compact' : ''}`;
    block.style.top = `${top}px`;
    block.style.height = `${height}px`;
    const timeLabel = `${utils.formatClock(range.startMs)}–${utils.formatClock(range.endMs)}`;
    block.setAttribute('aria-label', `${state} ${title} ${timeLabel}`);
    block.title = `${title} ${timeLabel}`;

    const strong = document.createElement('strong');
    strong.textContent = title;
    block.appendChild(strong);

    if (!isCompact) {
      const span = document.createElement('span');
      span.textContent = timeLabel;
      block.appendChild(span);
    }
    timeline.appendChild(block);
  }

  function createRangeList(state, busy, free, events) {
    const personLabel = state.person.name || state.person.email;
    const section = document.createElement('section');
    section.className = 'range-section';
    section.setAttribute('aria-label', `${personLabel} time ranges`);

    const heading = document.createElement('h3');
    heading.className = 'range-heading';
    heading.textContent = `${personLabel} - ${utils.formatDateLabel(state.dateKey)}`;

    const list = document.createElement('div');
    list.className = 'range-list';
    list.setAttribute('role', 'list');

    const namedBusy = events.filter((event) => event.isBusy);
    const ranges = [
      ...events.map((event) => ({ ...event, state: event.isBusy ? 'Busy' : 'Free' })),
      ...busy
        .filter((range) => !namedBusy.some((event) => event.startMs < range.endMs && event.endMs > range.startMs))
        .map((range) => ({ ...range, state: 'Busy', title: 'Busy' })),
      ...free.map((range) => ({ ...range, state: 'Free', title: 'Free time' }))
    ].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);

    for (const range of ranges) {
      const timeLabel = `${utils.formatClock(range.startMs)}–${utils.formatClock(range.endMs)}`;
      const item = document.createElement('div');
      item.className = `range-item range-item--${range.state.toLowerCase()}`;
      item.setAttribute('data-role', 'time-range');
      item.setAttribute('role', 'listitem');
      item.setAttribute('aria-label', `${personLabel}: ${range.state} ${range.title || range.state} ${timeLabel}`);

      const status = document.createElement('span');
      status.className = 'range-status';
      status.textContent = range.state;

      const details = document.createElement('span');
      details.className = 'range-details';

      const title = document.createElement('strong');
      title.className = 'range-title';
      title.textContent = range.title || range.state;

      const name = document.createElement('span');
      name.className = 'range-person';
      name.textContent = personLabel;
      details.append(title, name);

      const time = document.createElement('time');
      time.className = 'range-time';
      time.textContent = timeLabel;

      item.append(status, details, time);
      list.appendChild(item);
    }

    const disclosure = document.createElement('details');
    disclosure.className = 'range-disclosure';

    const summary = document.createElement('summary');
    summary.className = 'range-disclosure-summary';
    summary.innerHTML = `
      <span>
        <strong data-role="range-disclosure-label">Show all time ranges</strong>
        <small>${ranges.length} ranges</small>
      </span>`;
    disclosure.addEventListener('toggle', () => {
      summary.querySelector('[data-role="range-disclosure-label"]').textContent = disclosure.open
        ? 'Hide all time ranges'
        : 'Show all time ranges';
      requestAnimationFrame(() => state.reposition?.());
    });

    section.append(heading, list);
    disclosure.append(summary, section);
    return disclosure;
  }

  function normalizeEventRanges(events, displayStartMs, displayEndMs) {
    return (Array.isArray(events) ? events : [])
      .map((event) => {
        const startMs = Math.max(displayStartMs, Date.parse(event && event.start));
        const endMs = Math.min(displayEndMs, Date.parse(event && event.end));
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
          return null;
        }

        return {
          startMs,
          endMs,
          title: typeof event.title === 'string' && event.title.trim() ? event.title.trim() : 'Private event',
          isBusy: event.isBusy !== false,
          allDay: event.allDay === true
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  }

  function calculateDisplayBounds(dateKey, busy) {
    let startMinute = 8 * 60;
    let endMinute = 18 * 60;

    for (const range of Array.isArray(busy) ? busy : []) {
      const start = new Date(range.start);
      const end = new Date(range.end);
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
        continue;
      }

      const startKey = utils.toDateKey(start);
      const endKey = utils.toDateKey(new Date(end.getTime() - 1));
      const startValue = startKey === dateKey ? start.getHours() * 60 + start.getMinutes() : 0;
      const endValue = endKey === dateKey ? end.getHours() * 60 + end.getMinutes() : 24 * 60;
      startMinute = Math.min(startMinute, Math.max(0, Math.floor((startValue - 30) / 60) * 60));
      endMinute = Math.max(endMinute, Math.min(24 * 60, Math.ceil((endValue + 30) / 60) * 60));
    }

    if (endMinute <= startMinute) {
      return { startMinute: 8 * 60, endMinute: 18 * 60 };
    }

    return { startMinute, endMinute };
  }

  function describeAvailability(dateKey, busy, free, displayStartMs, displayEndMs) {
    const todayKey = utils.toDateKey(new Date());
    const now = Date.now();

    if (dateKey === todayKey && now >= displayStartMs && now <= displayEndMs) {
      const currentBusy = busy.find((range) => range.startMs <= now && range.endMs > now);
      if (currentBusy) {
        const nextFree = free.find((range) => range.startMs >= currentBusy.endMs && range.endMs - range.startMs >= MIN_USEFUL_FREE_MS);
        return {
          headline: `Busy until ${utils.formatClock(currentBusy.endMs)}`,
          detail: nextFree
            ? `Next 30+ minute free window: ${utils.formatClock(nextFree.startMs)}–${utils.formatClock(nextFree.endMs)}`
            : 'No 30-minute free window remains in the displayed day.'
        };
      }

      const currentFree = free.find((range) => range.startMs <= now && range.endMs > now);
      if (currentFree) {
        return {
          headline: 'Free now',
          detail: currentFree.endMs >= displayEndMs
            ? `Free through ${utils.formatClock(displayEndMs)}`
            : `Free until ${utils.formatClock(currentFree.endMs)}`
        };
      }
    }

    const totalFreeMinutes = free.reduce(
      (total, range) => total + utils.minutesBetween(range.startMs, range.endMs),
      0
    );
    const usefulWindow = free.find((range) => range.endMs - range.startMs >= MIN_USEFUL_FREE_MS);

    return {
      headline: busy.length === 0 ? 'Open workday' : `${busy.length} busy block${busy.length === 1 ? '' : 's'}`,
      detail: usefulWindow
        ? `${formatDuration(totalFreeMinutes)} free · first 30+ minute window ${utils.formatClock(usefulWindow.startMs)}–${utils.formatClock(usefulWindow.endMs)}`
        : `${formatDuration(totalFreeMinutes)} free in the displayed day`
    };
  }

  function calculateInitialScroll(dateKey, displayStartMs, displayEndMs, timelineHeight, busy) {
    const viewportHeight = 320;
    const todayKey = utils.toDateKey(new Date());
    let targetMs = displayStartMs;

    if (dateKey === todayKey && Date.now() >= displayStartMs && Date.now() <= displayEndMs) {
      targetMs = Date.now();
    } else if (busy.length > 0) {
      targetMs = busy[0].startMs;
    }

    const top = ((targetMs - displayStartMs) / (displayEndMs - displayStartMs)) * timelineHeight;
    return utils.clamp(top - viewportHeight * 0.35, 0, Math.max(0, timelineHeight - viewportHeight));
  }

  function updateDateLabel(state) {
    const label = state.shadow.querySelector('[data-role="date-label"]');
    const todayKey = utils.toDateKey(new Date());
    const prefix = state.dateKey === todayKey ? 'Today · ' : '';
    label.textContent = `${prefix}${utils.formatDateLabel(state.dateKey)}`;
  }

  function positionPopover(host, anchor, card) {
    if (!host.isConnected || !anchor.isConnected) {
      return;
    }

    const anchorRect = anchor.getBoundingClientRect();
    const cardRect = card && card.isConnected ? card.getBoundingClientRect() : anchorRect;
    const { panelWidth, panelHeight } = getPopoverDimensions(host);
    const margin = 12;

    let left = cardRect.left - panelWidth - 10;
    if (left < margin) {
      left = anchorRect.right + 10;
    }
    if (left + panelWidth > window.innerWidth - margin) {
      left = window.innerWidth - panelWidth - margin;
    }

    let top = Math.max(margin, Math.min(anchorRect.top - 12, window.innerHeight - panelHeight - margin));
    if (!Number.isFinite(top)) {
      top = margin;
    }

    positionPopoverAt(host, left, top);
  }

  function positionPopoverAt(host, left, top) {
    const { panelWidth, panelHeight } = getPopoverDimensions(host);
    const margin = 12;
    const maxLeft = Math.max(margin, window.innerWidth - panelWidth - margin);
    const maxTop = Math.max(margin, window.innerHeight - panelHeight - margin);
    const nextLeft = Math.max(margin, Math.min(Number(left) || margin, maxLeft));
    const nextTop = Math.max(margin, Math.min(Number(top) || margin, maxTop));

    host.style.setProperty('left', `${Math.round(nextLeft)}px`, 'important');
    host.style.setProperty('top', `${Math.round(nextTop)}px`, 'important');
    return { left: nextLeft, top: nextTop };
  }

  function getPopoverDimensions(host) {
    const panelWidth = Math.max(0, Math.min(380, window.innerWidth - 24));
    const panelHeight = Math.max(0, Math.min(host.getBoundingClientRect().height || 560, window.innerHeight - 24));
    return { panelWidth, panelHeight };
  }

  function createPopoverMarkup() {
    return `
      <style>
        :host {
          all: initial;
          color-scheme: light;
          font-family: Slack-Lato, Slack-Fractions, appleLogo, sans-serif;
          --cp-surface: #ffffff;
          --cp-surface-subtle: #f8f8f8;
          --cp-border: #c7c9cc;
          --cp-border-subtle: #e6e6e6;
          --cp-text: #1d1c1d;
          --cp-text-muted: #616061;
          --cp-text-subtle: #777777;
          --cp-accent: #1264a3;
          --cp-accent-strong: #007a5a;
          --cp-busy: #1264a3;
          --cp-busy-border: #0d4f82;
          --cp-free: #ffffff;
          --cp-free-border: #b7b7b7;
          --cp-error-surface: #fff7f6;
          --cp-error-border: #f0c4bf;
          --cp-success: #27744b;
          --cp-shadow: 0 12px 34px rgba(29, 28, 29, 0.28);
        }
        :host([data-theme="dark"]) {
          color-scheme: dark;
          --cp-surface: #1d1c1d;
          --cp-surface-subtle: #222529;
          --cp-border: #565856;
          --cp-border-subtle: #3f4147;
          --cp-text: #f8f8f8;
          --cp-text-muted: #c5c5c5;
          --cp-text-subtle: #a5a5a5;
          --cp-accent: #36c5f0;
          --cp-accent-strong: #2eb67d;
          --cp-busy: #1d9bd1;
          --cp-busy-border: #1679a6;
          --cp-free: #2f3136;
          --cp-free-border: #6b6f75;
          --cp-error-surface: #3b2025;
          --cp-error-border: #7f3a44;
          --cp-success: #6fdaa9;
          --cp-shadow: 0 12px 34px rgba(0, 0, 0, 0.55);
        }
        * { box-sizing: border-box; }
        button { font: inherit; }
        .panel {
          background: var(--cp-surface);
          border: 1px solid var(--cp-border);
          border-radius: 12px;
          box-shadow: var(--cp-shadow);
          color: var(--cp-text);
          display: flex;
          flex-direction: column;
          max-height: calc(100vh - 24px);
          overflow: hidden;
          width: 380px;
          max-width: calc(100vw - 24px);
        }
        .header {
          align-items: center;
          border-bottom: 1px solid var(--cp-border-subtle);
          cursor: grab;
          display: flex;
          gap: 10px;
          padding: 14px 14px 12px;
          touch-action: none;
          user-select: none;
        }
        .header:focus-visible {
          outline: 2px solid var(--cp-accent);
          outline-offset: -3px;
        }
        .header.is-dragging {
          cursor: grabbing;
        }
        .avatar {
          align-items: center;
          background: var(--cp-accent);
          border-radius: 9px;
          color: #ffffff;
          display: flex;
          flex: 0 0 38px;
          font-size: 13px;
          font-weight: 700;
          height: 38px;
          justify-content: center;
          letter-spacing: 0.2px;
          overflow: hidden;
          text-transform: uppercase;
        }
        .avatar img {
          border-radius: inherit;
          height: 100%;
          object-fit: cover;
          outline: 1px solid oklch(0 0 0 / 0.1);
          outline-offset: -1px;
          width: 100%;
        }
        :host([data-theme="dark"]) .avatar img {
          outline-color: oklch(1 0 0 / 0.1);
        }
        .identity { min-width: 0; flex: 1; }
        .identity strong {
          display: block;
          font-size: 15px;
          line-height: 20px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .identity span {
          color: var(--cp-text-muted);
          display: block;
          font-size: 12px;
          line-height: 17px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .icon-button {
          align-items: center;
          background: transparent;
          border: 0;
          border-radius: 6px;
          color: var(--cp-text-muted);
          cursor: pointer;
          display: inline-flex;
          height: 32px;
          justify-content: center;
          padding: 0;
          width: 32px;
        }
        .icon-button:hover { background: var(--cp-surface-subtle); color: var(--cp-text); }
        .icon-button:focus-visible, .primary-button:focus-visible, .secondary-button:focus-visible, .link-button:focus-visible {
          outline: 2px solid var(--cp-accent);
          outline-offset: 2px;
        }
        .icon-button svg { height: 18px; width: 18px; }
        .date-bar {
          align-items: center;
          background: var(--cp-surface-subtle);
          border-bottom: 1px solid var(--cp-border-subtle);
          display: grid;
          grid-template-columns: 34px 1fr 34px;
          gap: 6px;
          padding: 8px 10px;
        }
        .date-label {
          background: transparent;
          border: 0;
          border-radius: 6px;
          color: var(--cp-text);
          cursor: pointer;
          font-size: 13px;
          font-weight: 700;
          line-height: 28px;
          min-width: 0;
          overflow: hidden;
          padding: 0 8px;
          text-align: center;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .date-label:hover { background: var(--cp-surface); }
        .content {
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
          overscroll-behavior: contain;
          padding: 12px;
        }
        .state-card {
          align-items: center;
          background: var(--cp-surface-subtle);
          border: 1px solid var(--cp-border-subtle);
          border-radius: 9px;
          display: grid;
          gap: 10px;
          grid-template-columns: 38px minmax(0, 1fr);
          margin: 6px 0;
          min-height: 148px;
          padding: 14px;
        }
        .state-card > button { grid-column: 1 / -1; }
        .state-card--loading { display: flex; }
        .state-card--error { background: var(--cp-error-surface); border-color: var(--cp-error-border); }
        .state-card strong { display: block; font-size: 14px; line-height: 20px; }
        .state-card span { color: var(--cp-text-muted); display: block; font-size: 12px; line-height: 17px; margin-top: 2px; }
        .state-card small { color: var(--cp-text-subtle); display: block; font-size: 11px; line-height: 16px; margin-top: 6px; }
        .state-icon {
          align-items: center;
          background: var(--cp-surface);
          border: 1px solid var(--cp-border);
          border-radius: 9px;
          color: var(--cp-accent);
          display: flex;
          font-size: 18px;
          font-weight: 700;
          height: 38px;
          justify-content: center;
          width: 38px;
        }
        .state-icon--setup { color: #5f3dc4; }
        .state-icon--error { color: #b3261e; }
        .spinner {
          animation: spin 800ms linear infinite;
          border: 3px solid var(--cp-border-subtle);
          border-radius: 50%;
          border-top-color: var(--cp-accent);
          flex: 0 0 30px;
          height: 30px;
          width: 30px;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .primary-button, .secondary-button {
          border-radius: 7px;
          cursor: pointer;
          font-size: 13px;
          font-weight: 700;
          height: 36px;
          padding: 0 14px;
          width: 100%;
        }
        .primary-button { background: var(--cp-accent-strong); border: 1px solid var(--cp-accent-strong); color: #ffffff; }
        .primary-button:hover { filter: brightness(1.08); }
        .secondary-button { background: var(--cp-surface); border: 1px solid var(--cp-border); color: var(--cp-text); }
        .secondary-button:hover { background: var(--cp-surface-subtle); }
        .availability-summary {
          align-items: flex-start;
          display: flex;
          gap: 12px;
          justify-content: space-between;
          margin: 0 0 10px;
        }
        .availability-summary > div:first-child { min-width: 0; }
        .availability-summary strong { display: block; font-size: 14px; line-height: 19px; }
        .availability-summary span { color: var(--cp-text-muted); display: block; font-size: 11px; line-height: 16px; }
        .legend { display: flex; flex: 0 0 auto; gap: 8px; padding-top: 2px; }
        .legend span { align-items: center; display: flex; gap: 4px; white-space: nowrap; }
        .legend i { border-radius: 2px; display: inline-block; height: 9px; width: 9px; }
        .legend-free { background: var(--cp-free); border: 1px solid var(--cp-free-border); }
        .legend-busy { background: var(--cp-busy); }
        .timeline-scroll {
          background: var(--cp-surface);
          border: 1px solid var(--cp-border-subtle);
          border-radius: 8px;
          max-height: 320px;
          overflow-y: auto;
          overscroll-behavior: contain;
        }
        .timeline {
          background: linear-gradient(90deg, var(--cp-surface-subtle) 0, var(--cp-surface-subtle) 52px, var(--cp-surface) 52px);
          min-height: 220px;
          position: relative;
        }
        .hour-line {
          border-top: 1px solid var(--cp-border-subtle);
          left: 52px;
          position: absolute;
          right: 0;
        }
        .hour-label {
          color: var(--cp-text-subtle);
          font-size: 10px;
          line-height: 14px;
          position: absolute;
          right: calc(100% + 7px);
          top: -7px;
          white-space: nowrap;
        }
        .busy-block {
          background: var(--cp-busy);
          border: 1px solid var(--cp-busy-border);
          border-radius: 5px;
          color: #ffffff;
          left: 61px;
          overflow: hidden;
          padding: 4px 7px;
          position: absolute;
          right: 9px;
        }
        .event-block--compact {
          overflow: visible;
          padding: 0 5px;
          z-index: 1;
        }
        .event-block--free {
          background: var(--cp-free);
          border-color: var(--cp-free-border);
          color: var(--cp-text);
        }
        .busy-block strong { display: block; font-size: 11px; line-height: 14px; }
        .busy-block span { display: block; font-size: 10px; line-height: 13px; opacity: 0.92; }
        .event-block--compact strong {
          font-size: 9px;
          line-height: 11px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .event-notice {
          background: var(--cp-surface-subtle);
          border: 1px solid var(--cp-border-subtle);
          border-radius: 7px;
          color: var(--cp-text-muted);
          font-size: 11px;
          line-height: 15px;
          margin: 0 0 8px;
          padding: 7px 9px;
        }
        .range-disclosure {
          margin-top: 10px;
        }
        .range-disclosure-summary {
          align-items: center;
          background: var(--cp-surface-subtle);
          border: 1px solid var(--cp-border-subtle);
          border-radius: 8px;
          color: var(--cp-text);
          cursor: pointer;
          display: flex;
          justify-content: space-between;
          list-style: none;
          min-height: 40px;
          padding: 7px 11px;
        }
        .range-disclosure-summary::-webkit-details-marker { display: none; }
        .range-disclosure-summary:focus-visible {
          outline: 2px solid var(--cp-accent);
          outline-offset: 2px;
        }
        .range-disclosure-summary:hover { background: var(--cp-surface); }
        .range-disclosure-summary > span:first-child { min-width: 0; }
        .range-disclosure-summary strong,
        .range-disclosure-summary small {
          display: block;
        }
        .range-disclosure-summary strong {
          font-size: 12px;
          line-height: 16px;
        }
        .range-disclosure-summary small {
          color: var(--cp-text-muted);
          font-size: 10px;
          line-height: 13px;
        }
        .range-disclosure-summary::after {
          border-bottom: 1.5px solid currentColor;
          border-right: 1.5px solid currentColor;
          content: '';
          flex: 0 0 8px;
          height: 8px;
          margin: 0 3px 4px 12px;
          transform: rotate(45deg);
          transition: transform 150ms cubic-bezier(0.175, 0.885, 0.32, 1.1);
          width: 8px;
        }
        .range-disclosure[open] .range-disclosure-summary::after {
          margin-bottom: -4px;
          transform: rotate(225deg);
        }
        @media (prefers-reduced-motion: reduce) {
          .range-disclosure-summary::after { transition: none; }
        }
        .range-section { margin-top: 8px; }
        .range-heading {
          color: var(--cp-text-muted);
          font-size: 11px;
          font-weight: 700;
          line-height: 16px;
          margin: 0 0 5px;
        }
        .range-list {
          border: 1px solid var(--cp-border-subtle);
          border-radius: 8px;
          overflow: hidden;
        }
        .range-item {
          align-items: center;
          background: var(--cp-surface);
          border-bottom: 1px solid var(--cp-border-subtle);
          display: grid;
          gap: 7px;
          grid-template-columns: 42px minmax(0, 1fr) auto;
          min-height: 30px;
          padding: 5px 8px;
        }
        .range-item:last-child { border-bottom: 0; }
        .range-status { font-size: 10px; font-weight: 700; }
        .range-item--busy .range-status { color: var(--cp-busy); }
        .range-item--free .range-status { color: var(--cp-success); }
        .range-details { min-width: 0; }
        .range-title {
          color: var(--cp-text);
          display: block;
          font-size: 11px;
          line-height: 14px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .range-person {
          color: var(--cp-text-subtle);
          display: block;
          font-size: 10px;
          line-height: 13px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .range-time {
          color: var(--cp-text-muted);
          font-size: 10px;
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }
        .now-line {
          border-top: 2px solid #d72b3f;
          left: 48px;
          pointer-events: none;
          position: absolute;
          right: 0;
          z-index: 3;
        }
        .now-line::before {
          background: #d72b3f;
          border-radius: 50%;
          content: '';
          height: 7px;
          left: -3px;
          position: absolute;
          top: -4px;
          width: 7px;
        }
        .now-line span {
          background: #d72b3f;
          border-radius: 3px;
          color: #ffffff;
          font-size: 9px;
          left: 7px;
          line-height: 14px;
          padding: 0 4px;
          position: absolute;
          top: -8px;
        }
        .all-free {
          color: var(--cp-success);
          font-size: 12px;
          left: 70px;
          position: absolute;
          right: 14px;
          text-align: center;
          top: 46%;
        }
        .footer {
          align-items: center;
          border-top: 1px solid var(--cp-border-subtle);
          display: flex;
          gap: 10px;
          justify-content: space-between;
          padding: 10px 12px;
        }
        .footer-note {
          color: var(--cp-text-subtle);
          font-size: 10px;
          line-height: 14px;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .link-button {
          background: transparent;
          border: 0;
          color: var(--cp-accent);
          cursor: pointer;
          flex: 0 0 auto;
          font-size: 12px;
          font-weight: 700;
          padding: 4px;
        }
        .link-button:hover { text-decoration: underline; }
      </style>
      <section class="panel" role="dialog" aria-label="Coworker availability" aria-modal="false">
        <header class="header" data-role="drag-handle" tabindex="0" aria-label="Drag to move Calendar Peek. Use the arrow keys to nudge it.">
          <div class="avatar" data-role="person-avatar" aria-hidden="true"></div>
          <div class="identity">
            <strong data-role="person-name"></strong>
            <span data-role="person-email"></span>
          </div>
          <button class="icon-button" type="button" data-action="close" aria-label="Close Calendar Peek">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6.7 5.3a1 1 0 0 0-1.4 1.4l5.3 5.3-5.3 5.3a1 1 0 0 0 1.4 1.4l5.3-5.3 5.3 5.3a1 1 0 0 0 1.4-1.4L13.4 12l5.3-5.3a1 1 0 0 0-1.4-1.4L12 10.6 6.7 5.3Z"/></svg>
          </button>
        </header>
        <div class="date-bar">
          <button class="icon-button" type="button" data-action="previous-day" aria-label="Previous day">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M15.7 5.3a1 1 0 0 1 0 1.4L10.4 12l5.3 5.3a1 1 0 0 1-1.4 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.4 0Z"/></svg>
          </button>
          <button class="date-label" type="button" data-action="today" data-role="date-label" title="Jump to today"></button>
          <button class="icon-button" type="button" data-action="next-day" aria-label="Next day">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8.3 5.3a1 1 0 0 0 0 1.4l5.3 5.3-5.3 5.3a1 1 0 0 0 1.4 1.4l6-6a1 1 0 0 0 0-1.4l-6-6a1 1 0 0 0-1.4 0Z"/></svg>
          </button>
        </div>
        <div class="content" data-role="content" aria-live="polite"></div>
        <footer class="footer">
          <span class="footer-note" data-role="footer-note">Event names + free/busy</span>
          <button class="link-button" type="button" data-action="open-calendar">Open in Google Calendar</button>
        </footer>
      </section>`;
  }

  function getInitials(value) {
    const words = String(value || '')
      .replace(/@.*$/, '')
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
    if (words.length === 0) {
      return 'CP';
    }
    return words.slice(0, 2).map((word) => word[0]).join('').toUpperCase();
  }

  function formatDuration(totalMinutes) {
    const minutes = Math.max(0, Math.round(totalMinutes));
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    if (hours === 0) {
      return `${remainder}m`;
    }
    if (remainder === 0) {
      return `${hours}h`;
    }
    return `${hours}h ${remainder}m`;
  }

  function escapeAttribute(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }
})();
