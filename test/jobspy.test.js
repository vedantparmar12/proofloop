import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { jobspySearchSchema, normalizeJobspyResult } from '../src/jobspy.js';
import { renderJob } from '../src/views.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const moduleUrl = new URL('../src/jobspy.js', import.meta.url).href;
const workerPath = fileURLToPath(new URL('../src/jobspy_worker.py', import.meta.url));
const searchInput = { site: 'indeed', searchTerm: 'Backend Engineer', location: 'Bengaluru' };

function row(overrides = {}) {
  return {
    id: 'job-1', site: 'indeed', job_url: 'https://indeed.example.test/viewjob?jk=1',
    job_url_direct: 'https://careers.example.test/jobs/1', title: '  Backend Engineer  ',
    company: '  Example Company  ', location: 'Bengaluru',
    description: '<p>Build <strong>APIs</strong> &amp; services.</p>', date_posted: '2026-10-25',
    ...overrides,
  };
}

function payload(jobs = [], overrides = {}) {
  return { jobs, errors: {}, warnings: {}, ...overrides };
}

function normalize(jobs, site = 'indeed') {
  return normalizeJobspyResult(payload(jobs), site);
}

const digest = (value) => createHash('sha256').update(value).digest('hex');

test('JobSpy schema trims required text and applies bounded defaults for both providers', () => {
  for (const site of ['indeed', 'linkedin']) {
    assert.deepEqual(jobspySearchSchema.parse({ ...searchInput, site, searchTerm: '  Backend Engineer  ', location: '\tBengaluru\n' }), {
      site, searchTerm: 'Backend Engineer', location: 'Bengaluru', country: 'india', resultsWanted: 15, hoursOld: 168,
    });
  }
  for (const country of ['india', 'usa', 'uk', 'canada', 'australia', 'germany', 'france']) {
    assert.equal(jobspySearchSchema.parse({ ...searchInput, country }).country, country);
  }
  for (const [resultsWanted, hoursOld] of [[1, 1], [25, 720], ['1', '1'], ['25', '720']]) {
    const parsed = jobspySearchSchema.parse({ ...searchInput, resultsWanted, hoursOld });
    assert.equal(parsed.resultsWanted, Number(resultsWanted));
    assert.equal(parsed.hoursOld, Number(hoursOld));
  }
  for (const [field, maximum] of [['searchTerm', 200], ['location', 160]]) {
    for (const length of [2, maximum]) {
      assert.equal(jobspySearchSchema.parse({ ...searchInput, [field]: `  ${'x'.repeat(length)}  ` })[field], 'x'.repeat(length));
    }
  }
});

test('JobSpy schema rejects unsupported providers, countries, and invalid required text', () => {
  for (const site of ['glassdoor', 'google', 'zip_recruiter', 'Indeed', 'indeed,linkedin', ['indeed'], '', null, undefined]) {
    assert.equal(jobspySearchSchema.safeParse({ ...searchInput, site }).success, false, `site: ${site}`);
  }
  for (const country of ['India', 'us', 'unsupported', '', null]) {
    assert.equal(jobspySearchSchema.safeParse({ ...searchInput, country }).success, false);
  }
  for (const [field, maximum] of [['searchTerm', 200], ['location', 160]]) {
    for (const value of [undefined, null, 123, [], {}, '', ' ', 'x', ' x ', 'x'.repeat(maximum + 1)]) {
      assert.equal(jobspySearchSchema.safeParse({ ...searchInput, [field]: value }).success, false, `${field}: ${String(value)}`);
    }
  }
  for (const input of [undefined, null, [], {}, 'indeed']) {
    assert.equal(jobspySearchSchema.safeParse(input).success, false);
  }
});

test('JobSpy schema rejects zero, excessive, fractional and nonnumeric limits', () => {
  for (const [field, maximum] of [['resultsWanted', 25], ['hoursOld', 720]]) {
    for (const value of [0, -1, maximum + 1, 1.5, '1.5', String(maximum + 1), '', ' ', 'nope', null, NaN, Infinity, -Infinity]) {
      assert.equal(jobspySearchSchema.safeParse({ ...searchInput, [field]: value }).success, false, `${field}: ${String(value)}`);
    }
  }
});

test('JobSpy settings are strict and cannot override the worker, execution or provider options', () => {
  for (const key of [
    'unknown', 'python', 'worker', 'command', 'executable', 'args', 'shell', 'env', 'timeout', 'maxBuffer',
    'JOBSPY_PYTHON', 'proxy', 'proxies', 'cookies', 'headers', 'username', 'password',
    'site_name', 'search_term', 'results_wanted', 'hours_old', 'offset', 'linkedin_fetch_description',
  ]) {
    const result = jobspySearchSchema.safeParse({ ...searchInput, [key]: 'not allowed' });
    assert.equal(result.success, false, key);
    assert.ok(result.error.issues.some((issue) => issue.code === 'unrecognized_keys' && issue.keys.includes(key)), key);
  }
});

test('JobSpy rows normalize provider identity, direct links, text and UTC dates without mutating input', () => {
  for (const site of ['indeed', 'linkedin']) {
    const input = payload([row({ site, job_url_direct: 'HTTPS://Careers.Example.Test:443/jobs/1' })]);
    const before = structuredClone(input);
    assert.deepEqual(normalizeJobspyResult(input, site), {
      jobs: [{
        source: `jobspy:${site}`, sourceJobId: 'job-1', url: 'https://careers.example.test/jobs/1',
        title: 'Backend Engineer', company: 'Example Company', location: 'Bengaluru',
        description: 'Build APIs & services.', postedAt: '2026-10-25T00:00:00.000Z',
      }],
      errors: {}, warnings: {}, skipped: 0,
    });
    assert.deepEqual(input, before);
  }
});

test('JobSpy permits missing optional text and hashes missing identifiers deterministically', () => {
  for (const empty of [undefined, null, '']) {
    const input = row({ id: empty, job_url_direct: empty, location: empty, description: empty, date_posted: empty });
    const result = normalize([input]);
    assert.equal(result.skipped, 0);
    assert.equal(result.jobs[0].sourceJobId, digest(input.job_url));
    assert.equal(result.jobs[0].url, input.job_url);
    assert.equal(result.jobs[0].location, '');
    assert.equal(result.jobs[0].description, '');
    assert.equal(result.jobs[0].postedAt, null);
    assert.deepEqual(normalize([input]), result);
    assert.match(renderJob({ ...result.jobs[0], id: 1, match_score: 0 }), /Description unavailable/);
  }
  const directOnly = row({ id: null, job_url: null });
  assert.equal(normalize([directOnly]).jobs[0].sourceJobId, digest(directOnly.job_url_direct));
  assert.equal(normalize([row({ id: null })]).jobs[0].sourceJobId, digest(row().job_url));
});

test('JobSpy rejects unsafe or absent URLs and falls back only to credential-free HTTPS', () => {
  for (const unsafe of [
    null, undefined, '', 'not a URL', '/jobs/1', '//example.test/jobs/1',
    'http://example.test/jobs/1', 'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
    'file:///tmp/jobs', 'ftp://example.test/jobs/1',
    'https://user@example.test/jobs/1', 'https://:secret@example.test/jobs/1',
    'https://user:secret@example.test/jobs/1', 'https://%75ser@example.test/jobs/1',
  ]) {
    assert.deepEqual(normalize([row({ job_url: unsafe, job_url_direct: unsafe })]), {
      jobs: [], errors: {}, warnings: {}, skipped: 1,
    }, String(unsafe));
    assert.equal(normalize([row({ job_url_direct: unsafe })]).jobs[0].url, row().job_url);
    assert.equal(normalize([row({ job_url: unsafe })]).jobs[0].url, row().job_url_direct);
  }
});

test('JobSpy skips empty required metadata and mismatched sites without consuming their identifiers', () => {
  for (const field of ['title', 'company']) {
    for (const value of [null, undefined, '', ' \n\t ']) {
      const result = normalize([row({ [field]: value }), row()]);
      assert.equal(result.skipped, 1, `${field}: ${String(value)}`);
      assert.equal(result.jobs.length, 1);
    }
  }
  for (const site of ['indeed', 'linkedin']) {
    const other = site === 'indeed' ? 'linkedin' : 'indeed';
    const result = normalize([row({ site: other }), row({ site })], site);
    assert.equal(result.skipped, 1);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].source, `jobspy:${site}`);
  }
});

test('JobSpy deduplicates explicit and generated IDs, keeping the first valid row without counting duplicates as skipped', () => {
  const result = normalize([
    row(), row({ title: 'Later duplicate', job_url_direct: 'https://other.example.test/1' }),
    row({ id: 'job-2' }),
    row({ id: null }), row({ id: undefined, job_url_direct: 'https://other.example.test/2' }), row({ id: '' }),
    row({ id: 'invalid', title: null }),
  ]);
  assert.deepEqual(result.jobs.map((job) => job.sourceJobId), ['job-1', 'job-2', digest(row().job_url)]);
  assert.ok(result.jobs.every((job) => job.title === 'Backend Engineer'));
  assert.ok(result.jobs.every((job) => job.url === row().job_url_direct));
  assert.equal(result.skipped, 1);
});

test('JobSpy bounds external text and treats invalid or absent dates as unknown', () => {
  const job = normalize([row({ company: ` ${'c'.repeat(301)} `, title: ` ${'t'.repeat(501)} `, location: 'l'.repeat(501), description: 'd'.repeat(100001) })]).jobs[0];
  assert.equal(job.company, 'c'.repeat(300));
  assert.equal(job.title, 't'.repeat(500));
  assert.equal(job.location, 'l'.repeat(500));
  assert.equal(job.description, 'd'.repeat(60000));
  assert.equal(normalize([row({ description: `${' '.repeat(100000)}outside-input-limit` })]).jobs[0].description, '');
  for (const date_posted of [null, undefined, '', 'not-a-date', '2026-99-99', 'Infinity']) {
    assert.equal(normalize([row({ date_posted })]).jobs[0].postedAt, null);
  }
  assert.equal(normalize([row({ date_posted: '2026-10-25T12:30:00+05:30' })]).jobs[0].postedAt, '2026-10-25T07:00:00.000Z');
  assert.equal(normalize([row({ date_posted: '2026-10-25T00:00:00.000' })]).jobs[0].postedAt, '2026-10-25T00:00:00.000Z');
});

test('JobSpy strips description HTML while the UI escapes external metadata and decoded markup', () => {
  const hostile = `\"><img src=x onerror="alert(1)">&'`;
  const escaped = '&quot;&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;';
  const job = normalize([row({
    title: hostile, company: hostile, location: hostile,
    job_url_direct: 'https://careers.example.test/jobs/1?a=1&b=2',
    description: '<p>Build <strong>APIs</strong> &amp; services.</p><script>alert("script")</script><style>body{}</style><p><a href="javascript:alert(1)">Apply</a><img src=x onerror="alert(1)"></p><p>&lt;img src=x onerror=alert(2)&gt;</p>',
  })]).jobs[0];
  assert.equal(job.title, hostile);
  assert.equal(job.company, hostile);
  assert.equal(job.location, hostile);
  assert.equal(job.description, 'Build APIs & services.\n\nApply\n\n<img src=x onerror=alert(2)>');
  const html = renderJob({ ...job, id: 1, match_score: 80 });
  assert.ok(html.includes(`<h2>${escaped}</h2>`));
  assert.ok(html.includes(`<p>${escaped}</p>`));
  assert.ok(html.includes(`<p class="eyebrow">${escaped} · 80% heuristic match</p>`));
  assert.ok(html.includes('Build APIs &amp; services.\n\nApply\n\n&lt;img src=x onerror=alert(2)&gt;'));
  assert.ok(html.includes('href="https://careers.example.test/jobs/1?a=1&amp;b=2"'));
  assert.doesNotMatch(html, /<(?:img|script|style)\b|javascript:|onerror="|alert\("script"\)/i);
});

test('JobSpy preserves empty results and partial provider errors and warnings', () => {
  assert.deepEqual(normalize([]), { jobs: [], errors: {}, warnings: {}, skipped: 0 });
  const diagnostics = {
    errors: { indeed: 'Some listings were blocked', linkedin: 'Unavailable' },
    warnings: { indeed: ['Partial results', '<b>External warning</b>'], linkedin: [], worker: ['Provider limits apply'] },
  };
  for (const jobs of [[], [row()], [row({ company: null })]]) {
    const input = payload(jobs, diagnostics);
    const before = structuredClone(input);
    const result = normalizeJobspyResult(input, 'indeed');
    assert.deepEqual(result.errors, diagnostics.errors);
    assert.deepEqual(result.warnings, diagnostics.warnings);
    assert.equal(result.jobs.length, jobs.length && jobs[0].company ? 1 : 0);
    assert.equal(result.skipped, jobs.length && !jobs[0].company ? 1 : 0);
    assert.deepEqual(input, before);
  }
});

test('JobSpy validates the entire response shape and enforces the 25-row limit', () => {
  const maximum = Array.from({ length: 25 }, (_, index) => row({ id: `job-${index}` }));
  assert.equal(normalize(maximum).jobs.length, 25);
  for (const invalid of [
    null, [], {}, { jobs: [] }, { jobs: [], errors: {} },
    payload(null), payload({}), payload([...maximum, row({ id: 'overflow' })]),
    payload([row(), null]), payload([row({ site: 'glassdoor' })]), payload([row({ site: null })]),
    ...['id', 'job_url', 'job_url_direct', 'title', 'company', 'location', 'description', 'date_posted'].map((field) => payload([row({ [field]: 42 })])),
    payload([], { errors: null }), payload([], { errors: [] }), payload([], { errors: { indeed: 42 } }),
    payload([], { warnings: null }), payload([], { warnings: [] }),
    payload([], { warnings: { indeed: 'not an array' } }), payload([], { warnings: { indeed: [42] } }),
  ]) {
    assert.throws(() => normalizeJobspyResult(invalid, 'indeed'), { name: 'ZodError' });
  }
});

// Runtime-only fixtures: the executable is Bun, never Python, and it never runs the .py argument.
const fixtureSource = `
  const { appendFileSync } = require('node:fs');
  const rawInput = await Bun.stdin.text();
  const mode = process.env.JOBSPY_TEST_MODE;
  appendFileSync(process.env.JOBSPY_TEST_CAPTURE, JSON.stringify({
    args: process.argv.slice(2), input: JSON.parse(rawInput), rawInput, mode,
    env: { PYTHONIOENCODING: process.env.PYTHONIOENCODING, PYTHONUTF8: process.env.PYTHONUTF8 }
  }) + '\\n');
  if (mode === 'nonzero') { console.error('private worker diagnostic'); process.exit(7); }
  if (mode === 'corrupt') { console.log('not JSON'); process.exit(0); }
  if (mode === 'invalid-shape') { console.log(JSON.stringify({ jobs: [] })); process.exit(0); }
  if (mode === 'timeout') await new Promise(resolve => setTimeout(resolve, 2500));
  console.log(process.env.JOBSPY_TEST_PAYLOAD);
`;

// Isolate mocks and virtual time; record the real timeout before shortening it for the fixture.
const bridgeSource = `
  import { mock } from 'bun:test';
  const { execa: realExeca } = await import('execa');
  const calls = [];
  mock.module('execa', () => ({ execa: (file, args, options) => {
    calls.push(structuredClone({ file, args, options }));
    return realExeca(file, args, process.env.JOBSPY_TEST_MODE === 'timeout' ? { ...options, timeout: 1000 } : options);
  } }));
  let now = 1800000000000;
  Date.now = () => now;
  if (process.env.JOBSPY_TEST_MODE === 'default-venv') delete process.env.JOBSPY_PYTHON;
  const { searchJobspy } = await import(${JSON.stringify(moduleUrl)});
  const input = JSON.parse(process.env.JOBSPY_TEST_INPUT);
  async function outcome(action) {
    try { return { value: await action() }; }
    catch (error) { return { error: { name: error.name, message: error.message, status: error.status ?? null } }; }
  }
  const invalid = await outcome(() => searchJobspy({ ...input, proxies: ['not permitted'] }));
  const callsAfterInvalid = calls.length;
  const pending = outcome(() => searchJobspy(input));
  now += 5000;
  const concurrent = await outcome(() => searchJobspy({ ...input, site: input.site === 'indeed' ? 'linkedin' : 'indeed' }));
  const first = await pending;
  const cooling = await outcome(() => searchJobspy(input));
  now += 59999;
  const beforeDeadline = await outcome(() => searchJobspy(input));
  const callsBeforeRetry = calls.length;
  now += 1;
  process.env.JOBSPY_TEST_MODE = 'success';
  const retry = await outcome(() => searchJobspy(input));
  console.log(JSON.stringify({ invalid, callsAfterInvalid, concurrent, first, cooling, beforeDeadline, callsBeforeRetry, retry, calls }));
`;

async function runBridge(mode, response = payload(), input = searchInput) {
  const directory = await mkdtemp(path.join(tmpdir(), 'proofloop jobspy test '));
  const fixture = path.join(directory, 'fixture.cjs');
  const executable = path.join(directory, process.platform === 'win32' ? 'python-shim.cmd' : 'python-shim');
  const capture = path.join(directory, 'calls.jsonl');
  const missing = path.join(directory, process.platform === 'win32' ? 'missing-python.exe' : 'missing-python');
  const python = mode === 'missing' ? missing : executable;
  const expectedPython = mode === 'default-venv'
    ? path.join(directory, 'jobspy-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    : python;
  const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  try {
    await writeFile(fixture, fixtureSource);
    await writeFile(capture, '');
    await writeFile(executable, process.platform === 'win32'
      ? `@"${process.execPath}" "${fixture}" %*\r\n@exit /b %errorlevel%\r\n`
      : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixture)} "$@"\n`, { mode: 0o755 });
    const child = await execa(process.execPath, ['--input-type=module', '-e', bridgeSource], {
      cwd: root, timeout: 15000,
      env: {
        DATA_DIRECTORY: directory, JOBSPY_PYTHON: python, JOBSPY_TEST_MODE: mode,
        JOBSPY_TEST_INPUT: JSON.stringify(input), JOBSPY_TEST_PAYLOAD: JSON.stringify(response), JOBSPY_TEST_CAPTURE: capture,
      },
    });
    const report = JSON.parse(child.stdout);
    const captured = (await readFile(capture, 'utf8')).trim();
    return { ...report, captured: captured ? captured.split(/\r?\n/).map((line) => JSON.parse(line)) : [], expectedPython };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function assertBridgeContract(report, input) {
  const settings = jobspySearchSchema.parse(input);
  assert.equal(report.invalid.error.name, 'ZodError');
  assert.equal(report.callsAfterInvalid, 0, 'Invalid settings must not launch the worker or consume cooldown');
  for (const result of [report.concurrent, report.cooling, report.beforeDeadline]) {
    assert.equal(result.error.status, 429);
    assert.match(result.error.message, /busy or cooling down.*60 seconds/);
  }
  assert.equal(report.callsBeforeRetry, 1, 'Running/cooling searches must not spawn or automatically retry');
  assert.equal(report.calls.length, 2, 'A new attempt is permitted at exactly 60 seconds after completion');
  for (const call of report.calls) {
    assert.equal(call.file, report.expectedPython);
    assert.deepEqual(call.args, [workerPath], 'The worker path is fixed; settings belong on stdin, not argv');
    assert.deepEqual(call.options, {
      input: JSON.stringify(settings), timeout: 90000, maxBuffer: 4 * 1024 * 1024,
      windowsHide: true, env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
  }
  for (const invocation of report.captured) {
    assert.deepEqual(invocation.args, [workerPath]);
    assert.deepEqual(invocation.input, settings);
    assert.equal(invocation.rawInput, JSON.stringify(settings));
    assert.deepEqual(invocation.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' });
  }
}

test('JobSpy bridge uses the configured executable, fixed worker and JSON stdin, then enforces one search and cooldown', { timeout: 20000 }, async () => {
  const input = { ...searchInput, site: 'linkedin', searchTerm: '  Engineer & "systems"; $(not-a-command)  ', location: '  München  ', resultsWanted: '25', hoursOld: '720' };
  const response = payload([
    row({ site: 'linkedin' }), row({ site: 'linkedin', title: 'Duplicate' }),
    row({ id: 'invalid', site: 'linkedin', job_url_direct: 'javascript:alert(1)', job_url: null }),
    row({ id: 'wrong-site' }),
  ], { errors: { linkedin: 'Some listings blocked' }, warnings: { linkedin: ['Partial results'] } });
  const report = await runBridge('success', response, input);
  assertBridgeContract(report, input);
  assert.deepEqual(report.first.value, normalizeJobspyResult(response, 'linkedin'));
  assert.equal(report.first.value.jobs.length, 1);
  assert.equal(report.first.value.skipped, 2);
  assert.deepEqual(report.retry, report.first);
  assert.equal(report.captured.length, 2);
});

for (const [mode, message] of [
  ['corrupt', 'JobSpy returned an invalid response. No results were imported.'],
  ['invalid-shape', 'JobSpy returned an invalid response. No results were imported.'],
  ['nonzero', 'JobSpy worker failed. Run bun run setup:jobspy and check the search settings. No results were imported.'],
  ['timeout', 'JobSpy timed out after 90 seconds. No results were imported; try later or use company boards.'],
  ['missing', 'JobSpy is not installed. Run bun run setup:jobspy, then retry.'],
  ['default-venv', 'JobSpy is not installed. Run bun run setup:jobspy, then retry.'],
]) {
  test(`JobSpy bridge handles ${mode} without importing results and releases the lock only after cooldown`, { timeout: 20000 }, async () => {
    const report = await runBridge(mode);
    assertBridgeContract(report, searchInput);
    assert.deepEqual(report.first, { error: { name: 'Error', message, status: null } });
    if (mode === 'missing' || mode === 'default-venv') {
      assert.deepEqual(report.retry, report.first);
      assert.deepEqual(report.captured, []);
    } else {
      assert.deepEqual(report.retry, { value: { jobs: [], errors: {}, warnings: {}, skipped: 0 } });
      assert.equal(report.captured.length, 2);
      assert.deepEqual(report.captured.map((invocation) => invocation.mode), [mode, 'success']);
    }
  });
}
