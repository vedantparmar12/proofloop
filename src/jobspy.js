import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { execa } from 'execa';
import { z } from 'zod';
import { convert } from 'html-to-text';

export const jobspySearchSchema = z.object({
  site: z.enum(['indeed', 'linkedin']),
  searchTerm: z.string().trim().min(2).max(200),
  location: z.string().trim().min(2).max(160),
  country: z.enum(['india', 'usa', 'uk', 'canada', 'australia', 'germany', 'france']).default('india'),
  resultsWanted: z.coerce.number().int().min(1).max(25).default(15),
  hoursOld: z.coerce.number().int().min(1).max(720).default(168),
}).strict();

const nullableText = z.string().nullable().optional();
const payloadSchema = z.object({
  jobs: z.array(z.object({
    id: nullableText, site: z.enum(['indeed', 'linkedin']), job_url: nullableText,
    job_url_direct: nullableText, title: nullableText, company: nullableText,
    location: nullableText, description: nullableText, date_posted: nullableText,
  })).max(25),
  errors: z.record(z.string(), z.string()),
  warnings: z.record(z.string(), z.array(z.string())),
});
const environment = path.resolve(process.env.DATA_DIRECTORY || '.data', 'jobspy-venv');
const python = process.env.JOBSPY_PYTHON || path.join(environment, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const worker = fileURLToPath(new URL('./jobspy_worker.py', import.meta.url));
let running = false;
let nextSearchAt = 0;

export async function searchJobspy(input) {
  const search = jobspySearchSchema.parse(input);
  if (running || Date.now() < nextSearchAt) {
    throw Object.assign(new Error('JobSpy search is busy or cooling down. Wait at least 60 seconds between searches.'), { status: 429 });
  }
  running = true;
  try {
    const { stdout } = await execa(python, [worker], {
      input: JSON.stringify(search), timeout: 90000, maxBuffer: 4 * 1024 * 1024,
      windowsHide: true, env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    return normalizeJobspyResult(JSON.parse(stdout), search.site);
  } catch (error) {
    if (error.code === 'ENOENT' || (path.isAbsolute(python) && !existsSync(python))) throw new Error('JobSpy is not installed. Run bun run setup:jobspy, then retry.');
    if (error.timedOut) throw new Error('JobSpy timed out after 90 seconds. No results were imported; try later or use company boards.');
    if (error.failed) throw new Error('JobSpy worker failed. Run bun run setup:jobspy and check the search settings. No results were imported.');
    if (error instanceof SyntaxError || error instanceof z.ZodError) throw new Error('JobSpy returned an invalid response. No results were imported.');
    throw error;
  } finally {
    running = false;
    nextSearchAt = Date.now() + 60000;
  }
}

export function normalizeJobspyResult(payload, site) {
  const result = payloadSchema.parse(payload);
  let skipped = 0;
  const jobs = [];
  const seen = new Set();
  for (const row of result.jobs) {
    const url = [row.job_url_direct, row.job_url].map((value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : null;
      } catch { return null; }
    }).find(Boolean);
    if (row.site !== site || !url || !row.title?.trim() || !row.company?.trim()) { skipped += 1; continue; }
    const sourceJobId = row.id || createHash('sha256').update(row.job_url || url).digest('hex');
    if (seen.has(sourceJobId)) continue;
    seen.add(sourceJobId);
    // pandas serializes date-only values as midnight without a timezone.
    const date = row.date_posted?.replace(/^(\d{4}-\d{2}-\d{2}T[\d:.]+)$/, '$1Z');
    jobs.push({
      source: `jobspy:${site}`, sourceJobId, url,
      company: row.company.trim().slice(0, 300), title: row.title.trim().slice(0, 500),
      location: (row.location || '').slice(0, 500),
      description: convert((row.description || '').slice(0, 100000), { wordwrap: false, selectors: [{ selector: 'a', options: { ignoreHref: true } }, { selector: 'img', format: 'skip' }] }).slice(0, 60000),
      postedAt: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : null,
    });
  }
  return { jobs, errors: result.errors, warnings: result.warnings, skipped };
}

if (import.meta.main) {
  if (process.argv[2] !== '--setup') throw new Error('Use bun run setup:jobspy to install the optional discovery worker.');
  await execa('python', ['-m', 'venv', environment], { stdio: 'inherit' });
  const venvPython = path.join(environment, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  await execa(venvPython, ['-m', 'pip', 'install', '-r', fileURLToPath(new URL('../requirements-jobspy.txt', import.meta.url))], { stdio: 'inherit' });
  console.log('JobSpy is ready. ProofLoop still runs on Bun; only discovery uses this isolated Python environment.');
}
