import { randomUUID } from 'node:crypto';
import { normalizeReview } from './process.js';
import { classifyFailure } from './connections.js';

export const verdicts = ['LGTM', 'NON-BLOCKING', 'NON-BLOCKING BUT FIX', 'BLOCKING'];
export const methods = ['merge', 'squash', 'rebase'];
export const defaultMergeConfig = {
  devBranches: ['dev', 'develop', 'development'],
  prodBranches: ['main', 'master', 'prod', 'production'],
  rules: [],
};
const completed = ['awaiting_approval', 'published', 'publish_failed'];
export function reviewSummary(job, sha, baseBranch) {
  if (!job?.result || !completed.includes(job.status)) return null;
  let verdict;
  try {
    verdict = normalizeReview(job.result)
      .split('\n')[0]
      .match(/Verdict: ([A-Z -]+)\*\*/)[1];
  } catch {
    return null;
  }
  return {
    id: job.id,
    sha: job.sha,
    status: job.status,
    verdict,
    action: (job.result.match(/^\*\*Action:\*\*\s*(.+)$/m)?.[1] || '').slice(0, 400),
    finishedAt: job.finished_at,
    baseBranch: job.reviewed_base_branch || null,
    current:
      job.sha === sha &&
      (!job.reviewed_base_branch || !baseBranch || job.reviewed_base_branch === baseBranch),
  };
}
function branch(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 200 ||
    /[\s~^:?*\[\\]|\.\.|@\{|\/\/|^[-/.]|[/.]$|\.lock(?:\/|$)/.test(value) ||
    value === '@'
  )
    throw new Error('Use exact branch names, without spaces or wildcard patterns.');
  return value;
}
export function validateMergeConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid merge configuration.');
  for (const key of Object.keys(value))
    if (!['devBranches', 'prodBranches', 'rules'].includes(key))
      throw new Error('Unknown merge setting.');
  const branches = (key) => {
    if (!Array.isArray(value[key]) || value[key].length > 30)
      throw new Error('Provide up to 30 branch names.');
    return [...new Set(value[key].map(branch))];
  };
  const devBranches = branches('devBranches'),
    prodBranches = branches('prodBranches');
  if (devBranches.some((b) => prodBranches.includes(b)))
    throw new Error('A branch cannot be both DEV and PROD.');
  if (!Array.isArray(value.rules) || value.rules.length > 30)
    throw new Error('Provide up to 30 automatic merge rules.');
  const seen = new Set();
  const rules = value.rules.map((rule) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule))
      throw new Error('Invalid merge rule.');
    const baseBranch = branch(rule.baseBranch);
    if (seen.has(baseBranch)) throw new Error('Use one merge rule per base branch.');
    seen.add(baseBranch);
    if (!methods.includes(rule.method)) throw new Error('Choose merge commit, squash, or rebase.');
    if (
      !Array.isArray(rule.verdicts) ||
      !rule.verdicts.length ||
      rule.verdicts.some((v) => !verdicts.includes(v) || v === 'BLOCKING')
    )
      throw new Error(
        'Select at least one non-blocking verdict. Blocking reviews cannot merge automatically.',
      );
    return { baseBranch, method: rule.method, verdicts: [...new Set(rule.verdicts)] };
  });
  return { devBranches, prodBranches, rules };
}
export function mergeConfig(repo) {
  return repo?.merge_config
    ? validateMergeConfig(JSON.parse(repo.merge_config))
    : structuredClone(defaultMergeConfig);
}
export function environmentFor(repo, base) {
  const config = mergeConfig(repo);
  return config.prodBranches.includes(base)
    ? 'PROD'
    : config.devBranches.includes(base)
      ? 'DEV'
      : 'OTHER';
}
export function latestReview(store, prId) {
  return store.db
    .prepare(
      "SELECT * FROM jobs WHERE pr_id=? AND result IS NOT NULL AND status IN ('awaiting_approval','published','publish_failed') ORDER BY created_at DESC,rowid DESC LIMIT 1",
    )
    .get(prId);
}
export class MergeService {
  constructor(store, engine, { notify = () => {}, clock = Date.now } = {}) {
    this.s = store;
    this.e = engine;
    this.notify = notify;
    this.clock = clock;
    this.locks = new Set();
    this.checks = new Map();
    this.cursor = 0;
  }
  local(prId) {
    const pr = this.s.db.prepare('SELECT * FROM prs WHERE id=?').get(prId);
    if (!pr) throw new Error('Unknown pull request.');
    const repo = this.s.db.prepare('SELECT * FROM repos WHERE id=?').get(pr.repo);
    const job = latestReview(this.s, prId);
    const latest = this.s.db
      .prepare(
        "SELECT id,status FROM jobs WHERE pr_id=? AND status NOT IN ('cancelled','skipped') ORDER BY created_at DESC,rowid DESC LIMIT 1",
      )
      .get(prId);
    return { pr, repo, job, review: reviewSummary(job, pr.sha, pr.base_branch), latest };
  }
  async inspect(prId, { includeUpdate = false } = {}) {
    const local = this.local(prId);
    const [pr, repo] = await Promise.all([
      this.e.gh([
        'pr',
        'view',
        String(local.pr.number),
        '--repo',
        local.pr.repo,
        '--json',
        'number,title,headRefOid,baseRefOid,baseRefName,headRefName,state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,url,author',
      ]),
      this.e.gh(['api', `repos/${local.pr.repo}`]),
    ]);
    // Only refresh fields returned by this lightweight request; preserve cached diff metadata.
    this.s.db
      .prepare('UPDATE prs SET sha=?,base_branch=?,head_branch=?,state=?,draft=? WHERE id=?')
      .run(pr.headRefOid, pr.baseRefName, pr.headRefName, pr.state, +!!pr.isDraft, prId);
    if (pr.state === 'MERGED')
      this.s.db
        .prepare(
          "UPDATE merges SET status='merged',error=NULL WHERE pr_id=? AND sha=? AND status IN ('merging','unknown')",
        )
        .run(prId, pr.headRefOid);
    this.s.db
      .prepare(
        "UPDATE branch_updates SET status='head_changed',error=NULL WHERE pr_id=? AND sha<>? AND status IN ('updating','pending','unknown')",
      )
      .run(prId, pr.headRefOid);
    const branchUpdate = this.s.db
      .prepare('SELECT * FROM branch_updates WHERE pr_id=? ORDER BY rowid DESC LIMIT 1')
      .get(prId);
    const updatePending =
      branchUpdate && ['updating', 'pending', 'unknown'].includes(branchUpdate.status);
    const current = this.local(prId);
    const reasons = [];
    if (updatePending)
      reasons.push('A branch update is pending or uncertain. Refresh status before merging.');
    if (!current.repo.enabled || current.repo.archived) reasons.push('Repository is disabled.');
    if (pr.state !== 'OPEN') reasons.push('PR is no longer open.');
    if (pr.isDraft) reasons.push('PR is a draft.');
    if (!current.review) reasons.push('A completed Review Studio review is required.');
    else {
      if (!current.review.current)
        reasons.push('New commits or a changed target branch need a new review.');
      if (!current.review.baseBranch)
        reasons.push(
          'This older review has no recorded target branch. Run a new review before merging.',
        );
      if (current.latest?.id !== current.job.id)
        reasons.push('A newer review attempt must finish first.');
      if (current.review.verdict === 'BLOCKING')
        reasons.push('Latest review has blocking findings.');
      if (current.job.status === 'publish_failed')
        reasons.push('Resolve the failed review publication first.');
    }
    if (!repo.permissions?.push || repo.archived)
      reasons.push('The signed-in account cannot merge into this repository.');
    if (pr.mergeable !== 'MERGEABLE')
      reasons.push(
        pr.mergeable === 'CONFLICTING'
          ? 'Merge conflicts need resolving.'
          : 'GitHub is still calculating mergeability.',
      );
    if (pr.mergeStateStatus !== 'CLEAN')
      reasons.push(
        `GitHub merge requirements are not satisfied (${pr.mergeStateStatus || 'unknown'}).`,
      );
    if (['CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(pr.reviewDecision))
      reasons.push('Required GitHub reviews are not satisfied.');
    const checks = pr.statusCheckRollup;
    if (!Array.isArray(checks)) reasons.push('GitHub check status is unavailable.');
    else if (
      checks.some((c) =>
        c.__typename === 'StatusContext'
          ? c.state !== 'SUCCESS'
          : c.status !== 'COMPLETED' || !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion),
      )
    )
      reasons.push('Checks are pending or unsuccessful.');
    const attempt = this.s.db
      .prepare('SELECT * FROM merges WHERE pr_id=? AND sha=? ORDER BY rowid DESC LIMIT 1')
      .get(prId, pr.headRefOid);
    if (attempt && ['merging', 'unknown'].includes(attempt.status))
      reasons.push('A previous merge has an unresolved outcome. Check GitHub before trying again.');
    const allowedMethods = methods.filter(
      (m) =>
        repo[
          {
            merge: 'allow_merge_commit',
            squash: 'allow_squash_merge',
            rebase: 'allow_rebase_merge',
          }[m]
        ] === true,
    );
    if (!allowedMethods.length) reasons.push('No merge method is available.');
    let update;
    if (includeUpdate) {
      const updateReasons = [];
      if (
        !current.repo.enabled ||
        current.repo.archived ||
        !repo.permissions?.push ||
        repo.archived
      )
        updateReasons.push('Repository is disabled or your account lacks write permission.');
      if (pr.state !== 'OPEN') updateReasons.push('PR is no longer open.');
      if (['queued', 'running', 'publishing'].includes(current.latest?.status))
        updateReasons.push(
          'Wait for the active review or publication to finish before updating this branch.',
        );
      if (pr.mergeable !== 'MERGEABLE')
        updateReasons.push('Resolve conflicts or wait for GitHub to calculate mergeability.');
      if (updatePending)
        updateReasons.push(
          branchUpdate.status === 'unknown'
            ? 'The previous update has an uncertain outcome. Verify it on GitHub and refresh status.'
            : 'GitHub is processing the branch update. Refresh status shortly.',
        );
      if (attempt && ['merging', 'unknown'].includes(attempt.status))
        updateReasons.push('Resolve the previous merge outcome first.');
      let behind = null;
      if (!updateReasons.length) {
        const comparison = await this.e.gh([
          'api',
          `repos/${local.pr.repo}/compare/${pr.headRefOid}...${pr.baseRefOid}`,
        ]);
        behind = comparison.ahead_by;
        if (!Number.isInteger(behind) || behind < 0)
          updateReasons.push('Base branch comparison is unavailable.');
        else if (behind === 0)
          updateReasons.push('This PR branch already contains the latest base branch commits.');
      }
      update = { reasons: updateReasons, behind, attempt: branchUpdate || null };
    }
    const result = {
      update,
      sha: pr.headRefOid,
      baseBranch: pr.baseRefName,
      headBranch: pr.headRefName,
      state: pr.state,
      review: current.review,
      allowedMethods,
      reasons,
      checks: checks || [],
      attempt: attempt || null,
    };
    this.checks.set(prId, { reasons, checkedAt: new Date(this.clock()).toISOString() });
    this.notify();
    return result;
  }
  async merge(prId, { sha, baseBranch, reviewId, method, automatic = false }) {
    if (!methods.includes(method)) throw new Error('Invalid merge method.');
    if (this.locks.has(prId)) throw new Error('A merge is already in progress.');
    this.locks.add(prId);
    let id;
    try {
      const info = await this.inspect(prId);
      if (info.reasons.length) throw new Error(info.reasons.join(' '));
      if (info.sha !== sha || info.baseBranch !== baseBranch || info.review?.id !== reviewId)
        throw new Error('PR or review changed. Refresh the merge preview.');
      if (!info.allowedMethods.includes(method))
        throw new Error('This merge method is disabled on GitHub.');
      const current = this.local(prId);
      if (this.e.closing || !current.repo.enabled || current.repo.archived)
        throw new Error('Repository is disabled or the app is shutting down.');
      if (
        current.latest?.id !== reviewId ||
        !current.review?.current ||
        current.pr.sha !== sha ||
        current.review.baseBranch !== baseBranch ||
        current.review.verdict === 'BLOCKING' ||
        current.job.status === 'publish_failed'
      )
        throw new Error('A newer review or commit needs attention.');
      if (automatic) {
        const rule = mergeConfig(current.repo).rules.find((r) => r.baseBranch === baseBranch);
        if (
          this.s.get('paused') ||
          this.e.closing ||
          !current.repo.enabled ||
          current.repo.archived ||
          current.job.status !== 'published' ||
          !rule ||
          rule.method !== method ||
          !rule.verdicts.includes(current.review.verdict)
        )
          throw new Error('Automatic merge policy no longer matches.');
        if (this.s.db.prepare('SELECT id FROM merges WHERE pr_id=? AND sha=?').get(prId, sha))
          throw new Error('This commit already has a merge attempt. Inspect it manually.');
      }
      id = randomUUID();
      this.s.db
        .prepare(
          "INSERT INTO merges (id,pr_id,sha,base_branch,job_id,method,automatic,status,created_at) VALUES (?,?,?,?,?,?,?,'merging',?)",
        )
        .run(
          id,
          prId,
          sha,
          baseBranch,
          reviewId,
          method,
          +automatic,
          new Date(this.clock()).toISOString(),
        );
      this.notify();
      // This write is never retried. The SHA precondition prevents merging newly pushed code.
      const result = await this.e.gh(
        [
          'api',
          `repos/${current.pr.repo}/pulls/${current.pr.number}/merge`,
          '--method',
          'PUT',
          '--input',
          '-',
        ],
        {
          input: JSON.stringify({ sha, merge_method: method }),
          timeout: 30000,
        },
      );
      if (result.merged !== true) {
        this.s.db
          .prepare("UPDATE merges SET status='failed',error=? WHERE id=?")
          .run(result.message || 'GitHub did not merge this PR.', id);
        throw new Error(result.message || 'GitHub did not merge this PR.');
      }
      this.s.db
        .prepare("UPDATE merges SET status='merged',commit_sha=?,error=NULL WHERE id=?")
        .run(result.sha || null, id);
      this.s.db.prepare("UPDATE prs SET state='MERGED' WHERE id=? AND sha=?").run(prId, sha);
      this.e.log(
        'success',
        `${automatic ? 'Automatically merged' : 'Merged'} ${prId} using ${method}.`,
        reviewId,
      );
      return { merged: true, commit: result.sha };
    } catch (error) {
      if (id) {
        const rejected = [401, 403, 404, 405, 409, 422, 429].includes(
          classifyFailure(error, 'github').status,
        );
        this.s.db
          .prepare("UPDATE merges SET status=?,error=? WHERE id=? AND status='merging'")
          .run(
            rejected ? 'failed' : 'unknown',
            rejected
              ? error.message
              : 'Merge outcome could not be confirmed. Refresh merge status and verify GitHub before retrying. ' +
                  error.message,
            id,
          );
        this.e.log('error', `Merge needs attention: ${error.message}`, reviewId);
      }
      throw error;
    } finally {
      this.locks.delete(prId);
      this.notify();
    }
  }
  async updateBase(prId, { sha, baseBranch }) {
    if (this.locks.has(prId)) throw new Error('A PR operation is already in progress.');
    this.locks.add(prId);
    let id;
    try {
      const info = await this.inspect(prId, { includeUpdate: true });
      if (info.sha !== sha || info.baseBranch !== baseBranch)
        throw new Error('PR changed. Refresh the branch update preview.');
      if (info.update.reasons.length) throw new Error(info.update.reasons.join(' '));
      const current = this.local(prId);
      if (
        this.e.closing ||
        !current.repo.enabled ||
        current.repo.archived ||
        current.pr.sha !== sha ||
        current.pr.base_branch !== baseBranch
      )
        throw new Error('Repository or PR changed. Refresh before updating.');
      id = randomUUID();
      this.s.db
        .prepare(
          "INSERT INTO branch_updates (id,pr_id,sha,base_branch,status,created_at) VALUES (?,?,?,?,'updating',?)",
        )
        .run(id, prId, sha, baseBranch, new Date(this.clock()).toISOString());
      this.notify();
      await this.e.gh(
        [
          'api',
          `repos/${current.pr.repo}/pulls/${current.pr.number}/update-branch`,
          '--method',
          'PUT',
          '--input',
          '-',
        ],
        { input: JSON.stringify({ expected_head_sha: sha }), timeout: 30000 },
      );
      this.s.db.prepare("UPDATE branch_updates SET status='pending' WHERE id=?").run(id);
      this.e.log(
        'info',
        `Requested an update of ${prId} from ${baseBranch}. A new review is needed once its commits change.`,
      );
      return { accepted: true };
    } catch (error) {
      if (id) {
        const rejected = [401, 403, 404, 405, 409, 422, 429].includes(
          classifyFailure(error, 'github').status,
        );
        this.s.db
          .prepare('UPDATE branch_updates SET status=?,error=? WHERE id=?')
          .run(rejected ? 'failed' : 'unknown', error.message, id);
      }
      throw error;
    } finally {
      this.locks.delete(prId);
      this.notify();
    }
  }
  async refreshUpdates() {
    if (this.refreshingUpdates || this.e.closing || !this.e.canSync()) return;
    this.refreshingUpdates = true;
    try {
      const updates = this.s.db
        .prepare(
          "SELECT DISTINCT u.pr_id FROM branch_updates u JOIN prs p ON p.id=u.pr_id WHERE u.status IN ('pending','unknown') AND p.state='OPEN' ORDER BY u.rowid DESC",
        )
        .all();
      const start = (this.updateCursor || 0) % Math.max(1, updates.length);
      this.updateCursor = start + Math.min(5, updates.length);
      for (let i = 0; i < Math.min(5, updates.length); i++) {
        const { pr_id } = updates[(start + i) % updates.length];
        if (this.e.closing || !this.e.canSync()) break;
        try {
          await this.inspect(pr_id);
        } catch {
          /* Keep the durable pending state until GitHub can be reached. */
        }
      }
    } finally {
      this.refreshingUpdates = false;
      this.notify();
    }
  }
  async tick() {
    if (this.checking || this.e.closing || this.s.get('paused') || !this.e.canSync()) return;
    this.checking = true;
    try {
      const candidates = this.s.db
        .prepare(
          "SELECT p.id FROM prs p JOIN repos r ON r.id=p.repo WHERE p.state='OPEN' AND p.draft=0 AND r.enabled=1 AND r.archived=0 ORDER BY p.id",
        )
        .all()
        .filter(({ id }) => {
          const { pr, repo, review, job, latest } = this.local(id);
          const rule = mergeConfig(repo).rules.find((r) => r.baseBranch === pr.base_branch);
          return (
            rule &&
            review?.current &&
            review.baseBranch === pr.base_branch &&
            job.status === 'published' &&
            latest?.id === job.id &&
            rule.verdicts.includes(review.verdict) &&
            !this.s.db.prepare('SELECT id FROM merges WHERE pr_id=? AND sha=?').get(id, pr.sha)
          );
        });
      if (!candidates.length) return;
      const start = this.cursor % candidates.length;
      this.cursor = start + Math.min(5, candidates.length);
      for (let i = 0; i < Math.min(5, candidates.length); i++) {
        if (this.e.closing || this.s.get('paused') || !this.e.canSync()) break;
        const { id } = candidates[(start + i) % candidates.length];
        const { pr, repo, review } = this.local(id);
        const rule = mergeConfig(repo).rules.find((r) => r.baseBranch === pr.base_branch);
        if (!rule || !review) continue;
        try {
          await this.merge(id, {
            sha: pr.sha,
            baseBranch: pr.base_branch,
            reviewId: review.id,
            method: rule.method,
            automatic: true,
          });
        } catch (error) {
          this.checks.set(id, {
            reasons: [error.message],
            checkedAt: new Date(this.clock()).toISOString(),
          });
        }
      }
    } finally {
      this.checking = false;
      this.notify();
    }
  }
}
