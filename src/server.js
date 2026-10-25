import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { z } from 'zod';
import {
  addSource,
  createApplication,
  dataDirectory,
  getApplication,
  getApplicationForJob,
  getJob,
  getProfile,
  getApplicationMetrics,
  listApplications,
  listApplicationEvents,
  listJobs,
  listSources,
  recordApplicationEvent,
  recordOutcome,
  removeSource,
  setApplicationStatus,
  setJobStatus,
  updateDraft,
  updateProfile,
  upsertJob,
} from './db.js';
import { scanSource } from './connectors.js';
import { jobspySearchSchema, searchJobspy } from './jobspy.js';
import { rankJob } from './matcher.js';
import { createDraft } from './gemini.js';
import { createCvPdf, extractCvText, inspectCvPdf } from './documents.js';
import { assistApplication } from './assistedApply.js';
import { OUTCOME_STAGES } from './outcomes.js';
import { renderView, renderJobs, renderSources, renderDraft, renderJob, renderCvText, renderAssist, renderCounts, renderActivity } from './views.js';

const require = createRequire(import.meta.url);
const port = Number(process.env.PORT || 3000);
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

const profileSchema = z.object({
  name: z.string().trim().max(120).default(''),
  email: z.string().trim().max(200).default(''),
  phone: z.string().trim().max(80).default(''),
  location: z.string().trim().max(160).default(''),
  cvText: z.string().trim().max(100000).default(''),
  targetRoles: z.string().trim().max(1000).default(''),
  targetLocations: z.string().trim().max(1000).default(''),
  minMatch: z.number().int().min(0).max(100).default(60),
});
const sourceSchema = z.object({
  type: z.enum(['greenhouse', 'lever']),
  slug: z.string().trim().regex(/^[a-zA-Z0-9_-]{1,100}$/),
});
const draftSchema = z.object({
  tailoredCv: z.string().trim().min(100).max(60000),
  recruiterMessage: z.string().trim().min(20).max(4000),
  coverLetter: z.string().trim().min(100).max(12000),
});
const outcomeSchema = z.object({
  outcome: z.enum(OUTCOME_STAGES),
  detail: z.string().trim().max(500).default(''),
}).strict();

app.disable('x-powered-by');
app.use((request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
  response.vary('HX-Request');
  const origin = request.get('origin');
  if (origin) {
    let hostname;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      return response.status(403).json({ error: 'Invalid request origin' });
    }
    if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
      return response.status(403).json({ error: 'Cross-origin requests are not allowed' });
    }
  }
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

app.get('/vendor/htmx.min.js', (_request, response) => {
  response.sendFile(require.resolve('htmx.org/dist/htmx.min.js'));
});

app.get('/views/jobs/list', (request, response) => {
  response.type('html').send(renderJobs(dashboardState(), request.query));
});

app.get('/views/jobs/:id', (request, response) => {
  const job = getJob(idParameter(request.params.id));
  if (!job) return response.status(404).json({ error: 'Job not found' });
  response.type('html').send(renderJob({ ...job, application_id: getApplicationForJob(job.id)?.id }));
});

app.get('/views/:view', (request, response) => {
  if (!['jobs', 'review', 'applications', 'profile'].includes(request.params.view)) {
    return response.status(404).json({ error: 'View not found' });
  }
  sendView(response, request.params.view);
});

app.get('/api/health', (_request, response) => response.json({ ok: true }));
app.get('/api/state', (_request, response) => response.json(dashboardState()));
app.get('/api/activity', (request, response) => {
  const before = request.query.before === undefined ? null : z.coerce.number().int().positive().safe().parse(request.query.before);
  const activity = listApplicationEvents(before);
  if (isHtmx(request)) return response.type('html').send(renderActivity(activity));
  response.json(activity);
});

app.put('/api/profile', (request, response) => {
  const input = isHtmx(request) ? { ...request.body, minMatch: Number(request.body?.minMatch) } : request.body;
  const profile = updateProfile(profileSchema.parse(input));
  if (isHtmx(request)) return response.type('html').send('<p>Profile saved. New scans will use these preferences.</p>');
  response.json(profile);
});

app.post('/api/profile/cv', upload.single('cv'), async (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'Choose a CV file first' });
  const cvText = await extractCvText(request.file.buffer, request.file.mimetype, request.file.originalname);
  if (isHtmx(request)) return response.type('html').send(renderCvText(cvText));
  response.json({ cvText });
});

app.post('/api/sources', (request, response) => {
  const source = sourceSchema.parse(request.body);
  try {
    const added = addSource(source.type, source.slug);
    if (isHtmx(request)) return response.status(201).type('html').send(renderSources(listSources()));
    response.status(201).json(added);
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return response.status(409).json({ error: 'That source already exists' });
    throw error;
  }
});

app.delete('/api/sources/:id', (request, response) => {
  removeSource(idParameter(request.params.id));
  if (isHtmx(request)) return response.type('html').send(renderSources(listSources()));
  response.status(204).end();
});

app.post('/api/scan', async (request, response) => {
  const sources = listSources().filter((source) => source.active);
  if (!sources.length) return response.status(400).json({ error: 'Add a Greenhouse or Lever source first' });
  const profile = getProfile();
  const settled = await Promise.allSettled(sources.map(async (source) => {
    const jobs = await scanSource(source);
    for (const job of jobs) {
      if (!job.url || !job.description) continue;
      upsertJob(job, rankJob(profile, job));
    }
    return { source: `${source.type}:${source.slug}`, count: jobs.length };
  }));
  const results = settled.map((result, index) => result.status === 'fulfilled'
    ? result.value
    : { source: `${sources[index].type}:${sources[index].slug}`, error: result.reason.message });
  if (isHtmx(request)) return sendView(response, 'jobs', { ...dashboardState(), scanResults: results });
  response.json({ results });
});

app.post('/api/search', async (request, response) => {
  const search = jobspySearchSchema.parse(request.body);
  const result = await searchJobspy(search);
  const profile = getProfile();
  for (const job of result.jobs) upsertJob(job, rankJob(profile, job));
  const report = {
    source: `jobspy:${search.site}`, count: result.jobs.length, skipped: result.skipped,
    errors: Object.values(result.errors), warnings: Object.values(result.warnings).flat(),
  };
  if (isHtmx(request)) return sendView(response, 'jobs', { ...dashboardState(), searchResult: report, search });
  response.json(report);
});

app.post('/api/jobs/:id/prepare', async (request, response) => {
  const jobId = idParameter(request.params.id);
  const job = getJob(jobId);
  if (!job) return response.status(404).json({ error: 'Job not found' });
  if (!job.description.trim()) return response.status(400).json({ error: 'This posting has no job description. Review the original posting manually; a draft cannot be prepared.' });
  const profile = getProfile();
  if (profile.cv_text.length < 50) return response.status(400).json({ error: 'Add your CV in Profile before preparing a draft' });
  const existing = getApplicationForJob(jobId);
  if (existing) return response.status(409).json({ error: `This job already has a ${existing.status} application`, applicationId: existing.id });
  const draft = await createDraft(profile, job);
  const pdfPath = await createCvPdf(draft.tailoredCv, `${randomUUID()}.pdf`);
  const atsCheck = await inspectCvPdf(pdfPath, profile);
  const application = createApplication(jobId, draft, path.basename(pdfPath), atsCheck);
  if (isHtmx(request)) return sendView(response.status(201), 'review');
  response.status(201).json(application);
});

app.post('/api/jobs/:id/skip', (request, response) => {
  const jobId = idParameter(request.params.id);
  if (!getJob(jobId)) return response.status(404).json({ error: 'Job not found' });
  setJobStatus(jobId, 'skipped');
  if (isHtmx(request)) {
    const state = dashboardState();
    return response.type('html').send(renderJobs(state, request.body) + renderCounts(state));
  }
  response.status(204).end();
});

app.post('/api/jobs/:id/restore', (request, response) => {
  const jobId = idParameter(request.params.id);
  if (!getJob(jobId)) return response.status(404).json({ error: 'Job not found' });
  setJobStatus(jobId, 'new');
  if (isHtmx(request)) {
    const state = dashboardState();
    return response.type('html').send(renderJobs(state, request.body) + renderCounts(state));
  }
  response.status(204).end();
});

app.put('/api/applications/:id', async (request, response) => {
  const id = idParameter(request.params.id);
  const application = getApplication(id);
  if (!application) return response.status(404).json({ error: 'Application not found' });
  if (application.status !== 'draft') return response.status(409).json({ error: 'Only draft applications can be edited' });
  const draft = draftSchema.parse(request.body);
  const pdfPath = await createCvPdf(draft.tailoredCv, application.pdf_path);
  const atsCheck = await inspectCvPdf(pdfPath, getProfile());
  const updated = updateDraft(id, draft, path.basename(pdfPath), atsCheck);
  if (isHtmx(request)) return response.type('html').send(renderDraft(updated));
  response.json(updated);
});

app.post('/api/applications/:id/approve', async (request, response) => {
  const id = idParameter(request.params.id);
  const application = getApplication(id);
  if (!application) return response.status(404).json({ error: 'Application not found' });
  if (application.status !== 'draft') return response.status(409).json({ error: 'Only drafts can be approved' });
  if (isHtmx(request)) {
    const draft = draftSchema.parse(request.body);
    const pdfPath = await createCvPdf(draft.tailoredCv, application.pdf_path);
    const atsCheck = await inspectCvPdf(pdfPath, getProfile());
    updateDraft(id, draft, path.basename(pdfPath), atsCheck);
  }
  const approved = setApplicationStatus(id, 'approved');
  if (isHtmx(request)) return sendView(response, 'applications');
  response.json(approved);
});

app.post('/api/applications/:id/assist', async (request, response) => {
  const id = idParameter(request.params.id);
  const application = getApplication(id);
  if (!application) return response.status(404).json({ error: 'Application not found' });
  if (application.status !== 'approved') return response.status(409).json({ error: 'Approve the application before using assisted apply' });
  let result;
  try {
    result = await assistApplication(application, getProfile(), path.join(dataDirectory, path.basename(application.pdf_path)));
  } catch (error) {
    recordApplicationEvent(id, 'assist_failed', 'Browser assistance failed. No submission was recorded.');
    throw error;
  }
  recordApplicationEvent(id, result.paused ? 'assist_paused' : 'assist_opened', result.paused
    ? `Paused: ${result.paused}. No submission was recorded.`
    : `${result.filledFields} fields filled; ${result.cvAttached ? 'CV attached' : 'no new attachment'}. Submission remains manual.`);
  if (isHtmx(request)) return response.type('html').send(renderAssist(result) + `<div id="activity-list" hx-swap-oob="innerHTML">${renderActivity(listApplicationEvents())}</div>`);
  response.json(result);
});

app.post('/api/applications/:id/submit', (request, response) => {
  const id = idParameter(request.params.id);
  const application = getApplication(id);
  if (!application) return response.status(404).json({ error: 'Application not found' });
  if (application.status !== 'approved') return response.status(409).json({ error: 'Approve the application before marking it submitted' });
  const submitted = setApplicationStatus(id, 'submitted');
  if (isHtmx(request)) return sendView(response, 'applications');
  response.json(submitted);
});

app.post('/api/applications/:id/outcome', (request, response) => {
  const id = idParameter(request.params.id);
  const application = getApplication(id);
  if (!application) return response.status(404).json({ error: 'Application not found' });
  if (application.status !== 'submitted') return response.status(409).json({ error: 'Confirm submission before recording an outcome' });
  const { outcome, detail } = outcomeSchema.parse(request.body);
  const event = recordOutcome(id, outcome, detail);
  if (isHtmx(request)) return sendView(response.status(201), 'applications');
  response.status(201).json(event);
});

app.get('/api/applications/:id/pdf', async (request, response) => {
  const application = getApplication(idParameter(request.params.id));
  if (!application) return response.status(404).json({ error: 'Application not found' });
  const bytes = await readFile(path.join(dataDirectory, path.basename(application.pdf_path)));
  response.type('application/pdf');
  response.setHeader('Content-Disposition', `attachment; filename="${safeFilename(application.company)}-${safeFilename(application.title)}-cv.pdf"`);
  response.send(bytes);
});

app.use(express.static(path.resolve('public')));

app.use((error, _request, response, _next) => {
  if (error instanceof z.ZodError) {
    return response.status(400).json({ error: error.issues[0]?.message || 'Invalid input' });
  }
  if (error instanceof multer.MulterError) {
    return response.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'CV files must be 8 MB or smaller' : error.message });
  }
  console.error(error);
  response.status(error.status === 429 ? 429 : 500).json({ error: error.message || 'Unexpected server error' });
});

const server = app.listen(port, '127.0.0.1', () => {
  console.log(`ProofLoop is running at http://127.0.0.1:${server.address().port}`);
});

function dashboardState() {
  return {
    profile: getProfile(), sources: listSources(), jobs: listJobs(), applications: listApplications(),
    metrics: getApplicationMetrics(), activity: listApplicationEvents(),
  };
}

function isHtmx(request) {
  return request.get('HX-Request') === 'true';
}

function sendView(response, view, state = dashboardState()) {
  response.type('html').send(renderView(view, state) + renderCounts(state));
}

function idParameter(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid ID');
  return id;
}

function safeFilename(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'job';
}
