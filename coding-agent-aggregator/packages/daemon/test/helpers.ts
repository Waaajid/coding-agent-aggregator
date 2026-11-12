import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function sh(cwd: string, cmd: string, ...args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
}

export function makeTempDir(prefix = 'agg-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Throwaway git repo on `main` with one commit containing a.txt, b.txt. */
export function makeRepo(): string {
  const dir = makeTempDir('agg-repo-');
  sh(dir, 'git', 'init', '-q', '-b', 'main');
  sh(dir, 'git', 'config', 'user.name', 'Test');
  sh(dir, 'git', 'config', 'user.email', 'test@example.com');
  sh(dir, 'git', 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a1\na2\na3\n');
  writeFileSync(join(dir, 'b.txt'), 'b1\nb2\nb3\n');
  sh(dir, 'git', 'add', '-A');
  sh(dir, 'git', 'commit', '-q', '-m', 'init');
  return dir;
}

export function cleanup(...dirs: string[]): void {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

export { mkdirSync, readFileSync, writeFileSync, existsSync, lstatSync };
