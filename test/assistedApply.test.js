import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = await mkdtemp(path.join(tmpdir(), 'proofloop-assist-test-'));
process.env.DATA_DIRECTORY = directory;
const { assistApplication, closeAssistedBrowser } = await import('../src/assistedApply.js');
const { createCvPdf } = await import('../src/documents.js');
const pdfPath = await createCvPdf('# Ada Lovelace\n\nBuilt analytical systems and improved reliability.', 'approved-cv.pdf');
const profile = { name: 'Ada Lovelace', email: 'ada@example.com', phone: '+44 1234 567890', location: 'London' };
const observations = new EventEmitter();
let submissions = 0;
let visits = 0;
let uploads = 0;
const server = createServer(async (request, response) => {
  if (request.url === '/submit') submissions += 1;
  if (request.url === '/observe') {
    let body = '';
    for await (const chunk of request) body += chunk;
    uploads += 1;
    observations.emit('upload', JSON.parse(body));
    response.writeHead(204).end();
    return;
  }
  if (request.url === '/favicon.ico') return response.writeHead(204).end();
  visits += 1;
  response.setHeader('content-type', 'text/html');
  const blocker = request.url === '/login' ? '<input type="password">'
    : request.url === '/captcha' ? '<div class="g-recaptcha">Human verification</div>' : '';
  const cv = request.url === '/listing' ? '' : '<label for="attachment">Resume</label><input id="attachment" type="file" accept="application/pdf">';
  response.end(`<!doctype html><html><body>
    <form><input name="email" type="email" id="newsletter"></form>
    <form action="/submit" method="post" ${request.url === '/hidden' ? 'hidden' : ''}>
      ${blocker}
      <input name="fullName">
      <input name="email" type="email" value="existing@example.com">
      <input name="phone" type="tel">
      <input name="location">
      <input name="name" type="hidden">
      <input name="salary">
      <input type="checkbox" name="consent">
      <textarea name="coverLetter"></textarea>
      ${cv}
      ${request.url === '/ambiguous' ? '<input type="file" name="resume2" accept=".pdf">' : ''}
      <input type="file" name="photo" accept=".pdf">
      <button type="submit">Submit</button>
    </form>
    <script>
      document.querySelector('#attachment')?.addEventListener('change', (event) => {
        const form = event.target.form;
        fetch('/observe', { method: 'POST', body: JSON.stringify({
          name: form.elements.fullName.value,
          email: form.elements.email.value,
          phone: form.elements.phone.value,
          location: form.elements.location.value,
          coverLetter: form.elements.coverLetter.value,
          salary: form.elements.salary.value,
          consent: form.elements.consent.checked,
          hiddenName: form.elements.name.value,
          newsletter: document.querySelector('#newsletter').value,
          file: event.target.files[0]?.name,
          photo: form.elements.photo.files.length,
        }) });
      });
    </script>
  </body></html>`);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const application = { id: 1, url: `${baseUrl}/apply`, cover_letter: 'A reviewed cover letter.' };

test('fills only empty application fields, attaches the CV, and never submits', async () => {
  const observed = once(observations, 'upload', { signal: AbortSignal.timeout(10000) });
  const result = await assistApplication(application, profile, pdfPath, { headless: true });
  assert.deepEqual(result, { opened: true, filledFields: 4, cvAttached: true, paused: null });
  const [snapshot] = await observed;
  assert.deepEqual(snapshot, {
    name: profile.name, email: 'existing@example.com', phone: profile.phone, location: profile.location,
    coverLetter: application.cover_letter, salary: '', consent: false, hiddenName: '', newsletter: '',
    file: 'approved-cv.pdf', photo: 0,
  });
  assert.equal(submissions, 0);
});

test('reuses the current tab and preserves entered values and attachments', async () => {
  const beforeVisits = visits;
  const beforeUploads = uploads;
  const result = await assistApplication(application, { ...profile, name: 'Replacement' }, pdfPath, { headless: true });
  assert.deepEqual(result, { opened: true, filledFields: 0, cvAttached: false, paused: null });
  assert.equal(visits, beforeVisits);
  assert.equal(uploads, beforeUploads);
  assert.equal(submissions, 0);
});

for (const [index, route] of ['login', 'captcha', 'listing', 'ambiguous', 'hidden'].entries()) {
  test(`pauses without filling or attaching on ${route} pages`, async () => {
    const beforeUploads = uploads;
    const result = await assistApplication({ ...application, id: index + 2, url: `${baseUrl}/${route}` }, profile, pdfPath, { headless: true });
    assert.deepEqual(result, {
      opened: true, filledFields: 0, cvAttached: false,
      paused: ['login', 'captcha'].includes(route) ? 'login-or-captcha' : 'manual-form',
    });
    assert.equal(uploads, beforeUploads);
    assert.equal(submissions, 0);
  });
}

test('coalesces concurrent requests for the same application', async () => {
  const beforeVisits = visits;
  const item = { ...application, id: 20 };
  const observed = once(observations, 'upload', { signal: AbortSignal.timeout(10000) });
  const results = await Promise.all([
    assistApplication(item, profile, pdfPath, { headless: true }),
    assistApplication(item, profile, pdfPath, { headless: true }),
  ]);
  await observed;
  assert.deepEqual(results[0], results[1]);
  assert.equal(visits, beforeVisits + 1);
  assert.equal(submissions, 0);
});

test('rejects URLs with credentials or non-web schemes', async () => {
  for (const url of ['file:///private', 'javascript:alert(1)', 'https://user:secret@example.com']) {
    await assert.rejects(assistApplication({ ...application, id: 30, url }, profile, pdfPath), /HTTP\(S\)/);
  }
});

test.after(async () => {
  await closeAssistedBrowser();
  const closed = once(server, 'close');
  server.close();
  await closed;
  const { db } = await import('../src/db.js');
  db.close();
  await rm(directory, { recursive: true, force: true });
});
