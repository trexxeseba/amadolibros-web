import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CRITICAL_FILES = Object.freeze([
  'functions/libro/[[path]].js',
  'functions/catalogo.js',
  'functions/book-cover/[[path]].js',
  'functions/feed.xml.js',
]);

const clean = value => String(value ?? '').trim();

function hoursBetween(now, value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, (now.getTime() - timestamp) / 3_600_000) : null;
}

export function classifyPullRequest(pr, { now = new Date() } = {}) {
  const idleHours = hoursBetween(now, pr.updated_at);
  const checks = clean(pr.checks_state || 'unknown').toLowerCase();
  const reasons = [];
  let recommendation = 'review';

  if (checks === 'failure' || checks === 'error') {
    recommendation = 'fix_ci';
    reasons.push('CI rojo');
  }
  if (pr.draft && idleHours !== null && idleHours >= 168) {
    recommendation = recommendation === 'fix_ci' ? recommendation : 'triage_or_close';
    reasons.push('Draft sin movimiento durante 7 días');
  } else if (pr.draft && idleHours !== null && idleHours >= 72) {
    recommendation = recommendation === 'fix_ci' ? recommendation : 'assign_next_action';
    reasons.push('Draft sin próxima acción durante 72 horas');
  }
  if (!clean(pr.owner)) reasons.push('sin responsable declarado');

  return {
    number: pr.number,
    title: clean(pr.title),
    branch: clean(pr.head?.ref || pr.branch),
    draft: Boolean(pr.draft),
    updated_at: pr.updated_at || null,
    idle_hours: idleHours === null ? null : Math.round(idleHours),
    checks_state: checks,
    recommendation,
    reasons,
  };
}

export function findCriticalCollisions(pulls, criticalFiles = CRITICAL_FILES) {
  const critical = new Set(criticalFiles);
  const byFile = new Map();
  for (const pr of pulls) {
    for (const file of pr.files || []) {
      if (!critical.has(file)) continue;
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push(pr.number);
    }
  }
  return [...byFile.entries()]
    .filter(([, numbers]) => numbers.length > 1)
    .map(([file, numbers]) => ({ file, pull_requests: numbers.sort((a, b) => a - b) }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

export function summarizeChecks(checkRuns = []) {
  if (!checkRuns.length) return 'unknown';
  const failed = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure']);
  if (checkRuns.some(run => failed.has(clean(run.conclusion).toLowerCase()))) return 'failure';
  if (checkRuns.some(run => clean(run.status).toLowerCase() !== 'completed')) return 'pending';
  return checkRuns.every(run => clean(run.conclusion).toLowerCase() === 'success' || clean(run.conclusion).toLowerCase() === 'skipped')
    ? 'success'
    : 'unknown';
}

export function buildGovernanceReport({ pulls, branches = [], now = new Date() }) {
  const classified = pulls.map(pr => classifyPullRequest(pr, { now }));
  const prBranches = new Set(pulls.map(pr => clean(pr.head?.ref || pr.branch)).filter(Boolean));
  const branchWithoutPr = branches
    .map(branch => clean(branch.name || branch))
    .filter(name => name && name !== 'main' && !prBranches.has(name))
    .sort();
  return {
    generated_at: now.toISOString(),
    metrics: {
      open_prs: pulls.length,
      drafts: pulls.filter(pr => pr.draft).length,
      ci_red: classified.filter(pr => pr.recommendation === 'fix_ci').length,
      stale_72h: classified.filter(pr => (pr.idle_hours ?? 0) >= 72).length,
      stale_7d: classified.filter(pr => (pr.idle_hours ?? 0) >= 168).length,
      branches_without_pr: branchWithoutPr.length,
    },
    critical_collisions: findCriticalCollisions(pulls),
    branches_without_pr: branchWithoutPr,
    pull_requests: classified,
  };
}

function markdown(report) {
  const m = report.metrics;
  const lines = [
    '# Project governance audit', '',
    `Generated: ${report.generated_at}`, '',
    `- Open PRs: ${m.open_prs}`,
    `- Drafts: ${m.drafts}`,
    `- CI red: ${m.ci_red}`,
    `- Stale 72h: ${m.stale_72h}`,
    `- Stale 7d: ${m.stale_7d}`,
    `- Branches without PR: ${m.branches_without_pr}`, '',
    '## Critical collisions', '',
  ];
  if (!report.critical_collisions.length) lines.push('- None');
  for (const row of report.critical_collisions) lines.push(`- \`${row.file}\`: ${row.pull_requests.map(n => `#${n}`).join(', ')}`);
  lines.push('', '## Pull requests requiring action', '');
  for (const pr of report.pull_requests.filter(pr => pr.reasons.length)) {
    lines.push(`- #${pr.number} — ${pr.recommendation}: ${pr.reasons.join('; ')}`);
  }
  return `${lines.join('\n')}\n`;
}

async function api(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'user-agent': 'amadolibros-governance-audit',
    },
  });
  if (!response.ok) throw new Error(`${path} respondió HTTP ${response.status}`);
  return response.json();
}

async function allPages(path, token) {
  const rows = [];
  for (let page = 1; ; page += 1) {
    const join = path.includes('?') ? '&' : '?';
    const batch = await api(`${path}${join}per_page=100&page=${page}`, token);
    rows.push(...batch);
    if (batch.length < 100) return rows;
  }
}

async function mapLimit(rows, limit, fn) {
  const output = new Array(rows.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, async () => {
    while (cursor < rows.length) {
      const index = cursor++;
      output[index] = await fn(rows[index]);
    }
  }));
  return output;
}

async function main() {
  const repository = clean(process.env.GITHUB_REPOSITORY);
  if (!/^[^/]+\/[^/]+$/.test(repository)) throw new Error('GITHUB_REPOSITORY debe tener formato owner/repo.');
  const token = clean(process.env.GITHUB_TOKEN);
  const outputDir = clean(process.env.GOVERNANCE_OUTPUT_DIR) || 'artifacts/governance';
  const [pulls, branches] = await Promise.all([
    allPages(`/repos/${repository}/pulls?state=open`, token),
    allPages(`/repos/${repository}/branches?protected=false`, token),
  ]);
  const enriched = await mapLimit(pulls, 6, async pr => {
    const [files, checks] = await Promise.all([
      allPages(`/repos/${repository}/pulls/${pr.number}/files?`, token),
      api(`/repos/${repository}/commits/${pr.head.sha}/check-runs?per_page=100`, token),
    ]);
    return {
      ...pr,
      files: files.map(file => file.filename),
      checks_state: summarizeChecks(checks.check_runs),
      owner: pr.assignee?.login || '',
    };
  });
  const report = buildGovernanceReport({ pulls: enriched, branches });
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(`${outputDir}/project-governance.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${outputDir}/project-governance.md`, markdown(report));
  console.log(JSON.stringify(report.metrics, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`project-governance-audit falló: ${error.message}`);
    process.exitCode = 1;
  });
}
