import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { CLOSED_OUTCOMES, OUTCOME_STAGES, isFollowUpDue, outcomeStageFromKind } from './outcomes.js';

export const dataDirectory = path.resolve(process.env.DATA_DIRECTORY || '.data');
mkdirSync(dataDirectory, { recursive: true });

export const db = new DatabaseSync(path.join(dataDirectory, 'proofloop.sqlite'));
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    cv_text TEXT NOT NULL DEFAULT '',
    target_roles TEXT NOT NULL DEFAULT '',
    target_locations TEXT NOT NULL DEFAULT '',
    min_match INTEGER NOT NULL DEFAULT 60,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('greenhouse', 'lever')),
    slug TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(type, slug)
  );

  CREATE TABLE IF NOT EXISTS jobs (
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

  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
    tailored_cv TEXT NOT NULL,
    recruiter_message TEXT NOT NULL,
    cover_letter TEXT NOT NULL,
    pdf_path TEXT NOT NULL,
    ats_check TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'submitted')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    submitted_at TEXT
  );
`);

// Backfill and install triggers under one write lock, before new changes can be logged.
db.exec('BEGIN IMMEDIATE');
try {
  const applicationColumns = db.prepare('PRAGMA table_info(applications)').all();
  if (!applicationColumns.some((column) => column.name === 'ats_check')) {
    db.exec("ALTER TABLE applications ADD COLUMN ats_check TEXT NOT NULL DEFAULT ''");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS application_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL REFERENCES applications(id),
      kind TEXT NOT NULL CHECK (kind IN (
        'baseline', 'draft_created', 'draft_updated', 'approved', 'submitted',
        'assist_opened', 'assist_paused', 'assist_failed',
        'outcome_interview', 'outcome_offer', 'outcome_rejected', 'outcome_hired',
        'outcome_withdrawn', 'outcome_no_response'
      )),
      detail TEXT NOT NULL DEFAULT '',
      occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  const eventSchema = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'application_events'",
  ).get()?.sql || '';
  if (!eventSchema.includes("'outcome_interview'")) {
    db.exec(`
      CREATE TABLE application_events_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER NOT NULL REFERENCES applications(id),
        kind TEXT NOT NULL CHECK (kind IN (
          'baseline', 'draft_created', 'draft_updated', 'approved', 'submitted',
          'assist_opened', 'assist_paused', 'assist_failed',
          'outcome_interview', 'outcome_offer', 'outcome_rejected', 'outcome_hired',
          'outcome_withdrawn', 'outcome_no_response'
        )),
        detail TEXT NOT NULL DEFAULT '',
        occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      INSERT INTO application_events_migrated (id, application_id, kind, detail, occurred_at)
        SELECT id, application_id, kind, detail, occurred_at FROM application_events;
      DROP TABLE application_events;
      ALTER TABLE application_events_migrated RENAME TO application_events;
    `);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS application_events_application_id
      ON application_events(application_id);

    INSERT INTO application_events (application_id, kind, detail)
    SELECT applications.id, 'baseline',
      'Historical state only: ' || applications.status || '; earlier events unavailable.'
    FROM applications
    WHERE NOT EXISTS (
      SELECT 1 FROM application_events WHERE application_id = applications.id
    );

    CREATE TRIGGER IF NOT EXISTS application_draft_created
    AFTER INSERT ON applications
    WHEN NEW.status = 'draft'
    BEGIN
      INSERT INTO application_events (application_id, kind) VALUES (NEW.id, 'draft_created');
    END;

    CREATE TRIGGER IF NOT EXISTS application_draft_updated
    AFTER UPDATE OF tailored_cv, recruiter_message, cover_letter, pdf_path ON applications
    WHEN OLD.status = 'draft' AND (
      OLD.tailored_cv IS NOT NEW.tailored_cv OR
      OLD.recruiter_message IS NOT NEW.recruiter_message OR
      OLD.cover_letter IS NOT NEW.cover_letter OR
      OLD.pdf_path IS NOT NEW.pdf_path
    )
    BEGIN
      INSERT INTO application_events (application_id, kind) VALUES (NEW.id, 'draft_updated');
    END;

    CREATE TRIGGER IF NOT EXISTS application_status_changed
    AFTER UPDATE OF status ON applications
    WHEN OLD.status IS NOT NEW.status AND NEW.status IN ('approved', 'submitted')
    BEGIN
      INSERT INTO application_events (application_id, kind) VALUES (NEW.id, NEW.status);
    END;
    COMMIT;
  `);
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

db.prepare('INSERT OR IGNORE INTO profile (id) VALUES (1)').run();

export function getProfile() {
  return db.prepare('SELECT * FROM profile WHERE id = 1').get();
}

export function updateProfile(profile) {
  db.prepare(`
    UPDATE profile SET name = ?, email = ?, phone = ?, location = ?, cv_text = ?,
      target_roles = ?, target_locations = ?, min_match = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(
    profile.name,
    profile.email,
    profile.phone,
    profile.location,
    profile.cvText,
    profile.targetRoles,
    profile.targetLocations,
    profile.minMatch,
  );
  return getProfile();
}

export function listSources() {
  return db.prepare('SELECT * FROM sources ORDER BY created_at DESC').all();
}

export function addSource(type, slug) {
  const result = db.prepare('INSERT INTO sources (type, slug) VALUES (?, ?)').run(type, slug);
  return db.prepare('SELECT * FROM sources WHERE id = ?').get(result.lastInsertRowid);
}

export function removeSource(id) {
  db.prepare('DELETE FROM sources WHERE id = ?').run(id);
}

export function upsertJob(job, match) {
  db.prepare(`
    INSERT INTO jobs (source, source_job_id, company, title, location, url, description, posted_at, match_score, matched_terms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, source_job_id) DO UPDATE SET
      company = excluded.company,
      title = excluded.title,
      location = excluded.location,
      url = excluded.url,
      description = excluded.description,
      posted_at = excluded.posted_at,
      match_score = excluded.match_score,
      matched_terms = excluded.matched_terms
  `).run(
    job.source,
    job.sourceJobId,
    job.company,
    job.title,
    job.location,
    job.url,
    job.description,
    job.postedAt,
    match.score,
    JSON.stringify(match.matchedTerms),
  );
}

export function listJobs() {
  return db.prepare(`
    SELECT jobs.*, applications.id AS application_id, applications.status AS application_status
    FROM jobs
    LEFT JOIN applications ON applications.job_id = jobs.id
    ORDER BY jobs.match_score DESC, jobs.discovered_at DESC
  `).all().map(mapJob);
}

export function getJob(id) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  return job ? mapJob(job) : null;
}

export function setJobStatus(id, status) {
  db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, id);
}

export function createApplication(jobId, draft, pdfPath, atsCheck = null) {
  const result = db.prepare(`
    INSERT INTO applications (job_id, tailored_cv, recruiter_message, cover_letter, pdf_path, ats_check)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    jobId,
    draft.tailoredCv,
    draft.recruiterMessage,
    draft.coverLetter,
    pdfPath,
    atsCheck ? JSON.stringify(atsCheck) : '',
  );
  return getApplication(result.lastInsertRowid);
}

const applicationColumns = `
  applications.*, jobs.title, jobs.company, jobs.url, jobs.location,
  (SELECT substr(events.kind, 9) FROM application_events events
    WHERE events.application_id = applications.id AND events.kind LIKE 'outcome%'
    ORDER BY events.id DESC LIMIT 1) AS outcome,
  (SELECT events.occurred_at FROM application_events events
    WHERE events.application_id = applications.id AND events.kind LIKE 'outcome%'
    ORDER BY events.id DESC LIMIT 1) AS outcome_at,
  (SELECT events.detail FROM application_events events
    WHERE events.application_id = applications.id AND events.kind LIKE 'outcome%'
    ORDER BY events.id DESC LIMIT 1) AS outcome_detail
`;

export function getApplication(id) {
  return db.prepare(`
    SELECT ${applicationColumns}
    FROM applications JOIN jobs ON jobs.id = applications.job_id
    WHERE applications.id = ?
  `).get(id);
}

export function getApplicationForJob(jobId) {
  const row = db.prepare('SELECT id FROM applications WHERE job_id = ?').get(jobId);
  return row ? getApplication(row.id) : null;
}

export function listApplications() {
  return db.prepare(`
    SELECT ${applicationColumns}
    FROM applications JOIN jobs ON jobs.id = applications.job_id
    ORDER BY applications.updated_at DESC
  `).all();
}

export function updateDraft(id, draft, pdfPath, atsCheck = null) {
  db.prepare(`
    UPDATE applications SET tailored_cv = ?, recruiter_message = ?, cover_letter = ?,
      pdf_path = ?, ats_check = COALESCE(?, ats_check), updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'draft'
  `).run(
    draft.tailoredCv,
    draft.recruiterMessage,
    draft.coverLetter,
    pdfPath,
    atsCheck ? JSON.stringify(atsCheck) : null,
    id,
  );
  return getApplication(id);
}

export function setApplicationStatus(id, status) {
  db.prepare(`
    UPDATE applications SET status = ?,
      submitted_at = CASE WHEN ? = 'submitted'
        THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE submitted_at END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND (
      (status = 'draft' AND ? = 'approved') OR
      (status = 'approved' AND ? = 'submitted')
    )
  `).run(status, status, id, status, status);
  return getApplication(id);
}

export function recordApplicationEvent(applicationId, kind, detail = '') {
  // Triggers own lifecycle events; assist details must not contain contact data or documents.
  if (!['assist_opened', 'assist_paused', 'assist_failed'].includes(kind)) {
    throw new TypeError('Only assist events can be recorded explicitly');
  }
  return db.prepare(`
    INSERT INTO application_events (application_id, kind, detail) VALUES (?, ?, ?)
    RETURNING *
  `).get(applicationId, kind, detail);
}

export function recordOutcome(applicationId, outcome, detail = '') {
  if (!OUTCOME_STAGES.includes(outcome)) {
    throw new TypeError('Unknown outcome');
  }
  return db.prepare(`
    INSERT INTO application_events (application_id, kind, detail)
    SELECT id, ?, ? FROM applications WHERE id = ? AND status = 'submitted'
    RETURNING *
  `).get(`outcome_${outcome}`, detail, applicationId);
}

export function listApplicationEvents(before = null) {
  const rows = db.prepare(`
    SELECT application_events.*, jobs.company, jobs.title
    FROM application_events
    JOIN applications ON applications.id = application_events.application_id
    JOIN jobs ON jobs.id = applications.job_id
    WHERE (? IS NULL OR application_events.id < ?)
    ORDER BY application_events.id DESC
    LIMIT 51
  `).all(before, before);
  const events = rows.slice(0, 50);
  return { events, nextBefore: rows.length > 50 ? events[49].id : null };
}

export function getApplicationMetrics() {
  const metrics = {
    drafts: 0, approved: 0, submitted: 0, companiesApplied: 0,
    interviews: 0, offers: 0, hired: 0, closed: 0, awaitingOutcome: 0, followUpDue: 0,
  };
  const companies = new Set();
  const statusKeys = { draft: 'drafts', approved: 'approved', submitted: 'submitted' };
  const outcomes = new Map();
  for (const event of db.prepare(`
    SELECT application_id, kind FROM application_events
    WHERE kind LIKE 'outcome%' ORDER BY id
  `).all()) {
    const stage = outcomeStageFromKind(event.kind);
    if (!stage) continue;
    const reached = outcomes.get(event.application_id) || { stages: new Set(), latest: null };
    reached.stages.add(stage);
    reached.latest = stage;
    outcomes.set(event.application_id, reached);
  }
  const applications = db.prepare(`
    SELECT applications.id, applications.status, applications.submitted_at, jobs.company
    FROM applications JOIN jobs ON jobs.id = applications.job_id
  `).all();
  for (const application of applications) {
    metrics[statusKeys[application.status]] += 1;
    if (application.status !== 'submitted') continue;
    const company = application.company.trim().replace(/\s+/g, ' ').toLowerCase();
    if (company) companies.add(company);
    const reached = outcomes.get(application.id);
    if (reached?.stages.has('interview') || reached?.stages.has('offer') || reached?.stages.has('hired')) {
      metrics.interviews += 1;
    }
    if (reached?.stages.has('offer') || reached?.stages.has('hired')) metrics.offers += 1;
    if (reached?.stages.has('hired')) metrics.hired += 1;
    if (!reached) {
      metrics.awaitingOutcome += 1;
      if (isFollowUpDue(application.submitted_at)) metrics.followUpDue += 1;
    } else if (CLOSED_OUTCOMES.has(reached.latest)) {
      metrics.closed += 1;
    }
  }
  metrics.companiesApplied = companies.size;
  return metrics;
}

function mapJob(job) {
  return { ...job, matched_terms: JSON.parse(job.matched_terms) };
}
