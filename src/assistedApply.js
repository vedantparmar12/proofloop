import path from 'node:path';
import { chromium } from 'playwright-core';
import { dataDirectory } from './db.js';

let contextPromise;
const sessions = new Map();
const pending = new Map();

export async function assistApplication(application, profile, pdfPath, options = {}) {
  if (pending.has(application.id)) return pending.get(application.id);
  const operation = fillApplication(application, profile, pdfPath, options);
  pending.set(application.id, operation);
  try {
    return await operation;
  } finally {
    pending.delete(application.id);
  }
}

async function fillApplication(application, profile, pdfPath, options) {
  const url = new URL(application.url);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('The application URL must be HTTP(S) and contain no credentials');
  }

  const context = await getBrowserContext(options);
  let session = sessions.get(application.id);
  if (!session || session.page.isClosed()) {
    const page = await context.newPage();
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    session = { page, origin: new URL(page.url()).origin };
    sessions.set(application.id, session);
  }
  const { page } = session;
  await page.bringToFront();
  const result = { opened: true, filledFields: 0, cvAttached: false, paused: null };
  if (new URL(page.url()).origin !== session.origin) {
    return { ...result, paused: 'different-site' };
  }

  const blockers = page.locator([
    'input[type="password"]',
    'input[autocomplete="one-time-code"]',
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'iframe[src*="challenges.cloudflare.com"]',
    '.g-recaptcha', '.h-captcha', '.cf-turnstile',
    '#challenge-running', '#challenge-stage',
  ].join(','));
  for (let index = 0; index < await blockers.count(); index += 1) {
    if (await blockers.nth(index).isVisible()) return { ...result, paused: 'login-or-captcha' };
  }

  // A resume input anchors contact fields to an application, not a newsletter or login form.
  const uploads = page.locator('form input[type="file"]');
  const candidates = [];
  for (let index = 0; index < await uploads.count(); index += 1) {
    const field = uploads.nth(index);
    const identity = await field.evaluate((input) => [
      input.name, input.id, input.getAttribute('aria-label'),
      ...Array.from(input.labels || [], (label) => label.textContent),
    ].filter(Boolean).join(' '));
    const accept = (await field.getAttribute('accept') || '').toLowerCase();
    if (!/resume|résumé|\bcv\b|\bcv[_-]?(file|upload)/i.test(identity)) continue;
    if (accept && !accept.split(',').some((type) => ['.pdf', 'application/pdf', 'application/*', '*/*'].includes(type.trim()))) continue;
    const form = field.locator('xpath=ancestor::form');
    if (await field.isEnabled() && await form.isVisible()) candidates.push({ field, form });
  }
  if (candidates.length !== 1) return { ...result, paused: 'manual-form' };
  const { field, form } = candidates[0];

  result.filledFields += await fillEmpty(form, [
    'input[autocomplete="name" i]',
    'input[name="name" i]',
    'input[name="fullName" i]',
    'input[id="name" i]',
  ], profile.name);
  result.filledFields += await fillEmpty(form, [
    'input[autocomplete="email" i]',
    'input[name="email" i]',
    'input[type="email"]',
  ], profile.email);
  result.filledFields += await fillEmpty(form, [
    'input[autocomplete="tel" i]',
    'input[name="phone" i]',
    'input[type="tel"]',
  ], profile.phone);
  result.filledFields += await fillEmpty(form, ['input[name="location" i]'], profile.location);
  result.filledFields += await fillEmpty(form, [
    'textarea[name="coverLetter" i]',
    'textarea[name="cover_letter" i]',
    'textarea[id="coverLetter" i]',
  ], application.cover_letter);

  if (!await field.evaluate((input) => input.files.length)) {
    await field.setInputFiles(pdfPath, { timeout: 5000 });
    result.cvAttached = true;
  }
  return result;
}

export async function closeAssistedBrowser() {
  if (!contextPromise) return;
  const context = await contextPromise;
  contextPromise = undefined;
  sessions.clear();
  await context.close();
}

async function getBrowserContext(options) {
  if (!contextPromise) {
    contextPromise = chromium.launchPersistentContext(path.join(dataDirectory, 'chromium-profile'), {
      channel: 'chrome',
      headless: options.headless ?? false,
      viewport: null,
    });
    contextPromise.then((context) => {
      context.setDefaultTimeout(5000);
      context.once('close', () => {
        contextPromise = undefined;
        sessions.clear();
      });
    }).catch(() => { contextPromise = undefined; });
  }
  return contextPromise;
}

async function fillEmpty(form, selectors, value) {
  if (!value) return 0;
  const fields = form.locator(selectors.join(','));
  const editable = [];
  for (let index = 0; index < await fields.count(); index += 1) {
    const field = fields.nth(index);
    const type = await field.getAttribute('type');
    if (type && !['text', 'email', 'tel'].includes(type.toLowerCase())) continue;
    if (await field.isVisible() && await field.isEditable()) editable.push(field);
  }
  if (editable.length !== 1 || await editable[0].inputValue()) return 0;
  await editable[0].fill(value);
  return 1;
}
