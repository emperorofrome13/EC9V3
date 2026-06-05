#!/usr/bin/env node
// EC9v3 UI test runner — drives the React UI in headless Chromium via Playwright.
// Live end-to-end: every test types into the real DOM and waits for streamed
// responses from /api/chat (which means LM Studio must be running).
//
// Usage:
//   node ui-test.mjs                     # run all UI tests
//   node ui-test.mjs --headed            # show the browser
//   node ui-test.mjs --only chat         # filter to tests whose name contains "chat"
//   node ui-test.mjs --base http://localhost:3000
//   node ui-test.mjs --slow 200          # slowMo ms (debugging)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { argv, env, stderr, stdout, exit } from 'node:process';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, 'logs');
const SCREENSHOT_DIR = path.join(LOG_DIR, 'screenshots');
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ── arg parsing ────────────────────────────────────────────────────────

function parseArgs(args) {
  const out = { positional: [], flags: {} };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out.flags[k] = next; i++; }
      else out.flags[k] = true;
    } else out.positional.push(a);
  }
  return out;
}

const { flags } = parseArgs(argv.slice(2));
const BASE_URL = flags.base || env.EC9V3_SERVER || 'http://localhost:3000';
const HEADED = !!flags.headed;
const SLOW = flags.slow ? Number(flags.slow) : 0;
const FILTER = typeof flags.only === 'string' ? flags.only : null;
const RESPONSE_TIMEOUT = flags.timeout ? Number(flags.timeout) * 1000 : 180_000;

// ── logging ────────────────────────────────────────────────────────────

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const jsonlPath = path.join(LOG_DIR, `ui-test-${ts}.jsonl`);
const textPath = path.join(LOG_DIR, `ui-test-${ts}.log`);
const jsonlStream = fs.createWriteStream(jsonlPath, { flags: 'a' });
const textStream = fs.createWriteStream(textPath, { flags: 'a' });

function logEvent(type, payload) {
  jsonlStream.write(JSON.stringify({ t: new Date().toISOString(), type, ...payload }) + '\n');
}
function logHuman(line) { textStream.write(line + '\n'); }

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
const useColor = stderr.isTTY && !flags['no-color'];
const c = (k, s) => (useColor ? `${C[k]}${s}${C.reset}` : s);

const info = (m) => { stderr.write(c('dim', `[info]  ${m}\n`));   logHuman(`[info]  ${m}`); };
const ok   = (m) => { stderr.write(c('green', `[pass]  ${m}\n`)); logHuman(`[pass]  ${m}`); };
const warn = (m) => { stderr.write(c('yellow', `[warn]  ${m}\n`));logHuman(`[warn]  ${m}`); };
const fail = (m) => { stderr.write(c('red', `[fail]  ${m}\n`));   logHuman(`[fail]  ${m}`); };

// ── test framework ─────────────────────────────────────────────────────

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function captureFailure(page, name, error) {
  const safe = name.replace(/[^a-z0-9_-]/gi, '_');
  const shotPath = path.join(SCREENSHOT_DIR, `fail-${safe}-${ts}.png`);
  const htmlPath = path.join(SCREENSHOT_DIR, `fail-${safe}-${ts}.html`);
  try {
    await page.screenshot({ path: shotPath, fullPage: true });
    const html = await page.content();
    fs.writeFileSync(htmlPath, html);
    return { shotPath, htmlPath };
  } catch (e) {
    return { shotPath: null, htmlPath: null, captureError: String(e) };
  }
}

// ── test definitions ───────────────────────────────────────────────────

test('page_loads', async (page) => {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  // The empty-state heading should render before any conversation exists.
  await page.waitForSelector('text=EC9v3 AI Assistant', { timeout: 10_000 });
  const title = await page.title();
  logEvent('page_loaded', { title, url: page.url() });
  if (!title) throw new Error('page has no title');
});

test('chat_input_present', async (page) => {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  const ta = page.locator('textarea[placeholder*="Type a message"]');
  await ta.waitFor({ timeout: 10_000 });
  await ta.fill('hello world');
  const value = await ta.inputValue();
  if (value !== 'hello world') throw new Error(`textarea did not accept input, got "${value}"`);
  // Send button should now be enabled.
  const sendBtn = page.locator('button[title="Send message"]');
  const disabled = await sendBtn.isDisabled();
  if (disabled) throw new Error('send button is disabled despite non-empty input');
});

test('new_chat_button', async (page) => {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  // Sidebar "New Chat" button has the literal text.
  const newChat = page.locator('button:has-text("New Chat")');
  await newChat.waitFor({ timeout: 10_000 });
  await newChat.click();
  // After clicking, suggestions or input should still be present (fresh empty conv).
  await page.waitForSelector('textarea[placeholder*="Type a message"]', { timeout: 5000 });
  ok('new chat created');
});

test('suggestion_button_fills_input', async (page) => {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  // Empty state shows suggestion buttons. Click the first one.
  const suggestions = page.locator('button:has-text("Read a file"), button:has-text("Run a command")').first();
  await suggestions.waitFor({ timeout: 10_000 });
  await suggestions.click();
  const ta = page.locator('textarea[placeholder*="Type a message"]');
  const value = await ta.inputValue();
  if (!value || value.length < 5) throw new Error(`suggestion did not populate textarea, got "${value}"`);
  logEvent('suggestion_filled', { length: value.length, sample: value.slice(0, 80) });
});

test('settings_page_loads', async (page) => {
  await page.goto(`${BASE_URL}/settings`, { waitUntil: 'networkidle' });
  // Settings page should render some heading or form. Wait for any input.
  await page.waitForSelector('input, select, button', { timeout: 10_000 });
  const url = page.url();
  if (!/\/settings/.test(url)) throw new Error(`settings url not preserved: ${url}`);
});

test('chat_send_streams_response', async (page) => {
  // Live test: types a real prompt, hits send, waits for streamed content.
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  const ta = page.locator('textarea[placeholder*="Type a message"]');
  await ta.waitFor({ timeout: 10_000 });
  await ta.fill('Reply with the single word: pong. No commentary.');

  // Hook the network response from /api/chat to confirm SSE traffic.
  const sseStarted = page.waitForResponse(
    (r) => r.url().includes('/api/chat') && r.status() === 200,
    { timeout: 15_000 },
  );

  await page.locator('button[title="Send message"]').click();
  const resp = await sseStarted;
  logEvent('chat_response', { status: resp.status(), url: resp.url() });

  // Wait for an assistant message bubble to appear.
  // Assistant messages contain the "EC9v3" speaker label.
  await page.waitForSelector('text=EC9v3', { timeout: RESPONSE_TIMEOUT });

  // Wait until streaming finishes (Send button reappears, Stop disappears).
  await page.waitForFunction(
    () => !document.querySelector('button[title="Stop generation"]'),
    { timeout: RESPONSE_TIMEOUT },
  );

  // Read the rendered assistant content.
  const messages = await page.locator('#chat-messages .prose').allTextContents();
  const assistantText = messages.join('\n').toLowerCase();
  logEvent('assistant_text', { chars: assistantText.length, sample: assistantText.slice(0, 200) });
  if (assistantText.length === 0) throw new Error('no assistant message rendered');
  if (!/pong/.test(assistantText)) {
    warn(`assistant did not say "pong" (model may have misbehaved): "${assistantText.slice(0, 120)}"`);
    // Don't fail the test — UI rendering is what we're testing, not model intelligence.
  }
});

test('stop_button_aborts_stream', async (page) => {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  const ta = page.locator('textarea[placeholder*="Type a message"]');
  await ta.waitFor({ timeout: 10_000 });
  await ta.fill('Write a 500 word essay about turtles.');
  await page.locator('button[title="Send message"]').click();

  // Wait for stop button to appear (streaming started).
  const stopBtn = page.locator('button[title="Stop generation"]');
  await stopBtn.waitFor({ timeout: 15_000 });
  logEvent('stop_button_visible', {});

  // Click stop.
  await stopBtn.click();

  // Stop button should disappear within a short window.
  await page.waitForFunction(
    () => !document.querySelector('button[title="Stop generation"]'),
    { timeout: 10_000 },
  );
  logEvent('stream_aborted', {});
});

test('console_errors_clean', async (page) => {
  // Browse the main flows and confirm no console errors fired.
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Filter known noise: hydration warnings from third-party libs, missing favicon, etc.
      if (/favicon|Failed to load resource/i.test(text)) return;
      errors.push(text);
    }
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.goto(`${BASE_URL}/settings`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  logEvent('console_errors', { count: errors.length, errors });
  if (errors.length > 0) throw new Error(`${errors.length} console error(s): ${errors.slice(0, 3).join(' | ')}`);
});

// ── runner ─────────────────────────────────────────────────────────────

async function preflight() {
  info(`base url: ${BASE_URL}`);
  try {
    const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok && res.status >= 500) throw new Error(`HTTP ${res.status}`);
    ok(`server reachable`);
    return true;
  } catch (e) {
    fail(`server unreachable at ${BASE_URL} — start it with \`npm run dev\``);
    logEvent('preflight.fail', { error: String(e) });
    return false;
  }
}

async function main() {
  logEvent('ui_test.start', { baseUrl: BASE_URL, headed: HEADED, filter: FILTER });
  info(`logs: ${jsonlPath}`);

  const reachable = await preflight();
  if (!reachable) {
    logEvent('ui_test.aborted', { reason: 'server_unreachable' });
    exit(2);
  }

  const filtered = FILTER ? tests.filter((t) => t.name.includes(FILTER)) : tests;
  if (FILTER && filtered.length === 0) {
    fail(`no tests matched --only "${FILTER}"`);
    exit(2);
  }
  info(`running ${filtered.length} test(s)${FILTER ? ` (filter: ${FILTER})` : ''}`);

  const browser = await chromium.launch({ headless: !HEADED, slowMo: SLOW });
  const results = [];

  for (const tc of filtered) {
    stderr.write(`\n${c('bold', '▶')} ${tc.name}\n`);
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();

    // Forward browser console to our log so we capture client-side errors.
    page.on('console', (msg) => {
      logEvent('browser_console', { test: tc.name, level: msg.type(), text: msg.text() });
    });
    page.on('pageerror', (err) => {
      logEvent('browser_pageerror', { test: tc.name, message: err.message, stack: err.stack });
    });
    page.on('requestfailed', (req) => {
      logEvent('browser_requestfailed', { test: tc.name, url: req.url(), failure: req.failure()?.errorText });
    });

    const start = Date.now();
    let result;
    try {
      await tc.fn(page);
      const ms = Date.now() - start;
      result = { name: tc.name, passed: true, ms };
      ok(`${tc.name} (${ms}ms)`);
    } catch (e) {
      const ms = Date.now() - start;
      const capture = await captureFailure(page, tc.name, e);
      result = { name: tc.name, passed: false, ms, error: e.message, stack: e.stack, ...capture };
      fail(`${tc.name} (${ms}ms): ${e.message}`);
      if (capture.shotPath) info(`screenshot: ${capture.shotPath}`);
    }
    logEvent('test.case', result);
    results.push(result);
    await context.close();
  }

  await browser.close();

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  stderr.write(`\n${passed === total ? c('green', '✓') : c('red', '✗')} ${passed}/${total} passed\n`);
  stderr.write(c('dim', `JSONL log: ${jsonlPath}\n`));
  stderr.write(c('dim', `Text log:  ${textPath}\n`));
  if (passed < total) stderr.write(c('dim', `Screenshots: ${SCREENSHOT_DIR}\n`));

  logEvent('ui_test.done', { passed, total, results });
  jsonlStream.end();
  textStream.end();
  exit(passed === total ? 0 : 1);
}

main().catch((e) => {
  fail(`fatal: ${e.message}`);
  logEvent('ui_test.fatal', { error: String(e), stack: e.stack });
  jsonlStream.end();
  textStream.end();
  exit(1);
});
