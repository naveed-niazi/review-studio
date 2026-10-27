import React, { useEffect, useState } from 'react';
import Markdown from 'react-markdown';

export const VERDICTS = ['LGTM', 'NON-BLOCKING', 'NON-BLOCKING BUT FIX', 'BLOCKING'];
export const MERGE_METHODS = {
  merge: 'Create a merge commit',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge',
};
export const INITIAL_MERGE_CONFIG = {
  devBranches: ['dev', 'develop', 'development'],
  prodBranches: ['main', 'master', 'prod', 'production'],
  rules: [],
};
export function Verdict({ review }) {
  if (!review) return <span className="review-unavailable">Not reviewed</span>;
  return (
    <span
      className={`verdict verdict-${review.verdict === 'BLOCKING' ? 'blocking' : review.verdict === 'LGTM' ? 'clear' : 'followup'}`}
    >
      {review.verdict}
      {!review.current && <span> · Outdated</span>}
    </span>
  );
}
export function MergeSettings({ value, onChange }) {
  const patchRule = (index, change) =>
    onChange({
      ...value,
      rules: value.rules.map((r, i) => (i === index ? { ...r, ...change } : r)),
    });
  return (
    <section className="merge-settings">
      <h3>Branches & merging</h3>
      <p>
        DEV and PROD labels use the target branch, never the PR title. Enter exact branch names
        separated by commas.
      </p>
      <label>
        DEV branches
        <input
          value={value.devBranches.join(',')}
          onChange={(e) => onChange({ ...value, devBranches: e.target.value.split(',') })}
        />
      </label>
      <label>
        PROD branches
        <input
          value={value.prodBranches.join(',')}
          onChange={(e) => onChange({ ...value, prodBranches: e.target.value.split(',') })}
        />
      </label>
      <h4>Automatic merge rules</h4>
      <p>
        No rules means automatic merging is off. Rules apply to existing and future open PRs after a
        current review is published. Pausing the runner pauses automatic merging too.
      </p>
      {value.rules.map((rule, index) => (
        <fieldset className="merge-rule" key={index}>
          <legend>Rule {index + 1}</legend>
          <label>
            Target branch
            <input
              required
              aria-label={`Rule ${index + 1} target branch`}
              value={rule.baseBranch}
              placeholder="dev"
              onChange={(e) => patchRule(index, { baseBranch: e.target.value })}
            />
          </label>
          <label>
            Merge method
            <select
              aria-label={`Rule ${index + 1} merge method`}
              value={rule.method}
              onChange={(e) => patchRule(index, { method: e.target.value })}
            >
              {Object.entries(MERGE_METHODS).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <div className="merge-verdict-options">
            {VERDICTS.filter((v) => v !== 'BLOCKING').map((v) => (
              <label key={v}>
                <input
                  type="checkbox"
                  checked={rule.verdicts.includes(v)}
                  onChange={(e) =>
                    patchRule(index, {
                      verdicts: e.target.checked
                        ? [...rule.verdicts, v]
                        : rule.verdicts.filter((x) => x !== v),
                    })
                  }
                />
                {v}
              </label>
            ))}
          </div>
          <button
            type="button"
            className="text-button danger"
            onClick={() => onChange({ ...value, rules: value.rules.filter((_, i) => i !== index) })}
          >
            Remove rule
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className="button"
        onClick={() =>
          onChange({
            ...value,
            rules: [
              ...value.rules,
              { baseBranch: '', verdicts: ['LGTM', 'NON-BLOCKING'], method: 'merge' },
            ],
          })
        }
      >
        Add automatic merge rule
      </button>
      <p className="merge-help">
        Blocking reviews never merge. “NON-BLOCKING BUT FIX” requires an explicit selection. GitHub
        permissions, checks, review requirements, and enabled merge methods must also allow the
        merge. Repositories requiring a merge queue must use GitHub's queue.
      </p>
    </section>
  );
}
export function MergePreview({ pr, api, onMerged, Modal, Button }) {
  const [info, setInfo] = useState(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [merging, setMerging] = useState(false),
    [updating, setUpdating] = useState(false),
    [notice, setNotice] = useState(''),
    [method, setMethod] = useState('merge'),
    [reviewText, setReviewText] = useState('');
  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api('/api/merge?id=' + encodeURIComponent(pr.id));
      setInfo(data);
      setMethod((current) =>
        data.allowedMethods.includes(current) ? current : data.allowedMethods[0] || 'merge',
      );
      if (data.review) {
        const job = await api('/api/jobs/' + encodeURIComponent(data.review.id));
        setReviewText(job.result || job.job?.result || '');
      } else setReviewText('');
    } catch (e) {
      setError(e.message);
      setInfo(null);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, [pr.id]);
  const submit = async () => {
    setMerging(true);
    setError('');
    try {
      await api('/api/merge', 'POST', {
        prId: pr.id,
        sha: info.sha,
        baseBranch: info.baseBranch,
        reviewId: info.review.id,
        method,
      });
      await onMerged();
    } catch (e) {
      setError(e.message);
      setInfo(null);
    } finally {
      setMerging(false);
    }
  };
  const queueReview = async () => {
    setUpdating(true);
    setError('');
    try {
      await api('/api/jobs', 'POST', { prId: pr.id });
      await onMerged();
    } catch (e) {
      setError(e.message);
    } finally {
      setUpdating(false);
    }
  };
  const updateBranch = async () => {
    setUpdating(true);
    setError('');
    setNotice('');
    try {
      await api('/api/update-branch', 'POST', {
        prId: pr.id,
        sha: info.sha,
        baseBranch: info.baseBranch,
      });
      setNotice(
        'GitHub accepted the branch update. Refresh status to see the new commits, then request a fresh review.',
      );
      await refresh();
    } catch (e) {
      setError(e.message);
      setInfo(null);
    } finally {
      setUpdating(false);
    }
  };
  return (
    <Modal
      wide
      title={`PR actions · ${pr.repo} #${pr.number}`}
      description={pr.title}
      onClose={merging || updating ? () => {} : onMerged}
    >
      {loading && <p role="status">Checking GitHub merge requirements…</p>}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="merge-help">
          {notice}
        </p>
      )}
      {info && (
        <>
          <div className="merge-summary">
            <span>
              {info.headBranch} → <strong>{info.baseBranch}</strong>
            </span>
            <code>{info.sha.slice(0, 7)}</code>
            <Verdict review={info.review} />
          </div>
          {info.reasons.length > 0 && (
            <div className="error-banner">
              <b>Merge is not available yet</b>
              <ul>
                {info.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          )}
          {info.update && (
            <section className="branch-update">
              <h3>Update with base branch</h3>
              <p className="merge-help">
                Merge the latest commits from <strong>{info.baseBranch}</strong> into{' '}
                <strong>{info.headBranch}</strong>. This updates the PR branch, keeps it open, and
                requires a fresh review before merging its new commits.
              </p>
              {info.update.reasons.map((reason) => (
                <p className="merge-help" key={reason}>
                  {reason}
                </p>
              ))}
              {info.update.behind > 0 && (
                <p className="merge-help">
                  {info.update.behind} base branch commit{info.update.behind === 1 ? '' : 's'} to
                  bring in.
                </p>
              )}
              <Button
                busy={updating}
                disabled={loading || merging || updating || info.update.reasons.length > 0}
                onClick={updateBranch}
              >
                Update with base branch
              </Button>
            </section>
          )}
          {(!info.review || !info.review.current || !info.review.baseBranch) &&
            info.state === 'OPEN' && (
              <Button
                disabled={
                  loading ||
                  updating ||
                  merging ||
                  ['updating', 'pending', 'unknown'].includes(info.update?.attempt?.status)
                }
                onClick={queueReview}
              >
                Queue new review
              </Button>
            )}
          <details className="merge-review" open>
            <summary>
              Latest review
              {info.review?.finishedAt
                ? ` · ${new Date(info.review.finishedAt).toLocaleString()}`
                : ''}
            </summary>
            <div className="markdown">
              <Markdown>{reviewText || 'No completed review is available.'}</Markdown>
            </div>
          </details>
          {info.checks.length > 0 && (
            <details>
              <summary>GitHub checks · {info.checks.length}</summary>
              <ul>
                {info.checks.map((c, i) => (
                  <li key={i}>
                    {c.name || c.context || 'Check'}: {c.conclusion || c.state || c.status}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <label className="merge-method">
            Merge method
            <select
              aria-label="Merge method"
              value={method}
              disabled={merging || updating}
              onChange={(e) => setMethod(e.target.value)}
            >
              {Object.entries(MERGE_METHODS).map(([value, label]) => (
                <option key={value} value={value} disabled={!info.allowedMethods.includes(value)}>
                  {label}
                  {!info.allowedMethods.includes(value) ? ' — disabled on GitHub' : ''}
                </option>
              ))}
            </select>
          </label>
          <p className="merge-help">
            This merges the reviewed commit into {info.baseBranch}. Branches are kept. GitHub
            requirements are checked again when you confirm.
          </p>
        </>
      )}
      <div className="modal-actions">
        <Button disabled={loading || merging || updating} onClick={refresh}>
          Refresh merge status
        </Button>
        <Button
          className="primary"
          busy={merging}
          disabled={
            !info ||
            loading ||
            merging ||
            updating ||
            info.reasons.length > 0 ||
            !info.allowedMethods.includes(method)
          }
          onClick={submit}
        >
          Confirm {MERGE_METHODS[method].toLowerCase()}
        </Button>
      </div>
    </Modal>
  );
}
