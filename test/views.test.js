import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderAssist,
  renderCounts,
  renderCvText,
  renderDraft,
  renderJob,
  renderJobs,
  renderSources,
  renderView,
} from '../src/views.js';

// Match the rows returned by db.js without importing it or creating a database.
function job(overrides = {}) {
  return {
    id: 1,
    source: 'greenhouse:acme',
    source_job_id: 'backend-1',
    title: 'Backend Engineer',
    company: 'Acme',
    location: 'Remote',
    description: 'Build reliable services with Node.js.',
    url: 'https://jobs.example.test/backend',
    match_score: 80,
    matched_terms: ['node.js', 'postgresql'],
    status: 'new',
    application_id: null,
    application_status: null,
    ...overrides,
  };
}

function application(overrides = {}) {
  return {
    id: 11,
    job_id: 1,
    title: 'Backend Engineer',
    company: 'Acme',
    location: 'Remote',
    url: 'https://jobs.example.test/backend',
    tailored_cv: 'Built reliable Node.js services and PostgreSQL APIs. '.repeat(3),
    recruiter_message: 'I would like to discuss your backend engineering role.',
    cover_letter: 'My experience building and maintaining services fits this role. '.repeat(3),
    pdf_path: '/unused/application-11.pdf',
    status: 'draft',
    submitted_at: null,
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    profile: {
      id: 1,
      name: 'Alex Example',
      email: 'alex@example.test',
      phone: '+44 1234 567890',
      location: 'London',
      cv_text: 'Backend engineer with Node.js and PostgreSQL experience.',
      target_roles: 'Backend Engineer, Software Engineer',
      target_locations: 'Remote, London',
      min_match: 60,
    },
    jobs: [job()],
    applications: [],
    sources: [{ id: 21, slug: 'acme', type: 'greenhouse', active: 1 }],
    ...overrides,
  };
}

function tagWith(html, tagName, attribute, value) {
  const tags = html.match(new RegExp(`<${tagName}\\b[^>]*>`, 'g')) || [];
  const tag = tags.find((item) => item.includes(` ${attribute}="${value}"`));
  assert.ok(tag, `Expected ${tagName} with ${attribute}="${value}"`);
  return tag;
}

function attributes(tag, expected) {
  for (const [name, value] of Object.entries(expected)) {
    assert.ok(tag.includes(` ${name}="${value}"`), `Expected ${name}="${value}" in ${tag}`);
  }
}

function jobTitles(html) {
  return [...html.matchAll(/<h3>(.*?)<\/h3>/g)]
    .map((match) => match[1])
    .filter((title) => title !== 'No jobs in this view');
}

const hostile = `"</textarea><img src=x onerror="alert(1)"><button hx-post="/injected">owned</button>&'`;
const escapedHostile = '&quot;&lt;/textarea&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;button hx-post=&quot;/injected&quot;&gt;owned&lt;/button&gt;&amp;&#39;';

function assertInert(html) {
  assert.ok(html.includes(escapedHostile), 'The hostile value must remain visible as escaped text');
  assert.ok(!html.includes(hostile), 'The raw hostile value must not appear');
  assert.doesNotMatch(html, /<(?:img|script)\b|hx-post="\/injected"|onerror="alert\(1\)"/i);
}

for (const [view, heading, contentId] of [
  ['jobs', 'Good matches, not more noise.', 'jobs-list'],
  ['review', 'Make every word yours.', 'review-list'],
  ['applications', 'From ready to submitted.', 'applications-list'],
  ['profile', 'One profile. Truthful tailoring.', 'profile-form'],
]) {
  test(`${view} has an active, addressable view shell`, () => {
    const html = renderView(view, state());
    const section = tagWith(html, 'section', 'id', `view-${view}`);
    attributes(section, { class: 'view active', 'data-view': view });
    assert.ok(html.includes(`<h1>${heading}</h1>`));
    assert.ok(html.includes(`id="${contentId}"`));
    assert.equal((html.match(/<section\b/g) || []).length, 1);
    assert.match(html, /<\/section>$/);
  });
}

test('unknown views fail explicitly', () => {
  for (const view of ['unknown', '', null, undefined, hostile]) {
    assert.throws(() => renderView(view, state()), { message: 'Unknown view' });
  }
});

test('empty lists provide useful messages and review only includes drafts', () => {
  const empty = state({ jobs: [], applications: [], sources: [] });
  assert.match(renderView('jobs', empty), /No jobs in this view/);
  assert.match(renderView('review', empty), /No drafts waiting/);
  assert.match(renderView('applications', empty), /No applications yet/);
  assert.match(renderView('profile', empty), /No boards connected yet/);
  assert.match(renderSources([]), /No boards connected yet/);

  const applications = [
    application({ title: 'Draft role' }),
    application({ id: 12, title: 'Approved role', status: 'approved' }),
    application({ id: 13, title: 'Submitted role', status: 'submitted' }),
  ];
  const review = renderView('review', state({ applications }));
  assert.match(review, /<h2>Draft role<\/h2>/);
  assert.doesNotMatch(review, /Approved role|Submitted role/);
  assert.match(renderView('review', state({ applications: applications.slice(1) })), /No drafts waiting/);
  const tracker = renderView('applications', state({ applications }));
  for (const item of applications) assert.ok(tracker.includes(`<h3>${item.title}</h3>`));
});

test('jobs shell wires scanning and debounced filters to HTMX fragments', () => {
  const html = renderView('jobs', state());
  attributes(tagWith(html, 'button', 'data-action', 'scan'), {
    'hx-post': '/api/scan', 'hx-target': '#dashboard', 'hx-swap': 'innerHTML',
    'hx-sync': 'this:drop', 'hx-disabled-elt': 'this, .nav-item',
  });
  attributes(tagWith(html, 'form', 'id', 'job-filters'), {
    'hx-get': '/views/jobs/list', 'hx-target': '#jobs-list', 'hx-swap': 'innerHTML',
    'hx-trigger': 'input changed delay:250ms, change, submit', 'hx-sync': 'this:replace',
  });
  attributes(tagWith(html, 'input', 'id', 'job-search'), { name: 'q', type: 'search' });
  attributes(tagWith(html, 'select', 'id', 'job-filter'), { name: 'filter' });
  attributes(tagWith(html, 'input', 'id', 'match-only'), { name: 'matchOnly', type: 'checkbox', value: 'on' });
  for (const value of ['new', 'all', 'skipped']) tagWith(html, 'option', 'value', value);
});

test('jobs combine trimmed case-insensitive title/company search, status and inclusive threshold', () => {
  const fixture = state({ jobs: [
    job({ id: 1, title: 'Backend Engineer', company: 'Acme', match_score: 90 }),
    job({ id: 2, title: 'Frontend Engineer', company: 'Bright', match_score: 60 }),
    job({ id: 3, title: 'Platform Engineer', company: 'Acme', status: 'skipped', match_score: 80 }),
    job({ id: 4, title: 'Data Analyst', company: 'Cedar', match_score: 59 }),
  ] });
  const open = ['Backend Engineer', 'Frontend Engineer', 'Data Analyst'];
  const all = ['Backend Engineer', 'Frontend Engineer', 'Platform Engineer', 'Data Analyst'];
  for (const [query, expected] of [
    [{}, open],
    [{ filter: 'new' }, open],
    [{ filter: 'invalid' }, open],
    [{ filter: 'all' }, all],
    [{ filter: 'skipped' }, ['Platform Engineer']],
    [{ q: '  bAcKeNd  ' }, ['Backend Engineer']],
    [{ q: ' aCmE ', filter: 'all' }, ['Backend Engineer', 'Platform Engineer']],
    [{ q: ' acme ', filter: 'skipped', matchOnly: 'on' }, ['Platform Engineer']],
    [{ matchOnly: 'on' }, ['Backend Engineer', 'Frontend Engineer']],
    [{ filter: 'all', matchOnly: 'on' }, ['Backend Engineer', 'Frontend Engineer', 'Platform Engineer']],
    [{ q: 'engineer', matchOnly: 'on' }, ['Backend Engineer', 'Frontend Engineer']],
    [{ q: 'analyst', matchOnly: 'on' }, []],
    [{ q: 'Node.js' }, []], // Description and matched terms are not searched.
    [{ q: 'missing' }, []],
    [{ q: null }, open],
    [{ q: 123 }, []],
  ]) {
    const html = renderJobs(fixture, query);
    assert.deepEqual(jobTitles(html), expected, JSON.stringify(query));
    if (!expected.length) assert.match(html, /No jobs in this view/);
  }
  for (const matchOnly of [undefined, '', 'off', 'true', true, 1]) {
    assert.deepEqual(jobTitles(renderJobs(fixture, { matchOnly })), open);
  }
  assert.deepEqual(jobTitles(renderJobs({ ...fixture, profile: { ...fixture.profile, min_match: 90 } }, { matchOnly: 'on' })), ['Backend Engineer']);
});

test('unapplied job actions use fragment targets and preserve filters on skip/restore', () => {
  const html = renderJobs(state());
  attributes(tagWith(html, 'button', 'data-action', 'prepare'), {
    'data-id': '1', 'hx-post': '/api/jobs/1/prepare', 'hx-target': '#dashboard',
    'hx-swap': 'innerHTML', 'hx-sync': 'this:drop', 'hx-disabled-elt': 'this, .nav-item',
  });
  attributes(tagWith(html, 'button', 'data-action', 'view-job'), {
    'hx-get': '/views/jobs/1', 'hx-target': '#job-detail', 'hx-swap': 'innerHTML',
  });
  attributes(tagWith(html, 'button', 'data-action', 'skip'), {
    'hx-post': '/api/jobs/1/skip', 'hx-target': '#jobs-list', 'hx-include': '#job-filters',
  });
  const skipped = renderJobs(state({ jobs: [job({ status: 'skipped' })] }), { filter: 'skipped' });
  attributes(tagWith(skipped, 'button', 'data-action', 'restore'), {
    'hx-post': '/api/jobs/1/restore', 'hx-target': '#jobs-list', 'hx-include': '#job-filters',
  });
  assert.doesNotMatch(skipped, /data-action="skip"/);
  attributes(tagWith(renderJob(job()), 'button', 'data-action', 'prepare'), {
    'hx-post': '/api/jobs/1/prepare', 'hx-target': '#dashboard', 'hx-swap': 'innerHTML',
  });
});

test('existing applications route to review or tracker without prepare/skip/restore controls', () => {
  for (const status of ['draft', 'approved', 'submitted']) {
    for (const joined of [true, false]) {
      const item = job({ application_id: 11, application_status: joined ? status : null });
      const html = renderJobs(state({ jobs: [item], applications: [application({ status })] }));
      const review = status === 'draft';
      attributes(tagWith(html, 'button', 'data-action', review ? 'open-review' : 'open-applications'), {
        'hx-get': review ? '/views/review' : '/views/applications', 'hx-target': '#dashboard',
      });
      assert.match(html, review ? /Review draft/ : /View application/);
      assert.doesNotMatch(html, /data-action="(?:prepare|skip|restore)"/);
      assert.doesNotMatch(renderJob(item), /data-action="prepare"/);
    }
  }
  const missingStatus = renderJobs(state({ jobs: [job({ application_id: 11 })] }));
  tagWith(missingStatus, 'button', 'data-action', 'open-review');
});

test('score styling is finite and clamped; terms are limited and absent location has a fallback', () => {
  for (const [score, expected] of [[-5, 0], [0, 0], [60, 60], [100, 100], [150, 100], [Infinity, 0], [NaN, 0], ['80; color:red', 0]]) {
    const html = renderJobs(state({ jobs: [job({ match_score: score })] }));
    attributes(tagWith(html, 'div', 'class', 'match-score'), { style: `--score:${expected}` });
  }
  const html = renderJobs(state({ jobs: [job({ location: '', matched_terms: ['one', 'two', 'three', 'four', 'five', 'six'] })] }));
  assert.match(html, /Location not listed/);
  assert.equal((html.match(/class="term"/g) || []).length, 5);
  assert.match(html, /<span class="term">five<\/span>/);
  assert.doesNotMatch(html, /<span class="term">six<\/span>/);
});

test('hostile job metadata, description, scores and identifiers remain inert', () => {
  const item = job({
    id: hostile, title: hostile, company: hostile, source: hostile,
    location: hostile, description: hostile, match_score: hostile, matched_terms: [hostile],
  });
  const encodedId = encodeURIComponent(hostile).replaceAll("'", '&#39;');
  const list = renderJobs(state({ jobs: [item] }));
  const detail = renderJob(item);
  for (const html of [list, detail]) {
    assertInert(html);
    attributes(tagWith(html, 'button', 'data-action', 'prepare'), {
      'data-id': escapedHostile, 'hx-post': `/api/jobs/${encodedId}/prepare`,
    });
  }
  assert.ok(list.includes(`<h3>${escapedHostile}</h3>`));
  assert.ok(list.includes(`<div class="job-company">${escapedHostile} · ${escapedHostile}</div>`));
  assert.ok(list.includes(`<div class="job-meta">${escapedHostile}</div>`));
  assert.ok(list.includes(`<span class="term">${escapedHostile}</span>`));
  attributes(tagWith(list, 'div', 'class', 'match-score'), { style: '--score:0' });
  assert.ok(list.includes(`<span>${escapedHostile}%</span>`));
  attributes(tagWith(list, 'button', 'data-action', 'view-job'), { 'hx-get': `/views/jobs/${encodedId}` });
  attributes(tagWith(list, 'button', 'data-action', 'skip'), { 'hx-post': `/api/jobs/${encodedId}/skip` });
  assert.ok(detail.includes(`<h2>${escapedHostile}</h2>`));
  assert.ok(detail.includes(`<div class="job-description">${escapedHostile}</div>`));
});

test('external posting links allow only credential-free HTTPS and escape URL attributes', () => {
  const allowed = [
    ['https://jobs.example.test/role?a=1&b=2#apply', 'https://jobs.example.test/role?a=1&amp;b=2#apply'],
    ['HTTPS://Jobs.Example.Test:443/role', 'https://jobs.example.test/role'],
    ["https://jobs.example.test/role?q='quoted'", 'https://jobs.example.test/role?q=%27quoted%27'],
  ];
  const blocked = [
    'http://jobs.example.test/role', 'javascript:alert(1)', 'data:text/html,<img src=x>',
    'ftp://jobs.example.test/role', '//jobs.example.test/role', '/role', 'not a URL', '',
    'https://user@jobs.example.test/role', 'https://:secret@jobs.example.test/role',
    'https://user:secret@jobs.example.test/role', 'https://%75ser@jobs.example.test/role',
    hostile, null, undefined,
  ];
  for (const [url, expected] of [...allowed, ...blocked.map((url) => [url, '#'])]) {
    for (const html of [renderJob(job({ url })), renderView('applications', state({ applications: [application({ url })] }))]) {
      const link = tagWith(html, 'a', 'target', '_blank');
      attributes(link, { href: expected, rel: 'noopener noreferrer' });
      assert.doesNotMatch(link, /hx-post="\/injected"|<img\b/);
    }
  }
});

test('only approved applications offer assisted apply and confirmed submission', () => {
  for (const status of ['draft', 'approved', 'submitted', 'rejected', 'APPROVED', 'approved ', hostile]) {
    const html = renderView('applications', state({ applications: [application({ status })] }));
    tagWith(html, 'a', 'href', '/api/applications/11/pdf');
    tagWith(html, 'div', 'id', 'assist-result');
    if (status !== 'approved') {
      assert.doesNotMatch(html, /data-action="(?:assist|submitted)"|hx-post="[^\"]*\/(?:assist|submit)"/);
    } else {
      const assist = tagWith(html, 'button', 'data-action', 'assist');
      attributes(assist, {
        'hx-post': '/api/applications/11/assist', 'hx-target': '#assist-result',
        'hx-swap': 'innerHTML', 'hx-sync': 'this:drop', 'hx-disabled-elt': 'this, .nav-item',
      });
      assert.match(assist, /hx-confirm="[^"]*shares your contact details, approved cover letter and CV[^"]*attachments may upload immediately\.[^"]*automated prefill is permitted\./);
      attributes(tagWith(html, 'button', 'data-action', 'submitted'), {
        'hx-post': '/api/applications/11/submit', 'hx-target': '#dashboard', 'hx-swap': 'innerHTML',
        'hx-confirm': 'Did you complete and verify the final submission in the job portal?',
      });
    }
    if (status === 'draft') {
      attributes(tagWith(html, 'button', 'data-action', 'open-review'), { 'hx-get': '/views/review', 'hx-target': '#dashboard' });
    } else {
      assert.doesNotMatch(html, /data-action="open-review"/);
    }
    if (status === hostile) assertInert(html);
  }
});

test('draft form saves with PUT and approves included validated edits with confirmation', () => {
  const item = application();
  const html = renderDraft(item);
  attributes(tagWith(html, 'form', 'id', 'application-11'), {
    'data-application': '11', 'hx-put': '/api/applications/11', 'hx-target': 'this',
    'hx-swap': 'outerHTML', 'hx-sync': 'closest form:drop',
    'hx-disabled-elt': '#application-11 button, #application-11 textarea, .nav-item',
  });
  for (const [name, value, min, max] of [
    ['tailoredCv', item.tailored_cv, '100', '60000'],
    ['recruiterMessage', item.recruiter_message, '20', '4000'],
    ['coverLetter', item.cover_letter, '100', '12000'],
  ]) {
    const tag = tagWith(html, 'textarea', 'name', name);
    attributes(tag, { minlength: min, maxlength: max });
    assert.match(tag, /\srequired(?:\s|>)/);
    assert.ok(html.includes(`${tag}${value}</textarea>`));
  }
  attributes(tagWith(html, 'button', 'data-action', 'save-draft'), { type: 'submit', 'data-id': '11' });
  attributes(tagWith(html, 'button', 'data-action', 'approve'), {
    type: 'button', 'hx-post': '/api/applications/11/approve', 'hx-include': 'closest form',
    'hx-target': '#dashboard', 'hx-swap': 'innerHTML', 'hx-validate': 'true',
    'hx-confirm': 'Approve this reviewed application?',
  });
  tagWith(html, 'a', 'href', '/api/applications/11/pdf');
});

test('application text and attributes cannot escape cards or draft textareas', () => {
  const item = application({
    id: hostile, title: hostile, company: hostile, location: hostile,
    tailored_cv: hostile, recruiter_message: hostile, cover_letter: hostile,
  });
  const encodedId = encodeURIComponent(hostile).replaceAll("'", '&#39;');
  const draft = renderDraft(item);
  assertInert(draft);
  assert.equal((draft.match(/<textarea\b/g) || []).length, 3);
  assert.equal((draft.match(/<\/textarea>/g) || []).length, 3);
  for (const name of ['tailoredCv', 'recruiterMessage', 'coverLetter']) {
    const tag = tagWith(draft, 'textarea', 'name', name);
    assert.ok(draft.includes(`${tag}${escapedHostile}</textarea>`));
  }
  attributes(tagWith(draft, 'form', 'id', `application-${escapedHostile}`), {
    'data-application': escapedHostile, 'hx-put': `/api/applications/${encodedId}`,
    'hx-disabled-elt': `#application-${escapedHostile} button, #application-${escapedHostile} textarea, .nav-item`,
  });
  attributes(tagWith(draft, 'button', 'data-action', 'approve'), {
    'data-id': escapedHostile, 'hx-post': `/api/applications/${encodedId}/approve`,
  });
  assert.ok(draft.includes(`<h2>${escapedHostile}</h2>`));
  assert.ok(draft.includes(`<p>${escapedHostile} · ${escapedHostile}</p>`));
  const tracker = renderView('applications', state({ applications: [{ ...item, status: 'approved' }] }));
  assertInert(tracker);
  assert.ok(tracker.includes(`<h3>${escapedHostile}</h3>`));
  assert.ok(tracker.includes(`<p>${escapedHostile} · ${escapedHostile}</p>`));
  for (const [action, endpoint] of [['assist', 'assist'], ['submitted', 'submit']]) {
    attributes(tagWith(tracker, 'button', 'data-action', action), {
      'data-id': escapedHostile, 'hx-post': `/api/applications/${encodedId}/${endpoint}`,
    });
  }
  tagWith(tracker, 'a', 'href', `/api/applications/${encodedId}/pdf`);
});

test('profile preserves saved values and keeps multipart CV upload outside the profile form', () => {
  const fixture = state();
  const html = renderView('profile', fixture);
  const forms = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) || [];
  assert.equal(forms.length, 3);
  for (const form of forms) assert.equal((form.match(/<form\b/g) || []).length, 1, 'Forms must not be nested');
  const profileForm = forms.find((form) => form.includes('id="profile-form"'));
  const uploadForm = forms.find((form) => form.includes('id="cv-file"'));
  assert.ok(profileForm);
  assert.ok(uploadForm);
  attributes(tagWith(profileForm, 'form', 'id', 'profile-form'), {
    'hx-put': '/api/profile', 'hx-target': '#profile-result', 'hx-swap': 'innerHTML',
  });
  for (const [name, key] of [
    ['name', 'name'], ['email', 'email'], ['phone', 'phone'], ['location', 'location'],
    ['targetRoles', 'target_roles'], ['targetLocations', 'target_locations'], ['minMatch', 'min_match'],
  ]) attributes(tagWith(profileForm, 'input', 'name', name), { value: String(fixture.profile[key]) });
  attributes(tagWith(profileForm, 'input', 'name', 'minMatch'), { type: 'range', min: '0', max: '100' });
  assert.match(tagWith(profileForm, 'input', 'name', 'targetRoles'), /\srequired(?:\s|>)/);
  assert.ok(profileForm.includes(`${fixture.profile.min_match}%</span>`));
  const cv = tagWith(profileForm, 'textarea', 'name', 'cvText');
  attributes(cv, { id: 'cv-text', maxlength: '100000' });
  assert.match(cv, /\srequired(?:\s|>)/);
  assert.ok(profileForm.includes(`${cv}${fixture.profile.cv_text}</textarea>`));
  assert.doesNotMatch(profileForm, /type="file"|name="cv"|\/api\/profile\/cv/);
  assert.doesNotMatch(uploadForm, /name="cvText"|hx-put="\/api\/profile"/);
  tagWith(uploadForm, 'form', 'enctype', 'multipart/form-data');
  attributes(tagWith(uploadForm, 'input', 'id', 'cv-file'), {
    name: 'cv', type: 'file', accept: '.pdf,.docx,.txt,.md', 'hx-post': '/api/profile/cv',
    'hx-trigger': 'change', 'hx-encoding': 'multipart/form-data', 'hx-params': 'cv',
    'hx-target': '#cv-text', 'hx-swap': 'outerHTML',
  });
  attributes(tagWith(html, 'form', 'id', 'source-form'), {
    'hx-post': '/api/sources', 'hx-target': '#sources-list', 'hx-swap': 'innerHTML',
  });
  attributes(tagWith(html, 'input', 'name', 'slug'), { pattern: '[A-Za-z0-9_-]+', maxlength: '100' });
});

test('profile values and uploaded CV text cannot inject attributes or close the textarea', () => {
  const profile = state().profile;
  for (const key of ['name', 'email', 'phone', 'location', 'target_roles', 'target_locations', 'min_match', 'cv_text']) profile[key] = hostile;
  const html = renderView('profile', state({ profile }));
  assertInert(html);
  for (const name of ['name', 'email', 'phone', 'location', 'targetRoles', 'targetLocations', 'minMatch']) {
    attributes(tagWith(html, 'input', 'name', name), { value: escapedHostile });
  }
  const cv = renderCvText(hostile);
  assertInert(cv);
  assert.equal((cv.match(/<textarea\b/g) || []).length, 1);
  assert.equal((cv.match(/<\/textarea>/g) || []).length, 1);
  assert.ok(cv.includes(`>${escapedHostile}</textarea>`));
  assert.ok(html.includes(cv));
  assert.match(renderCvText(null), /><\/textarea>$/);
});

test('connected sources escape labels and IDs while using encoded HTMX delete URLs', () => {
  const html = renderSources([{ id: hostile, slug: hostile, type: hostile }]);
  assertInert(html);
  assert.ok(html.includes(`<strong>${escapedHostile}</strong><small>${escapedHostile}</small>`));
  attributes(tagWith(html, 'button', 'data-action', 'delete-source'), {
    'aria-label': `Remove ${escapedHostile}`, 'data-id': escapedHostile,
    'hx-delete': `/api/sources/${encodeURIComponent(hostile).replaceAll("'", '&#39;')}`,
    'hx-target': '#sources-list', 'hx-swap': 'innerHTML', 'hx-sync': 'this:drop', 'hx-disabled-elt': 'this, .nav-item',
  });
});

test('out-of-band counts include every new job, only drafts in review and all applications', () => {
  const fixture = state({
    jobs: [job({ match_score: 10 }), job({ id: 2, application_id: 11 }), job({ id: 3, status: 'skipped' })],
    applications: [application(), application({ id: 12, status: 'approved' }), application({ id: 13, status: 'submitted' })],
  });
  for (const [input, expected] of [
    [fixture, { 'jobs-count': 2, 'review-count': 1, 'applications-count': 3 }],
    [state({ jobs: [], applications: [] }), { 'jobs-count': 0, 'review-count': 0, 'applications-count': 0 }],
  ]) {
    const html = renderCounts(input);
    for (const [id, count] of Object.entries(expected)) {
      const tag = tagWith(html, 'span', 'id', id);
      attributes(tag, { class: 'count', 'hx-swap-oob': 'outerHTML' });
      assert.ok(html.includes(`${tag}${count}</span>`));
    }
  }
});

test('scan results toggle visibility, include zero counts and escape source/count/error text', () => {
  for (const scanResults of [undefined, null]) {
    assert.match(tagWith(renderView('jobs', state({ scanResults })), 'div', 'id', 'scan-results'), /\shidden(?:\s|>)/);
  }
  for (const scanResults of [[], [{ source: 'Acme', count: 0 }]]) {
    const html = renderView('jobs', state({ scanResults }));
    assert.doesNotMatch(tagWith(html, 'div', 'id', 'scan-results'), /\shidden(?:\s|>)/);
    if (scanResults.length) assert.match(html, /<strong>Acme<\/strong>: 0 openings found/);
  }
  const html = renderView('jobs', state({ scanResults: [
    { source: hostile, count: hostile },
    { source: 'Failed board', count: 999, error: hostile },
    { source: 'Successful board', count: 4 },
  ] }));
  assertInert(html);
  assert.ok(html.includes(`<strong>${escapedHostile}</strong>: ${escapedHostile} openings found`));
  assert.ok(html.includes(`<strong>Failed board</strong>: ${escapedHostile}</p>`));
  assert.match(html, /<strong>Successful board<\/strong>: 4 openings found/);
  assert.doesNotMatch(html, /999 openings found/);
});

test('assisted apply pauses explain the required manual action without claiming success', () => {
  for (const [paused, messages] of [
    ['login-or-captcha', [/Paused\./, /Handle login or CAPTCHA yourself/, /select Assisted apply again/]],
    ['manual-form', [/Open the application form in Chrome/, /select Assisted apply again/, /Unrecognized forms require manual completion/]],
    ['different-site', [/tab moved to another site/, /Complete that portal manually/, /no information was filled/]],
  ]) {
    const html = renderAssist({ paused, filledFields: 9, cvAttached: true });
    for (const message of messages) assert.match(html, message);
    assert.doesNotMatch(html, /9 fields filled|CV attached\./);
  }
});

test('assisted apply completion reports attachment state, keeps submission manual and escapes messages', () => {
  const attached = renderAssist({ filledFields: 3, cvAttached: true });
  assert.match(attached, /3 fields filled\. CV attached\./);
  assert.match(attached, /Review every field and submit yourself\./);
  const unattached = renderAssist({ filledFields: 0, cvAttached: false });
  assert.match(unattached, /0 fields filled\./);
  assert.match(unattached, /No new attachment added; check the CV in Chrome\./);
  assert.match(unattached, /Review every field and submit yourself\./);
  const html = renderAssist({ paused: 'unknown', filledFields: hostile, cvAttached: false });
  assertInert(html);
  assert.ok(html.includes(`${escapedHostile} fields filled.`));
});
