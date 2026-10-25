const baseUrl = process.env.PROOFLOOP_URL || 'http://127.0.0.1:3000';
const [command, ...args] = process.argv.slice(2);

try {
  const result = await run(command, args);
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}

async function run(action, args) {
  const [value, stage, ...noteWords] = args;
  if (!action || action === 'status') {
    const state = await request('/api/state');
    return {
      jobs: state.jobs.length,
      matched: state.jobs.filter((job) => job.match_score >= state.profile.min_match && job.status === 'new').length,
      ...state.metrics,
    };
  }
  if (action === 'log') return request(`/api/activity${value ? `?before=${encodeURIComponent(value)}` : ''}`);
  if (action === 'search' && value && args[1] && args[2]) {
    return request('/api/search', {
      method: 'POST',
      body: JSON.stringify({ site: value, searchTerm: args[1], location: args[2], country: args[3] || 'india' }),
    });
  }
  if (action === 'scan') return request('/api/scan', { method: 'POST' });
  if (action === 'list') {
    const state = await request('/api/state');
    const jobs = state.jobs.filter((job) => job.status === 'new');
    return {
      showing: Math.min(30, jobs.length),
      total: jobs.length,
      jobs: jobs.slice(0, 30).map((job) => ({
        id: job.id,
        score: job.match_score,
        company: job.company,
        title: job.title,
        location: job.location,
        applicationId: job.application_id,
      })),
    };
  }
  if (action === 'prepare' && value) {
    const application = await request(`/api/jobs/${Number(value)}/prepare`, { method: 'POST' });
    return { applicationId: application.id, jobId: application.job_id, status: application.status };
  }
  if (action === 'approve' && value) {
    const application = await request(`/api/applications/${Number(value)}/approve`, { method: 'POST' });
    return { applicationId: application.id, status: application.status };
  }
  if (action === 'assist' && value) {
    return request(`/api/applications/${Number(value)}/assist`, { method: 'POST' });
  }
  if (action === 'submitted' && value) {
    const application = await request(`/api/applications/${Number(value)}/submit`, { method: 'POST' });
    return { applicationId: application.id, status: application.status, submittedAt: application.submitted_at };
  }
  if (action === 'outcome' && value && stage) {
    const event = await request(`/api/applications/${Number(value)}/outcome`, {
      method: 'POST',
      body: JSON.stringify({ outcome: stage, detail: noteWords.join(' ') }),
    });
    return { applicationId: event.application_id, outcome: event.kind, recordedAt: event.occurred_at };
  }
  return `Usage:\n  bun run cli status\n  bun run cli log [before-event-id]\n  bun run cli search <indeed|linkedin> "<role>" "<location>" [country]\n  bun run cli scan\n  bun run cli list\n  bun run cli prepare <job-id>\n  bun run cli approve <application-id>\n  bun run cli assist <application-id>\n  bun run cli submitted <application-id>\n  bun run cli outcome <application-id> <interview|offer|rejected|hired|withdrawn|no_response> [note]\n\nJobSpy needs bun run setup:jobspy and searches at most once per minute. Assisted apply opens visible Chrome and never submits. Mark submitted only after confirming it in the job portal. Record outcomes only after the employer tells you; they are never inferred or sent automatically. ATS checks are mechanical, not a guarantee.`;
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
  return payload;
}
