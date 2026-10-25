import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';

const directory = await mkdtemp(path.join(tmpdir(), 'proofloop-test-'));
process.env.DATA_DIRECTORY = directory;
const { createCvPdf, extractCvText, inspectCvPdf } = await import('../src/documents.js');
const profile = { name: 'Ada Lovelace', email: 'ada@example.com', phone: '+44 1234 567890' };
const summary = 'Built analytical systems and improved reliability across distributed teams.';

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

test('ATS inspection passes generated PDFs with complete contact text', async () => {
  const output = await createCvPdf(
    '# Ada Lovelace\n\nada@example.com · +44 1234 567890\n\nBuilt analytical systems and improved reliability.',
    'inspect-pass.pdf',
  );
  const result = await inspectCvPdf(output, profile);
  assert.equal(result.status, 'pass');
  assert.equal(result.pages, 1);
  assert.ok(result.characters > 80);
  assert.deepEqual(result.checks.map((check) => [check.label, check.status]), [
    ['Selectable text', 'pass'], ['Clean text layer', 'pass'],
    ['Name', 'pass'], ['Email', 'pass'], ['Phone', 'pass'],
  ]);
});

test('ATS inspection flags a missing profile email and warns about a missing phone', async () => {
  const output = await createCvPdf(`# Ada Lovelace\n\n${summary}`, 'inspect-warn.pdf');
  const result = await inspectCvPdf(output, { ...profile, email: 'missing@example.com' });
  const checks = Object.fromEntries(result.checks.map((check) => [check.label, check]));
  assert.equal(result.status, 'fail');
  assert.equal(checks.Name.status, 'pass');
  assert.equal(checks.Email.status, 'fail');
  assert.equal(checks.Phone.status, 'warn');
});

test('ATS inspection warns when profile contact details are blank and skips the phone check', async () => {
  const output = await createCvPdf(`# Ada Lovelace\n\n${summary}`, 'inspect-blank.pdf');
  const result = await inspectCvPdf(output, { name: '', email: '', phone: '' });
  assert.equal(result.status, 'warn');
  assert.deepEqual(result.checks.map((check) => check.label), ['Selectable text', 'Clean text layer', 'Name', 'Email']);
  assert(result.checks.filter((check) => ['Name', 'Email'].includes(check.label)).every((check) => check.status === 'warn'));
});

test('ATS inspection fails safely on PDFs without text or unreadable files', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const blankPath = path.join(directory, 'inspect-blank-page.pdf');
  await writeFile(blankPath, await pdf.save());
  const blank = await inspectCvPdf(blankPath, profile);
  assert.equal(blank.status, 'fail');
  assert.equal(blank.characters, 0);
  assert.equal(blank.checks.length, 1);
  assert.equal(blank.checks[0].status, 'fail');
  assert.match(blank.checks[0].detail, /Too little selectable text/);

  const fakePath = path.join(directory, 'inspect-fake.pdf');
  await writeFile(fakePath, 'not a pdf');
  for (const file of [fakePath, path.join(directory, 'missing.pdf')]) {
    const result = await inspectCvPdf(file, profile);
    assert.equal(result.status, 'fail');
    assert.equal(result.pages, 0);
    assert.deepEqual(result.checks, [{
      label: 'Selectable text', status: 'fail', detail: 'The generated PDF could not be read as text.',
    }]);
  }
});

test.after(async () => {
  const { db } = await import('../src/db.js');
  db.close();
  await rm(directory, { recursive: true, force: true });
});
