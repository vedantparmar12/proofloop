import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = await mkdtemp(path.join(tmpdir(), 'proofloop-test-'));
process.env.DATA_DIRECTORY = directory;
const { createCvPdf, extractCvText } = await import('../src/documents.js');

test('creates a real PDF with Unicode text and multiple headings', async () => {
  const output = await createCvPdf('# Ada Lovelace\n\n## Experience — Zürich\n\n- Built analytical systems\n- Improved reliability', 'test-cv.pdf');
  const bytes = await readFile(output);
  assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
  assert.ok(bytes.length > 2000);
  const text = await extractCvText(bytes, 'application/pdf', 'test-cv.pdf');
  assert.match(text, /Ada Lovelace/);
  assert.match(text, /Experience — Zürich/);
  assert.match(text, /Built analytical systems/);
});

test.after(async () => {
  const { db } = await import('../src/db.js');
  db.close();
  await rm(directory, { recursive: true, force: true });
});
