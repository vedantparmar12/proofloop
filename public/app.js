let toastTimer;
const dialog = document.querySelector('#job-dialog');

for (const name of ['input', 'change']) {
  document.body.addEventListener(name, (event) => {
    const form = event.target.closest('[data-editor]');
    if (form) form.dataset.dirty = 'true';
    if (event.target.name === 'minMatch') {
      document.querySelector('#match-value').textContent = `${event.target.value}%`;
    }
  });
}

window.addEventListener('beforeunload', (event) => {
  if (document.querySelector('[data-editor][data-dirty="true"]')) {
    event.preventDefault();
    event.returnValue = '';
  }
});

document.body.addEventListener('htmx:confirm', (event) => {
  if (event.detail.target?.id !== 'dashboard') return;
  const savedForm = event.detail.elt.closest('[data-editor]');
  const unsaved = [...document.querySelectorAll('[data-editor][data-dirty="true"]')].some((form) => form !== savedForm);
  if (!unsaved) return;
  event.preventDefault();
  const question = [event.detail.question, 'Discard unsaved edits in other forms and continue?'].filter(Boolean).join('\n\n');
  if (window.confirm(question)) event.detail.issueRequest(true);
});

document.body.addEventListener('htmx:afterRequest', (event) => {
  if (!event.detail.successful) return;
  const element = event.detail.requestConfig.elt;
  if (element.id === 'source-form') element.reset();
  if (element.id === 'profile-form') delete element.dataset.dirty;
  if (element.matches('form.review-card')) toast('Edits saved');
  if (element.matches('form.outcome-form')) toast('Outcome saved locally');
});

document.body.addEventListener('htmx:afterSwap', (event) => {
  if (event.detail.target.id === 'dashboard') {
    const view = document.querySelector('#dashboard [data-view]')?.dataset.view;
    document.querySelectorAll('.nav-item').forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    dialog.close();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  if (event.detail.target.id === 'job-detail') dialog.showModal();
  if (event.detail.requestConfig.elt.id === 'cv-file') {
    document.querySelector('#profile-form').dataset.dirty = 'true';
    document.querySelector('#upload-status').textContent = 'Text extracted. Review it, then save your profile.';
    document.querySelector('#cv-file').value = '';
  }
});

document.body.addEventListener('htmx:responseError', (event) => {
  let message = `Request failed (${event.detail.xhr.status})`;
  try { message = JSON.parse(event.detail.xhr.responseText).error || message; } catch {}
  toast(message, true);
});
document.body.addEventListener('htmx:sendError', () => toast('Cannot reach ProofLoop. Check that the local server is running.', true));

document.body.addEventListener('click', (event) => {
  if (event.target.closest('[data-action="close-dialog"]') || event.target === dialog) dialog.close();
});

function toast(message, isError = false) {
  clearTimeout(toastTimer);
  const element = document.querySelector('#toast');
  element.textContent = message;
  element.className = `toast show${isError ? ' error' : ''}`;
  toastTimer = setTimeout(() => { element.className = 'toast'; }, 4500);
}
