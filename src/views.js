import { FOLLOW_UP_DAYS, OUTCOME_EVENT_LABELS, OUTCOME_LABELS, OUTCOME_STAGES, daysSince } from './outcomes.js';

const ATS_STATUS_LABELS = { pass: 'Passed', warn: 'Warnings', fail: 'Needs attention' };
const outcomeEventLabels = Object.fromEntries(
  Object.entries(OUTCOME_EVENT_LABELS).map(([stage, label]) => [`outcome_${stage}`, label]),
);

export function renderView(view, state) {
  let content;
  switch (view) {
    case 'jobs':
      content = `
        <div class="page-heading">
          <div><p class="eyebrow">OPPORTUNITY INBOX</p><h1>Good matches, not more noise.</h1><p>Ranked against your target roles and evidence in your CV.</p></div>
          <button type="button" class="button primary" data-action="scan" hx-post="/api/scan" hx-target="#dashboard" hx-swap="innerHTML" hx-sync="this:drop" hx-disabled-elt="this, .nav-item">Scan sources</button>
        </div>
        ${renderSearch(state)}
        <div id="scan-results" class="scan-results" ${state.scanResults ? '' : 'hidden'}>${(state.scanResults || []).map((item) => `<p><strong>${escapeHtml(item.source)}</strong>: ${item.error ? escapeHtml(item.error) : `${escapeHtml(item.count)} openings found`}</p>`).join('')}</div>
        <form id="job-filters" class="toolbar" hx-get="/views/jobs/list" hx-target="#jobs-list" hx-swap="innerHTML" hx-trigger="input changed delay:250ms, change, submit" hx-sync="this:replace">
          <label class="search"><span class="sr-only">Search jobs</span><input name="q" id="job-search" type="search" placeholder="Search title or company…"></label>
          <select name="filter" id="job-filter" aria-label="Filter jobs"><option value="new">Open matches</option><option value="all">All jobs</option><option value="skipped">Skipped</option></select>
          <label class="check"><input name="matchOnly" id="match-only" type="checkbox" value="on"> Above my threshold</label>
        </form>
        <div id="jobs-list" class="job-list">${renderJobs(state)}</div>`;
      break;
    case 'review': {
      const drafts = state.applications.filter((item) => item.status === 'draft');
      content = `
        <div class="page-heading"><div><p class="eyebrow">HUMAN REVIEW</p><h1>Make every word yours.</h1><p>Edit the draft, verify every claim, then approve the application.</p></div></div>
        <div id="review-list" class="review-list">${drafts.length ? drafts.map(renderDraft).join('') : emptyState('No drafts waiting', 'Choose a job and select Prepare to create a tailored application.')}</div>`;
      break;
    }
    case 'applications':
      content = `
        <div class="page-heading"><div><p class="eyebrow">APPLICATION TRACKER</p><h1>From ready to submitted.</h1><p>Assisted apply uses installed Google Chrome to fill recognized application forms. Handle login, CAPTCHA, screening answers, and submission yourself; select Assisted apply again after navigating to the form. Record any replies or interviews yourself.</p></div></div>
        <div class="metrics-grid" aria-label="Application totals">
          <div class="metric"><strong id="companies-applied">${state.metrics.companiesApplied}</strong><span>Companies applied to</span></div>
          <div class="metric"><strong id="submitted-total">${state.metrics.submitted}</strong><span>Confirmed submissions</span></div>
          <div class="metric"><strong id="approved-total">${state.metrics.approved}</strong><span>Approved, not submitted</span></div>
          <div class="metric"><strong id="drafts-total">${state.metrics.drafts}</strong><span>Drafts to review</span></div>
        </div>
        <p class="tracking-note">Only submissions you confirm count as applied. Company names are grouped ignoring case and extra spaces, not aliases or subsidiaries.</p>
        <div class="panel funnel-panel" aria-label="Outcome funnel">
          <div class="panel-heading"><div><h2>Stage reach</h2><p>User-recorded outcomes only. Counts are cumulative, so an interview still counts after a later rejection.</p></div></div>
          <div class="funnel-grid">
            <div class="funnel-step"><strong id="funnel-applied">${state.metrics.submitted}</strong><span>Applied</span></div>
            <div class="funnel-step"><strong id="funnel-interviews">${state.metrics.interviews}</strong><span>Interviewed</span></div>
            <div class="funnel-step"><strong id="funnel-offers">${state.metrics.offers}</strong><span>Offered</span></div>
            <div class="funnel-step"><strong id="funnel-hired">${state.metrics.hired}</strong><span>Hired</span></div>
          </div>
          <p class="funnel-note">${state.metrics.awaitingOutcome} awaiting an outcome · ${state.metrics.followUpDue} ready for a follow-up (${FOLLOW_UP_DAYS}+ days quiet) · ${state.metrics.closed} closed</p>
          <p class="hint">Outcomes are saved locally. ProofLoop does not contact employers, send follow-ups or detect replies.</p>
        </div>
        <div id="assist-result" class="scan-results" role="status"></div>
        <div id="applications-list" class="applications-list">${state.applications.length ? state.applications.map(renderApplication).join('') : emptyState('No applications yet', 'Approved and submitted applications will appear here.')}</div>
        <div class="panel activity-panel"><div class="panel-heading"><div><h2>Application activity</h2><p>Newest first · saved locally · times in UTC</p></div></div><div id="activity-list">${renderActivity(state.activity)}</div></div>`;
      break;
    case 'profile':
      content = renderProfile(state);
      break;
    default:
      throw new Error('Unknown view');
  }
  return `<section id="view-${escapeHtml(view)}" class="view active" data-view="${escapeHtml(view)}">${content}</section>`;
}

function renderSearch(state) {
  const search = state.search || {
    site: 'indeed', searchTerm: state.profile.target_roles.split(',')[0].trim(),
    location: state.profile.target_locations.split(',')[0].trim(), country: 'india', resultsWanted: 15, hoursOld: 168,
  };
  const result = state.searchResult;
  return `<details class="panel discovery-panel" ${result ? 'open' : ''}>
    <summary>Search job boards with JobSpy <span class="hint">LinkedIn + Indeed</span></summary>
    <p>Search by role and location, without company board slugs. Only these search settings go to the provider—not your CV or contact details. Use only where permitted; blocked searches are not bypassed.</p>
    <form id="jobspy-search" class="discovery-form" hx-post="/api/search" hx-target="#dashboard" hx-swap="innerHTML" hx-sync="this:drop" hx-disabled-elt="#jobspy-search button, #jobspy-search input, #jobspy-search select, .nav-item, [data-action=scan]">
      <div class="form-grid">
        <label>Job board<select name="site">${[['indeed', 'Indeed'], ['linkedin', 'LinkedIn']].map(([value, label]) => `<option value="${value}" ${search.site === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label>Role or keywords<input name="searchTerm" required minlength="2" maxlength="200" value="${escapeHtml(search.searchTerm)}" placeholder="Backend Engineer"></label>
        <label>Search location<input name="location" required minlength="2" maxlength="160" value="${escapeHtml(search.location)}" placeholder="Bengaluru"></label>
        <label>Country (Indeed)<select name="country">${[['india', 'India'], ['usa', 'United States'], ['uk', 'United Kingdom'], ['canada', 'Canada'], ['australia', 'Australia'], ['germany', 'Germany'], ['france', 'France']].map(([value, label]) => `<option value="${value}" ${search.country === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label>Maximum results<input name="resultsWanted" type="number" required min="1" max="25" value="${escapeHtml(search.resultsWanted)}"></label>
        <label>Posted within (hours)<input name="hoursOld" type="number" required min="1" max="720" value="${escapeHtml(search.hoursOld)}"></label>
      </div>
      <button type="submit" class="button secondary">Search JobSpy</button>
    </form>
    <p class="hint">Optional setup: <code>bun run setup:jobspy</code> (Python 3.10+). One search at a time, up to 25 results, 90-second timeout, 60-second cooldown. No automatic retries. Provider filters and availability vary.</p>
    ${result ? `<div id="jobspy-result" class="scan-results" role="status"><p><strong>${escapeHtml(result.source)}</strong>: ${escapeHtml(result.count)} usable openings returned. Repeated provider IDs update existing jobs.${result.skipped ? ` ${escapeHtml(result.skipped)} invalid records skipped.` : ''}</p>${result.errors.map((message) => `<p class="search-error">Provider error: ${escapeHtml(message)} Results may be incomplete; try later or use company boards.</p>`).join('')}${result.warnings.map((message) => `<p>Warning: ${escapeHtml(message)}</p>`).join('')}${!result.count && !result.errors.length ? '<p>No openings returned. Try different keywords or a different location after the cooldown.</p>' : ''}</div>` : ''}
  </details>`;
}

export function renderJobs(state, query = {}) {
  const q = String(query.q ?? '').toLowerCase().trim();
  const filter = ['new', 'all', 'skipped'].includes(query.filter) ? query.filter : 'new';
  const matchOnly = query.matchOnly === 'on';
  const jobs = state.jobs.filter((job) => {
    if (filter !== 'all' && job.status !== filter) return false;
    if (matchOnly && job.match_score < state.profile.min_match) return false;
    return `${job.title} ${job.company}`.toLowerCase().includes(q);
  });
  return jobs.length ? jobs.map((job) => {
    const id = escapeHtml(job.id);
    const endpoint = `/api/jobs/${urlId(job.id)}`;
    const applicationStatus = job.application_status || state.applications.find((item) => item.id === job.application_id)?.status;
    const review = !applicationStatus || applicationStatus === 'draft';
    return `
      <article class="job-card">
        <div class="match-score" style="--score:${matchScore(job.match_score)}"><span>${escapeHtml(job.match_score)}%</span></div>
        <div>
          <div class="job-company">${escapeHtml(job.company)} · ${escapeHtml(job.source)}</div>
          <h3>${escapeHtml(job.title)}</h3>
          <div class="job-meta">${escapeHtml(job.location || 'Location not listed')}</div>
          <div class="term-list">${job.matched_terms.slice(0, 5).map((term) => `<span class="term">${escapeHtml(term)}</span>`).join('')}</div>
        </div>
        <div class="job-actions">
          ${job.application_id
            ? `<button type="button" class="button ghost small" data-action="${review ? 'open-review' : 'open-applications'}" hx-get="/views/${review ? 'review' : 'applications'}" hx-target="#dashboard" hx-swap="innerHTML">${review ? 'Review draft' : 'View application'}</button>`
            : `<button type="button" class="button ghost small" ${job.description.trim() ? '' : 'disabled title="Job description unavailable; view the original posting"'} data-action="prepare" data-id="${id}" hx-post="${endpoint}/prepare" hx-target="#dashboard" hx-swap="innerHTML" hx-sync="this:drop" hx-disabled-elt="this, .nav-item">Prepare</button>`}
          <button type="button" class="button secondary small" data-action="view-job" data-id="${id}" hx-get="/views/jobs/${urlId(job.id)}" hx-target="#job-detail" hx-swap="innerHTML">View</button>
          ${job.application_id ? '' : job.status === 'new'
            ? `<button type="button" class="icon-button" title="Skip job" data-action="skip" data-id="${id}" hx-post="${endpoint}/skip" hx-target="#jobs-list" hx-swap="innerHTML" hx-include="#job-filters">Skip</button>`
            : `<button type="button" class="icon-button" title="Restore job" data-action="restore" data-id="${id}" hx-post="${endpoint}/restore" hx-target="#jobs-list" hx-swap="innerHTML" hx-include="#job-filters">Restore</button>`}
        </div>
      </article>`;
  }).join('') : emptyState('No jobs in this view', 'Add a source and scan, or adjust your filters.');
}

export function renderSources(sources) {
  return sources.length ? sources.map((source) => `
    <div class="source-item"><div><strong>${escapeHtml(source.slug)}</strong><small>${escapeHtml(source.type)}</small></div><button type="button" class="icon-button" aria-label="Remove ${escapeHtml(source.slug)}" data-action="delete-source" data-id="${escapeHtml(source.id)}" hx-delete="/api/sources/${urlId(source.id)}" hx-target="#sources-list" hx-swap="innerHTML" hx-sync="this:drop" hx-disabled-elt="this, .nav-item">Remove</button></div>
  `).join('') : '<p>No boards connected yet.</p>';
}

export function renderDraft(application) {
  const id = escapeHtml(application.id);
  const endpoint = `/api/applications/${urlId(application.id)}`;
  return `
    <form id="application-${id}" class="review-card" data-application="${id}" data-editor hx-put="${endpoint}" hx-target="this" hx-swap="outerHTML" hx-sync="closest form:drop" hx-disabled-elt="#application-${id} button, #application-${id} textarea, .nav-item">
      <div class="review-head"><div><h2>${escapeHtml(application.title)}</h2><p>${escapeHtml(application.company)} · ${escapeHtml(application.location)}</p></div><span class="status">Draft</span></div>
      <div class="review-body">
        <label>Tailored CV<textarea name="tailoredCv" rows="18" required minlength="100" maxlength="60000">${escapeHtml(application.tailored_cv)}</textarea></label>
        <label>Recruiter message<textarea name="recruiterMessage" rows="4" required minlength="20" maxlength="4000">${escapeHtml(application.recruiter_message)}</textarea></label>
        <label>Cover letter<textarea name="coverLetter" rows="9" required minlength="100" maxlength="12000">${escapeHtml(application.cover_letter)}</textarea></label>
      </div>
      ${renderAtsCheck(application.ats_check)}
      <div class="review-actions"><a class="text-link" href="${endpoint}/pdf">Download ATS PDF</a><div><button type="submit" class="button ghost" data-action="save-draft" data-id="${id}">Save edits</button><button type="button" class="button primary" data-action="approve" data-id="${id}" hx-post="${endpoint}/approve" hx-include="closest form" hx-target="#dashboard" hx-swap="innerHTML" hx-validate="true" hx-confirm="Approve this reviewed application?">Approve application</button></div></div>
    </form>`;
}

export function renderJob(job) {
  return `
    <p class="eyebrow">${escapeHtml(job.company)} · ${escapeHtml(job.match_score)}% heuristic match</p>
    <h2>${escapeHtml(job.title)}</h2>
    <p>${escapeHtml(job.location)}</p>
    <div class="job-description">${escapeHtml(job.description || 'Description unavailable. Review the original posting manually; a draft cannot be prepared.')}</div>
    <div class="detail-actions"><a class="button ghost" href="${safeUrl(job.url)}" target="_blank" rel="noopener noreferrer">Original posting</a>${job.application_id || !job.description.trim() ? '' : `<button type="button" class="button primary" data-action="prepare" data-id="${escapeHtml(job.id)}" hx-post="/api/jobs/${urlId(job.id)}/prepare" hx-target="#dashboard" hx-swap="innerHTML" hx-sync="this:drop" hx-disabled-elt="this, .nav-item">Prepare application</button>`}</div>`;
}

export function renderCvText(text) {
  return `<textarea id="cv-text" name="cvText" rows="15" placeholder="Paste your complete CV here, or upload a file below." required maxlength="100000">${escapeHtml(text)}</textarea>`;
}

export function renderAssist(result) {
  let message;
  switch (result.paused) {
    case 'login-or-captcha':
      message = 'Paused. Handle login or CAPTCHA yourself, then select Assisted apply again.';
      break;
    case 'manual-form':
      message = 'Open the application form in Chrome, then select Assisted apply again. Unrecognized forms require manual completion.';
      break;
    case 'different-site':
      message = 'The tab moved to another site. Complete that portal manually; no information was filled.';
      break;
    default:
      message = `${result.filledFields} fields filled. ${result.cvAttached ? 'CV attached.' : 'No new attachment added; check the CV in Chrome.'} Review every field and submit yourself.`;
  }
  return `<p>${escapeHtml(message)}</p>`;
}

export function renderCounts(state) {
  return `<span class="count" id="jobs-count" hx-swap-oob="outerHTML">${state.jobs.filter((job) => job.status === 'new').length}</span>
    <span class="count" id="review-count" hx-swap-oob="outerHTML">${state.applications.filter((item) => item.status === 'draft').length}</span>
    <span class="count" id="applications-count" hx-swap-oob="outerHTML">${state.applications.length}</span>`;
}

export function renderActivity({ events, nextBefore }) {
  const labels = {
    baseline: 'Existing record', draft_created: 'Draft created', draft_updated: 'Draft edited',
    approved: 'Application approved', submitted: 'Submission confirmed by you',
    assist_opened: 'Browser assistance opened', assist_paused: 'Browser assistance paused', assist_failed: 'Browser assistance failed',
    ...outcomeEventLabels,
  };
  return (events.length ? events.map((event) => `<div class="activity-item">
    <div><strong>${escapeHtml(labels[event.kind])}</strong><span class="hint">Application #${escapeHtml(event.application_id)}</span></div>
    <p>${escapeHtml(event.company)} · ${escapeHtml(event.title)}</p>
    ${event.detail ? `<p>${escapeHtml(event.detail)}</p>` : ''}
    <time datetime="${escapeHtml(event.occurred_at)}">${escapeHtml(event.occurred_at)}</time>
  </div>`).join('') : '<p>No application activity yet.</p>')
    + (nextBefore ? `<button type="button" class="button ghost" hx-get="/api/activity?before=${urlId(nextBefore)}" hx-target="this" hx-swap="outerHTML" hx-sync="this:drop" hx-disabled-elt="this">Load older activity</button>` : '');
}

function renderApplication(application) {
  const id = escapeHtml(application.id);
  const endpoint = `/api/applications/${urlId(application.id)}`;
  const ats = parseAtsCheck(application.ats_check);
  return `
    <article class="application-card" id="application-${id}">
      <div class="application-summary">
        <div class="status-row"><span class="status ${escapeHtml(application.status)}">${escapeHtml(application.status)}</span>${ats ? `<span class="ats-chip ats-${ats.status}">ATS: ${ATS_STATUS_LABELS[ats.status]}</span>` : ''}</div>
        <h3>${escapeHtml(application.title)}</h3><p>${escapeHtml(application.company)} · ${escapeHtml(application.location)}</p>${application.submitted_at ? `<p class="submitted-date">Confirmed <time datetime="${escapeHtml(application.submitted_at)}">${escapeHtml(application.submitted_at)}</time> (UTC)</p>` : ''}
      </div>
      <div class="application-actions">
        <a class="text-link" href="${endpoint}/pdf">CV PDF</a>
        <a class="button ghost small" href="${safeUrl(application.url)}" target="_blank" rel="noopener noreferrer">Open job</a>
        ${application.status === 'approved' ? `<button type="button" class="button secondary small" data-action="assist" data-id="${id}" hx-post="${endpoint}/assist" hx-target="#assist-result" hx-swap="innerHTML" hx-sync="this:drop" hx-disabled-elt="this, .nav-item" hx-confirm="Open or reuse this application’s Chrome tab and fill its current form? This shares your contact details, approved cover letter and CV with the portal; attachments may upload immediately. Continue only where automated prefill is permitted.">Assisted apply</button><button type="button" class="button primary small" data-action="submitted" data-id="${id}" hx-post="${endpoint}/submit" hx-target="#dashboard" hx-swap="innerHTML" hx-confirm="Did you complete and verify the final submission in the job portal?">Confirm submitted</button>` : ''}
        ${application.status === 'draft' ? '<button type="button" class="button secondary small" data-action="open-review" hx-get="/views/review" hx-target="#dashboard" hx-swap="innerHTML">Review</button>' : ''}
      </div>
      ${application.status === 'submitted' ? renderOutcome(application) : ''}
    </article>`;
}

function renderOutcome(application) {
  const stage = OUTCOME_STAGES.includes(application.outcome) ? application.outcome : null;
  const endpoint = `/api/applications/${urlId(application.id)}/outcome`;
  const days = daysSince(application.submitted_at);
  const quiet = !stage && days !== null && days >= FOLLOW_UP_DAYS;
  return `<div class="application-extra">
    <div class="outcome-summary">
      ${stage
        ? `<span class="outcome-badge ${escapeHtml(stage)}">${escapeHtml(OUTCOME_LABELS[stage])}</span><span class="outcome-date">Recorded <time datetime="${escapeHtml(application.outcome_at)}">${escapeHtml(application.outcome_at)}</time> (UTC)</span>${application.outcome_detail ? `<p class="outcome-detail">${escapeHtml(application.outcome_detail)}</p>` : ''}`
        : '<span class="status">Awaiting outcome</span>'}
      ${quiet ? `<span class="follow-up-due">No outcome recorded ${escapeHtml(days)} days after submission. Follow up with the employer yourself.</span>` : ''}
    </div>
    <details class="outcome-editor">
      <summary>${stage ? 'Update outcome' : 'Record outcome'}</summary>
      <form class="outcome-form" hx-post="${endpoint}" hx-target="#dashboard" hx-swap="innerHTML" hx-sync="this:drop" hx-disabled-elt="this button, .nav-item">
        <select name="outcome" required aria-label="Outcome">${OUTCOME_STAGES.map((value) => `<option value="${value}" ${stage === value ? 'selected' : ''}>${escapeHtml(OUTCOME_LABELS[value])}</option>`).join('')}</select>
        <input name="detail" maxlength="500" placeholder="Optional private note">
        <button type="submit" class="button ghost small">Save outcome</button>
      </form>
      <p class="hint">Saved locally. Recording an outcome does not contact the employer, change the confirmed submission or edit your application.</p>
    </details>
  </div>`;
}

function parseAtsCheck(stored) {
  try {
    const check = typeof stored === 'string' && stored ? JSON.parse(stored) : null;
    return check && ATS_STATUS_LABELS[check.status] && Array.isArray(check.checks) ? check : null;
  } catch {
    return null;
  }
}

function renderAtsCheck(stored) {
  const check = parseAtsCheck(stored);
  if (!check) {
    return '<div class="ats-panel ats-pending"><div class="ats-heading"><strong>ATS parse check</strong><span class="ats-status">Not run</span></div><p>Save edits or approve to run a mechanical text-layer check on this PDF.</p></div>';
  }
  return `<div class="ats-panel ats-${check.status}">
    <div class="ats-heading"><strong>ATS parse check</strong><span class="ats-status ats-${check.status}">${ATS_STATUS_LABELS[check.status]}</span></div>
    <p>${escapeHtml(Number(check.characters) || 0)} characters across ${escapeHtml(Number(check.pages) || 0)} page(s). Mechanical check only; not an ATS guarantee.</p>
    <ul class="ats-checks">${check.checks.map((item) => `<li class="ats-${['pass', 'warn', 'fail'].includes(item.status) ? item.status : 'warn'}"><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.detail)}</span></li>`).join('')}</ul>
  </div>`;
}

function renderProfile(state) {
  const profile = state.profile;
  return `
    <div class="page-heading"><div><p class="eyebrow">YOUR CAREER RECORD</p><h1>One profile. Truthful tailoring.</h1><p>Files and the separate Chrome session are stored locally in <code>.data</code>. Drafting sends your CV to Gemini; assisted apply shares approved details and documents with the job portal.</p></div></div>
    <div class="profile-grid">
      <div>
        <form id="profile-form" class="panel profile-form" data-editor hx-put="/api/profile" hx-target="#profile-result" hx-swap="innerHTML" hx-sync="this:drop" hx-disabled-elt="#profile-form button, #profile-form input, #profile-form textarea, .nav-item">
          <div class="panel-heading"><div><h2>Profile</h2><p>Used for matching and application documents.</p></div></div>
          <div class="form-grid">
            <label>Full name<input name="name" autocomplete="name" maxlength="120" value="${escapeHtml(profile.name)}"></label>
            <label>Email<input name="email" type="email" autocomplete="email" maxlength="200" value="${escapeHtml(profile.email)}"></label>
            <label>Phone<input name="phone" autocomplete="tel" maxlength="80" value="${escapeHtml(profile.phone)}"></label>
            <label>Location<input name="location" autocomplete="address-level2" maxlength="160" value="${escapeHtml(profile.location)}"></label>
          </div>
          <label>Target roles <span class="hint">Comma-separated</span><input name="targetRoles" placeholder="Backend Engineer, Software Engineer" required maxlength="1000" value="${escapeHtml(profile.target_roles)}"></label>
          <label>Target locations <span class="hint">Comma-separated</span><input name="targetLocations" placeholder="Remote, London, Bengaluru" maxlength="1000" value="${escapeHtml(profile.target_locations)}"></label>
          <label>Minimum match <span id="match-value" class="hint">${escapeHtml(profile.min_match)}%</span><input name="minMatch" type="range" min="0" max="100" value="${escapeHtml(profile.min_match)}"></label>
          <label>Master CV${renderCvText(profile.cv_text)}</label>
          <button class="button primary" type="submit">Save profile</button>
          <div id="profile-result" role="status"></div>
        </form>
        <form class="panel upload-row" enctype="multipart/form-data">
          <label class="file-button">Upload CV<input name="cv" id="cv-file" type="file" accept=".pdf,.docx,.txt,.md" hx-post="/api/profile/cv" hx-trigger="change" hx-encoding="multipart/form-data" hx-params="cv" hx-target="#cv-text" hx-swap="outerHTML"></label>
          <span id="upload-status" class="hint">PDF, DOCX, TXT or MD · max 8 MB</span>
        </form>
      </div>
      <div>
        <form id="source-form" class="panel source-form" hx-post="/api/sources" hx-target="#sources-list" hx-swap="innerHTML" hx-sync="this:drop" hx-disabled-elt="#source-form button, .nav-item">
          <div class="panel-heading"><div><h2>Job sources</h2><p>Use public company board slugs.</p></div></div>
          <label>Platform<select name="type"><option value="greenhouse">Greenhouse</option><option value="lever">Lever</option></select></label>
          <label>Company board slug<input name="slug" placeholder="company-name" pattern="[A-Za-z0-9_-]+" required maxlength="100"></label>
          <button class="button secondary" type="submit">Add source</button>
        </form>
        <div class="panel"><div class="panel-heading"><div><h2>Connected boards</h2><p>Duplicates are removed automatically.</p></div></div><div id="sources-list" class="sources-list">${renderSources(state.sources)}</div></div>
        <div class="panel setup-note"><h2>Gemini CLI</h2><p>Drafting uses your existing local Gemini CLI login. Install and authenticate <code>gemini</code> before selecting “Prepare application”.</p></div>
      </div>
    </div>`;
}

function emptyState(title, message) {
  return `<div class="empty"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(message)}</p></div>`;
}

function matchScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.min(100, Math.max(0, score)) : 0;
}

function urlId(value) {
  return escapeHtml(encodeURIComponent(String(value ?? '')));
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? escapeHtml(url.href) : '#';
  } catch {
    return '#';
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}
