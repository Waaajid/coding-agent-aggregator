import { execFile } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, realpath, symlink, stat, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { MergeResult } from '@aggregator/shared';

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface DiffResult {
  diff: string;
  files: Array<{ path: string; added: number; deleted: number }>;
  mergeBase: string;
}

export interface RepoConfig {
  /** Extra repo-relative files to copy into each worktree (in addition to `.env*`). */
  copy?: string[];
  /** Repo-relative paths to symlink into each worktree (e.g. `node_modules`). */
  symlink?: string[];
}

/** A repo path the user typed that can't be used; the message is written for end users. */
export class RepoPathError extends Error {}

export class GitError extends Error {
  constructor(message: string, readonly result?: GitResult) {
    super(message);
  }
}

export function git(cwd: string, args: string[], opts: { allowFail?: boolean; input?: string } = {}): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
      (err, stdout, stderr) => {
        const rawCode = err ? (err as { code?: unknown }).code : 0;
        const result: GitResult = { stdout: String(stdout), stderr: String(stderr), code: typeof rawCode === 'number' ? rawCode : 1 };
        if (err && !opts.allowFail) {
          reject(new GitError(`git ${args.join(' ')} failed: ${result.stderr.trim() || err.message}`, result));
        } else {
          resolvePromise(result);
        }
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

export class WorktreeManager {
  private readonly mergeLocks = new Map<string, Promise<unknown>>();

  /**
   * Resolve to the canonical repo root (a subfolder of a repo resolves to the repo's top folder).
   * Throws a RepoPathError with a message that is safe to show to the user.
   */
  async resolveRepoRoot(repoPath: string): Promise<string> {
    const typed = repoPath.trim();
    const expanded = typed === '~' || typed.startsWith('~/') ? join(homedir(), typed.slice(1)) : typed;
    let real: string;
    try {
      real = await realpath(expanded);
    } catch {
      throw new RepoPathError(
        isAbsolute(expanded)
          ? `That folder doesn't exist: ${expanded}`
          : `"${typed}" is not a full path. Paste the absolute path, e.g. /Users/you/projects/my-app (run "pwd" inside your project to get it).`,
      );
    }
    const top = await git(real, ['rev-parse', '--show-toplevel'], { allowFail: true });
    if (top.code !== 0) {
      throw new RepoPathError(
        `"${real}" is not a git repository (there is no .git folder in it or above it). ` +
          `Use the folder of a project that is tracked by git, or turn this one into one: cd "${real}" && git init && git add -A && git commit -m "first commit"`,
      );
    }
    const root = await realpath(top.stdout.trim());
    const head = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true });
    if (head.code !== 0) {
      throw new RepoPathError(`The git repository at "${root}" has no commits yet. Make a first commit (git add -A && git commit -m "first commit") and try again.`);
    }
    return root;
  }

  /** Name of the branch currently checked out in the main working copy (falls back to "main"). */
  async currentBranch(repoPath: string): Promise<string> {
    const r = await git(repoPath, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true });
    return r.stdout.trim() || 'main';
  }

  async branchExists(repoPath: string, branch: string): Promise<boolean> {
    const r = await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true });
    return r.code === 0;
  }

  async createWorktree(
    repoPath: string,
    baseBranch: string,
    agentId: string,
    taskId: string,
  ): Promise<{ worktreePath: string; branch: string }> {
    await this.ensureExcluded(repoPath);
    const branch = `agent/${agentId}/${taskId}`;
    const worktreePath = join(repoPath, '.aggregator', 'worktrees', taskId);
    await mkdir(join(repoPath, '.aggregator', 'worktrees'), { recursive: true });
    await git(repoPath, ['worktree', 'add', '-b', branch, worktreePath, baseBranch]);
    await this.hydrate(repoPath, worktreePath);
    return { worktreePath, branch };
  }

  /** Keep `.aggregator/` and per-worktree agent settings out of `git status` in every worktree. */
  private async ensureExcluded(repoPath: string): Promise<void> {
    const { stdout } = await git(repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const infoDir = join(stdout.trim(), 'info');
    await mkdir(infoDir, { recursive: true });
    const excludePath = join(infoDir, 'exclude');
    const current = existsSync(excludePath) ? await readFile(excludePath, 'utf8') : '';
    const lines = new Set(current.split('\n').map((l) => l.trim()));
    const wanted = ['.aggregator/', '.claude/settings.local.json'].filter((l) => !lines.has(l));
    if (wanted.length) {
      const prefix = current.length && !current.endsWith('\n') ? '\n' : '';
      await appendFile(excludePath, `${prefix}${wanted.join('\n')}\n`);
    }
  }

  private async readRepoConfig(repoPath: string): Promise<RepoConfig> {
    try {
      return JSON.parse(await readFile(join(repoPath, '.aggregator.json'), 'utf8')) as RepoConfig;
    } catch {
      return {};
    }
  }

  /** Repo-relative path that stays inside the repo; returns null for anything that escapes it. */
  private safeRelative(rel: string): string | null {
    if (isAbsolute(rel)) return null;
    const n = normalize(rel);
    if (n === '..' || n.startsWith(`..${sep}`) || n === '.') return null;
    return n;
  }

  private async hydrate(repoPath: string, worktreePath: string): Promise<void> {
    const config = await this.readRepoConfig(repoPath);
    const envFiles = (await readdir(repoPath)).filter((f) => f === '.env' || f.startsWith('.env.'));
    const toCopy = [...envFiles, ...(config.copy ?? [])];
    for (const rel of toCopy) {
      const safe = this.safeRelative(rel);
      if (!safe) continue;
      const src = join(repoPath, safe);
      const dest = join(worktreePath, safe);
      if (!existsSync(src) || existsSync(dest)) continue;
      if (!(await stat(src)).isFile()) continue;
      await mkdir(resolve(dest, '..'), { recursive: true });
      await copyFile(src, dest);
    }
    for (const rel of config.symlink ?? []) {
      const safe = this.safeRelative(rel);
      if (!safe) continue;
      const src = join(repoPath, safe);
      const dest = join(worktreePath, safe);
      if (!existsSync(src) || existsSync(dest)) continue;
      await mkdir(resolve(dest, '..'), { recursive: true });
      await symlink(src, dest);
    }
  }

  /** Unified diff of everything in the worktree (committed or not, new files included) vs the base branch. */
  async getDiff(worktreePath: string, baseBranch: string, fileFilter?: string): Promise<DiffResult> {
    await git(worktreePath, ['add', '-N', '.']);
    const mergeBase = (await git(worktreePath, ['merge-base', 'HEAD', baseBranch])).stdout.trim();
    const pathspec = fileFilter ? ['--', fileFilter] : [];
    const diff = (await git(worktreePath, ['diff', mergeBase, ...pathspec])).stdout;
    const numstat = (await git(worktreePath, ['diff', '--numstat', mergeBase, ...pathspec])).stdout;
    const files = numstat
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [a = '0', d = '0', ...rest] = line.split('\t');
        return { path: rest.join('\t'), added: a === '-' ? 0 : Number(a), deleted: d === '-' ? 0 : Number(d) };
      });
    return { diff, files, mergeBase };
  }

  /** Commit everything in the worktree onto its branch. Returns false when there was nothing to commit. */
  async commitAll(worktreePath: string, message: string): Promise<boolean> {
    await git(worktreePath, ['add', '-A']);
    const status = await git(worktreePath, ['status', '--porcelain']);
    if (!status.stdout.trim()) return false;
    await this.commit(worktreePath, message);
    return true;
  }

  private async commit(cwd: string, message: string): Promise<void> {
    const args = ['-c', 'commit.gpgsign=false'];
    const name = await git(cwd, ['config', 'user.name'], { allowFail: true });
    if (!name.stdout.trim()) args.push('-c', 'user.name=Aggregator', '-c', 'user.email=aggregator@localhost');
    await git(cwd, [...args, 'commit', '--no-verify', '-m', message]);
  }

  async removeWorktree(repoPath: string, worktreePath: string, branch?: string): Promise<void> {
    await git(repoPath, ['worktree', 'remove', '--force', worktreePath], { allowFail: true });
    await git(repoPath, ['worktree', 'prune'], { allowFail: true });
    if (branch) await git(repoPath, ['branch', '-D', branch], { allowFail: true });
  }

  async prune(repoPath: string): Promise<void> {
    await git(repoPath, ['worktree', 'prune'], { allowFail: true });
  }

  /**
   * Conflict-safe merge: the merge is attempted in a throwaway detached worktree at the target tip, so the
   * user's checked-out branch is only touched (fast-forward) once the merge is known to be clean.
   */
  mergeWorktree(
    repoPath: string,
    worktreePath: string,
    branchName: string,
    targetBranch: string,
    squash: boolean,
    commitMessage?: string,
  ): Promise<MergeResult> {
    const previous = this.mergeLocks.get(repoPath) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.doMerge(repoPath, worktreePath, branchName, targetBranch, squash, commitMessage));
    this.mergeLocks.set(repoPath, run);
    return run;
  }

  private async doMerge(
    repoPath: string,
    worktreePath: string,
    branchName: string,
    targetBranch: string,
    squash: boolean,
    commitMessage?: string,
  ): Promise<MergeResult> {
    await this.commitAll(worktreePath, `agent: ${branchName}`);
    const targetRef = `refs/heads/${targetBranch}`;
    const targetSha = (await git(repoPath, ['rev-parse', '--verify', targetRef])).stdout.trim();

    const staging = join(repoPath, '.aggregator', 'staging', `mrg_${randomBytes(6).toString('hex')}`);
    await mkdir(join(repoPath, '.aggregator', 'staging'), { recursive: true });
    await git(repoPath, ['worktree', 'add', '--detach', staging, targetSha]);

    try {
      const mergeArgs = squash ? ['merge', '--squash', branchName] : ['merge', '--no-commit', '--no-ff', branchName];
      const merge = await git(staging, mergeArgs, { allowFail: true });
      if (merge.code !== 0) {
        const conflicted = (await git(staging, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
        if (!conflicted.length) throw new GitError(`merge failed: ${merge.stderr.trim() || merge.stdout.trim()}`, merge);
        return { status: 'conflict', conflictedFiles: conflicted };
      }

      const mergeHeadPath = (await git(staging, ['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD'])).stdout.trim();
      const mergeInProgress = existsSync(mergeHeadPath);
      const staged = await git(staging, ['diff', '--cached', '--quiet'], { allowFail: true });
      if (staged.code === 0 && !mergeInProgress) return { status: 'merged', commit: targetSha };

      await this.commit(staging, commitMessage ?? `Merge ${branchName}`);
      const newSha = (await git(staging, ['rev-parse', 'HEAD'])).stdout.trim();

      const head = await git(repoPath, ['symbolic-ref', '-q', 'HEAD'], { allowFail: true });
      if (head.stdout.trim() === targetRef) {
        const ff = await git(repoPath, ['merge', '--ff-only', newSha], { allowFail: true });
        if (ff.code !== 0) {
          return { status: 'target_dirty', message: ff.stderr.trim() || ff.stdout.trim() };
        }
      } else {
        await git(repoPath, ['update-ref', targetRef, newSha, targetSha]);
      }

      await this.removeWorktree(repoPath, worktreePath, branchName);
      return { status: 'merged', commit: newSha };
    } finally {
      await git(repoPath, ['worktree', 'remove', '--force', staging], { allowFail: true });
      await git(repoPath, ['worktree', 'prune'], { allowFail: true });
    }
  }
}
