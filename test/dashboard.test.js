import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const directory = await mkdtemp(path.join(tmpdir(), 'proofloop-htmx-'));
const events = new EventEmitter();
let portalVisits = 0;
let portalSubmissions = 0;
let browser;
let child;
let baseUrl;
const draft = {
  tailoredCv: '# Test Candidate\n\ncandidate@example.com · London\n\nBackend Engineer building reliable Node.js software and PostgreSQL services.\n\n## Experience\n- Built and tested accessible web applications.',
  recruiterMessage: 'Hello hiring team, my experience building Node.js services fits this engineering opportunity.',
  coverLetter: 'I am interested in this engineering role. My experience includes building reliable Node.js systems and accessible web applications, as described in my CV.',
};
const portal = createServer(async (request, response) => {
  if (request.url === '/observe') {
    let body = '';
    for await (const chunk of request) body += chunk;
    events.emit('upload', JSON.parse(body));
    return response.writeHead(204).end();
  }
  if (request.url === '/submit') portalSubmissions += 1;
  if (request.url === '/favicon.ico') return response.writeHead(204).end();
  portalVisits += 1;
  response.setHeader('content-type', 'text/html');
  response.end(`<!doctype html><form method="post" action="/submit">
    ${request.url === '/login' ? '<input type="password">' : ''}
    <input name="fullName"><input name="email" type="email"><input name="salary">
    <input name="resume" type="file" accept=".pdf"><button>Submit</button></form>
    <script>document.querySelector('[name=resume]').onchange=e=>fetch('/observe',{method:'POST',body:JSON.stringify({name:document.querySelector('[name=fullName]').value,email:document.querySelector('[name=email]').value,salary:document.querySelector('[name=salary]').value,file:e.target.files[0]?.name})})</script>`);
});

async function state() {
  return (await fetch(`${baseUrl}/api/state`)).json();
}

async function requestFrom(page, endpoint, action, status = 200) {
  await page.waitForFunction(() => !document.querySelector('.htmx-settling, .htmx-swapping, .htmx-request'));
  const pending = page.waitForResponse((response) => new URL(response.url()).pathname === endpoint);
  await action();
  const response = await pending;
  assert.equal(response.status(), status, await response.text());
  return response;
}

test('HTMX dashboard preserves edits, API behavior and explicit approval through the full workflow', { timeout: 120000 }, async () => {
  portal.listen(0, '127.0.0.1');
  await once(portal, 'listening');
  const portalUrl = `http://127.0.0.1:${portal.address().port}`;
  const bin = path.join(directory, 'bin');
  await mkdir(bin);
  const fakeGemini = path.join(bin, 'gemini.cjs');
  await writeFile(fakeGemini, `process.stdin.resume(); process.stdin.on('end', () => console.log(${JSON.stringify(JSON.stringify(draft))}));`);
  if (process.platform === 'win32') {
    await writeFile(path.join(bin, 'gemini.cmd'), `@"${process.execPath}" "${fakeGemini}"\r\n`);
  } else {
    await writeFile(path.join(bin, 'gemini'), `#!/bin/sh\nexec "${process.execPath}" "${fakeGemini}"\n`, { mode: 0o755 });
  }
  const fakeWorker = path.join(bin, 'jobspy.cjs');
  await writeFile(fakeWorker, `let input=''; process.stdin.on('data',chunk=>input+=chunk); process.stdin.on('end',()=>{
    const settings=JSON.parse(input);
    if (Object.keys(settings).some(key=>!['site','searchTerm','location','country','resultsWanted','hoursOld'].includes(key))) process.exit(2);
    console.log(JSON.stringify({jobs:[
      {id:'test-1',site:settings.site,title:'Platform Engineer',company:'Discovery Company',location:settings.location,job_url:'https://example.test/jobs/discovery-1',description:'Build reliable PostgreSQL services.'},
      {id:'test-2',site:settings.site,title:'No description role',company:'Discovery Company',location:settings.location,job_url:'https://example.test/jobs/discovery-2',description:null}
    ],errors:{[settings.site]:'Some listings were blocked'},warnings:{[settings.site]:['Partial fixture results']}}));
  });`);
  const jobspyExecutable = path.join(bin, process.platform === 'win32' ? 'jobspy.cmd' : 'jobspy');
  await writeFile(jobspyExecutable, process.platform === 'win32'
    ? `@"${process.execPath}" "${fakeWorker}"\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${fakeWorker}"\n`, { mode: 0o755 });
  const jobs = ['Backend Engineer', 'Sales Manager'].map((title, index) => ({
    id: index + 1, title, location: { name: 'London' },
    absolute_url: `${portalUrl}/${index ? 'login' : 'apply'}`,
    content: index ? 'Sales strategy and account management.' : 'Build reliable Node.js software and PostgreSQL services. Backend Engineer.',
  }));
  const serverUrl = pathToFileURL(path.resolve('src/server.js')).href;
  const assistUrl = pathToFileURL(path.resolve('src/assistedApply.js')).href;
  const bootstrap = `
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => String(input).startsWith('https://boards-api.greenhouse.io/')
      ? Promise.resolve(Response.json({jobs:${JSON.stringify(jobs)}})) : originalFetch(input, options);
    await import(${JSON.stringify(serverUrl)});
    process.on('message', async (message) => {
      if (message === 'close') {
        await (await import(${JSON.stringify(assistUrl)})).closeAssistedBrowser();
        process.exit(0);
      }
    });`;
  child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
    env: { ...process.env, DATA_DIRECTORY: directory, PORT: '0', JOBSPY_PYTHON: jobspyExecutable, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  baseUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Dashboard server did not start')), 20000);
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/ProofLoop is running at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Dashboard exited (${code}): ${output}`)); });
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  const requestedPaths = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => requestedPaths.push(new URL(request.url()).pathname));
  await page.goto(baseUrl);
  await page.locator('#view-jobs').waitFor();
  assert.equal(await page.evaluate(() => htmx.config.allowEval), false);
  assert.equal(await page.evaluate(() => htmx.config.historyCacheSize), 0);
  assert(requestedPaths.includes('/vendor/htmx.min.js'));

  await requestFrom(page, '/api/scan', () => page.locator('[data-action=scan]').click(), 400);
  await page.getByText('Add a Greenhouse or Lever source first', { exact: true }).waitFor();
  await page.locator('[data-view=profile].nav-item').click();
  await page.locator('#profile-form').waitFor();
  await page.locator('[name=name]').fill('Test Candidate');
  await page.locator('[name=email]').fill('candidate@example.com');
  await page.locator('[name=targetRoles]').fill('Backend Engineer');
  await page.locator('[name=targetLocations]').fill('London');
  const cv = Buffer.from(draft.tailoredCv);
  await requestFrom(page, '/api/profile/cv', () => page.locator('#cv-file').setInputFiles({ name: 'cv.txt', mimeType: 'text/plain', buffer: cv }));
  await page.waitForFunction((text) => document.querySelector('#cv-text').value === text, draft.tailoredCv);
  assert.equal((await state()).profile.cv_text, '');
  await page.locator('#source-form [name=slug]').fill('fixture');
  await requestFrom(page, '/api/sources', () => page.locator('#source-form [type=submit]').click(), 201);
  await page.locator('.source-item').waitFor();
  assert.equal(await page.locator('[name=name]').inputValue(), 'Test Candidate');
  await page.locator('#source-form [name=slug]').fill('fixture');
  await requestFrom(page, '/api/sources', () => page.locator('#source-form [type=submit]').click(), 409);
  await page.getByText('That source already exists', { exact: true }).waitFor();
  const sourceId = (await state()).sources[0].id;
  await requestFrom(page, `/api/sources/${sourceId}`, () => page.locator('[data-action=delete-source]').click());
  await page.getByText('No boards connected yet.', { exact: true }).waitFor();
  await requestFrom(page, '/api/sources', () => page.locator('#source-form [type=submit]').click(), 201);
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('[data-view=jobs].nav-item').click();
  assert.equal(await page.locator('#profile-form').isVisible(), true);
  await requestFrom(page, '/api/profile', () => page.locator('#profile-form [type=submit]').click());
  await page.getByText('Profile saved. New scans will use these preferences.', { exact: true }).waitFor();
  assert.equal((await state()).profile.name, 'Test Candidate');
  assert.equal((await state()).profile.min_match, 60);

  await page.locator('[data-view=jobs].nav-item').click();
  await requestFrom(page, '/api/scan', () => page.locator('[data-action=scan]').click());
  await page.getByText('2 openings found', { exact: false }).waitFor();
  assert.equal(await page.locator('.job-card').count(), 2);
  await requestFrom(page, '/views/jobs/list', () => page.locator('#job-search').fill('Backend'));
  await page.waitForFunction(() => document.querySelectorAll('.job-card').length === 1);
  await requestFrom(page, '/api/jobs/1/skip', () => page.locator('[data-action=skip]').click());
  await page.getByText('No jobs in this view', { exact: true }).waitFor();
  assert.equal(await page.locator('#job-search').inputValue(), 'Backend');
  await requestFrom(page, '/views/jobs/list', () => page.locator('#job-filter').selectOption('skipped'));
  await page.locator('[data-action=restore]').waitFor();
  await requestFrom(page, '/api/jobs/1/restore', () => page.locator('[data-action=restore]').click());
  await requestFrom(page, '/views/jobs/list', () => page.locator('#job-filter').selectOption('all'));
  await requestFrom(page, '/views/jobs/list', () => page.locator('#job-search').fill(''));
  await requestFrom(page, '/views/jobs/list', () => page.locator('#match-only').check());
  await page.waitForFunction(() => document.querySelectorAll('.job-card').length === 1);
  await requestFrom(page, '/views/jobs/1', () => page.locator('[data-action=view-job][data-id="1"]').click());
  await page.locator('#job-dialog[open]').waitFor();
  await requestFrom(page, '/api/jobs/1/prepare', () => page.locator('#job-dialog [data-action=prepare]').click(), 201);
  await page.locator('#application-1').waitFor();
  await page.locator('#application-1 .ats-panel').getByText('Passed', { exact: true }).waitFor();
  assert.match(await page.locator('#application-1 .ats-panel').innerText(), /Profile email is present as text/);
  assert.equal(await page.locator('#job-dialog').evaluate((element) => element.open), false);
  assert.equal(await page.locator('#review-count').innerText(), '1');
  await page.locator('[data-view=jobs].nav-item').click();
  await requestFrom(page, '/api/jobs/2/prepare', () => page.locator('[data-action=prepare][data-id="2"]').click(), 201);
  await page.locator('#application-2').waitFor();
  const edited = `${draft.tailoredCv}\n- Reviewed and edited by the candidate.`;
  await page.locator('#application-2 [name=tailoredCv]').fill(`${edited}\nUnsubmitted second edit.`);
  await page.locator('#application-1 [name=tailoredCv]').fill(edited);
  await requestFrom(page, '/api/applications/1', () => page.locator('#application-1 [data-action=save-draft]').click());
  assert.match(await page.locator('#application-2 [name=tailoredCv]').inputValue(), /Unsubmitted second edit/);
  await page.locator('#application-1 [name=tailoredCv]').fill(' '.repeat(110));
  page.once('dialog', (dialog) => dialog.accept());
  await requestFrom(page, '/api/applications/1/approve', () => page.locator('#application-1 [data-action=approve]').click(), 400);
  assert.equal((await state()).applications.find((item) => item.id === 1).status, 'draft');
  assert.match(await page.locator('#application-2 [name=tailoredCv]').inputValue(), /Unsubmitted second edit/);
  await page.locator('#application-1 [name=tailoredCv]').fill(`${edited}\nFinal approved version.`);
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('#application-1 [data-action=approve]').click();
  assert.equal((await state()).applications.find((item) => item.id === 1).status, 'draft');
  page.once('dialog', (dialog) => dialog.accept());
  await requestFrom(page, '/api/applications/1/approve', () => page.locator('#application-1 [data-action=approve]').click());
  await page.locator('#view-applications').waitFor();
  assert.equal(await page.locator('#review-count').innerText(), '1');
  assert.match((await state()).applications.find((item) => item.id === 1).tailored_cv, /Final approved version/);
  assert.equal((await state()).applications.find((item) => item.id === 2).tailored_cv, draft.tailoredCv);
  const pdf = await fetch(`${baseUrl}/api/applications/1/pdf`);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  await page.locator('#application-1 .ats-chip').waitFor();
  assert.equal(await page.locator('#application-1 .ats-chip').textContent(), 'ATS: Passed');

  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('[data-action=assist][data-id="1"]').click();
  assert.equal(portalVisits, 0);
  const uploaded = once(events, 'upload', { signal: AbortSignal.timeout(15000) });
  page.once('dialog', (dialog) => dialog.accept());
  await requestFrom(page, '/api/applications/1/assist', () => page.locator('[data-action=assist][data-id="1"]').click());
  const [snapshot] = await uploaded;
  assert.equal(snapshot.name, 'Test Candidate');
  assert.equal(snapshot.email, 'candidate@example.com');
  assert.equal(snapshot.salary, '');
  await page.locator('#assist-result').getByText(/CV attached/).waitFor();
  assert.equal((await state()).applications.find((item) => item.id === 1).status, 'approved');
  assert.equal((await state()).metrics.companiesApplied, 0);
  await page.locator('#activity-list').getByText('Browser assistance opened', { exact: true }).waitFor();
  const approved = await fetch(`${baseUrl}/api/applications/2/approve`, { method: 'POST' });
  assert.equal((await approved.json()).status, 'approved');
  await page.locator('[data-view=applications].nav-item').click();
  await page.locator('[data-action=assist][data-id="2"]').waitFor();
  page.once('dialog', (dialog) => dialog.accept());
  await requestFrom(page, '/api/applications/2/assist', () => page.locator('[data-action=assist][data-id="2"]').click());
  await page.getByText('Paused. Handle login or CAPTCHA yourself, then select Assisted apply again.', { exact: true }).waitFor();
  const earlyOutcome = await fetch(`${baseUrl}/api/applications/1/outcome`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outcome: 'interview' }),
  });
  assert.equal(earlyOutcome.status, 409);
  assert.equal((await state()).applications.find((item) => item.id === 1).outcome, null);
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('[data-action=submitted][data-id="1"]').click();
  assert.equal((await state()).applications.find((item) => item.id === 1).status, 'approved');
  page.once('dialog', (dialog) => dialog.accept());
  await requestFrom(page, '/api/applications/1/submit', () => page.locator('[data-action=submitted][data-id="1"]').click());
  await page.locator('.status.submitted').waitFor();
  assert.equal(portalSubmissions, 0);
  assert.equal((await state()).applications.find((item) => item.id === 1).status, 'submitted');
  assert.equal(await page.locator('#companies-applied').innerText(), '1');
  assert.equal(await page.locator('#submitted-total').innerText(), '1');
  assert.equal(await page.locator('.submitted-date').count(), 1);
  const submittedAt = (await state()).applications.find((item) => item.id === 1).submitted_at;
  assert.equal((await fetch(`${baseUrl}/api/applications/1/submit`, { method: 'POST' })).status, 409);
  assert.equal((await state()).applications.find((item) => item.id === 1).submitted_at, submittedAt);
  page.once('dialog', (dialog) => dialog.accept());
  await requestFrom(page, '/api/applications/2/submit', () => page.locator('[data-action=submitted][data-id="2"]').click());
  await page.waitForFunction(() => document.querySelector('#submitted-total').textContent === '2');
  assert.equal(await page.locator('#companies-applied').innerText(), '1');
  const activity = await (await fetch(`${baseUrl}/api/activity`)).json();
  assert.equal(activity.events.filter((item) => item.kind === 'submitted').length, 2);
  assert(activity.events.some((item) => item.kind === 'assist_paused'));
  assert.equal((await fetch(`${baseUrl}/api/activity?before=invalid`)).status, 400);
  assert.equal(portalSubmissions, 0);
  assert.equal(await page.locator('#funnel-applied').innerText(), '2');
  assert.equal(await page.locator('#funnel-interviews').innerText(), '0');
  const invalidOutcome = await fetch(`${baseUrl}/api/applications/1/outcome`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outcome: 'unknown' }),
  });
  assert.equal(invalidOutcome.status, 400);
  await page.locator('#application-1 .outcome-editor summary').click();
  await page.locator('#application-1 [name=outcome]').selectOption('interview');
  await page.locator('#application-1 [name=detail]').fill('Recruiter screen scheduled');
  await requestFrom(page, '/api/applications/1/outcome', () => page.locator('#application-1 .outcome-form button').click(), 201);
  await page.waitForFunction(() => document.querySelector('#funnel-interviews')?.textContent === '1');
  assert.equal(await page.locator('#application-1 .outcome-badge').textContent(), 'Interview');
  assert.match(await page.locator('#application-1 .outcome-detail').innerText(), /Recruiter screen scheduled/);
  assert.match(await page.locator('#activity-list').innerText(), /Interview recorded/);
  const recorded = (await state()).applications.find((item) => item.id === 1);
  assert.equal(recorded.outcome, 'interview');
  assert.equal(recorded.outcome_detail, 'Recruiter screen scheduled');
  const outcomeMetrics = (await state()).metrics;
  assert.equal(outcomeMetrics.interviews, 1);
  assert.equal(outcomeMetrics.offers, 0);
  assert.equal(outcomeMetrics.awaitingOutcome, 1);
  assert.equal(outcomeMetrics.followUpDue, 0);
  assert.equal(portalSubmissions, 0);
  if (process.env.PROOFLOOP_SCREENSHOT_DIRECTORY) {
    await page.locator('#toast:not(.show)').waitFor({ state: 'attached' });
    await page.screenshot({ path: path.join(process.env.PROOFLOOP_SCREENSHOT_DIRECTORY, 'desktop.png'), fullPage: true, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (process.env.PROOFLOOP_SCREENSHOT_DIRECTORY) await page.screenshot({ path: path.join(process.env.PROOFLOOP_SCREENSHOT_DIRECTORY, 'mobile.png'), fullPage: true, animations: 'disabled' });
  await page.locator('[data-view=jobs].nav-item').click();
  await page.locator('.discovery-panel summary').click();
  const searchForm = page.locator('#jobspy-search');
  await searchForm.locator('[name=site]').selectOption('linkedin');
  await searchForm.locator('[name=searchTerm]').fill('Platform Engineer');
  await searchForm.locator('[name=location]').fill('Bengaluru');
  await requestFrom(page, '/api/search', () => searchForm.locator('button').click());
  await page.locator('#jobspy-result').getByText(/Some listings were blocked/).waitFor();
  assert.match(await page.locator('#jobspy-result').innerText(), /2 usable openings returned/);
  assert.match(await page.locator('#jobspy-result').innerText(), /Partial fixture results/);
  assert.equal(await page.locator('#jobspy-search [name=searchTerm]').inputValue(), 'Platform Engineer');
  const discovered = (await state()).jobs.filter((item) => item.source === 'jobspy:linkedin');
  assert.equal(discovered.length, 2);
  assert.equal((await state()).metrics.companiesApplied, 1);
  const noDescription = discovered.find((item) => !item.description);
  assert.equal(await page.locator(`[data-action=prepare][data-id="${noDescription.id}"]`).isDisabled(), true);
  assert.equal((await fetch(`${baseUrl}/api/jobs/${noDescription.id}/prepare`, { method: 'POST' })).status, 400);
  await requestFrom(page, '/api/search', () => page.locator('#jobspy-search button').click(), 429);
  await page.getByText('JobSpy search is busy or cooling down. Wait at least 60 seconds between searches.', { exact: true }).waitFor();
  assert.equal(await page.locator('#jobspy-search [name=searchTerm]').inputValue(), 'Platform Engineer');
  const invalidSearch = await fetch(`${baseUrl}/api/search`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ site: 'naukri', searchTerm: 'Engineer', location: 'Pune' }),
  });
  assert.equal(invalidSearch.status, 400);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (process.env.PROOFLOOP_SCREENSHOT_DIRECTORY) {
    await page.locator('#toast:not(.show)').waitFor({ state: 'attached' });
    await page.screenshot({ path: path.join(process.env.PROOFLOOP_SCREENSHOT_DIRECTORY, 'discovery-mobile.png'), fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: path.join(process.env.PROOFLOOP_SCREENSHOT_DIRECTORY, 'discovery-desktop.png'), fullPage: true, animations: 'disabled' });
  }
  assert.deepEqual(errors, []);
  assert(!requestedPaths.includes('/api/state'));
});

test.after(async () => {
  await browser?.close();
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(15000) });
    child.send('close');
    await exited;
  }
  if (portal.listening) {
    const closed = once(portal, 'close');
    portal.close();
    await closed;
  }
  await rm(directory, { recursive: true, force: true });
});
