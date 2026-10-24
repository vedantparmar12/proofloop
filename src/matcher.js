const STOP_WORDS = new Set(
  'a an and are as at be by for from has have in is it of on or our that the their this to we will with you your years year experience experienced work working team teams role roles job jobs candidate candidates ability strong skills skill requirements required preferred plus including include across other more most who what how when where why'.split(' '),
);

export function rankJob(profile, job) {
  const roles = splitTerms(profile.targetRoles || profile.target_roles);
  const locations = splitTerms(profile.targetLocations || profile.target_locations);
  const cv = normalize(profile.cvText || profile.cv_text);
  const title = normalize(job.title);
  const description = normalize(job.description);
  const jobLocation = normalize(job.location);

  let roleScore = 0;
  const matchedRoles = [];
  for (const role of roles) {
    const phrase = normalize(role);
    const words = significantWords(phrase);
    if (!phrase || words.length === 0) continue;
    if (title.includes(phrase)) {
      roleScore = Math.max(roleScore, 50);
      matchedRoles.push(role);
    } else {
      const coverage = words.filter((word) => title.includes(word)).length / words.length;
      roleScore = Math.max(roleScore, Math.round(coverage * 35));
      if (coverage >= 0.5) matchedRoles.push(role);
    }
  }

  const jobTerms = frequentTerms(`${title} ${title} ${title} ${description}`, 20);
  const matchedTerms = jobTerms.filter((term) => containsTerm(cv, term));
  const evidenceScore = jobTerms.length ? Math.round((matchedTerms.length / jobTerms.length) * 40) : 0;

  let locationScore = 10;
  if (locations.length) {
    locationScore = locations.some((location) => {
      const value = normalize(location);
      return jobLocation.includes(value) || (value === 'remote' && description.includes('remote'));
    }) ? 10 : 0;
  }

  return {
    score: Math.min(100, roleScore + evidenceScore + locationScore),
    matchedTerms: [...new Set([...matchedRoles, ...matchedTerms])].slice(0, 12),
  };
}

function frequentTerms(text, limit) {
  const counts = new Map();
  for (const word of significantWords(text)) counts.set(word, (counts.get(word) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

function significantWords(text) {
  return normalize(text).match(/[a-z0-9+#.]{2,}/g)?.filter((word) => !STOP_WORDS.has(word)) || [];
}

function containsTerm(text, term) {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}([^a-z0-9]|$)`).test(text);
}

function splitTerms(value = '') {
  return value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
}

function normalize(value = '') {
  return value.toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
