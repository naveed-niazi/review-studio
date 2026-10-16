import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  Clock3,
  Code2,
  Copy,
  ExternalLink,
  FileCode2,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  Github,
  GripVertical,
  Inbox,
  Layers3,
  LoaderCircle,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';
import '@fontsource/manrope/800.css';
import './styles.css';

let csrf;
async function api(url, method = 'GET', body) {
  if (method !== 'GET' && !csrf) csrf = (await (await fetch('/api/session')).json()).token;
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(csrf ? { 'X-Studio-Token': csrf } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
const labels = {
  queued: 'Queued',
  running: 'Reviewing',
  awaiting_approval: 'Ready for approval',
  published: 'Published',
  failed: 'Failed',
  cancelled: 'Cancelled',
  publishing: 'Publishing',
  publish_failed: 'Publish failed',
};
const connectionLabels = {
  local_network: 'Network unavailable',
  dns: 'DNS problem',
  connection: 'Connection interrupted',
  service: 'Service unavailable',
  rate_limit: 'Rate limited',
  authentication: 'Sign-in needed',
  billing: 'Account limit',
  configuration: 'Setup needed',
  permission: 'Access denied',
  unknown: 'Check failed',
};
function nextCheck(value) {
  return value
    ? new Date(value).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      })
    : 'shortly';
}
function ConnectionProblem({ entry }) {
  return (
    <div className="connection-problem">
      <b>
        {connectionLabels[entry?.issue?.kind] ||
          (entry?.checking ? 'Checking connections…' : 'Connection check pending')}
      </b>
      {entry?.error && <p>{entry.error}</p>}
      {entry?.issue?.diagnosis && <p>{entry.issue.diagnosis}</p>}
      {entry?.nextCheckAt && (
        <small>
          Next connection check: {nextCheck(entry.nextCheckAt)}.{' '}
          {entry.actionRequired
            ? 'Account or setup changes may be needed before reviews can continue.'
            : 'Recovery is automatic; a manual pause remains paused.'}
        </small>
      )}
    </div>
  );
}
function relative(value) {
  if (!value) return 'Not yet';
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value)) / 60000));
  return minutes < 1
    ? 'just now'
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : `${Math.floor(minutes / 1440)}d ago`;
}
function Badge({ status, children }) {
  return (
    <span className={`badge ${status || ''}`}>
      {status === 'running' ? (
        <LoaderCircle size={12} className="spin" />
      ) : status === 'published' ? (
        <Check size={12} />
      ) : (
        <span className="dot" />
      )}
      {children || labels[status] || status}
    </span>
  );
}
function Button({ children, icon: Icon, className = '', busy = false, ...props }) {
  return (
    <button {...props} className={`button ${className}`} disabled={busy || props.disabled}>
      {busy ? <LoaderCircle size={15} className="spin" /> : Icon && <Icon size={15} />}
      {children}
    </button>
  );
}
function Toggle({ checked, onChange, label, description }) {
  return (
    <label className="toggle-row">
      <span>
        <b>{label}</b>
        {description && <small>{description}</small>}
      </span>
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch" />
    </label>
  );
}
function Empty({ icon: Icon = Inbox, title, children, action }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={26} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
function Modal({ title, description, onClose, children, wide = false }) {
  useEffect(() => {
    const fn = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function App() {
  const [state, setState] = useState(null),
    [page, setPage] = useState('inbox'),
    [toast, setToast] = useState(null),
    [modal, setModal] = useState(null),
    [busy, setBusy] = useState({}),
    [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all'),
    [repoFilter, setRepoFilter] = useState('all'),
    [limit, setLimit] = useState(60),
    [connected, setConnected] = useState(true);
  const fetchInFlight = useRef(false),
    fetchAgain = useRef(false),
    toastTimer = useRef();
  const refresh = async () => {
    if (fetchInFlight.current) {
      fetchAgain.current = true;
      return;
    }
    fetchInFlight.current = true;
    try {
      setState(await api('/api/state'));
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      fetchInFlight.current = false;
      if (fetchAgain.current) {
        fetchAgain.current = false;
        void refresh();
      }
    }
  };
  function showToast(message, type = 'success') {
    clearTimeout(toastTimer.current);
    setToast({ message, type });
    toastTimer.current = setTimeout(() => setToast(null), 6500);
  }
  async function action(key, fn, message) {
    setBusy((s) => ({ ...s, [key]: true }));
    try {
      const result = await fn();
      await refresh();
      if (message) showToast(message);
      return result;
    } catch (e) {
      showToast(e.message, 'error');
      return null;
    } finally {
      setBusy((s) => ({ ...s, [key]: false }));
    }
  }
  useEffect(() => {
    void refresh();
    const events = new EventSource('/api/events');
    events.onmessage = () => {
      setConnected(true);
      void refresh();
    };
    events.onerror = () => setConnected(false);
    return () => {
      events.close();
      clearTimeout(toastTimer.current);
    };
  }, []);
  useEffect(
    () =>
      window.reviewStudio?.onNavigate((p) => {
        setPage(p);
        setSearch('');
      }),
    [],
  );
  useEffect(() => setLimit(60), [search, filter, repoFilter, page]);
  if (!state)
    return (
      <div className="boot">
        <div className="brand-symbol">
          <Layers3 size={24} />
        </div>
        <h2>Review Studio</h2>
        <p>Opening your local workspace…</p>
        <LoaderCircle className="spin" />
        {toast && <p className="error-text">{toast.message}</p>}
      </div>
    );
  const { settings, prs, jobs, repos, health } = state;
  const connectionReady = health && ['github', 'claude', 'git'].every((key) => health[key]?.ok);
  const connectionProblems = health
    ? ['github', 'claude', 'git'].filter((key) => !health[key]?.ok)
    : [];
  const queued = jobs.filter((j) => j.status === 'queued').sort((a, b) => a.position - b.position),
    running = jobs.filter((j) => ['running', 'publishing'].includes(j.status)),
    ready = jobs.filter((j) => j.status === 'awaiting_approval'),
    failed = jobs.filter(
      (j) =>
        ['failed', 'publish_failed'].includes(j.status) &&
        !jobs.some(
          (newer) =>
            newer.pr_id === j.pr_id &&
            newer.created_at > j.created_at &&
            newer.status !== 'cancelled',
        ),
    );
  const navigate = (p) => {
    setPage(p);
    setSearch('');
  };
  const queuePR = (pr, instructions = '') =>
    action(
      `queue-${pr.id}`,
      () => api('/api/jobs', 'POST', { prId: pr.id, instructions }),
      'Added to the review queue',
    );
  const move = async (id, direction) => {
    const ids = queued.map((j) => j.id),
      index = ids.indexOf(id),
      target = index + direction;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    await action('reorder', () => api('/api/queue', 'PUT', { ids }));
  };
  const drop = (e, target) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    const ids = queued.map((j) => j.id);
    if (id === target || !ids.includes(id)) return;
    ids.splice(ids.indexOf(id), 1);
    ids.splice(ids.indexOf(target), 0, id);
    void action('reorder', () => api('/api/queue', 'PUT', { ids }));
  };
  const statusFor = (pr) =>
    jobs.find((j) => j.pr_id === pr.id && j.sha === pr.sha && j.status !== 'cancelled');
  const displayed = prs.filter(
    (pr) =>
      (repoFilter === 'all' || pr.repo === repoFilter) &&
      `${pr.title} ${pr.repo} ${pr.number} ${pr.author} ${pr.base_branch || ''} ${pr.head_branch || ''}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (filter === 'all' ||
        (filter === 'unreviewed' && !pr.reviewed && !statusFor(pr)) ||
        (filter === 'draft' && pr.draft)),
  );
  const nav = [
    ['inbox', 'Pull requests', GitPullRequest, prs.length],
    ['queue', 'Review queue', Layers3, queued.length + running.length],
    ['reviews', 'Reviews', ShieldCheck, ready.length],
    ['repositories', 'Repositories', FolderGit2, null],
    ['prompts', 'Prompts & rules', BookOpen, null],
    ['activity', 'Activity', Activity, failed.length || null],
  ];
  return (
    <div className="shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          aria-label="Review Studio home"
          onClick={(e) => {
            e.preventDefault();
            navigate('inbox');
          }}
        >
          <span className="brand-symbol">
            <Layers3 size={21} />
          </span>
          <span>
            review<span className="brand-light">studio</span>
            <small>LOCAL CODE REVIEWS</small>
          </span>
        </a>
        <div className="workspace-label">
          WORKSPACE <span>PERSONAL</span>
        </div>
        <nav>
          {nav.map(([id, title, Icon, count]) => (
            <button
              key={id}
              aria-label={title}
              title={title}
              aria-current={page === id ? 'page' : undefined}
              className={page === id ? 'nav-item selected' : 'nav-item'}
              onClick={() => navigate(id)}
            >
              <Icon size={18} />
              <span>{title}</span>
              {count !== null && <em>{count}</em>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="engine-card">
            <span className="engine-icon">
              <Zap size={17} />
            </span>
            <b>Runs on your machine</b>
            <p>
              Your repositories. Your Claude.
              <br />
              One place to review.
            </p>
            <div>
              <span className={`dot ${connected ? 'green' : 'red'}`} />
              {connected ? 'Local connection active' : 'Reconnecting…'}
            </div>
          </div>
          <button
            aria-label="Settings & connections"
            title="Settings & connections"
            aria-current={page === 'settings' ? 'page' : undefined}
            className={page === 'settings' ? 'nav-item selected' : 'nav-item'}
            onClick={() => navigate('settings')}
          >
            <Settings2 size={18} />
            <span>Settings & connections</span>
          </button>
          <div className="profile">
            <span className="avatar">
              {(health?.github?.output || 'L').slice(0, 1).toUpperCase()}
            </span>
            <div>
              <b>{health?.github?.ok ? health.github.output : 'Local workspace'}</b>
              <small>{health?.github?.ok ? 'GitHub connected' : 'Connect your accounts'}</small>
            </div>
            <span className="dot green" />
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>
            Workspace <ChevronRight size={14} />{' '}
            <b>{nav.find((n) => n[0] === page)?.[1] || 'Settings & connections'}</b>
          </span>
          <div>
            <span className="local-pill">
              <span className="dot green" /> Local workspace
            </span>
            <span className="divider" />
            <button className="top-help" onClick={() => navigate('settings')}>
              <Terminal size={15} /> CLI connections{' '}
              <span
                className={`dot ${health?.github?.ok && health?.claude?.ok ? 'green' : 'amber'}`}
              />
            </button>
          </div>
        </header>
        <div className="content">
          {!connectionReady && health && (
            <div className="banner warning">
              <CircleAlert size={18} />
              <div className="connection-problems">
                {connectionProblems.map((key) => (
                  <ConnectionProblem key={key} entry={health[key]} />
                ))}
              </div>
              <Button onClick={() => navigate('settings')}>
                Connection details <ArrowUpRight size={14} />
              </Button>
            </div>
          )}
          {['inbox', 'queue', 'reviews'].includes(page) && (
            <>
              <div className="page-head">
                <div>
                  <div className="eyebrow">YOUR LOCAL REVIEW WORKSPACE</div>
                  <h1>
                    {page === 'inbox'
                      ? 'Good code. Clear reviews.'
                      : page === 'queue'
                        ? 'Make room for better reviews.'
                        : 'Every review, in one place.'}
                  </h1>
                  <p>
                    {page === 'inbox'
                      ? 'A little less context switching. A lot more confidence in what ships.'
                      : page === 'queue'
                        ? 'Set the order, add context, and let Claude take it from here.'
                        : 'Read the findings, follow up, and decide what goes to GitHub.'}
                  </p>
                </div>
                <Button className="primary" icon={Plus} onClick={() => setModal({ type: 'add' })}>
                  Add pull request
                </Button>
              </div>
              <div className="stats-grid">
                {[
                  [
                    GitPullRequest,
                    'Open pull requests',
                    prs.length,
                    'Across your connected repositories',
                    'purple',
                  ],
                  [
                    Layers3,
                    'In the queue',
                    queued.length,
                    `${running.length} active · ${settings.concurrency} parallel slots`,
                    'blue',
                  ],
                  [
                    CheckCircle2,
                    'Ready to approve',
                    ready.length,
                    'Reviewed locally, waiting for you',
                    'green',
                  ],
                  [
                    CircleAlert,
                    'Needs attention',
                    failed.length,
                    failed.length
                      ? 'Open a review to inspect and retry'
                      : 'Everything is looking good',
                    'orange',
                  ],
                ].map(([Icon, label, count, sub, color], i) => (
                  <button
                    key={label}
                    className="stat-card"
                    onClick={() => navigate(['inbox', 'queue', 'reviews', 'activity'][i])}
                  >
                    <div>
                      <span>{label}</span>
                      <Icon size={17} className={color} />
                    </div>
                    <strong>{count.toLocaleString()}</strong>
                    <small>{sub}</small>
                  </button>
                ))}
              </div>
            </>
          )}
          {page === 'inbox' && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>
                    Pull requests <span className="count">{prs.length}</span>
                  </h2>
                  <p>Find the next change worth a closer look.</p>
                </div>
                <Button
                  icon={RefreshCw}
                  busy={state.syncing}
                  onClick={() => action('sync', () => api('/api/sync', 'POST'))}
                >
                  {state.syncing ? 'Syncing…' : 'Sync GitHub'}
                </Button>
              </div>
              <div className="toolbar">
                <div className="tabs">
                  {[
                    ['all', 'All open'],
                    ['unreviewed', 'To review'],
                    ['draft', 'Drafts'],
                  ].map(([id, label]) => (
                    <button
                      key={id}
                      className={filter === id ? 'active' : ''}
                      onClick={() => setFilter(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="filters">
                  <div className="search">
                    <Search size={15} />
                    <input
                      aria-label="Search pull requests"
                      placeholder="Search pull requests…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    <kbd>⌕</kbd>
                  </div>
                  <select
                    aria-label="Filter repository"
                    value={repoFilter}
                    onChange={(e) => setRepoFilter(e.target.value)}
                  >
                    <option value="all">All repositories</option>
                    {repos.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.id.split('/')[1]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {!repos.length ? (
                <Empty
                  icon={FolderGit2}
                  title="Bring your repositories together"
                  action={
                    <Button
                      className="primary"
                      icon={Plus}
                      onClick={() => navigate('repositories')}
                    >
                      Connect a repository
                    </Button>
                  }
                >
                  Connect an existing local clone or clone a repository from GitHub.
                </Empty>
              ) : !displayed.length ? (
                <Empty
                  title={
                    state.syncing ? 'Fetching your pull requests…' : 'No matching pull requests'
                  }
                >
                  Try a different filter or sync with GitHub.
                </Empty>
              ) : (
                <>
                  <div className="pr-table">
                    <div className="table-label">
                      <span>PULL REQUEST</span>
                      <span>CHANGES</span>
                      <span>STATUS</span>
                      <span />
                    </div>
                    {displayed.slice(0, limit).map((pr) => {
                      const job = statusFor(pr);
                      return (
                        <div className="pr-row" key={pr.id}>
                          <button
                            className="pr-main"
                            onClick={() => setModal({ type: 'detail', pr, jobId: job?.id })}
                          >
                            <span className={`pr-icon ${pr.draft ? 'muted' : ''}`}>
                              <GitPullRequest size={19} />
                            </span>
                            <div>
                              <h3>{pr.title}</h3>
                              <p>
                                <span className="repo-tag">{pr.repo.split('/')[1]}</span>
                                <span>#{pr.number}</span>
                                {pr.base_branch && (
                                  <span
                                    className="branch-tag"
                                    title={`${pr.head_branch || 'Source branch'} → ${pr.base_branch}`}
                                  >
                                    <GitBranch size={12} />
                                    <span>
                                      into <b>{pr.base_branch}</b>
                                    </span>
                                  </span>
                                )}
                                <span className="middle-dot">·</span>
                                <span>{pr.author}</span>
                                <span className="middle-dot">·</span>
                                <span>{relative(pr.updated_at)}</span>
                              </p>
                            </div>
                          </button>
                          <div className="changes">
                            <span>+{pr.additions.toLocaleString()}</span>
                            <span>−{pr.deletions.toLocaleString()}</span>
                            <small>{pr.files} files</small>
                          </div>
                          <div>
                            {job ? (
                              <Badge status={job.status} />
                            ) : pr.reviewed ? (
                              <Badge status="published">Reviewed</Badge>
                            ) : pr.draft ? (
                              <Badge status="cancelled">Draft</Badge>
                            ) : (
                              <Badge status="open">Open</Badge>
                            )}
                          </div>
                          <Button
                            className="row-action"
                            icon={job ? ChevronRight : Plus}
                            busy={busy[`queue-${pr.id}`]}
                            onClick={() =>
                              job
                                ? setModal({
                                    type: 'detail',
                                    pr,
                                    jobId: job.id,
                                  })
                                : queuePR(pr)
                            }
                          >
                            {job ? 'View' : 'Queue'}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                  {displayed.length > limit && (
                    <div className="load-more">
                      <Button onClick={() => setLimit(limit + 60)}>Show more pull requests</Button>
                    </div>
                  )}
                </>
              )}
              <div className="panel-footer">
                <span>
                  <span className="dot green" /> {displayed.length} pull requests ·{' '}
                  {repos.filter((r) => r.enabled).length} repositories
                </span>
                <span>
                  {state.syncing
                    ? 'Syncing in the background…'
                    : `Last synced ${relative(state.lastSync)}`}
                </span>
              </div>
            </section>
          )}
          {page === 'queue' && (
            <>
              <div className="runner-bar">
                <div>
                  <span
                    className={`runner-indicator ${settings.paused || !connectionReady ? 'paused' : ''}`}
                  >
                    <Zap size={20} />
                  </span>
                  <div>
                    <h3>
                      {settings.paused
                        ? 'Runner is paused'
                        : !connectionReady
                          ? 'Waiting for connections'
                          : 'Runner is active'}
                    </h3>
                    <p>
                      {settings.paused
                        ? 'Your queue is saved. Start when you’re ready.'
                        : !connectionReady
                          ? 'Your queue is saved. Connection checks retry automatically; review failures show their own retry status.'
                          : `${running.length} reviews in progress. Up to ${settings.concurrency} at a time.`}
                    </p>
                  </div>
                </div>
                <Button
                  className={settings.paused ? 'primary' : ''}
                  icon={settings.paused ? Play : Pause}
                  busy={busy.runner}
                  onClick={() =>
                    action('runner', () =>
                      api('/api/settings', 'PATCH', {
                        paused: !settings.paused,
                      }),
                    )
                  }
                >
                  {settings.paused ? 'Start runner' : 'Pause new reviews'}
                </Button>
              </div>
              {running.length > 0 && (
                <section className="section">
                  <h2>
                    In progress <span className="count">{running.length}</span>
                  </h2>
                  <div className="running-grid">
                    {running.map((j) => (
                      <button
                        className="running-card"
                        key={j.id}
                        onClick={() => setModal({ type: 'detail', jobId: j.id })}
                      >
                        <div>
                          <Badge status={j.status} />
                          <small>{relative(j.started_at)}</small>
                        </div>
                        <h3>{j.title}</h3>
                        <p>
                          {j.repo.split('/')[1]} #{j.number}
                        </p>
                        <div className="progress-track">
                          <span />
                        </div>
                        <small>
                          <Sparkles size={13} />
                          {j.phase || 'Publishing to GitHub'}
                        </small>
                      </button>
                    ))}
                  </div>
                </section>
              )}
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>
                      Up next <span className="count">{queued.length}</span>
                    </h2>
                    <p>Drag to reorder, or use the arrows. Eligible reviews run in this order.</p>
                  </div>
                  <span className="subtle">
                    <GripVertical size={15} /> Your order, your workflow
                  </span>
                </div>
                {!queued.length ? (
                  <Empty
                    icon={Layers3}
                    title="A clear queue. A fresh start."
                    action={<Button onClick={() => navigate('inbox')}>Browse pull requests</Button>}
                  >
                    Add pull requests from your inbox or paste a specific PR URL.
                  </Empty>
                ) : (
                  queued.map((j, i) => (
                    <div
                      className="queue-row"
                      key={j.id}
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData('text/plain', j.id)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => drop(e, j.id)}
                    >
                      <GripVertical size={17} className="grip" />
                      <span className="queue-number">{String(i + 1).padStart(2, '0')}</span>
                      <button
                        className="queue-title"
                        onClick={() => setModal({ type: 'detail', jobId: j.id })}
                      >
                        <h3>{j.title}</h3>
                        <p>
                          {j.repo.split('/')[1]} #{j.number} <span>·</span>{' '}
                          {j.instructions ? 'Custom review focus' : 'Default review rules'}{' '}
                          <span>·</span>{' '}
                          {j.policy === 'automatic' ? 'Auto-publish' : 'Approval required'}
                        </p>
                        {j.retry_at && (
                          <p className="retry-note">
                            {connectionLabels[j.failure_kind] || 'Temporary failure'} · Retry{' '}
                            {j.retry_count}/3 at {nextCheck(j.retry_at)}
                          </p>
                        )}
                      </button>
                      <div className="reorder">
                        <button
                          aria-label="Move review up"
                          disabled={i === 0 || busy.reorder}
                          onClick={() => move(j.id, -1)}
                        >
                          <ArrowUp size={15} />
                        </button>
                        <button
                          aria-label="Move review down"
                          disabled={i === queued.length - 1 || busy.reorder}
                          onClick={() => move(j.id, 1)}
                        >
                          <ArrowDown size={15} />
                        </button>
                      </div>
                      <button
                        className="icon-button"
                        aria-label="Remove from queue"
                        onClick={() => action(j.id, () => api(`/api/jobs/${j.id}/cancel`, 'POST'))}
                      >
                        <X size={16} />
                      </button>
                    </div>
                  ))
                )}
              </section>
            </>
          )}
          {page === 'reviews' && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Review history</h2>
                  <p>Results, approvals, and the exact commit each review covered.</p>
                </div>
              </div>
              {!jobs.filter((j) => !['queued', 'running'].includes(j.status)).length ? (
                <Empty icon={ShieldCheck} title="Your reviews will live here">
                  Completed reviews are saved locally, with their findings and activity.
                </Empty>
              ) : (
                jobs
                  .filter((j) => !['queued', 'running'].includes(j.status))
                  .map((j) => (
                    <button
                      className="history-row"
                      key={j.id}
                      onClick={() => setModal({ type: 'detail', jobId: j.id })}
                    >
                      <span className="history-icon">
                        <FileCode2 size={19} />
                      </span>
                      <div>
                        <h3>{j.title}</h3>
                        <p>
                          {j.repo.split('/')[1]} #{j.number} · <code>{j.sha.slice(0, 7)}</code> ·{' '}
                          {relative(j.finished_at || j.created_at)}
                        </p>
                      </div>
                      <Badge status={j.status} />
                      <ChevronRight size={17} />
                    </button>
                  ))
              )}
            </section>
          )}
          {state.operations
            ?.filter((o) => o.status !== 'complete')
            .map((o) => (
              <div className={`banner ${o.status === 'failed' ? 'warning' : ''}`} key={o.id}>
                {o.status === 'running' ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <CircleAlert size={16} />
                )}
                <span>
                  <b>{o.repo}</b> · {o.message}
                </span>
              </div>
            ))}
          {page === 'repositories' && (
            <Repositories state={state} action={action} busy={busy} setModal={setModal} />
          )}
          {page === 'prompts' && <Prompts state={state} action={action} busy={busy} />}
          {page === 'activity' && (
            <>
              <PageHead
                eyebrow="A CLEAR PICTURE"
                title="Nothing gets lost in the logs."
                description="Review progress and errors, with the context to take the next step."
              />
              {failed.length > 0 && (
                <section className="panel attention">
                  <div className="panel-heading">
                    <h2>
                      Needs attention <span className="count">{failed.length}</span>
                    </h2>
                  </div>
                  {failed.map((j) => (
                    <button
                      key={j.id}
                      className="error-row"
                      onClick={() => setModal({ type: 'detail', jobId: j.id })}
                    >
                      <CircleAlert size={18} />
                      <div>
                        <b>
                          {j.repo.split('/')[1]} #{j.number}
                        </b>
                        <p>{j.error}</p>
                      </div>
                      <ChevronRight size={16} />
                    </button>
                  ))}
                </section>
              )}
              <section className="panel">
                <div className="panel-heading">
                  <h2>Recent activity</h2>
                  <span className="subtle">Live updates</span>
                </div>
                {state.events.length ? (
                  state.events.map((e) => (
                    <div className={`event-row ${e.level}`} key={e.id}>
                      <span className="dot" />
                      <div>
                        <p>{e.message.length > 500 ? e.message.slice(0, 500) + '…' : e.message}</p>
                        <small>{new Date(e.created_at).toLocaleString()}</small>
                      </div>
                      {e.job_id && (
                        <button
                          className="text-button"
                          onClick={() => setModal({ type: 'detail', jobId: e.job_id })}
                        >
                          View review <ArrowUpRight size={13} />
                        </button>
                      )}
                    </div>
                  ))
                ) : (
                  <Empty icon={Activity} title="You’re all caught up">
                    Activity will appear as you connect repositories and run reviews.
                  </Empty>
                )}
              </section>
            </>
          )}
          {page === 'settings' && (
            <Settings
              state={state}
              action={action}
              busy={busy}
              refresh={refresh}
              showToast={showToast}
            />
          )}
        </div>
        <footer className="app-footer">
          <span>
            <Layers3 size={13} /> Review Studio
          </span>
          <span>Built for thoughtful reviews. Powered by Claude Code.</span>
          <span>v1.0.0</span>
        </footer>
      </main>
      {toast && (
        <div role="status" className={`toast ${toast.type}`}>
          {toast.type === 'error' ? <CircleAlert size={18} /> : <CheckCircle2 size={18} />}
          <span>{toast.message}</span>
          <button aria-label="Dismiss notification" onClick={() => setToast(null)}>
            <X size={16} />
          </button>
        </div>
      )}
      {!settings.onboardingComplete && !repos.length && health && (
        <Welcome
          health={health}
          onContinue={async (destination) => {
            const saved = await action('welcome', () =>
              api('/api/settings', 'PATCH', { onboardingComplete: true }),
            );
            if (saved) navigate(destination);
          }}
        />
      )}
      {modal?.type === 'add' && (
        <AddPR state={state} close={() => setModal(null)} action={action} busy={busy} />
      )}
      {modal?.type === 'repo' && (
        <RepoModal
          state={state}
          repo={modal.repo}
          close={() => setModal(null)}
          action={action}
          busy={busy}
        />
      )}
      {modal?.type === 'removeRepo' && (
        <RemoveRepo repo={modal.repo} close={() => setModal(null)} action={action} busy={busy} />
      )}
      {modal?.type === 'detail' && (
        <Detail
          modal={modal}
          state={state}
          close={() => setModal(null)}
          action={action}
          busy={busy}
          setModal={setModal}
        />
      )}
    </div>
  );
}
function PageHead({ eyebrow, title, description, children }) {
  return (
    <div className="page-head">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children}
    </div>
  );
}
function Welcome({ health, onContinue }) {
  const ready = health.github.ok && health.claude.ok && health.git.ok;
  return (
    <Modal
      title="Welcome to Review Studio"
      description="A local home for thoughtful code reviews. Let’s check what’s already set up."
      onClose={() => onContinue('inbox')}
    >
      <div className="welcome-brand">
        <span className="brand-symbol">
          <Layers3 size={25} />
        </span>
        <h3>Your tools. Already connected.</h3>
        <p>We use your existing CLI accounts wherever possible.</p>
      </div>
      {[
        ['github', 'GitHub CLI', Github],
        ['claude', 'Claude Code', Sparkles],
        ['git', 'Git', GitBranch],
      ].map(([key, title, Icon]) => (
        <div className="welcome-check" key={key}>
          <Icon size={20} />
          <div>
            <b>{title}</b>
            <small>
              {health[key].ok ? health[key].output : 'Setup needed — we’ll guide you through it'}
            </small>
          </div>
          <Badge status={health[key].ok ? 'published' : 'failed'}>
            {health[key].ok ? 'Ready' : 'Set up'}
          </Badge>
        </div>
      ))}
      <div className="info-note" style={{ marginTop: 20 }}>
        <ShieldCheck size={17} />
        <span>
          Start with approval before publishing. No reviews run until you start the queue.
        </span>
      </div>
      <div className="modal-actions">
        <Button onClick={() => onContinue('inbox')}>Explore first</Button>
        <Button className="primary" onClick={() => onContinue(ready ? 'repositories' : 'settings')}>
          {ready ? 'Continue to repositories' : 'Set up connections'}
          <ArrowUpRight size={14} />
        </Button>
      </div>
    </Modal>
  );
}
function AddPR({ state, close, action, busy }) {
  const [url, setUrl] = useState(''),
    [instructions, setInstructions] = useState('');
  return (
    <Modal
      title="Add a pull request"
      description="One specific PR, with exactly the context it needs."
      onClose={close}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const result = await action(
            'add',
            () => api('/api/jobs', 'POST', { url, instructions }),
            'Pull request added to the queue',
          );
          if (result) close();
        }}
      >
        <label>
          Pull request URL
          <input
            autoFocus
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/owner/repo/pull/123"
          />
        </label>
        <TemplatePicker templates={state.templates} onSelect={setInstructions} />
        <label>
          What should Claude focus on? <span className="optional">Optional</span>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Check the authentication flow, especially token expiry and permission boundaries."
            rows={5}
          />
        </label>
        <div className="info-note">
          <ShieldCheck size={17} />
          <span>
            This review will{' '}
            {state.settings.publishPolicy === 'automatic'
              ? 'publish automatically when complete'
              : 'wait for your approval before publishing'}
            . You can change this in Settings.
          </span>
        </div>
        <div className="modal-actions">
          <Button type="button" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" className="primary" icon={Plus} busy={busy.add}>
            Add to queue
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function TemplatePicker({ templates, onSelect }) {
  return (
    templates.length > 0 && (
      <label>
        Use a saved prompt
        <select
          defaultValue=""
          onChange={(e) => {
            const t = templates.find((t) => t.id === e.target.value);
            if (t) onSelect(t.body);
          }}
        >
          <option value="">Choose a prompt…</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
    )
  );
}
function Repositories({ state, action, busy, setModal }) {
  return (
    <>
      <PageHead
        eyebrow="CLOSE TO YOUR CODE"
        title="Your repositories, connected."
        description="Use local clones, add repository rules, and choose what gets reviewed."
      >
        <Button className="primary" icon={Plus} onClick={() => setModal({ type: 'repo' })}>
          Add repository
        </Button>
      </PageHead>
      <div className="repo-grid">
        {state.repos.map((r) => (
          <section className="panel repo-card" key={r.id}>
            <div className="repo-card-top">
              <span className="repo-symbol">
                <FolderGit2 size={23} />
              </span>
              <Badge status={r.error ? 'failed' : r.enabled ? 'open' : 'cancelled'}>
                {r.error ? 'Sync error' : r.enabled ? 'Connected' : 'Disabled'}
              </Badge>
            </div>
            <h3>{r.id.split('/')[1]}</h3>
            <p>{r.id.split('/')[0]}</p>
            <code className="path">{r.path}</code>
            {r.error && <p className="error-text clamp">{r.error}</p>}
            <div className="repo-rule-summary">
              <BookOpen size={14} />
              {r.managed
                ? 'App-managed local clone'
                : r.instructions
                  ? 'Repository rules configured'
                  : 'Existing local clone'}
            </div>
            <div className="repo-card-bottom">
              <button
                className="icon-button"
                aria-label={`Remove ${r.id}`}
                onClick={() => setModal({ type: 'removeRepo', repo: r })}
              >
                <Trash2 size={14} />
              </button>
              <Toggle
                label="Enabled"
                checked={r.enabled}
                onChange={(enabled) =>
                  action(r.id, () => api('/api/repos', 'PATCH', { id: r.id, enabled }))
                }
              />
              <Button onClick={() => setModal({ type: 'repo', repo: r })}>
                Configure <ChevronRight size={14} />
              </Button>
            </div>
          </section>
        ))}
      </div>
      {!state.repos.length && (
        <section className="panel">
          <Empty
            icon={FolderGit2}
            title="Start with a repository"
            action={
              <Button className="primary" onClick={() => setModal({ type: 'repo' })}>
                Connect your first repository
              </Button>
            }
          >
            Already have a clone? Use it as-is. Or clone a repository from GitHub here.
          </Empty>
        </section>
      )}
    </>
  );
}
function RepoModal({ repo, state, close, action, busy }) {
  const [id, setId] = useState(repo?.id || ''),
    [localPath, setPath] = useState(repo?.path || ''),
    [instructions, setInstructions] = useState(repo?.instructions || ''),
    [mode, setMode] = useState('existing'),
    [checks, setChecks] = useState(JSON.parse(repo?.checks || '{}')),
    [owner, setOwner] = useState(state.health?.github?.output || ''),
    [available, setAvailable] = useState(null),
    [query, setQuery] = useState('');
  return (
    <Modal
      wide
      title={repo ? 'Repository settings' : 'Connect a repository'}
      description="Review code locally, in isolated worktrees that keep your checkout intact."
      onClose={close}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const result = await action(
            'repo',
            async () => {
              if (mode === 'clone' && !repo)
                return api('/api/repos/clone', 'POST', {
                  id,
                  path: localPath,
                  instructions,
                  checks,
                });
              await api('/api/repos', 'POST', { id, path: localPath });
              return api('/api/repos', 'PATCH', { id, instructions, checks });
            },
            mode === 'clone' ? 'Cloning started. Track progress in Activity.' : 'Repository saved',
          );
          if (result) close();
        }}
      >
        {!repo && (
          <>
            <div className="segmented">
              <button
                type="button"
                className={mode === 'existing' ? 'active' : ''}
                onClick={() => setMode('existing')}
              >
                Use local clone
              </button>
              <button
                type="button"
                className={mode === 'clone' ? 'active' : ''}
                onClick={() => setMode('clone')}
              >
                Clone from GitHub
              </button>
            </div>
            <div className="repo-picker">
              <div className="inline-form">
                <input
                  aria-label="GitHub account or organization"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  placeholder="GitHub username or organization"
                />
                <Button
                  type="button"
                  icon={Github}
                  busy={busy.browse}
                  onClick={async () => {
                    const result = await action('browse', () =>
                      api(`/api/github/repos?owner=${encodeURIComponent(owner)}`),
                    );
                    if (result) setAvailable(result);
                  }}
                >
                  Browse repositories
                </Button>
              </div>
              {available && (
                <>
                  <input
                    className="repo-search"
                    aria-label="Search GitHub repositories"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filter your repositories…"
                  />
                  <div className="repo-options">
                    {available
                      .filter((r) => r.nameWithOwner.toLowerCase().includes(query.toLowerCase()))
                      .map((r) => (
                        <button
                          type="button"
                          key={r.nameWithOwner}
                          disabled={r.connected}
                          className={id === r.nameWithOwner ? 'chosen' : ''}
                          onClick={() => setId(r.nameWithOwner)}
                        >
                          <FolderGit2 size={16} />
                          <span>
                            {r.nameWithOwner}
                            <small>{r.description}</small>
                          </span>
                          <em>{r.connected ? 'Connected' : r.isPrivate ? 'Private' : 'Public'}</em>
                          {id === r.nameWithOwner && <Check size={14} />}
                        </button>
                      ))}
                  </div>
                </>
              )}
            </div>
          </>
        )}
        <div className="form-grid">
          <label>
            GitHub repository
            <input
              required
              disabled={!!repo}
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="owner/repository"
            />
          </label>
          <label>
            {mode === 'clone' ? 'Clone destination (optional)' : 'Local repository path'}
            <div className="path-input">
              <input
                required={mode !== 'clone'}
                value={localPath}
                onChange={(e) => setPath(e.target.value)}
                placeholder={
                  mode === 'clone' ? 'Use the app’s repository folder' : '~/projects/repository'
                }
              />
              {window.reviewStudio && mode === 'existing' && (
                <Button
                  type="button"
                  onClick={async () => {
                    const p = await window.reviewStudio.selectDirectory();
                    if (p) setPath(p);
                  }}
                >
                  Choose…
                </Button>
              )}
            </div>
          </label>
        </div>
        <TemplatePicker templates={state.templates} onSelect={setInstructions} />
        <label>
          Repository review rules
          <textarea
            rows={5}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Architecture constraints, critical flows, required analytics, testing conventions…"
          />
        </label>
        <CheckToggles
          value={checks}
          defaults={state.settings.checks}
          onChange={setChecks}
          inherit
        />
        <div className="info-note">
          <BookOpen size={16} />
          <span>
            These rules are added to the default prompt for every review of this repository.
          </span>
        </div>
        <div className="modal-actions">
          <Button type="button" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" className="primary" busy={busy.repo}>
            {mode === 'clone' ? 'Clone & connect' : repo ? 'Save changes' : 'Connect repository'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
const checkLabels = {
  tests: [
    'Tests accompany feature changes',
    'Require appropriate tests for meaningful new or changed behavior.',
  ],
  analytics: [
    'Analytics accompany feature changes',
    'Check tracking against the repository’s established event requirements.',
  ],
  security: [
    'Security checks',
    'Trace authentication, permissions, validation, and trust boundaries.',
  ],
  compatibility: [
    'Backward compatibility',
    'Check public APIs, migrations, data formats, and affected callers.',
  ],
};
function CheckToggles({ value = {}, onChange, inherit = false, defaults = {} }) {
  return (
    <div className="check-toggles">
      {Object.entries(checkLabels).map(([key, [title, description]]) =>
        inherit ? (
          <label className="override-row" key={key}>
            <span>
              <b>{title}</b>
              <small>{description}</small>
            </span>
            <select
              value={value[key] === undefined ? 'inherit' : String(value[key])}
              onChange={(e) => {
                const next = { ...value };
                if (e.target.value === 'inherit') delete next[key];
                else next[key] = e.target.value === 'true';
                onChange(next);
              }}
            >
              <option value="inherit">Default ({defaults[key] ? 'on' : 'off'})</option>
              <option value="true">Required</option>
              <option value="false">Off</option>
            </select>
          </label>
        ) : (
          <Toggle
            key={key}
            label={title}
            description={description}
            checked={value[key]}
            onChange={(v) => onChange({ ...value, [key]: v })}
          />
        ),
      )}
    </div>
  );
}
function RemoveRepo({ repo, close, action, busy }) {
  const [deleteClone, setDelete] = useState(false);
  return (
    <Modal
      title={`Remove ${repo.id.split('/')[1]}?`}
      description="Disconnect the repository from syncing and future reviews. Completed review history is retained."
      onClose={close}
    >
      <code className="path">{repo.path}</code>
      {repo.managed ? (
        <Toggle
          label="Also delete the app-managed local clone"
          description="Only allowed when there are no local changes, unpushed commits, or extra worktrees."
          checked={deleteClone}
          onChange={setDelete}
        />
      ) : (
        <p className="subtle" style={{ marginTop: 15 }}>
          This is an existing local clone. Its files will stay where they are.
        </p>
      )}
      <div className="modal-actions">
        <Button onClick={close}>Keep repository</Button>
        <Button
          className="danger"
          busy={busy.removeRepo}
          onClick={async () => {
            const result = await action(
              'removeRepo',
              () => api('/api/repos/remove', 'POST', { id: repo.id, deleteClone }),
              'Repository removed',
            );
            if (result) close();
          }}
        >
          Remove repository{deleteClone ? ' & delete clone' : ''}
        </Button>
      </div>
    </Modal>
  );
}
function Prompts({ state, action, busy }) {
  const [global, setGlobal] = useState(state.settings.instructions),
    [templates, setTemplates] = useState(state.templates),
    [selected, setSelected] = useState(null);
  const current = templates.find((t) => t.id === selected);
  const update = (key, value) =>
    setTemplates(templates.map((t) => (t.id === selected ? { ...t, [key]: value } : t)));
  return (
    <>
      <PageHead
        eyebrow="GIVE CLAUDE THE RIGHT CONTEXT"
        title="Your standards. Every review."
        description="Keep shared instructions, reusable prompts, and repository rules in one place."
      />
      <section className="panel settings-panel">
        <div className="section-title">
          <span className="section-icon">
            <BookOpen size={21} />
          </span>
          <div>
            <h2>Default review instructions</h2>
            <p>
              The foundation for every review. Repository rules and per-PR notes are added on top.
            </p>
          </div>
        </div>
        <textarea
          aria-label="Default review instructions"
          rows={8}
          value={global}
          onChange={(e) => setGlobal(e.target.value)}
        />
        <div className="right">
          <Button
            className="primary"
            busy={busy.global}
            onClick={() =>
              action(
                'global',
                () => api('/api/settings', 'PATCH', { instructions: global }),
                'Default instructions saved',
              )
            }
          >
            Save default instructions
          </Button>
        </div>
      </section>
      <section className="panel settings-panel">
        <div className="section-title">
          <span className="section-icon">
            <Sparkles size={21} />
          </span>
          <div>
            <h2>Prompt library</h2>
            <p>Save a focused review checklist and reuse it on any repository or PR.</p>
          </div>
          <Button
            icon={Plus}
            onClick={() => {
              const t = {
                id: crypto.randomUUID(),
                name: 'New prompt',
                body: '',
              };
              setTemplates([...templates, t]);
              setSelected(t.id);
            }}
          >
            New prompt
          </Button>
        </div>
        <div className="prompt-editor">
          <div className="prompt-list">
            {templates.map((t) => (
              <button
                key={t.id}
                className={t.id === selected ? 'active' : ''}
                onClick={() => setSelected(t.id)}
              >
                <FileCode2 size={17} />
                {t.name}
                <ChevronRight size={14} />
              </button>
            ))}
            {!templates.length && <p>No saved prompts yet.</p>}
          </div>
          {current ? (
            <div className="prompt-fields">
              <label>
                Prompt name
                <input value={current.name} onChange={(e) => update('name', e.target.value)} />
              </label>
              <label>
                Instructions
                <textarea
                  rows={7}
                  value={current.body}
                  onChange={(e) => update('body', e.target.value)}
                  placeholder="For example: trace each permission check and verify unauthorized users cannot access protected data."
                />
              </label>
              <button
                className="text-button danger"
                onClick={() => {
                  setTemplates(templates.filter((t) => t.id !== selected));
                  setSelected(null);
                }}
              >
                <Trash2 size={14} /> Remove prompt
              </button>
            </div>
          ) : (
            <Empty icon={BookOpen} title="A prompt for the task at hand">
              Security, regressions, migrations, or your team’s release checklist.
            </Empty>
          )}
        </div>
        <div className="right">
          <Button
            className="primary"
            busy={busy.templates}
            onClick={() =>
              action(
                'templates',
                () => api('/api/templates', 'PUT', { templates }),
                'Prompt library saved',
              )
            }
          >
            Save prompt library
          </Button>
        </div>
      </section>
      <div className="info-note">
        <Layers3 size={17} />
        <span>
          Review context: <b>default instructions → repository rules → per-PR focus.</b> Configure
          repository rules from each repository’s settings.
        </span>
      </div>
    </>
  );
}
function Settings({ state, action, busy, refresh, showToast }) {
  const [form, setForm] = useState(state.settings),
    [key, setKey] = useState(''),
    [auth, setAuth] = useState(null),
    [authInput, setAuthInput] = useState(''),
    [desktop, setDesktop] = useState(null);
  const patch = (k, v) => setForm({ ...form, [k]: v });
  useEffect(() => {
    if (window.reviewStudio) window.reviewStudio.getPreferences().then(setDesktop);
  }, []);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const data = await api('/api/auth/session');
        if (alive) setAuth(data);
      } catch {}
    };
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  const h = state.health;
  const desktopPreference = async (k, v) => {
    try {
      setDesktop(await window.reviewStudio.setPreferences({ [k]: v }));
    } catch (e) {
      showToast(e.message, 'error');
    }
  };
  return (
    <>
      <PageHead
        eyebrow="MAKE IT YOURS"
        title="Set up once. Review comfortably."
        description="Existing CLI sign-ins are detected automatically. Your credentials stay on your machine."
      >
        <Button
          icon={RefreshCw}
          busy={busy.health}
          onClick={() => action('health', () => api('/api/health'), 'Connections checked')}
        >
          Check connections
        </Button>
      </PageHead>
      {h && !h.git.ok && (
        <div className="banner warning">
          <CircleAlert size={17} />
          <span>Git needs to be installed before repositories can be cloned or reviewed.</span>
          <a href="https://git-scm.com/downloads" target="_blank" rel="noreferrer">
            Install Git <ExternalLink size={13} />
          </a>
        </div>
      )}
      <div className="connection-grid">
        {[
          [
            'github',
            'GitHub CLI',
            Github,
            'Connect your account to browse repositories, sync PRs, and publish reviews.',
          ],
          [
            'claude',
            'Claude Code',
            Sparkles,
            'Use your existing Claude subscription or an Anthropic API key.',
          ],
        ].map(([id, title, Icon, description]) => (
          <section key={id} className="panel connection-card">
            <div>
              <span className="connection-icon">
                <Icon size={23} />
              </span>
              <Badge status={h?.[id]?.ok ? 'published' : 'failed'}>
                {h?.[id]?.ok ? 'Connected' : connectionLabels[h?.[id]?.issue?.kind] || 'Checking…'}
              </Badge>
            </div>
            <h2>{title}</h2>
            <p>{description}</p>
            {h?.[id]?.ok ? (
              <div className="account-info">
                <CheckCircle2 size={16} />
                <span>{h[id].output}</span>
                <small>Existing CLI account</small>
              </div>
            ) : (
              <ConnectionProblem entry={h?.[id]} />
            )}
            <div className="connection-actions">
              <Button
                icon={ArrowUpRight}
                busy={busy[`auth-${id}`]}
                onClick={() =>
                  action(`auth-${id}`, () => api('/api/auth/login', 'POST', { provider: id }))
                }
              >
                {h?.[id]?.issue?.kind === 'authentication' ? 'Sign in' : 'Change account'}
              </Button>
              <a
                href={
                  id === 'github'
                    ? 'https://cli.github.com/'
                    : 'https://code.claude.com/docs/en/setup'
                }
                target="_blank"
                rel="noreferrer"
              >
                Install CLI <ExternalLink size={12} />
              </a>
            </div>
          </section>
        ))}
      </div>
      {auth && auth.status !== 'idle' && (
        <section className="panel settings-panel">
          <div className="section-title">
            <Terminal size={21} />
            <div>
              <h2>{auth.provider === 'github' ? 'GitHub' : 'Claude'} sign-in</h2>
              <p>Follow the browser flow. If a code or Enter is requested, use the input below.</p>
            </div>
            <Badge
              status={
                auth.status === 'complete'
                  ? 'published'
                  : auth.status === 'failed'
                    ? 'failed'
                    : 'running'
              }
            >
              {auth.status}
            </Badge>
          </div>
          <pre className="terminal-output">{auth.output || 'Starting sign-in…'}</pre>
          {auth.status === 'running' && (
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                void action('auth-input', () =>
                  api('/api/auth/input', 'POST', { input: authInput }),
                );
                setAuthInput('');
              }}
            >
              <input
                type="password"
                autoComplete="off"
                placeholder="Paste a code, or leave blank to send Enter"
                aria-label="Sign-in response"
                value={authInput}
                onChange={(e) => setAuthInput(e.target.value)}
              />
              <Button>Continue</Button>
              <Button
                type="button"
                onClick={() => action('cancel-auth', () => api('/api/auth/cancel', 'POST'))}
              >
                Cancel sign-in
              </Button>
            </form>
          )}
        </section>
      )}
      <section className="panel settings-panel">
        <div className="section-title">
          <span className="section-icon">
            <Code2 size={20} />
          </span>
          <div>
            <h2>Use an API key instead</h2>
            <p>
              {window.reviewStudio
                ? 'Optional. The desktop app encrypts saved keys using your operating system’s secure storage.'
                : 'Optional. A pasted key stays in memory for this app session. CLI sign-in persists across restarts.'}
            </p>
          </div>
        </div>
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const result = await action(
              'key',
              async () => {
                if (window.reviewStudio) setDesktop(await window.reviewStudio.setApiKey(key));
                return api('/api/auth/key', 'POST', { key });
              },
              window.reviewStudio ? 'API key saved securely' : 'API key set for this session',
            );
            if (result) {
              setKey('');
              await action('health', () => api('/api/health'));
            }
          }}
        >
          <input
            type="password"
            autoComplete="off"
            aria-label="Anthropic API key"
            placeholder={
              h?.apiKeySet ? 'An API key is active for this session' : 'Anthropic API key'
            }
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <Button busy={busy.key} disabled={!key}>
            Use key
          </Button>
          {h?.apiKeySet && (
            <Button
              type="button"
              onClick={() =>
                action(
                  'key',
                  async () => {
                    if (window.reviewStudio) setDesktop(await window.reviewStudio.setApiKey(''));
                    await api('/api/auth/key', 'POST', { key: '' });
                    return api('/api/health');
                  },
                  'Using CLI credentials',
                )
              }
            >
              Clear key
            </Button>
          )}
        </form>
      </section>
      <section className="panel settings-panel">
        <div className="section-title">
          <span className="section-icon">
            <ShieldCheck size={21} />
          </span>
          <div>
            <h2>Publishing policy</h2>
            <p>
              Choose how completed reviews reach GitHub. Applies to reviews added after you save.
            </p>
          </div>
        </div>
        <div className="policy-grid">
          {[
            [
              'approval',
              'Require my approval',
              'Save findings locally. Read the review, then approve publishing.',
              ShieldCheck,
            ],
            [
              'automatic',
              'Publish automatically',
              'Post a single summary review as soon as the review completes.',
              Zap,
            ],
          ].map(([value, title, description, Icon]) => (
            <label
              key={value}
              className={`policy-option ${form.publishPolicy === value ? 'chosen' : ''}`}
            >
              <input
                type="radio"
                name="publish"
                checked={form.publishPolicy === value}
                onChange={() => patch('publishPolicy', value)}
              />
              <Icon size={22} />
              <b>{title}</b>
              <p>{description}</p>
            </label>
          ))}
        </div>
        <div className="info-note">
          <GitPullRequest size={16} />
          <span>
            Blocking findings request changes. Other verdicts post a comment review. Reviews of your
            own PRs use comments. Each review is attached to the commit that was inspected.
          </span>
        </div>
      </section>
      <section className="panel settings-panel">
        <div className="section-title">
          <span className="section-icon">
            <CheckCircle2 size={21} />
          </span>
          <div>
            <h2>Required review checks</h2>
            <p>Default requirements for every repository. Override them in repository settings.</p>
          </div>
        </div>
        <CheckToggles value={form.checks} onChange={(v) => patch('checks', v)} />
      </section>
      <section className="panel settings-panel">
        <div className="section-title">
          <span className="section-icon">
            <Settings2 size={21} />
          </span>
          <div>
            <h2>Review workflow</h2>
            <p>Control pace, model, and automatic discovery.</p>
          </div>
        </div>
        <div className="form-grid three">
          <label>
            Parallel reviews
            <input
              type="number"
              min="1"
              max="6"
              value={form.concurrency}
              onChange={(e) => patch('concurrency', Number(e.target.value))}
            />
            <small>1–6 simultaneous reviews</small>
          </label>
          <label>
            Claude model
            <input value={form.model} onChange={(e) => patch('model', e.target.value)} />
            <small>Use default for your CLI’s model, or a model alias/ID</small>
          </label>
          <label>
            Review effort
            <select value={form.effort} onChange={(e) => patch('effort', e.target.value)}>
              {['low', 'medium', 'high', 'xhigh', 'max'].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            Sync interval (minutes)
            <input
              type="number"
              min="1"
              max="120"
              value={form.syncMinutes}
              onChange={(e) => patch('syncMinutes', Number(e.target.value))}
            />
          </label>
          <label>
            Review timeout (minutes)
            <input
              type="number"
              min="1"
              max="120"
              value={form.timeoutMinutes}
              onChange={(e) => patch('timeoutMinutes', Number(e.target.value))}
            />
          </label>
          <label>
            Auto-queue age window (days)
            <input
              type="number"
              min="1"
              max="365"
              value={form.maxAgeDays}
              onChange={(e) => patch('maxAgeDays', Number(e.target.value))}
            />
          </label>
          <label>
            Age measured from
            <select value={form.ageBasis} onChange={(e) => patch('ageBasis', e.target.value)}>
              <option value="activity">Last PR activity</option>
              <option value="commit">Last code commit</option>
            </select>
          </label>
        </div>
        <Toggle
          checked={form.autoQueue}
          onChange={(v) => patch('autoQueue', v)}
          label="Automatically queue new and updated PRs"
          description="Queue open, non-draft PRs within the selected age window. Temporary connection or service failures retry up to three times. Other failures need a manual retry."
        />
        <div className="right">
          <Button
            className="primary"
            busy={busy.settings}
            onClick={() => {
              const { paused, instructions, onboardingComplete, ...values } = form;
              void action(
                'settings',
                () => api('/api/settings', 'PATCH', values),
                'Workflow settings saved',
              );
            }}
          >
            Save workflow settings
          </Button>
        </div>
      </section>
      <section className="panel settings-panel">
        <div className="section-title">
          <span className="section-icon">
            <Zap size={21} />
          </span>
          <div>
            <h2>App & startup</h2>
            <p>Keep the workspace available when you need it.</p>
          </div>
        </div>
        {desktop ? (
          <>
            {desktop.loginStatus === 'requires-approval' && (
              <div className="banner warning">
                <CircleAlert size={16} />
                Enable Review Studio in macOS System Settings → General → Login Items.
              </div>
            )}
            <Toggle
              checked={desktop.openAtLogin}
              onChange={(v) => desktopPreference('openAtLogin', v)}
              label="Start Review Studio at login"
              description="Open quietly in the background when you sign in to your Mac."
            />
            <Toggle
              checked={desktop.keepRunning}
              onChange={(v) => desktopPreference('keepRunning', v)}
              label="Keep running when the window closes"
              description="Reviews continue in the menu bar. Use Quit Review Studio to stop the app."
            />
          </>
        ) : (
          <p className="subtle">
            Login and menu bar options are available in the desktop app. This browser version runs
            while its server is active.
          </p>
        )}
        <div className="storage-info">
          <b>Local application data</b>
          <code>{state.dataDir}</code>
          <small>
            SQLite database, review results, and app-managed clones. No hosted service is required.
          </small>
        </div>
      </section>
    </>
  );
}
function Detail({ modal, state, close, action, busy, setModal }) {
  const [job, setJob] = useState(null),
    [details, setDetails] = useState(null),
    [error, setError] = useState(''),
    [tab, setTab] = useState('overview'),
    [notes, setNotes] = useState(''),
    [notesLoaded, setNotesLoaded] = useState(false),
    [copy, setCopy] = useState(false);
  const summary = state.jobs.find((j) => j.id === modal.jobId),
    pr = modal.pr || summary || job;
  useEffect(() => {
    let alive = true;
    if (modal.jobId)
      api(`/api/jobs/${modal.jobId}`)
        .then((j) => {
          if (alive) {
            setJob(j);
            if (!notesLoaded) {
              setNotes(j.instructions);
              setNotesLoaded(true);
            }
          }
        })
        .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [modal.jobId, summary?.status, state.events[0]?.id]);
  useEffect(() => {
    let alive = true;
    const id = modal.pr?.id || summary?.pr_id || job?.pr_id;
    if (id)
      api(`/api/pr?id=${encodeURIComponent(id)}`)
        .then((d) => alive && setDetails(d))
        .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [modal.pr?.id, summary?.pr_id, job?.pr_id]);
  const data = job || pr;
  return (
    <Modal
      wide
      title={data?.title || 'Loading review…'}
      description={data ? `${data.repo} #${data.number}` : ''}
      onClose={close}
    >
      <div className="detail-meta">
        {job ? <Badge status={job.status} /> : <Badge status="open">Open pull request</Badge>}
        <span>
          <GitBranch size={14} />
          {(job?.sha || pr?.sha || '').slice(0, 7)}
        </span>
        {job && (
          <span>
            {job.model} · {job.effort} effort
          </span>
        )}
        <a href={data?.url} target="_blank" rel="noreferrer">
          Open on GitHub <ExternalLink size={13} />
        </a>
      </div>
      {error && (
        <div className="banner warning">
          <CircleAlert size={16} />
          {error}
        </div>
      )}
      {job?.error && (
        <div className="banner warning">
          <CircleAlert size={17} />
          <span>
            {job.error}
            {job.retry_at && (
              <>
                <br />
                Automatic retry {job.retry_count}/3 at {nextCheck(job.retry_at)}.
              </>
            )}
          </span>
        </div>
      )}
      {job && job.current_sha !== job.sha && (
        <div className="banner warning">
          <CircleAlert size={17} />
          This PR has new commits. This review covers an older version.
        </div>
      )}
      <div className="detail-tabs tabs">
        {[
          ['overview', 'Overview'],
          ['changes', `Changed files${details ? ` · ${details.files.length}` : ''}`],
          ['result', 'Review'],
          ['activity', 'Activity'],
        ].map(([id, label]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="detail-body">
        {tab === 'overview' && (
          <>
            <div className="branch-summary">
              <GitBranch size={15} />
              <span>Current branches</span>
              <code>{details?.metadata.headRefName || data?.head_branch || '—'}</code>
              <span aria-label="into">→</span>
              <code>{details?.metadata.baseRefName || data?.base_branch || '—'}</code>
            </div>
            <div className="detail-summary">
              <div>
                <small>AUTHOR</small>
                <b>{details?.metadata.author?.login || data?.author || '—'}</b>
              </div>
              <div>
                <small>CHANGES</small>
                <b className="diff-count">
                  +{details?.metadata.additions ?? '—'}{' '}
                  <span>−{details?.metadata.deletions ?? '—'}</span>
                </b>
              </div>
              <div>
                <small>PUBLISHING</small>
                <b>
                  {(job?.policy || state.settings.publishPolicy) === 'automatic'
                    ? 'Automatic'
                    : 'Approval required'}
                </b>
              </div>
            </div>
            {details ? (
              <div className="markdown description">
                <Markdown
                  components={{
                    img: () => null,
                    a: ({ children, ...props }) => (
                      <a {...props} target="_blank" rel="noreferrer">
                        {children}
                      </a>
                    ),
                  }}
                >
                  {details.metadata.body || 'No description provided.'}
                </Markdown>
              </div>
            ) : (
              <p className="subtle">
                <LoaderCircle size={15} className="spin" /> Loading PR context…
              </p>
            )}
            <hr />
            {job?.config && (
              <div className="saved-checks">
                <b>Checks used for this review</b>
                {Object.entries(JSON.parse(job.config).checks || {})
                  .filter(([, v]) => v)
                  .map(([k]) => (
                    <span key={k}>
                      <CheckCircle2 size={12} />
                      {checkLabels[k]?.[0] || k}
                    </span>
                  ))}
              </div>
            )}
            <TemplatePicker templates={state.templates} onSelect={setNotes} />
            <label>
              Review focus
              <textarea
                value={notes}
                disabled={job && job.status !== 'queued'}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
                placeholder="Add what you want checked for this particular PR…"
              />
            </label>
            {job?.status === 'queued' && (
              <Button
                busy={busy.notes}
                onClick={() =>
                  action(
                    'notes',
                    () =>
                      api(`/api/jobs/${job.id}`, 'PATCH', {
                        instructions: notes,
                      }),
                    'Review focus saved',
                  )
                }
              >
                Save focus
              </Button>
            )}
            <p className="subtle">
              Default instructions and repository rules are included automatically.
            </p>
          </>
        )}
        {tab === 'changes' &&
          (!details ? (
            <p className="subtle">Loading changed files…</p>
          ) : (
            details.files.map((file) => (
              <details className="file-diff" key={file.filename}>
                <summary>
                  <FileCode2 size={15} />
                  <span>{file.filename}</span>
                  <em>
                    +{file.additions} <b>−{file.deletions}</b>
                  </em>
                </summary>
                {file.patch ? (
                  <pre>
                    {file.patch.split('\n').map((line, i) => (
                      <span
                        key={i}
                        className={
                          line.startsWith('+')
                            ? 'added'
                            : line.startsWith('-')
                              ? 'removed'
                              : line.startsWith('@@')
                                ? 'hunk'
                                : ''
                        }
                      >
                        {line + '\n'}
                      </span>
                    ))}
                  </pre>
                ) : (
                  <p>
                    GitHub did not return a text patch for this file. Open the PR to inspect it.
                  </p>
                )}
              </details>
            ))
          ))}
        {tab === 'result' &&
          (job?.result ? (
            <>
              <div className="result-toolbar">
                <span>Saved local review</span>
                <Button
                  icon={copy ? Check : Copy}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(job.result);
                      setCopy(true);
                    } catch {
                      setError('Could not copy. Select the review text instead.');
                    }
                  }}
                >
                  {copy ? 'Copied' : 'Copy Markdown'}
                </Button>
              </div>
              <div className="markdown review-result">
                <Markdown
                  components={{
                    img: () => null,
                    a: ({ children, ...props }) => (
                      <a {...props} target="_blank" rel="noreferrer">
                        {children}
                      </a>
                    ),
                  }}
                >
                  {job.result}
                </Markdown>
              </div>
              {job.cost != null && (
                <p className="subtle">
                  Estimated API cost: ${job.cost.toFixed(4)}. Subscription billing may differ.
                </p>
              )}
            </>
          ) : (
            <Empty
              icon={Sparkles}
              title={
                job?.status === 'running'
                  ? 'Claude is reviewing this change'
                  : 'No review result yet'
              }
            >
              {job?.phase || 'Once the review finishes, its findings will appear here.'}
            </Empty>
          ))}
        {tab === 'activity' &&
          (job?.events?.length ? (
            <div className="detail-events">
              {job.events.map((e) => (
                <div key={e.id} className={`event-row ${e.level}`}>
                  <span className="dot" />
                  <div>
                    <small>{new Date(e.created_at).toLocaleTimeString()}</small>
                    <p>{e.message}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty icon={Activity} title="No activity yet">
              Progress will appear when the review starts.
            </Empty>
          ))}
      </div>
      <div className="modal-actions detail-actions">
        <span className="subtle">
          {job?.status === 'running' ? 'Live updates enabled' : 'Reviewed on your machine'}
        </span>
        {!job ? (
          <Button
            className="primary"
            icon={Plus}
            busy={busy.add}
            onClick={async () => {
              const r = await action(
                'add',
                () =>
                  api('/api/jobs', 'POST', {
                    prId: pr.id,
                    instructions: notes,
                  }),
                'Added to the queue',
              );
              if (r) setModal({ type: 'detail', jobId: r.id });
            }}
          >
            Add to queue
          </Button>
        ) : (
          <>
            {['queued', 'running'].includes(job.status) && (
              <Button
                busy={busy.cancel}
                onClick={() =>
                  action(
                    'cancel',
                    () => api(`/api/jobs/${job.id}/cancel`, 'POST'),
                    'Review cancelled',
                  )
                }
              >
                Cancel review
              </Button>
            )}
            {['failed', 'cancelled', 'published', 'publish_failed', 'awaiting_approval'].includes(
              job.status,
            ) && (
              <Button
                icon={RefreshCw}
                busy={busy.retry}
                onClick={async () => {
                  const r = await action(
                    'retry',
                    () => api(`/api/jobs/${job.id}/retry`, 'POST'),
                    'New review queued',
                  );
                  if (r) {
                    setJob(null);
                    setNotesLoaded(false);
                    setModal({ type: 'detail', jobId: r.id });
                  }
                }}
              >
                {['failed', 'cancelled'].includes(job.status) ? 'Retry review' : 'Review again'}
              </Button>
            )}
            {['awaiting_approval', 'publish_failed'].includes(job.status) && (
              <Button
                className="primary"
                icon={Github}
                disabled={job.current_sha !== job.sha}
                busy={busy.publish}
                onClick={() =>
                  action(
                    'publish',
                    () => api(`/api/jobs/${job.id}/publish`, 'POST'),
                    'Publishing review to GitHub',
                  )
                }
              >
                {job.status === 'publish_failed' ? 'Retry publishing' : 'Approve & publish'}
              </Button>
            )}
            {job.published_url && (
              <a
                className="button primary"
                href={job.published_url}
                target="_blank"
                rel="noreferrer"
              >
                View on GitHub <ExternalLink size={14} />
              </a>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

createRoot(document.getElementById('root')).render(<App />);
