import { run } from './process.js';

const names = { github: 'GitHub', claude: 'Claude', git: 'Git' };
const transportKinds = new Set(['local_network', 'dns', 'connection']);
export const MAX_REVIEW_RETRIES = 3;

export function classifyFailure(error, provider = 'github', { health = false } = {}) {
  const message = String(error?.message || error || 'Unknown error');
  const detail = `${error?.code || ''} ${error?.cause?.code || ''} ${message}`;
  const status =
    Number(
      detail.match(
        /(?:HTTP(?:\/\S+)?\s+|API Error:\s*|Error code:\s*|returned error:\s*|"status(?:_code)?"\s*:\s*)(\d{3})\b/i,
      )?.[1],
    ) || null;
  const retryHeader = detail.match(/retry-after["']?\s*[:=]\s*["']?([^\r\n"']+)/i)?.[1]?.trim();
  let retryAfterMs = 0;
  if (retryHeader) {
    const seconds = Number(retryHeader);
    retryAfterMs = Number.isFinite(seconds)
      ? Math.max(0, seconds * 1000)
      : Math.max(0, Date.parse(retryHeader) - Date.now()) || 0;
  }
  let kind = 'unknown',
    retryable = false,
    actionRequired = false,
    summary;
  const name = names[provider] || provider;
  if (
    /credit balance|insufficient (?:credits|funds)|spend(?:ing)? (?:cap|limit)|billing/i.test(
      detail,
    )
  ) {
    kind = 'billing';
    actionRequired = true;
    summary = `${name} reported an account or spending limit. Check the account before retrying.`;
  } else if (
    status === 401 ||
    /authentication_error|not logged in|not authenticated|authentication failed|failed to authenticate|bad credentials|invalid authentication credentials|invalid[ _.-](?:x-)?api[ _.-]key|(?:token|oauth)[ _.-]expired|expired[ _.-](?:token|oauth)|please (?:log|sign) in|(?:gh|claude) auth login|"loggedIn"\s*:\s*false/i.test(
      detail,
    )
  ) {
    kind = 'authentication';
    actionRequired = true;
    summary = `${name} needs a valid sign-in. Reconnect the account, then check connections.`;
  } else if (
    status === 429 ||
    /rate.?limit|too many requests|usage limit reached|you(?:'ve| have) hit your (?:usage )?limit/i.test(
      detail,
    )
  ) {
    kind = 'rate_limit';
    retryable = true;
    summary = `${name} is limiting requests. Waiting before retrying.`;
  } else if (
    (status >= 500 && status <= 599) ||
    /overloaded_error|service unavailable/i.test(detail)
  ) {
    kind = 'service';
    retryable = true;
    summary = `${name} returned a service error${status ? ` (HTTP ${status})` : ''}. It will be retried.`;
  } else if (
    /ENETDOWN|ENETUNREACH|EHOSTUNREACH|network is (?:down|unreachable)|no route to host/i.test(
      detail,
    )
  ) {
    kind = 'local_network';
    retryable = true;
    summary = `This machine cannot reach ${name}. Check the network, VPN or proxy; recovery is automatic.`;
  } else if (/ENOTFOUND|EAI_AGAIN|could not resolve (?:host|proxy)|name resolution/i.test(detail)) {
    kind = 'dns';
    retryable = true;
    summary = `${name}'s address could not be resolved. This may be local DNS, VPN, proxy or upstream DNS.`;
  } else if (
    /certificate|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT/i.test(detail)
  ) {
    kind = 'configuration';
    actionRequired = true;
    summary = `${name}'s secure connection could not be verified. Check certificates and proxy settings.`;
  } else if (/ENOENT|command not found|Unrecognized Claude authentication status/i.test(detail)) {
    kind = 'configuration';
    actionRequired = true;
    summary = `${name}'s CLI is missing or incompatible. Check its installation in Settings.`;
  } else if (provider === 'claude' && !health && /timed out after/i.test(detail)) {
    kind = 'review_timeout';
    summary =
      'The review exceeded its time limit. Inspect the log before retrying; this does not prove a network failure.';
  } else if (
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|unexpected EOF|socket hang up|fetch failed|connection (?:error|closed|reset)|timed? ?out|TLS handshake timeout|unable to connect|network error/i.test(
      detail,
    )
  ) {
    kind = 'connection';
    retryable = true;
    summary = `The connection to ${name} failed. The error alone does not identify a local or service-side cause.`;
  } else if (status === 403 || /permission denied|forbidden/i.test(detail)) {
    kind = 'permission';
    summary = `${name} denied access. Check permissions for this operation.`;
  } else {
    summary = `${name} could not complete this operation. Inspect the error details.`;
  }
  return { provider, kind, summary, retryable, actionRequired, status, retryAfterMs };
}

export function retryDelay(issue, attempt, random = Math.random) {
  const base = issue.kind === 'rate_limit' ? 60000 : 15000;
  const backoff = Math.min(300000, base * 2 ** Math.min(Math.max(attempt - 1, 0), 5));
  // Retry-After is a minimum, never shortened by jitter or the backoff cap.
  return Math.max(issue.retryAfterMs || 0, backoff + Math.floor(backoff * 0.2 * random()));
}

export async function probeConnectivity() {
  const endpoints = { github: 'https://api.github.com/', claude: 'https://api.anthropic.com/' };
  return Object.fromEntries(
    await Promise.all(
      Object.entries(endpoints).map(async ([key, url]) => {
        try {
          const response = await fetch(url, {
            method: 'HEAD',
            redirect: 'manual',
            signal: AbortSignal.timeout(6000),
          });
          await response.body?.cancel();
          // Even a 401/404 proves an HTTP response arrived; it does not validate credentials or model availability.
          return [key, { reachable: true, status: response.status }];
        } catch (error) {
          return [key, { reachable: false, code: error.cause?.code || error.code || error.name }];
        }
      }),
    ),
  );
}

export class ConnectionMonitor {
  constructor({
    command = run,
    env = () => ({}),
    clock = Date.now,
    random = Math.random,
    probe = probeConnectivity,
    notify = () => {},
    event = () => {},
    saved = {},
    persist = () => {},
  } = {}) {
    Object.assign(this, { command, env, clock, random, probe, notify, event, persist });
    this.reported = structuredClone(saved);
    this.entries = Object.fromEntries(
      Object.entries(this.reported).map(([provider, state]) => [
        provider,
        {
          ok: false,
          checking: false,
          issue: state.issue,
          error: state.issue.summary,
          nextCheckAt: state.nextCheckAt,
          failures: state.failures || 1,
          actionRequired: state.issue.actionRequired,
        },
      ]),
    );
    this.revisions = {};
    this.controller = new AbortController();
    this.closed = false;
  }
  snapshot() {
    const checking = { ok: false, checking: true, output: '', error: null };
    return {
      github: this.entries.github || checking,
      claude: this.entries.claude || checking,
      git: this.entries.git || checking,
      checkedAt: this.checkedAt || null,
    };
  }
  ready() {
    return ['github', 'claude', 'git'].every((key) => this.entries[key]?.ok);
  }
  assertRequestAllowed(provider) {
    const state = this.reported[provider];
    const remaining = Date.parse(state?.nextCheckAt) - this.clock();
    if (remaining > 0 && (state.issue.kind === 'rate_limit' || state.issue.retryAfterMs > 0)) {
      const status = state.issue.status || (state.issue.kind === 'rate_limit' ? 429 : 503);
      const error = new Error(
        `HTTP ${status}: ${state.issue.summary}\nRetry-After: ${Math.ceil(remaining / 1000)}`,
      );
      error.provider = provider;
      throw error;
    }
  }
  report(error, provider, retryAt) {
    if (this.closed) return;
    const issue = classifyFailure(error, provider);
    if (!issue.retryable && !issue.actionRequired) return;
    const existing = this.reported[provider];
    if (
      (existing?.issue.kind === 'rate_limit' || existing?.issue.retryAfterMs > 0) &&
      Date.parse(existing.nextCheckAt) > this.clock() + retryDelay(issue, 1, () => 0)
    )
      return;
    this.revisions[provider] = (this.revisions[provider] || 0) + 1;
    const nextCheckAt = new Date(
      Math.max(retryAt || 0, this.clock() + retryDelay(issue, 1, this.random)),
    ).toISOString();
    this.reported[provider] = { issue, nextCheckAt, origin: 'operation' };
    this.entries[provider] = {
      ...this.entries[provider],
      ok: false,
      checking: false,
      issue,
      error: issue.summary,
      nextCheckAt,
      failures: 1,
      actionRequired: issue.actionRequired,
    };
    this.persist(this.reported);
    this.notify();
  }
  async refresh({ force = false, retryAccount = false } = {}) {
    if (this.closed) return this.snapshot();
    if (this.pending) {
      await this.pending;
      if (!force) return this.snapshot();
    }
    if (
      !force &&
      ['github', 'claude', 'git'].every((key) => {
        const due = this.entries[key]?.nextCheckAt || this.reported[key]?.nextCheckAt;
        return due && Date.parse(due) > this.clock();
      })
    )
      return this.snapshot();
    this.pending = this.check({ force, retryAccount });
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }
  async check({ force, retryAccount }) {
    const definitions = {
      github: ['gh', ['api', 'user', '--jq', '.login']],
      claude: ['claude', ['auth', 'status']],
      git: ['git', ['--version']],
    };
    let probePromise;
    await Promise.all(
      Object.entries(definitions).map(async ([provider, [command, args]]) => {
        const previous = this.entries[provider];
        const reported = this.reported[provider];
        const due = previous?.nextCheckAt || reported?.nextCheckAt;
        // Force checks may inspect account repairs, but cannot bypass a provider's explicit retry window.
        if (
          due &&
          Date.parse(due) > this.clock() &&
          (!force ||
            reported?.issue.kind === 'rate_limit' ||
            reported?.issue.retryAfterMs > 0 ||
            previous?.issue?.kind === 'rate_limit')
        )
          return;
        const revision = this.revisions[provider] || 0;
        let entry;
        try {
          let output = await this.command(command, args, {
            timeout: 15000,
            env: provider === 'claude' ? this.env() : {},
            signal: this.controller.signal,
          });
          if (provider === 'claude') {
            let auth;
            try {
              auth = JSON.parse(output);
            } catch {
              throw new Error('Unrecognized Claude authentication status. Update Claude Code.');
            }
            if (!auth.loggedIn) throw new Error('Claude is not logged in.');
            output = [auth.email, auth.authMethod].filter(Boolean).join(' · ') || 'Claude account';
          }
          // Claude auth status is local metadata, not proof that an API credential or balance was repaired.
          if (
            reported?.origin === 'operation' &&
            reported.issue.actionRequired &&
            !retryAccount &&
            !(provider === 'github' && reported.issue.kind === 'authentication')
          ) {
            entry = {
              ok: false,
              output,
              error: reported.issue.summary,
              issue: reported.issue,
              actionRequired: true,
              nextCheckAt: new Date(this.clock() + 180000).toISOString(),
              failures: previous?.failures || 1,
            };
          } else {
            entry = {
              ok: true,
              output,
              failures: 0,
              nextCheckAt: new Date(this.clock() + 180000).toISOString(),
            };
          }
        } catch (error) {
          const issue = classifyFailure(error, provider, { health: true });
          if (transportKinds.has(issue.kind)) {
            probePromise ??= this.probe();
            try {
              issue.connectivity = await probePromise;
              const reachable = Object.values(issue.connectivity).filter((p) => p.reachable).length;
              issue.diagnosis =
                reachable === 0
                  ? 'Neither service endpoint responded from this machine. Check internet, DNS, VPN and proxy; a wider outage is also possible.'
                  : 'At least one service endpoint responded. This is not evidence of a complete local internet outage; the failing service or network path may still be unavailable.';
            } catch {
              issue.diagnosis =
                'Connectivity diagnosis is unavailable; the cause is not confirmed.';
            }
          }
          const failures = (previous?.failures || 0) + 1;
          entry = {
            ok: false,
            error: issue.summary,
            issue,
            actionRequired: issue.actionRequired,
            failures,
            nextCheckAt: new Date(
              this.clock() + retryDelay(issue, failures, this.random),
            ).toISOString(),
          };
        }
        if (this.closed || revision !== (this.revisions[provider] || 0)) return;
        this.entries[provider] = {
          ...entry,
          checking: false,
          checkedAt: new Date(this.clock()).toISOString(),
        };
        if (entry.ok) {
          delete this.reported[provider];
          if (previous && !previous.ok)
            this.event(
              'success',
              `${names[provider]} connection checks passed. Waiting reviews can continue unless manually paused.`,
            );
        } else {
          this.reported[provider] =
            reported?.origin === 'operation' && reported.issue.actionRequired
              ? { ...reported, nextCheckAt: entry.nextCheckAt, failures: entry.failures }
              : {
                  issue: entry.issue,
                  nextCheckAt: entry.nextCheckAt,
                  failures: entry.failures,
                  origin: 'health',
                };
          if (previous?.issue?.kind !== entry.issue.kind)
            this.event('warning', `${entry.issue.summary} Connection checks retry automatically.`);
        }
      }),
    );
    if (!this.closed) {
      this.checkedAt = new Date(this.clock()).toISOString();
      this.persist(this.reported);
      this.notify();
    }
    return this.snapshot();
  }
  close() {
    this.closed = true;
    this.controller.abort();
  }
}
