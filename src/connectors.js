import { convert } from 'html-to-text';

export async function scanSource(source) {
  if (source.type === 'greenhouse') return scanGreenhouse(source.slug);
  if (source.type === 'lever') return scanLever(source.slug);
  throw new Error(`Unsupported source: ${source.type}`);
}

export async function scanGreenhouse(slug) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Greenhouse returned ${response.status} for ${slug}`);
  const payload = await response.json();
  if (!Array.isArray(payload.jobs)) throw new Error(`Unexpected Greenhouse response for ${slug}`);
  return payload.jobs.map((job) => normalizeGreenhouseJob(slug, job));
}

export async function scanLever(slug) {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Lever returned ${response.status} for ${slug}`);
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error(`Unexpected Lever response for ${slug}`);
  return payload.map((job) => normalizeLeverJob(slug, job));
}

export function normalizeGreenhouseJob(slug, job) {
  return {
    source: 'greenhouse',
    sourceJobId: String(job.id),
    company: slug,
    title: String(job.title || 'Untitled role'),
    location: job.location?.name || '',
    url: job.absolute_url,
    description: htmlToText(job.content || ''),
    postedAt: job.updated_at || null,
  };
}

export function normalizeLeverJob(slug, job) {
  const categories = [job.categories?.location, job.categories?.commitment, job.workplaceType]
    .filter(Boolean).join(' · ');
  return {
    source: 'lever',
    sourceJobId: String(job.id),
    company: slug,
    title: String(job.text || 'Untitled role'),
    location: categories,
    url: job.hostedUrl,
    description: job.descriptionPlain || htmlToText(job.description || ''),
    postedAt: job.createdAt ? new Date(job.createdAt).toISOString() : null,
  };
}

function htmlToText(value) {
  const options = {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
    ],
  };
  let text = convert(value, options);
  if (/<\/?[a-z][^>]*>/i.test(text)) text = convert(text, options);
  return text.slice(0, 60000);
}
