import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '').replace(/\r(?!\n)/g, '\n');
}

export function findOnPath(command: string, pathEnv = process.env.PATH ?? ''): string | undefined {
  if (isAbsolute(command)) {
    try {
      accessSync(command, constants.X_OK);
      return command;
    } catch {
      return undefined;
    }
  }
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

export async function probeBinary(
  command: string,
  versionArgs: string[] = ['--version'],
): Promise<{ installed: boolean; version?: string; binaryPath?: string }> {
  const binaryPath = findOnPath(command);
  if (!binaryPath) return { installed: false };
  const version = await new Promise<string | undefined>((resolve) => {
    execFile(binaryPath, versionArgs, { timeout: 5000 }, (err, stdout) => {
      resolve(err ? undefined : String(stdout).trim().split('\n')[0]);
    });
  });
  return { installed: true, version, binaryPath };
}

export const RATE_LIMIT_RE = /(rate[ -]?limit|usage limit|quota exceeded|too many requests|\b429\b)/i;

/** "try again in 30 seconds" / "retry after 2 minutes" -> seconds */
export function parseRetryAfter(text: string): number | undefined {
  const m = /(?:try again|retry|resets?)(?:\s+\w+)?\s+(?:in|after)\s+(\d+)\s*(second|sec|s|minute|min|m|hour|hr|h)/i.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? 's').toLowerCase();
  if (unit.startsWith('h')) return n * 3600;
  if (unit.startsWith('m')) return n * 60;
  return n;
}

export function tryParseJson(line: string): Record<string, unknown> | undefined {
  const t = line.trim();
  if (!t.startsWith('{')) return undefined;
  try {
    const v = JSON.parse(t);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Rate-limit detection for JSONL agents. Agent *content* (assistant text, tool output) is never scanned,
 * because code under discussion often mentions "429" or "rate limit"; only error events and non-JSON
 * (stderr-style) lines count.
 */
export function detectRateLimitInJsonl(
  raw: string,
  isErrorEvent: (obj: Record<string, unknown>) => boolean,
): { isRateLimited: boolean; retryAfterSeconds?: number } {
  for (const line of raw.split('\n')) {
    const obj = tryParseJson(line);
    const text = obj ? (isErrorEvent(obj) ? JSON.stringify(obj) : '') : line;
    if (text && RATE_LIMIT_RE.test(text)) return { isRateLimited: true, retryAfterSeconds: parseRetryAfter(text) };
  }
  return { isRateLimited: false };
}
