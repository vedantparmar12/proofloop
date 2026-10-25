export const OUTCOME_STAGES = Object.freeze([
  'interview', 'offer', 'rejected', 'hired', 'withdrawn', 'no_response',
]);

export const OUTCOME_LABELS = Object.freeze({
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
  hired: 'Hired',
  withdrawn: 'Withdrawn',
  no_response: 'No response',
});

export const OUTCOME_EVENT_LABELS = Object.freeze({
  interview: 'Interview recorded',
  offer: 'Offer recorded',
  rejected: 'Rejection recorded',
  hired: 'Hire recorded',
  withdrawn: 'Withdrawal recorded',
  no_response: 'No response recorded',
});

export const OUTCOME_EVENT_KINDS = Object.freeze(OUTCOME_STAGES.map((stage) => `outcome_${stage}`));
export const CLOSED_OUTCOMES = new Set(['rejected', 'no_response', 'withdrawn']);
export const FOLLOW_UP_DAYS = 10;

export function outcomeStageFromKind(kind) {
  if (typeof kind !== 'string' || !kind.startsWith('outcome_')) return null;
  const stage = kind.slice(8);
  return OUTCOME_STAGES.includes(stage) ? stage : null;
}

export function daysSince(value, now = Date.now()) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(0, Math.floor((now - time) / 86400000)) : null;
}

export function isFollowUpDue(submittedAt, now = Date.now()) {
  const days = daysSince(submittedAt, now);
  return days !== null && days >= FOLLOW_UP_DAYS;
}
