import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGreenhouseJob, normalizeLeverJob } from '../src/connectors.js';

test('normalizes Greenhouse content and strips markup', () => {
  const job = normalizeGreenhouseJob('example', {
    id: 42,
    title: 'Platform Engineer',
    location: { name: 'Remote' },
    absolute_url: 'https://example.test/job',
    content: '&lt;p&gt;Build &lt;strong&gt;APIs&lt;/strong&gt;.&lt;/p&gt;',
    updated_at: '2026-10-25',
  });
  assert.equal(job.sourceJobId, '42');
  assert.equal(job.company, 'example');
  assert.equal(job.description, 'Build APIs.');
});

test('normalizes Lever posting fields', () => {
  const job = normalizeLeverJob('example', {
    id: 'abc',
    text: 'Backend Engineer',
    hostedUrl: 'https://example.test/apply',
    descriptionPlain: 'Build services.',
    categories: { location: 'London', commitment: 'Full-time' },
    workplaceType: 'hybrid',
    createdAt: 1761430000000,
  });
  assert.equal(job.source, 'lever');
  assert.match(job.location, /London/);
  assert.match(job.location, /hybrid/);
  assert.equal(job.description, 'Build services.');
});
