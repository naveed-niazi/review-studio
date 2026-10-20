import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';

const active = new Map();
export async function abortAllProcesses() {
  const tasks = [...active.values()];
  for (const task of tasks) task.abort();
  await Promise.all(tasks.map((task) => task.closed));
}

export function run(
  command,
  args,
  {
    cwd,
    input,
    signal,
    timeout = 120000,
    idleTimeout = 0,
    outputFile,
    onData,
    env,
    maxBytes = 16 * 1024 * 1024,
  } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'));
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      failure,
      bytes = 0,
      killTimer,
      idleTimer;
    const kill = () => {
      try {
        process.platform === 'win32' ? child.kill('SIGTERM') : process.kill(-child.pid, 'SIGTERM');
      } catch {}
      killTimer ??= setTimeout(() => {
        try {
          process.platform === 'win32'
            ? child.kill('SIGKILL')
            : process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }, 2500);
      killTimer.unref();
    };
    const abort = () => {
      failure = new Error('Cancelled');
      kill();
    };
    let markClosed;
    const closed = new Promise((resolve) => {
      markClosed = resolve;
    });
    active.set(child, { abort, closed });
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      failure = new Error(
        `${command} timed out after ${timeout < 60000 ? `${Math.round(timeout / 1000)} seconds` : `${Math.round(timeout / 60000)} minutes`}`,
      );
      kill();
    }, timeout);
    timer.unref();
    const resetIdle = () => {
      if (!idleTimeout || failure) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        failure = new Error(
          `${command} produced no output for ${idleTimeout < 60000 ? `${Math.round(idleTimeout / 1000)} seconds` : `${Math.round(idleTimeout / 60000)} minutes`}. Retrying a stalled process.`,
        );
        failure.code = 'REVIEW_STALLED';
        kill();
      }, idleTimeout);
      idleTimer.unref();
    };
    resetIdle();
    const sink = outputFile ? createWriteStream(outputFile, { mode: 0o600, flags: 'wx' }) : null;
    const saved = sink
      ? finished(sink).catch((error) => {
          failure ||= error;
          kill();
        })
      : null;
    if (sink) child.stdout.pipe(sink);
    const receive = (chunk, stream) => {
      resetIdle();
      bytes += chunk.length;
      if (bytes > maxBytes) {
        failure = new Error(`${command} output exceeded ${Math.round(maxBytes / 1024 / 1024)} MB`);
        if (sink) {
          child.stdout.unpipe(sink);
          sink.end();
        }
        kill();
        return;
      }
      if (stream === 'stdout' && sink && !onData) return;
      const text = chunk.toString();
      if (stream === 'stdout') {
        if (!sink) stdout += text;
      } else stderr += text;
      try {
        onData?.(text, stream);
      } catch (e) {
        failure = e;
        kill();
      }
    };
    child.stdout.on('data', (c) => receive(c, 'stdout'));
    child.stderr.on('data', (c) => receive(c, 'stderr'));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('error', (e) => {
      failure = e;
    });
    child.on('close', async (code) => {
      clearTimeout(idleTimer);
      clearTimeout(timer);
      await saved;
      active.delete(child);
      markClosed();
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) {
        let detail = (stderr || stdout).trim().slice(-4000);
        if (command === 'claude') {
          for (const line of stdout.trim().split('\n').reverse()) {
            try {
              const event = JSON.parse(line);
              if (event.type === 'result' && event.is_error) {
                detail = event.result || event.errors?.join('\n') || detail;
                break;
              }
            } catch {}
          }
        }
        reject(new Error(`${command} exited ${code}: ${detail.slice(-4000)}`));
      } else resolve(stdout.trim());
    });
  });
}

export const isRepository = (value) =>
  typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(value);

export function parsePR(value) {
  const text = String(value || '').trim();
  const match =
    text.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)(?:[/?#].*)?$/) ||
    text.match(/^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/);
  if (!match || !isRepository(match[1]) || !Number.isSafeInteger(Number(match[2])))
    throw new Error('Enter a GitHub PR URL or owner/repository#123.');
  return { repo: match[1], number: Number(match[2]) };
}
export function remoteRepo(remote) {
  return String(remote)
    .trim()
    .match(
      /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/,
    )?.[1];
}
export function claudeResult(output) {
  const events = output
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const result = events.findLast((e) => e.type === 'result');
  if (!result) throw new Error('Claude exited without a result. See the review log.');
  if (result.is_error || result.subtype !== 'success')
    throw new Error(
      result.result || result.errors?.join('\n') || 'Claude did not complete the review.',
    );
  if (typeof result.result !== 'string' || !result.result.trim())
    throw new Error('Claude returned an empty review.');
  if (result.permission_denials?.length)
    throw new Error(
      'Claude could not access required tools. Review the denied operations in the log.',
    );
  return {
    text: normalizeReview(result.result),
    cost: result.total_cost_usd ?? null,
  };
}

export function normalizeReview(value) {
  const lines = value.trim().replace(/\r\n/g, '\n').split('\n');
  const verdicts = [];
  let fence = null;
  for (let index = 0; index < lines.length; index++) {
    const marker = lines[index].match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (
      !fence &&
      /^\*\*Verdict: (LGTM|BLOCKING|NON-BLOCKING|NON-BLOCKING BUT FIX)\*\*(?:[ \t]+[—–-][^\n]*)?[ \t]*$/.test(
        lines[index],
      )
    )
      verdicts.push(index);
  }
  if (verdicts.length !== 1)
    throw new Error(
      'Claude did not return one unambiguous review verdict. See Activity for its response.',
    );
  // Claude sometimes adds a title or introduction. Move the explicit verdict
  // to the top without dropping any findings or inferring a different verdict.
  const [verdict] = lines.splice(verdicts[0], 1);
  return `${verdict.trim()}\n\n${lines.join('\n').trim()}`.trim();
}
