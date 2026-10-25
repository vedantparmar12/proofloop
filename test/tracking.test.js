import { afterAll, beforeEach, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const directory = mkdtempSync(path.join(tmpdir(), 'proofloop-tracking-'));
const previousDirectory = process.env.DATA_DIRECTORY;
process.env.DATA_DIRECTORY = directory;
const {
  db, createApplication, getApplication, listApplications, updateDraft, setApplicationStatus,
  recordApplicationEvent, recordOutcome, listApplicationEvents, getApplicationMetrics,
} = await import('../src/db.js');
const draft = {
  tailoredCv: 'Private CV: candidate@example.com, +44 1234 567890',
  recruiterMessage: 'Private recruiter message',
  coverLetter: 'Private cover letter',
};
// SQLite's Windows clock can lag Bun's higher-resolution clock by one timer tick.
const clockToleranceMs = 100;
let jobSequence = 0;

function addJob(company = 'Example Company') {
  const result = db.prepare(`
    INSERT INTO jobs (source, source_job_id, company, title, url, description)
    VALUES ('lever', ?, ?, 'Engineer', 'https://example.com/jobs/1', 'Job description')
  `).run(String(++jobSequence), company);
  return result.lastInsertRowid;
}

function create(company) {
  return createApplication(addJob(company), draft, '/private/candidate-cv.pdf');
}

function eventsFor(id) {
  return db.prepare('SELECT * FROM application_events WHERE application_id = ? ORDER BY id').all(id);
}

function assertIsoUtc(timestamp) {
  assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(new Date(timestamp).toISOString(), timestamp);
}

beforeEach(() => {
  db.exec('DELETE FROM application_events; DELETE FROM applications; DELETE FROM jobs;');
});

afterAll(() => {
  db.close();
  if (previousDirectory === undefined) delete process.env.DATA_DIRECTORY;
  else process.env.DATA_DIRECTORY = previousDirectory;
  rmSync(directory, { recursive: true, force: true });
});

test('starts empty and logs draft creation without copying CV or contact data', () => {
  assert.deepEqual(listApplicationEvents(), { events: [], nextBefore: null });
  assert.deepEqual(getApplicationMetrics(), {
    drafts: 0, approved: 0, submitted: 0, companiesApplied: 0,
    interviews: 0, offers: 0, hired: 0, closed: 0, awaitingOutcome: 0, followUpDue: 0,
  });
  const started = Date.now();
  const application = create();
  assert.equal(application.status, 'draft');
  assert.equal(application.submitted_at, null);
  const { events, nextBefore } = listApplicationEvents();
  assert.equal(nextBefore, null);
  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0]).sort(), [
    'application_id', 'company', 'detail', 'id', 'kind', 'occurred_at', 'title',
  ]);
  assert.equal(events[0].application_id, application.id);
  assert.equal(events[0].company, 'Example Company');
  assert.equal(events[0].title, 'Engineer');
  assert.equal(events[0].kind, 'draft_created');
  assert.equal(events[0].detail, '');
  assertIsoUtc(events[0].occurred_at);
  assert(Date.parse(events[0].occurred_at) >= started - clockToleranceMs);
  assert(Date.parse(events[0].occurred_at) <= Date.now() + clockToleranceMs);
});

test('guards status transitions and preserves timestamps and logs on retries or downgrades', () => {
  const application = create();
  for (const status of ['submitted', 'draft', 'unknown']) {
    assert.deepEqual(setApplicationStatus(application.id, status), application);
  }
  assert.equal(eventsFor(application.id).length, 1);

  setApplicationStatus(application.id, 'approved');
  db.prepare("UPDATE applications SET updated_at = '2001-01-01 01:01:01' WHERE id = ?").run(application.id);
  const approved = getApplication(application.id);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.submitted_at, null);
  for (const status of ['approved', 'draft', 'unknown']) {
    assert.deepEqual(setApplicationStatus(application.id, status), approved);
  }

  const submitted = setApplicationStatus(application.id, 'submitted');
  assert.equal(submitted.status, 'submitted');
  assertIsoUtc(submitted.submitted_at);
  assert.equal(eventsFor(application.id).at(-1).occurred_at, submitted.submitted_at);
  // Distinct fixed timestamps make this check independent of clock resolution.
  db.prepare(`
    UPDATE applications SET submitted_at = '2002-02-02T02:02:02.000Z',
      updated_at = '2002-02-02 02:02:02' WHERE id = ?
  `).run(application.id);
  const fixed = getApplication(application.id);
  const logged = eventsFor(application.id);
  for (const status of ['submitted', 'submitted', 'approved', 'draft', 'unknown']) {
    assert.deepEqual(setApplicationStatus(application.id, status), fixed);
    assert.deepEqual(eventsFor(application.id), logged);
  }
  assert.deepEqual(logged.map((event) => event.kind), ['draft_created', 'approved', 'submitted']);
  assert(logged.every((event) => event.detail === ''));
  assert.equal(setApplicationStatus(-1, 'approved'), undefined);
});

test('logs each material draft field change but not identical values or timestamp-only edits', () => {
  const application = create();
  let edited = { ...draft };
  let pdfPath = application.pdf_path;
  updateDraft(application.id, edited, pdfPath);
  db.prepare("UPDATE applications SET updated_at = '2000-01-01' WHERE id = ?").run(application.id);
  assert.equal(eventsFor(application.id).length, 1);

  for (const field of ['tailoredCv', 'recruiterMessage', 'coverLetter', 'pdfPath']) {
    if (field === 'pdfPath') pdfPath = '/private/revised-cv.pdf';
    else edited = { ...edited, [field]: `${edited[field]} revised` };
    const count = eventsFor(application.id).length;
    updateDraft(application.id, edited, pdfPath);
    assert.equal(eventsFor(application.id).length, count + 1);
    updateDraft(application.id, edited, pdfPath);
    assert.equal(eventsFor(application.id).length, count + 1);
  }
  assert.deepEqual(eventsFor(application.id).map((event) => event.kind), [
    'draft_created', 'draft_updated', 'draft_updated', 'draft_updated', 'draft_updated',
  ]);
  assert(eventsFor(application.id).every((event) => event.detail === ''));
  const approved = setApplicationStatus(application.id, 'approved');
  const count = eventsFor(application.id).length;
  assert.deepEqual(updateDraft(application.id, draft, 'another.pdf'), approved);
  assert.equal(eventsFor(application.id).length, count);
});

test('SQL writes also log atomically and status assignments without changes do not log', () => {
  const jobId = addJob();
  const { lastInsertRowid: id } = db.prepare(`
    INSERT INTO applications (job_id, tailored_cv, recruiter_message, cover_letter, pdf_path)
    VALUES (?, 'cv', 'message', 'letter', 'cv.pdf')
  `).run(jobId);
  db.prepare("UPDATE applications SET tailored_cv = 'edited', cover_letter = 'edited' WHERE id = ?").run(id);
  db.prepare("UPDATE applications SET status = 'approved' WHERE id = ?").run(id);
  db.prepare("UPDATE applications SET status = 'approved', tailored_cv = 'not a draft' WHERE id = ?").run(id);
  db.prepare("UPDATE applications SET status = 'submitted' WHERE id = ?").run(id);
  db.prepare("UPDATE applications SET status = 'submitted', updated_at = '2000-01-01' WHERE id = ?").run(id);
  assert.deepEqual(eventsFor(id).map((event) => event.kind), [
    'draft_created', 'draft_updated', 'approved', 'submitted',
  ]);
});

test('records internal assists without changing application status and enforces event constraints', () => {
  const application = create();
  const opened = recordApplicationEvent(application.id, 'assist_opened');
  const paused = recordApplicationEvent(application.id, 'assist_paused', 'login-or-captcha');
  const failed = recordApplicationEvent(application.id, 'assist_failed', 'browser-unavailable');
  assert.equal(opened.detail, '');
  assert.equal(paused.detail, 'login-or-captcha');
  assert.equal(failed.detail, 'browser-unavailable');
  for (const event of [opened, paused, failed]) assertIsoUtc(event.occurred_at);
  assert.deepEqual(getApplication(application.id), application);
  for (const kind of ['baseline', 'draft_created', 'draft_updated', 'approved', 'submitted', 'unknown']) {
    assert.throws(() => recordApplicationEvent(application.id, kind), /Only assist events/);
  }
  assert.throws(() => recordApplicationEvent(-1, 'assist_opened'), /FOREIGN KEY/i);
  assert.throws(() => db.prepare(`
    INSERT INTO application_events (application_id, kind) VALUES (?, 'unknown')
  `).run(application.id), /CHECK/i);
  assert.equal(eventsFor(application.id).length, 4);
});

test('records outcomes only after confirmed submission and exposes the latest one', () => {
  const application = create();
  assert.equal(recordOutcome(application.id, 'interview', 'ignored'), undefined);
  setApplicationStatus(application.id, 'approved');
  assert.equal(recordOutcome(application.id, 'interview', 'ignored'), undefined);
  assert.equal(eventsFor(application.id).filter((event) => event.kind.startsWith('outcome')).length, 0);

  const submitted = setApplicationStatus(application.id, 'submitted');
  const interview = recordOutcome(application.id, 'interview', 'Phone screen booked');
  assert.equal(interview.application_id, application.id);
  assert.equal(interview.kind, 'outcome_interview');
  assert.equal(interview.detail, 'Phone screen booked');
  assertIsoUtc(interview.occurred_at);

  let current = getApplication(application.id);
  assert.equal(current.status, 'submitted');
  assert.equal(current.outcome, 'interview');
  assert.equal(current.outcome_detail, 'Phone screen booked');
  assert.equal(current.outcome_at, interview.occurred_at);
  assert.equal(current.submitted_at, submitted.submitted_at);

  const offer = recordOutcome(application.id, 'offer');
  current = getApplication(application.id);
  assert.equal(current.outcome, 'offer');
  assert.equal(current.outcome_detail, '');
  assert.equal(current.outcome_at, offer.occurred_at);
  assert.equal(listApplications().find((item) => item.id === application.id).outcome, 'offer');

  assert.throws(() => recordOutcome(application.id, 'unknown'), /Unknown outcome/);
  assert.throws(() => db.prepare(`
    INSERT INTO application_events (application_id, kind) VALUES (?, 'outcome_unknown')
  `).run(application.id), /CHECK/i);
  assert.equal(recordOutcome(-1, 'interview'), undefined);
  assert.equal(setApplicationStatus(application.id, 'approved').status, 'submitted');
  assert.equal(eventsFor(application.id).filter((event) => event.kind.startsWith('outcome')).length, 2);
});

test('funnel metrics are cumulative and closure follows the latest recorded outcome', () => {
  const pending = create('Pending Co');
  const interviewed = create('Interview Co');
  const rejected = create('Rejected Co');
  const offered = create('Offer Co');
  const hired = create('Hired Co');
  for (const application of [pending, interviewed, rejected, offered, hired]) {
    setApplicationStatus(application.id, 'approved');
    setApplicationStatus(application.id, 'submitted');
  }
  recordOutcome(interviewed.id, 'interview');
  recordOutcome(rejected.id, 'interview');
  recordOutcome(rejected.id, 'rejected');
  recordOutcome(offered.id, 'offer');
  recordOutcome(hired.id, 'hired');
  for (const application of [pending, interviewed]) {
    db.prepare("UPDATE applications SET submitted_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(application.id);
  }

  assert.deepEqual(getApplicationMetrics(), {
    drafts: 0, approved: 0, submitted: 5, companiesApplied: 5,
    interviews: 4, offers: 2, hired: 1, closed: 1, awaitingOutcome: 1, followUpDue: 1,
  });

  recordOutcome(rejected.id, 'withdrawn');
  assert.equal(getApplication(rejected.id).outcome, 'withdrawn');
  assert.deepEqual(getApplicationMetrics(), {
    drafts: 0, approved: 0, submitted: 5, companiesApplied: 5,
    interviews: 4, offers: 2, hired: 1, closed: 1, awaitingOutcome: 1, followUpDue: 1,
  });

  recordOutcome(pending.id, 'no_response');
  assert.deepEqual(getApplicationMetrics(), {
    drafts: 0, approved: 0, submitted: 5, companiesApplied: 5,
    interviews: 4, offers: 2, hired: 1, closed: 2, awaitingOutcome: 0, followUpDue: 0,
  });
});

test('follow-up tracking starts after ten quiet days and ignores invalid dates', async () => {
  const { isFollowUpDue } = await import('../src/outcomes.js');
  assert.equal(isFollowUpDue('2026-01-01T00:00:00.000Z', Date.parse('2026-01-10T23:59:59.000Z')), false);
  assert.equal(isFollowUpDue('2026-01-01T00:00:00.000Z', Date.parse('2026-01-11T00:00:00.000Z')), true);
  assert.equal(isFollowUpDue(null), false);
  assert.equal(isFollowUpDue('not-a-date'), false);
});

test('failed event writes roll back creation, material edits, approval, and submission', () => {
  const rejectEvents = () => db.exec(`
    CREATE TRIGGER reject_tracking_event BEFORE INSERT ON application_events
    BEGIN SELECT RAISE(ABORT, 'tracking unavailable'); END;
  `);
  const allowEvents = () => db.exec('DROP TRIGGER IF EXISTS reject_tracking_event');
  const jobId = addJob();
  try {
    rejectEvents();
    assert.throws(() => createApplication(jobId, draft, 'cv.pdf'), /tracking unavailable/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM applications').get().count, 0);
    assert.equal(listApplicationEvents().events.length, 0);

    allowEvents();
    const application = createApplication(jobId, draft, 'cv.pdf');
    const createdEvents = eventsFor(application.id);
    rejectEvents();
    assert.throws(() => updateDraft(application.id, { ...draft, tailoredCv: 'changed' }, 'cv.pdf'), /tracking unavailable/);
    assert.deepEqual(getApplication(application.id), application);
    assert.throws(() => setApplicationStatus(application.id, 'approved'), /tracking unavailable/);
    assert.deepEqual(getApplication(application.id), application);
    assert.deepEqual(eventsFor(application.id), createdEvents);

    allowEvents();
    const approved = setApplicationStatus(application.id, 'approved');
    const approvedEvents = eventsFor(application.id);
    rejectEvents();
    assert.throws(() => setApplicationStatus(application.id, 'submitted'), /tracking unavailable/);
    assert.deepEqual(getApplication(application.id), approved);
    assert.deepEqual(eventsFor(application.id), approvedEvents);
  } finally {
    allowEvents();
  }
});

test('application and assist events participate in the caller transaction', () => {
  db.exec('BEGIN');
  let id;
  try {
    const application = create();
    id = application.id;
    updateDraft(id, { ...draft, coverLetter: 'revised' }, application.pdf_path);
    setApplicationStatus(id, 'approved');
    recordApplicationEvent(id, 'assist_opened');
    setApplicationStatus(id, 'submitted');
    assert.equal(eventsFor(id).length, 5);
  } finally {
    db.exec('ROLLBACK');
  }
  assert.equal(getApplication(id), undefined);
  assert.deepEqual(listApplicationEvents(), { events: [], nextBefore: null });
});

test('counts only submitted companies using case and whitespace normalization, not fuzzy merging', () => {
  const companies = [
    ' Acme   Labs ', 'acme labs', 'ACME\tLABS', '\nAcme\u00a0 Labs\u00a0',
    'Acme-Labs', 'Acme Labs, Inc.', '\u00a0CAFÉ\tGroup ', 'café group', '', ' \t\n\u00a0',
  ];
  for (const company of companies) {
    const application = create(company);
    setApplicationStatus(application.id, 'approved');
    setApplicationStatus(application.id, 'submitted');
    setApplicationStatus(application.id, 'submitted');
    recordApplicationEvent(application.id, 'assist_opened');
  }
  create('Draft only');
  create('Acme Labs');
  setApplicationStatus(create('Approved only').id, 'approved');
  addJob('Scanned only');
  assert.deepEqual(getApplicationMetrics(), {
    drafts: 2, approved: 1, submitted: companies.length, companiesApplied: 4,
    interviews: 0, offers: 0, hired: 0, closed: 0, awaitingOutcome: companies.length, followUpDue: 0,
  });
});

test('paginates newest event IDs without gaps or duplicates when more events arrive', () => {
  const first = create('First Company');
  const second = create('Second Company');
  for (let index = 0; index < 119; index += 1) {
    recordApplicationEvent(index % 2 ? first.id : second.id, 'assist_opened');
  }
  // Equal timestamps must not affect ordering or cursor boundaries.
  db.exec("UPDATE application_events SET occurred_at = '2025-01-01T00:00:00.000Z'");
  const expectedIds = db.prepare('SELECT id FROM application_events ORDER BY id DESC').all().map((row) => row.id);
  const firstPage = listApplicationEvents();
  assert.equal(firstPage.events.length, 50);
  assert.equal(firstPage.nextBefore, firstPage.events.at(-1).id);
  const newest = recordApplicationEvent(first.id, 'assist_paused', 'manual-form');
  const secondPage = listApplicationEvents(firstPage.nextBefore);
  assert.equal(secondPage.events.length, 50);
  assert.equal(secondPage.nextBefore, secondPage.events.at(-1).id);
  const thirdPage = listApplicationEvents(secondPage.nextBefore);
  assert.equal(thirdPage.events.length, 21);
  assert.equal(thirdPage.nextBefore, null);
  const events = [...firstPage.events, ...secondPage.events, ...thirdPage.events];
  assert.deepEqual(events.map((event) => event.id), expectedIds);
  for (const event of events) {
    assert.equal(event.company, event.application_id === first.id ? 'First Company' : 'Second Company');
    assert.equal(event.title, 'Engineer');
  }
  assert.equal(listApplicationEvents().events[0].id, newest.id);
  assert.deepEqual(listApplicationEvents(thirdPage.events.at(-1).id), { events: [], nextBefore: null });
});

test('uses the 51st row only to detect another page', () => {
  const application = create();
  for (let index = 0; index < 49; index += 1) recordApplicationEvent(application.id, 'assist_opened');
  const exactPage = listApplicationEvents();
  assert.equal(exactPage.events.length, 50);
  assert.equal(exactPage.nextBefore, null);
  recordApplicationEvent(application.id, 'assist_failed');
  const page = listApplicationEvents();
  assert.equal(page.events.length, 50);
  assert.equal(page.nextBefore, page.events.at(-1).id);
  const finalPage = listApplicationEvents(page.nextBefore);
  assert.equal(finalPage.events.length, 1);
  assert.equal(finalPage.events[0].kind, 'draft_created');
  assert.equal(finalPage.nextBefore, null);
});

function runTracking(dataDirectory, script) {
  const moduleUrl = new URL('../src/db.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const tracking = await import(${JSON.stringify(moduleUrl)});
    ${script}
    tracking.db.close();
  `], {
    env: { ...process.env, DATA_DIRECTORY: dataDirectory },
    encoding: 'utf8', timeout: 20000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  return child.stdout ? JSON.parse(child.stdout) : null;
}

function restartTracking(dataDirectory) {
  return runTracking(dataDirectory, `
    console.log(JSON.stringify({
      events: tracking.listApplicationEvents().events,
      applications: tracking.listApplications(),
      metrics: tracking.getApplicationMetrics(),
    }));
  `);
}

test('backfills the legacy schema at migration time, preserves timestamps, and is restart-safe', () => {
  const legacyDirectory = mkdtempSync(path.join(tmpdir(), 'proofloop-tracking-legacy-'));
  const databasePath = path.join(legacyDirectory, 'proofloop.sqlite');
  let legacy;
  try {
    legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        source_job_id TEXT NOT NULL,
        company TEXT NOT NULL,
        title TEXT NOT NULL,
        location TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL,
        description TEXT NOT NULL,
        posted_at TEXT,
        discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        match_score INTEGER NOT NULL DEFAULT 0,
        matched_terms TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'skipped')),
        UNIQUE(source, source_job_id)
      );
      CREATE TABLE applications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
        tailored_cv TEXT NOT NULL,
        recruiter_message TEXT NOT NULL,
        cover_letter TEXT NOT NULL,
        pdf_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'submitted')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        submitted_at TEXT
      );
    `);
    for (const [index, status] of ['draft', 'approved', 'submitted'].entries()) {
      const id = index + 1;
      legacy.prepare(`
        INSERT INTO jobs (id, source, source_job_id, company, title, url, description)
        VALUES (?, 'lever', ?, 'Legacy Company', 'Legacy Engineer', 'https://example.com', '')
      `).run(id, String(id));
      legacy.prepare(`
        INSERT INTO applications (job_id, tailored_cv, recruiter_message, cover_letter, pdf_path,
          status, created_at, updated_at, submitted_at)
        VALUES (?, ?, ?, ?, 'legacy.pdf', ?, '2020-01-01 12:34:56', '2020-02-02 12:34:56', ?)
      `).run(id, draft.tailoredCv, draft.recruiterMessage, draft.coverLetter, status,
        status === 'submitted' ? '2020-02-02T12:34:56.789Z' : null);
    }
    const original = legacy.prepare('SELECT * FROM applications ORDER BY id').all();
    legacy.close();
    legacy = null;

    const started = Date.now();
    const migrated = restartTracking(legacyDirectory);
    const finished = Date.now();
    assert.equal(migrated.events.length, 3);
    assert.deepEqual(migrated.metrics, {
      drafts: 1, approved: 1, submitted: 1, companiesApplied: 1,
      interviews: 0, offers: 0, hired: 0, closed: 0, awaitingOutcome: 1, followUpDue: 1,
    });
    for (const row of original) {
      const current = migrated.applications.find((application) => application.id === row.id);
      for (const key of Object.keys(row)) assert.equal(current[key], row[key]);
      const event = migrated.events.find((event) => event.application_id === row.id);
      assert.equal(event.kind, 'baseline');
      assert.equal(event.detail, `Historical state only: ${row.status}; earlier events unavailable.`);
      assertIsoUtc(event.occurred_at);
      assert(Date.parse(event.occurred_at) >= started - clockToleranceMs);
      assert(Date.parse(event.occurred_at) <= finished + clockToleranceMs);
    }
    assert.deepEqual(restartTracking(legacyDirectory), migrated);

    // A missing history can be backfilled later without replacing existing history.
    legacy = new DatabaseSync(databasePath);
    legacy.prepare('DELETE FROM application_events WHERE application_id = 2').run();
    legacy.close();
    legacy = null;
    const backfilled = restartTracking(legacyDirectory);
    assert.equal(backfilled.events.length, 3);
    const restored = backfilled.events.find((event) => event.application_id === 2);
    assert.equal(restored.kind, 'baseline');
    assert(restored.id > Math.max(...migrated.events.map((event) => event.id)));
    for (const event of migrated.events.filter((event) => event.application_id !== 2)) {
      assert.deepEqual(backfilled.events.find((row) => row.id === event.id), event);
    }
    assert.deepEqual(backfilled.applications, migrated.applications);
    assert.deepEqual(restartTracking(legacyDirectory), backfilled);

    // The migrated database also has live triggers, not just baseline rows.
    legacy = new DatabaseSync(databasePath);
    legacy.exec("UPDATE applications SET tailored_cv = 'edited legacy draft' WHERE id = 1");
    legacy.exec("UPDATE applications SET status = 'approved' WHERE id = 1");
    legacy.exec(`
      INSERT INTO jobs (id, source, source_job_id, company, title, url, description)
      VALUES (4, 'lever', '4', 'New Company', 'Engineer', 'https://example.com', '');
      INSERT INTO applications (job_id, tailored_cv, recruiter_message, cover_letter, pdf_path)
      VALUES (4, 'new cv', 'new message', 'new letter', 'new.pdf');
    `);
    legacy.close();
    legacy = null;
    const updated = restartTracking(legacyDirectory);
    assert.deepEqual(updated.events.filter((event) => event.application_id === 1).map((event) => event.kind), [
      'approved', 'draft_updated', 'baseline',
    ]);
    assert.deepEqual(updated.events.filter((event) => event.application_id === 4).map((event) => event.kind), [
      'draft_created',
    ]);
    assert.equal(updated.applications.find((application) => application.id === 3).submitted_at,
      '2020-02-02T12:34:56.789Z');
    assert.deepEqual(restartTracking(legacyDirectory), updated);
  } finally {
    legacy?.close();
    rmSync(legacyDirectory, { recursive: true, force: true });
  }
});

test('migrates the legacy event constraint and adds ATS storage without losing history', () => {
  const legacyDirectory = mkdtempSync(path.join(tmpdir(), 'proofloop-tracking-events-'));
  let legacy;
  try {
    legacy = new DatabaseSync(path.join(legacyDirectory, 'proofloop.sqlite'));
    legacy.exec(`
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        source_job_id TEXT NOT NULL,
        company TEXT NOT NULL,
        title TEXT NOT NULL,
        location TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL,
        description TEXT NOT NULL,
        posted_at TEXT,
        discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        match_score INTEGER NOT NULL DEFAULT 0,
        matched_terms TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'skipped')),
        UNIQUE(source, source_job_id)
      );
      CREATE TABLE applications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
        tailored_cv TEXT NOT NULL,
        recruiter_message TEXT NOT NULL,
        cover_letter TEXT NOT NULL,
        pdf_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'submitted')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        submitted_at TEXT
      );
      CREATE TABLE application_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER NOT NULL REFERENCES applications(id),
        kind TEXT NOT NULL CHECK (kind IN (
          'baseline', 'draft_created', 'draft_updated', 'approved', 'submitted',
          'assist_opened', 'assist_paused', 'assist_failed'
        )),
        detail TEXT NOT NULL DEFAULT '',
        occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX application_events_application_id ON application_events(application_id);
      INSERT INTO jobs (id, source, source_job_id, company, title, url, description)
        VALUES (1, 'lever', '1', 'Legacy Events Co', 'Engineer', 'https://example.com', '');
      INSERT INTO applications (id, job_id, tailored_cv, recruiter_message, cover_letter, pdf_path, status)
        VALUES (1, 1, 'cv', 'message', 'letter', 'legacy.pdf', 'approved');
      INSERT INTO application_events (id, application_id, kind, detail, occurred_at)
        VALUES (7, 1, 'approved', '', '2024-05-06T07:08:09.123Z');
    `);
    legacy.close();
    legacy = null;

    const dumped = runTracking(legacyDirectory, `
      const eventSchema = tracking.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'application_events'"
      ).get().sql;
      console.log(JSON.stringify({
        events: tracking.listApplicationEvents().events,
        applications: tracking.listApplications(),
        eventSchema,
        columns: tracking.db.prepare('PRAGMA table_info(applications)').all().map((column) => column.name),
      }));
    `);
    assert.equal(dumped.events.length, 1);
    assert.equal(dumped.events[0].id, 7);
    assert.equal(dumped.events[0].kind, 'approved');
    assert.equal(dumped.events[0].occurred_at, '2024-05-06T07:08:09.123Z');
    assert.equal(dumped.applications[0].ats_check, '');
    assert.equal(dumped.applications[0].outcome, null);
    assert.match(dumped.eventSchema, /outcome_interview/);
    assert.match(dumped.eventSchema, /outcome_no_response/);
    assert.ok(dumped.columns.includes('ats_check'));

    const recorded = runTracking(legacyDirectory, `
      tracking.setApplicationStatus(1, 'submitted');
      const event = tracking.recordOutcome(1, 'interview', 'Legacy interview');
      console.log(JSON.stringify({
        event,
        application: tracking.getApplication(1),
        metrics: tracking.getApplicationMetrics(),
      }));
    `);
    assert.equal(recorded.event.kind, 'outcome_interview');
    assert.equal(recorded.event.id, 9);
    assert.equal(recorded.application.status, 'submitted');
    assert.equal(recorded.application.outcome, 'interview');
    assert.equal(recorded.application.outcome_detail, 'Legacy interview');
    assert.deepEqual(recorded.metrics, {
      drafts: 0, approved: 0, submitted: 1, companiesApplied: 1,
      interviews: 1, offers: 0, hired: 0, closed: 0, awaitingOutcome: 0, followUpDue: 0,
    });

    const restarted = restartTracking(legacyDirectory);
    assert.deepEqual(restarted.events.map((event) => [event.id, event.kind]), [
      [9, 'outcome_interview'], [8, 'submitted'], [7, 'approved'],
    ]);
    assert.equal(restarted.events.at(-1).occurred_at, '2024-05-06T07:08:09.123Z');
    assert.equal(restarted.applications[0].outcome, 'interview');
    assert.deepEqual(restartTracking(legacyDirectory), restarted);
  } finally {
    legacy?.close();
    rmSync(legacyDirectory, { recursive: true, force: true });
  }
});
