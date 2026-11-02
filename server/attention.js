import { createHash } from 'node:crypto';

export function dismissAttention(store, snapshot, keys) {
  const dismissed = store.get('dismissedAttention') || {};
  const requested = new Set(keys);
  for (const item of snapshot.items)
    if (requested.has(item.dismissalKey)) dismissed[item.id] = item.dismissalKey;
  store.set('dismissedAttention', dismissed);
}

export function attentionSnapshot(store, health, operations = []) {
  const items = [];
  const add = (id, kind, title, page, extra = {}, occurrence = '') =>
    items.push({
      id,
      kind,
      title,
      page,
      category: 'attention',
      ...extra,
      dismissalKey: createHash('sha256')
        .update(JSON.stringify([id, kind, occurrence]))
        .digest('hex'),
    });
  for (const provider of ['github', 'claude', 'git']) {
    const entry = health?.[provider];
    if (!entry || entry.ok || entry.checking || !entry.issue) continue;
    const name = { github: 'GitHub', claude: 'Claude', git: 'Git' }[provider];
    const kind = entry.issue.kind;
    const description =
      {
        authentication: 'sign-in needs attention',
        billing: 'account limit needs attention',
        rate_limit: 'is limiting requests',
        service: 'service is unavailable',
        local_network: 'cannot be reached from this Mac',
        dns: 'address could not be resolved',
        connection: 'connection failed',
        configuration: 'setup needs attention',
      }[kind] || 'connection needs attention';
    add(
      `connection:${provider}`,
      kind,
      `${name} ${description}`,
      'settings',
      {
        category: 'connection',
      },
      kind,
    );
  }
  const jobs = store.db
    .prepare(
      `SELECT j.*,p.repo,p.number,p.sha AS current_sha,p.base_branch
    FROM jobs j JOIN prs p ON p.id=j.pr_id JOIN repos r ON r.id=p.repo
    WHERE p.state='OPEN' AND r.enabled=1 AND r.archived=0 AND j.sha=p.sha
    AND j.rowid=(SELECT MAX(n.rowid) FROM jobs n WHERE n.pr_id=j.pr_id)`,
    )
    .all();
  for (const j of jobs) {
    let kind, title;
    if (j.status === 'failed' || (j.status === 'queued' && j.retry_at)) {
      kind = 'review_failed';
      title =
        j.recovery_pending || j.retry_at
          ? 'Review failed; recovery is scheduled'
          : 'Review needs attention';
    } else if (j.status === 'publish_failed') {
      kind = 'publish_failed';
      title = 'Review publication failed';
    } else if (j.status === 'awaiting_approval') {
      kind = 'approval';
      title = 'Review is ready for approval';
    }
    if (kind && (!j.reviewed_base_branch || j.reviewed_base_branch === j.base_branch))
      add(
        `review:${j.pr_id}`,
        kind,
        title,
        kind === 'approval' ? 'reviews' : 'activity',
        {
          jobId: j.id,
          generation: `${j.sha}:${j.base_branch}`,
          label: `${j.repo} #${j.number}`,
        },
        [j.sha, j.base_branch, kind === 'approval' ? j.id : j.error],
      );
  }
  for (const r of store.db
    .prepare(
      "SELECT id,error FROM repos WHERE enabled=1 AND archived=0 AND error IS NOT NULL AND error<>''",
    )
    .all())
    add(
      `repository:${r.id}`,
      'repository',
      'Repository sync needs attention',
      'repositories',
      {
        label: r.id,
      },
      r.error,
    );
  for (const table of ['merges', 'branch_updates']) {
    const rows = store.db
      .prepare(
        `SELECT a.* FROM ${table} a JOIN prs p ON p.id=a.pr_id JOIN repos r ON r.id=p.repo
      WHERE p.state='OPEN' AND r.enabled=1 AND r.archived=0 AND a.sha=p.sha AND a.status IN ('failed','unknown')
      AND a.rowid=(SELECT MAX(n.rowid) FROM ${table} n WHERE n.pr_id=a.pr_id)`,
      )
      .all();
    for (const a of rows)
      add(
        `${table}:${a.pr_id}`,
        a.status,
        table === 'merges' ? 'Merge needs attention' : 'Branch update needs attention',
        'inbox',
        { label: a.pr_id },
        a.id,
      );
  }
  for (const o of operations)
    if (o.status === 'failed')
      add(`clone:${o.id}`, 'clone', 'Repository clone failed', 'repositories', { label: o.repo });
  const dismissed = store.get('dismissedAttention') || {};
  // Keep dismissals through transient connection checks, but forget resolved occurrences.
  const current = new Map(items.map((item) => [item.id, item.dismissalKey]));
  const retained = Object.fromEntries(
    Object.entries(dismissed).filter(
      ([id, key]) =>
        current.get(id) === key ||
        (id.startsWith('connection:') && health?.[id.slice('connection:'.length)]?.checking),
    ),
  );
  if (JSON.stringify(retained) !== JSON.stringify(dismissed))
    store.set('dismissedAttention', retained);
  const visible = items.filter((item) => retained[item.id] !== item.dismissalKey);
  return {
    count: visible.length,
    items: visible,
    hasConnectionIssues: items.some((item) => item.category === 'connection'),
    connectionsChecked: ['github', 'claude', 'git'].every(
      (p) => health?.[p] && !health[p].checking,
    ),
  };
}
