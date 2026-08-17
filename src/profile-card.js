'use strict';

(() => {
  if (!globalThis.CalendarPeek) {
    return;
  }

  const HOST_ATTRIBUTE = 'data-calendar-peek-button-host';
  const NAME_ATTRIBUTE = 'data-calendar-peek-person-name';
  const TEMPORARY_ATTRIBUTE = 'data-calendar-peek-temporary';
  const POSITION_ATTRIBUTE = 'data-calendar-peek-positioned';
  const CARD_SELECTORS = [
    '[role="dialog"]',
    '[aria-modal="true"]',
    '[role="menu"]'
  ].join(',');

  let scanTimer = null;

  const observer = new MutationObserver(() => scheduleScan());
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-hidden', 'style']
  });

  document.addEventListener('click', handleDocumentClick, true);
  document.addEventListener('focusin', () => scheduleScan(80), true);
  scheduleScan(250);

  function handleDocumentClick(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (path.some((node) => node instanceof Element && node.hasAttribute(HOST_ATTRIBUTE))) {
      return;
    }

    const target = path.find((node) => node instanceof Element) || event.target;
    scheduleScan(80);

    if (!(target instanceof Element)) {
      return;
    }

    const person = extractPersonFromClickedElement(target);
    if (!person.email) {
      return;
    }

    setTimeout(() => {
      scanForProfileCards();
      if (!hasHostForEmail(person.email) && target.isConnected && globalThis.CalendarPeek.isVisible(target)) {
        attachAnchoredButton(target, person);
      }
    }, 450);
  }

  function scheduleScan(delayMs = 120) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanForProfileCards, delayMs);
  }

  function scanForProfileCards() {
    const candidates = new Set(
      [...document.querySelectorAll(CARD_SELECTORS)].filter(isPlausibleCard)
    );

    for (const mailLink of document.querySelectorAll('a[href^="mailto:"]')) {
      if (!globalThis.CalendarPeek.isVisible(mailLink)) {
        continue;
      }
      const overlay = findOverlayAncestor(mailLink);
      if (overlay) {
        candidates.add(overlay);
      }
    }

    if (window.top !== window && isPlausibleEmbeddedCard(document.body)) {
      candidates.add(document.body);
    }

    for (const card of candidates) {
      const person = extractPerson(card);
      if (!person.email) {
        continue;
      }

      const existing = card.querySelector(`[${HOST_ATTRIBUTE}]`);
      if (existing) {
        const existingEmail = existing.getAttribute(HOST_ATTRIBUTE) || '';
        const existingName = existing.getAttribute(NAME_ATTRIBUTE) || '';
        if (existingEmail === person.email && existingName === person.name) {
          continue;
        }
        existing.remove();
      }

      removeTemporaryHostsForEmail(person.email);
      attachCalendarButton(card, person);
    }
  }

  function isPlausibleCard(element) {
    if (!globalThis.CalendarPeek.isVisible(element)) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width < 210 || rect.height < 90 || rect.width > 920 || rect.height > 920) {
      return false;
    }

    return Boolean(extractEmail(element));
  }

  function isPlausibleEmbeddedCard(body) {
    if (!body || !globalThis.CalendarPeek.isVisible(body)) {
      return false;
    }

    const rect = body.getBoundingClientRect();
    return rect.width <= 920 && rect.height <= 920 && Boolean(extractEmail(body));
  }

  function findOverlayAncestor(start) {
    let current = start;
    for (let depth = 0; current && depth < 12; depth += 1, current = current.parentElement) {
      const rect = current.getBoundingClientRect();
      const style = getComputedStyle(current);
      const role = current.getAttribute('role');
      const isOverlay = role === 'dialog' || role === 'menu' || style.position === 'fixed' || style.position === 'absolute';
      const plausibleSize = rect.width >= 210 && rect.width <= 920 && rect.height >= 90 && rect.height <= 920;

      if (isOverlay && plausibleSize && globalThis.CalendarPeek.isVisible(current)) {
        return current;
      }
    }
    return null;
  }

  function extractPerson(card) {
    const email = extractEmail(card);
    const heading = card.querySelector('[role="heading"], h1, h2, h3, [data-name]');
    let name = heading ? globalThis.CalendarPeek.normalizeWhitespace(heading.textContent) : '';

    if (!name) {
      const lines = String(card.innerText || card.textContent || '')
        .split(/\n+/)
        .map(globalThis.CalendarPeek.normalizeWhitespace)
        .filter(Boolean)
        .filter((line) => !line.toLocaleLowerCase().includes(email));
      name = lines.find((line) => line.length <= 120) || '';
    }

    return { email, name };
  }

  function extractPersonFromClickedElement(start) {
    let current = start;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
      const email = extractEmailFromElement(current);
      if (!email) {
        continue;
      }

      const nameSources = [
        current.getAttribute('data-name'),
        current.getAttribute('name'),
        current.getAttribute('aria-label'),
        current.getAttribute('title'),
        current.textContent
      ];
      const name = nameSources
        .map(globalThis.CalendarPeek.normalizeWhitespace)
        .find((value) => value && value.length <= 160 && !value.toLocaleLowerCase().includes(email)) || '';

      return { email, name };
    }

    return { email: '', name: '' };
  }

  function extractEmailFromElement(element) {
    const attributeValues = [
      element.getAttribute('data-email'),
      element.getAttribute('email'),
      element.getAttribute('data-hovercard-id'),
      element.getAttribute('data-hovercard-email'),
      element.getAttribute('aria-label'),
      element.getAttribute('title')
    ];

    const href = element.getAttribute('href');
    if (href && /^mailto:/i.test(href)) {
      attributeValues.push(href);
    }

    for (const value of attributeValues) {
      const emails = globalThis.CalendarPeek.extractEmails(value || '');
      if (emails[0]) {
        return emails[0];
      }
    }

    const compactText = globalThis.CalendarPeek.normalizeWhitespace(element.textContent);
    if (compactText.length > 0 && compactText.length <= 240) {
      const emails = globalThis.CalendarPeek.extractEmails(compactText);
      if (emails[0]) {
        return emails[0];
      }
    }

    return '';
  }

  function extractEmail(card) {
    const mailLink = card.querySelector('a[href^="mailto:"]');
    if (mailLink) {
      const email = globalThis.CalendarPeek.normalizeEmail(mailLink.getAttribute('href'));
      if (email) {
        return email;
      }
    }

    for (const element of card.querySelectorAll('[data-email], [email], [data-hovercard-id], [data-hovercard-email]')) {
      const email = extractEmailFromElement(element);
      if (email) {
        return email;
      }
    }

    const ariaText = [...card.querySelectorAll('[aria-label], [title]')]
      .slice(0, 200)
      .map((element) => `${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`)
      .join(' ');
    const ariaEmails = globalThis.CalendarPeek.extractEmails(ariaText);
    if (ariaEmails[0]) {
      return ariaEmails[0];
    }

    const textEmails = globalThis.CalendarPeek.extractEmails(String(card.innerText || card.textContent || ''));
    return textEmails[0] || '';
  }

  function attachCalendarButton(card, person) {
    const host = createButtonHost(person);

    if (card === document.body) {
      host.style.setProperty('position', 'fixed', 'important');
    } else {
      const position = getComputedStyle(card).position;
      if (position === 'static') {
        card.style.setProperty('position', 'relative', 'important');
        card.setAttribute(POSITION_ATTRIBUTE, 'true');
      }
      host.style.setProperty('position', 'absolute', 'important');
    }

    host.style.setProperty('top', '10px', 'important');
    host.style.setProperty('right', '46px', 'important');
    card.appendChild(host);
  }

  function attachAnchoredButton(target, person) {
    removeTemporaryHosts();

    const rect = target.getBoundingClientRect();
    const host = createButtonHost(person);
    host.setAttribute(TEMPORARY_ATTRIBUTE, 'true');
    host.style.setProperty('position', 'fixed', 'important');

    const top = clamp(rect.top + (rect.height / 2) - 18, 8, Math.max(8, window.innerHeight - 44));
    const preferredLeft = rect.right + 8;
    const left = preferredLeft + 36 <= window.innerWidth - 8
      ? preferredLeft
      : clamp(rect.left - 44, 8, Math.max(8, window.innerWidth - 44));

    host.style.setProperty('top', `${Math.round(top)}px`, 'important');
    host.style.setProperty('left', `${Math.round(left)}px`, 'important');
    document.documentElement.appendChild(host);

    let removed = false;
    let timeout = null;
    const remove = () => {
      if (removed) {
        return;
      }
      removed = true;
      if (timeout !== null) {
        clearTimeout(timeout);
      }
      window.removeEventListener('scroll', remove, true);
      window.removeEventListener('resize', remove);
      host.remove();
    };

    host.calendarPeekRemove = remove;
    timeout = setTimeout(remove, 8000);
    window.addEventListener('scroll', remove, { capture: true, once: true });
    window.addEventListener('resize', remove, { once: true });
  }

  function createButtonHost(person) {
    const host = document.createElement('span');
    host.setAttribute(HOST_ATTRIBUTE, person.email);
    host.setAttribute(NAME_ATTRIBUTE, person.name);
    host.setAttribute('aria-hidden', 'false');
    host.style.setProperty('z-index', '2147483647', 'important');
    host.style.setProperty('display', 'block', 'important');
    host.style.setProperty('width', '36px', 'important');
    host.style.setProperty('height', '36px', 'important');

    const shadow = host.attachShadow({ mode: 'open' });
    const title = person.name ? `View ${person.name}’s calendar` : `View ${person.email} calendar`;
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        button {
          align-items: center;
          background: #fff;
          border: 1px solid #dadce0;
          border-radius: 50%;
          box-shadow: 0 1px 3px rgba(60, 64, 67, 0.25);
          box-sizing: border-box;
          color: #1a73e8;
          cursor: pointer;
          display: inline-flex;
          height: 36px;
          justify-content: center;
          margin: 0;
          padding: 0;
          width: 36px;
        }
        button:hover { background: #f6fafe; box-shadow: 0 2px 6px rgba(60, 64, 67, 0.30); }
        button:focus-visible { outline: 2px solid #1a73e8; outline-offset: 2px; }
        button:active { transform: translateY(1px); }
        button:disabled { cursor: default; opacity: 0.65; }
        svg { display: block; height: 20px; width: 20px; }
      </style>
      <button type="button" title="${escapeAttribute(title)}" aria-label="${escapeAttribute(title)}">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path fill="currentColor" d="M7 2a1 1 0 0 1 1 1v1h8V3a1 1 0 1 1 2 0v1h1a3 3 0 0 1 3 3v5.3a6.5 6.5 0 0 0-2-1.2V9H4v10a1 1 0 0 0 1 1h7.1c.3.7.7 1.4 1.2 2H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h1V3a1 1 0 0 1 1-1Zm13 11a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 2a1 1 0 0 0-1 1v3c0 .3.1.5.3.7l1.8 1.3a1 1 0 1 0 1.2-1.6L21 18.5V16a1 1 0 0 0-1-1Z"/>
        </svg>
      </button>`;

    const button = shadow.querySelector('button');
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      button.disabled = true;

      try {
        await globalThis.CalendarPeek.openPersonCalendar(person);
      } catch (error) {
        console.error('[Calendar Peek] Could not open coworker calendar.', error);
        button.disabled = false;
        button.title = error instanceof Error ? error.message : 'Could not open Google Calendar.';
      }
    });

    return host;
  }

  function hasHostForEmail(email) {
    return [...document.querySelectorAll(`[${HOST_ATTRIBUTE}]`)]
      .some((host) => host.getAttribute(HOST_ATTRIBUTE) === email);
  }

  function removeTemporaryHostsForEmail(email) {
    for (const host of document.querySelectorAll(`[${HOST_ATTRIBUTE}][${TEMPORARY_ATTRIBUTE}]`)) {
      if (host.getAttribute(HOST_ATTRIBUTE) === email) {
        if (typeof host.calendarPeekRemove === 'function') {
          host.calendarPeekRemove();
        } else {
          host.remove();
        }
      }
    }
  }

  function removeTemporaryHosts() {
    document.querySelectorAll(`[${HOST_ATTRIBUTE}][${TEMPORARY_ATTRIBUTE}]`).forEach((host) => {
      if (typeof host.calendarPeekRemove === 'function') {
        host.calendarPeekRemove();
      } else {
        host.remove();
      }
    });
  }

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
  }

  function escapeAttribute(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }
})();
