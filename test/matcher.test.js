import test from 'node:test';
import assert from 'node:assert/strict';
import { rankJob } from '../src/matcher.js';

const profile = {
  targetRoles: 'Backend Engineer, Software Engineer',
  targetLocations: 'Remote, London',
  cvText: 'Backend engineer with Python, Node.js, PostgreSQL and Docker experience. Built APIs and automated reporting.',
};

test('ranks a supported role above an unrelated role', () => {
  const backend = rankJob(profile, {
    title: 'Backend Engineer',
    location: 'Remote',
    description: 'Build Python APIs with PostgreSQL and Docker.',
  });
  const designer = rankJob(profile, {
    title: 'Visual Designer',
    location: 'New York',
    description: 'Create brand illustrations and campaign layouts.',
  });
  assert.ok(backend.score > designer.score);
  assert.ok(backend.score >= 60);
  assert.ok(backend.matchedTerms.includes('python'));
});

test('does not treat unsupported job requirements as candidate evidence', () => {
  const result = rankJob(profile, {
    title: 'Backend Engineer',
    location: 'Remote',
    description: 'Python and Kubernetes experience required.',
  });
  assert.ok(result.matchedTerms.includes('python'));
  assert.ok(!result.matchedTerms.includes('kubernetes'));
});

test('scores location preferences without inventing a remote match', () => {
  const remote = rankJob(profile, { title: 'Software Engineer', location: 'Remote', description: 'Node.js APIs' });
  const onsite = rankJob(profile, { title: 'Software Engineer', location: 'New York', description: 'Node.js APIs' });
  assert.ok(remote.score > onsite.score);
});
