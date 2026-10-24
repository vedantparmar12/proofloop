import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

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
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'submitted')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    submitted_at TEXT
  );
`);

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

export function createApplication(jobId, draft, pdfPath) {
  const result = db.prepare(`
    INSERT INTO applications (job_id, tailored_cv, recruiter_message, cover_letter, pdf_path)
    VALUES (?, ?, ?, ?, ?)
  `).run(jobId, draft.tailoredCv, draft.recruiterMessage, draft.coverLetter, pdfPath);
  return getApplication(result.lastInsertRowid);
}

export function getApplication(id) {
  return db.prepare(`
    SELECT applications.*, jobs.title, jobs.company, jobs.url, jobs.location
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
    SELECT applications.*, jobs.title, jobs.company, jobs.url, jobs.location
    FROM applications JOIN jobs ON jobs.id = applications.job_id
    ORDER BY applications.updated_at DESC
  `).all();
}

export function updateDraft(id, draft, pdfPath) {
  db.prepare(`
    UPDATE applications SET tailored_cv = ?, recruiter_message = ?, cover_letter = ?,
      pdf_path = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'draft'
  `).run(draft.tailoredCv, draft.recruiterMessage, draft.coverLetter, pdfPath, id);
  return getApplication(id);
}

export function setApplicationStatus(id, status) {
  const submittedAt = status === 'submitted' ? new Date().toISOString() : null;
  db.prepare(`
    UPDATE applications SET status = ?, submitted_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(status, submittedAt, id);
  return getApplication(id);
}

function mapJob(job) {
  return { ...job, matched_terms: JSON.parse(job.matched_terms) };
}
