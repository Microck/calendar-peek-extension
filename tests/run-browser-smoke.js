'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

class CdpClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data));
        if (!message.id || !this.pending.has(message.id)) {
          return;
        }
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(`${message.error.message} (${message.error.code})`));
        } else {
          pending.resolve(message.result);
        }
      });
      socket.addEventListener('close', () => {
        for (const pending of this.pending.values()) {
          pending.reject(new Error('Chrome DevTools connection closed.'));
        }
        this.pending.clear();
      });
    });
  }

  send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Chrome DevTools connection is not open.'));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (this.socket) {
      this.socket.close();
    }
  }
}

async function pollJson(url, timeoutMs) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.json();
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

function buildFixtureHtml(root) {
  const fixturePath = path.join(root, 'tests', 'slack-smoke.html');
  const fixtureDirectory = path.dirname(fixturePath);
  let html = fs.readFileSync(fixturePath, 'utf8');

  html = html.replace(/<script\s+src="([^"]+)"\s*><\/script>/g, (match, source) => {
    const scriptPath = path.resolve(fixtureDirectory, source);
    const script = fs.readFileSync(scriptPath, 'utf8').replace(/<\/script/gi, '<\\/script');
    return `<script>\n${script}\n<\/script>`;
  });

  return html;
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const fixtureHtml = buildFixtureHtml(root);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-peek-chrome-'));
  const port = 9300 + Math.floor(Math.random() * 300);
  const browser = spawn('xvfb-run', [
    '-a',
    'chromium',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    'about:blank'
  ], {
    detached: true,
    stdio: 'ignore'
  });

  let client = null;
  try {
    await pollJson(`http://127.0.0.1:${port}/json/version`, 10000);
    const targetResponse = await fetch(
      `http://127.0.0.1:${port}/json/new?about%3Ablank`,
      { method: 'PUT' }
    );
    if (!targetResponse.ok) {
      throw new Error(`Could not open smoke-test target: HTTP ${targetResponse.status}`);
    }
    const target = await targetResponse.json();

    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    const frameTree = await client.send('Page.getFrameTree');
    const frameId = frameTree && frameTree.frameTree && frameTree.frameTree.frame &&
      frameTree.frameTree.frame.id;
    assert.ok(frameId, 'Could not determine the smoke-test frame ID.');
    await client.send('Page.setDocumentContent', { frameId, html: fixtureHtml });
    await new Promise((resolve) => setTimeout(resolve, 3500));

    const evaluation = await client.send('Runtime.evaluate', {
      expression: 'document.body && document.body.dataset.calendarPeekSmoke',
      returnByValue: true
    });
    const raw = evaluation && evaluation.result && evaluation.result.value;

    if (!raw) {
      const diagnostic = await client.send('Runtime.evaluate', {
        expression: `JSON.stringify({
          readyState: document.readyState,
          title: document.title,
          href: location.href.slice(0, 60),
          calendarPeek: Boolean(globalThis.CalendarPeek),
          availabilityUtils: Boolean(globalThis.CalendarPeekAvailability),
          chromeRuntime: Boolean(globalThis.chrome && chrome.runtime),
          buttonCount: document.querySelectorAll('[data-calendar-peek-slack-button]').length,
          popoverCount: document.querySelectorAll('[data-calendar-peek-slack-popover]').length,
          bodyText: document.body ? document.body.innerText.slice(0, 200) : ''
        })`,
        returnByValue: true
      });
      console.error('Smoke-test diagnostic:', diagnostic.result && diagnostic.result.value);
    }

    assert.ok(raw, 'Smoke test did not report a result.');
    assert.notEqual(raw, 'missing-button', 'Calendar Peek button was not injected.');
    assert.notEqual(raw, 'missing-updated-button', 'Calendar Peek button was not refreshed when Slack reused the profile card.');

    const result = JSON.parse(raw);
    assert.deepEqual({
      button: result.button,
      buttonCount: result.buttonCount,
      buttonEmail: result.buttonEmail,
      requestedEmail: result.requestedEmail,
      requestedName: result.requestedName,
      popoverName: result.popoverName,
      popover: result.popover,
      timeline: result.timeline,
      busyBlocks: result.busyBlocks,
      rangeDisclosure: result.rangeDisclosure,
      rangeDisclosureOpen: result.rangeDisclosureOpen,
      dragHandle: result.dragHandle
    }, {
      button: true,
      buttonCount: 1,
      buttonEmail: 'jamie.chen@example.com',
      requestedEmail: 'jamie.chen@example.com',
      requestedName: 'Jamie Chen',
      popoverName: 'Jamie Chen',
      popover: true,
      timeline: true,
      busyBlocks: 2,
      rangeDisclosure: true,
      rangeDisclosureOpen: false,
      dragHandle: true
    });
    assert.equal(result.avatarSrc, 'data:image/svg+xml,%3Csvg xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22 width%3D%221%22 height%3D%221%22%3E%3Crect width%3D%221%22 height%3D%221%22 fill%3D%22%23ff0000%22%2F%3E%3C%2Fsvg%3E');
    assert.equal(result.popoverTheme, 'dark');
    assert.equal(result.rangeCount, 5);
    assert.deepEqual(result.eventTitles, ['Chapter - Automation', 'Onboarding Check']);
    assert.ok(result.rangeLabels.every((label) => /(?:Busy|Free)/.test(label) && /\d/.test(label)));
    assert.ok(result.rangeLabels.every((label) => label.includes('Jamie Chen')));
    assert.ok(result.rangeLabels.some((label) => label.includes('Chapter - Automation')));
    assert.ok(result.rangeLabels.some((label) => label.includes('Onboarding Check')));

    const expandedLayoutEvaluation = await client.send('Runtime.evaluate', {
      expression: `(() => {
        const host = document.querySelector('[data-calendar-peek-slack-popover]');
        const root = host.shadowRoot;
        const disclosure = root.querySelector('.range-disclosure');
        disclosure.querySelector('summary').click();
        return new Promise((resolve) => requestAnimationFrame(() => {
          const panel = root.querySelector('.panel').getBoundingClientRect();
          const footer = root.querySelector('.footer').getBoundingClientRect();
          resolve(JSON.stringify({
            open: disclosure.open,
            label: disclosure.querySelector('[data-role="range-disclosure-label"]').textContent,
            panelBottom: panel.bottom,
            footerBottom: footer.bottom,
            viewportHeight: window.innerHeight
          }));
        }));
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    const expandedLayout = JSON.parse(expandedLayoutEvaluation.result.value);
    assert.equal(expandedLayout.open, true);
    assert.equal(expandedLayout.label, 'Hide all time ranges');
    assert.ok(expandedLayout.panelBottom <= expandedLayout.viewportHeight);
    assert.ok(expandedLayout.footerBottom <= expandedLayout.viewportHeight);

    const dragEvaluation = await client.send('Runtime.evaluate', {
      expression: `(() => {
        const host = document.querySelector('[data-calendar-peek-slack-popover]');
        const root = host.shadowRoot;
        const disclosure = root.querySelector('.range-disclosure');
        disclosure.querySelector('summary').click();
        return new Promise((resolve) => requestAnimationFrame(() => {
          const header = root.querySelector('[data-role="drag-handle"]');
          const before = host.getBoundingClientRect();
          const startX = before.left + 18;
          const startY = before.top + 18;
          header.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: startX,
            clientY: startY,
            pointerId: 1
          }));
          header.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            button: 0,
            clientX: startX + 60,
            clientY: startY + 40,
            pointerId: 1
          }));
          header.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            button: 0,
            clientX: startX + 60,
            clientY: startY + 40,
            pointerId: 1
          }));
          const after = host.getBoundingClientRect();
          resolve(JSON.stringify({
            moved: after.left > before.left && after.top > before.top,
            dragging: header.classList.contains('is-dragging')
          }));
        }));
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    const dragResult = JSON.parse(dragEvaluation.result.value);
    assert.equal(dragResult.moved, true);
    assert.equal(dragResult.dragging, false);

    await client.send('Runtime.evaluate', {
      expression: "document.body.dataset.theme = 'light'"
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    const lightThemeEvaluation = await client.send('Runtime.evaluate', {
      expression: "document.querySelector('[data-calendar-peek-slack-popover]').getAttribute('data-theme')",
      returnByValue: true
    });
    assert.equal(lightThemeEvaluation.result && lightThemeEvaluation.result.value, 'light');

    if (process.env.CALENDAR_PEEK_SCREENSHOT) {
      const screenshot = await client.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false
      });
      fs.writeFileSync(process.env.CALENDAR_PEEK_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
    }

    console.log('slack browser smoke test: passed');
  } finally {
    if (client) {
      client.close();
    }
    try {
      process.kill(-browser.pid, 'SIGTERM');
    } catch {
      // The browser may already have closed.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
