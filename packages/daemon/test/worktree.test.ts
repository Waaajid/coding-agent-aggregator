import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RepoPathError, WorktreeManager } from '../src/git/WorktreeManager.js';
import { cleanup, existsSync, lstatSync, makeRepo, makeTempDir, readFileSync, sh, writeFileSync, mkdirSync } from './helpers.js';
import { join } from 'node:path';

describe('WorktreeManager', () => {
  let repo: string;
  const wm = new WorktreeManager();

  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => cleanup(repo));

  it('creates an isolated worktree on agent/<agent>/<task>, keeps git status clean, copies .env files', async () => {
    writeFileSync(join(repo, '.env'), 'SECRET=1\n');
    writeFileSync(join(repo, '.env.local'), 'LOCAL=1\n');
    const { worktreePath, branch } = await wm.createWorktree(repo, 'main', 'codex', 'tsk_1');

    expect(branch).toBe('agent/codex/tsk_1');
    expect(worktreePath).toBe(join(repo, '.aggregator', 'worktrees', 'tsk_1'));
    expect(sh(worktreePath, 'git', 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(branch);
    expect(readFileSync(join(worktreePath, '.env'), 'utf8')).toBe('SECRET=1\n');
    expect(readFileSync(join(worktreePath, '.env.local'), 'utf8')).toBe('LOCAL=1\n');
    // .aggregator/ is excluded, and the untracked .env files are the only noise in the root repo
    expect(sh(repo, 'git', 'status', '--porcelain')).not.toContain('.aggregator');
  });

  it('copies configured files, symlinks configured paths, and ignores paths escaping the repo', async () => {
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), '1');
    writeFileSync(join(repo, 'local.json'), '{}');
    writeFileSync(
      join(repo, '.aggregator.json'),
      JSON.stringify({ copy: ['local.json', '../outside', '/etc/hosts'], symlink: ['node_modules', '../escape'] }),
    );
    const { worktreePath } = await wm.createWorktree(repo, 'main', 'claude', 'tsk_2');

    expect(existsSync(join(worktreePath, 'local.json'))).toBe(true);
    expect(lstatSync(join(worktreePath, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(worktreePath, 'escape'))).toBe(false);
    expect(existsSync(join(worktreePath, 'hosts'))).toBe(false);
  });

  it('getDiff includes committed, modified and brand-new files with stats', async () => {
    const { worktreePath } = await wm.createWorktree(repo, 'main', 'codex', 'tsk_3');
    writeFileSync(join(worktreePath, 'a.txt'), 'a1\nCHANGED\na3\n');
    writeFileSync(join(worktreePath, 'new.txt'), 'hello\nworld\n');

    const { diff, files } = await wm.getDiff(worktreePath, 'main');
    expect(diff).toContain('+CHANGED');
    expect(diff).toContain('+++ b/new.txt');
    expect(files.map((f) => f.path).sort()).toEqual(['a.txt', 'new.txt']);
    expect(files.find((f) => f.path === 'new.txt')).toMatchObject({ added: 2, deleted: 0 });

    await wm.commitAll(worktreePath, 'work');
    const after = await wm.getDiff(worktreePath, 'main');
    expect(after.files).toHaveLength(2);
    expect((await wm.getDiff(worktreePath, 'main', 'new.txt')).files).toHaveLength(1);
  });

  it('commitAll reports false when there is nothing to commit', async () => {
    const { worktreePath } = await wm.createWorktree(repo, 'main', 'codex', 'tsk_4');
    expect(await wm.commitAll(worktreePath, 'noop')).toBe(false);
  });

  it('runs two concurrent worktrees in isolation and merges both cleanly into main (squash)', async () => {
    const [w1, w2] = await Promise.all([
      wm.createWorktree(repo, 'main', 'codex', 'tsk_a'),
      wm.createWorktree(repo, 'main', 'claude', 'tsk_b'),
    ]);
    writeFileSync(join(w1.worktreePath, 'a.txt'), 'a1\nFROM_A\na3\n');
    writeFileSync(join(w2.worktreePath, 'b.txt'), 'b1\nFROM_B\nb3\n');
    writeFileSync(join(w2.worktreePath, 'extra.txt'), 'extra\n');

    // isolation: each worktree only sees its own edits
    expect(readFileSync(join(w1.worktreePath, 'b.txt'), 'utf8')).not.toContain('FROM_B');
    expect(readFileSync(join(w2.worktreePath, 'a.txt'), 'utf8')).not.toContain('FROM_A');

    const [m1, m2] = await Promise.all([
      wm.mergeWorktree(repo, w1.worktreePath, w1.branch, 'main', true, 'merge A'),
      wm.mergeWorktree(repo, w2.worktreePath, w2.branch, 'main', true, 'merge B'),
    ]);
    expect(m1.status).toBe('merged');
    expect(m2.status).toBe('merged');

    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toContain('FROM_A');
    expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toContain('FROM_B');
    expect(readFileSync(join(repo, 'extra.txt'), 'utf8')).toBe('extra\n');
    expect(sh(repo, 'git', 'status', '--porcelain').trim()).toBe('');
    // squash => linear history, one commit per task
    expect(sh(repo, 'git', 'log', '--format=%s', 'main').trim().split('\n').sort()).toEqual(['init', 'merge A', 'merge B']);
    // cleanup: worktrees, staging dirs and branches are gone
    expect(existsSync(w1.worktreePath)).toBe(false);
    expect(existsSync(w2.worktreePath)).toBe(false);
    expect(sh(repo, 'git', 'branch', '--list', 'agent/*').trim()).toBe('');
    expect(sh(repo, 'git', 'worktree', 'list', '--porcelain')).not.toContain('.aggregator');
  });

  it('non-squash merge creates a merge commit with both parents', async () => {
    const w = await wm.createWorktree(repo, 'main', 'codex', 'tsk_c');
    writeFileSync(join(w.worktreePath, 'a.txt'), 'a1\nX\na3\n');
    // main moves on so a true merge commit is required
    writeFileSync(join(repo, 'b.txt'), 'b1\nMAIN\nb3\n');
    sh(repo, 'git', 'commit', '-qam', 'main moves');

    const res = await wm.mergeWorktree(repo, w.worktreePath, w.branch, 'main', false, 'no-ff merge');
    expect(res.status).toBe('merged');
    expect(sh(repo, 'git', 'rev-list', '--parents', '-n', '1', 'main').trim().split(' ')).toHaveLength(3);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toContain('X');
    expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toContain('MAIN');
  });

  it('reports conflicts, leaves main untouched, and keeps the worker branch for resolution', async () => {
    const w = await wm.createWorktree(repo, 'main', 'codex', 'tsk_d');
    writeFileSync(join(w.worktreePath, 'a.txt'), 'a1\nWORKER\na3\n');
    writeFileSync(join(repo, 'a.txt'), 'a1\nMAIN\na3\n');
    sh(repo, 'git', 'commit', '-qam', 'main edits a');
    const mainBefore = sh(repo, 'git', 'rev-parse', 'main').trim();

    const res = await wm.mergeWorktree(repo, w.worktreePath, w.branch, 'main', true);
    expect(res).toEqual({ status: 'conflict', conflictedFiles: ['a.txt'] });
    expect(sh(repo, 'git', 'rev-parse', 'main').trim()).toBe(mainBefore);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('a1\nMAIN\na3\n');
    expect(existsSync(w.worktreePath)).toBe(true);
    expect(sh(repo, 'git', 'branch', '--list', w.branch).trim()).not.toBe('');
    expect(existsSync(join(repo, '.aggregator', 'staging')) ? sh(repo, 'git', 'worktree', 'list') : '').not.toContain('staging');
  });

  it('merging into a branch that is not checked out advances it without touching the working tree', async () => {
    sh(repo, 'git', 'branch', 'develop');
    const w = await wm.createWorktree(repo, 'develop', 'codex', 'tsk_e');
    writeFileSync(join(w.worktreePath, 'dev.txt'), 'dev\n');

    const res = await wm.mergeWorktree(repo, w.worktreePath, w.branch, 'develop', true, 'to develop');
    expect(res.status).toBe('merged');
    expect(sh(repo, 'git', 'show', 'develop:dev.txt')).toBe('dev\n');
    expect(existsSync(join(repo, 'dev.txt'))).toBe(false); // main checkout unchanged
  });

  it('refuses (target_dirty) when uncommitted local changes would be overwritten, without losing them', async () => {
    const w = await wm.createWorktree(repo, 'main', 'codex', 'tsk_f');
    writeFileSync(join(w.worktreePath, 'a.txt'), 'a1\nWORKER\na3\n');
    writeFileSync(join(repo, 'a.txt'), 'a1\nUSER_WIP\na3\n'); // uncommitted edit on checked-out main

    const res = await wm.mergeWorktree(repo, w.worktreePath, w.branch, 'main', true);
    expect(res.status).toBe('target_dirty');
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('a1\nUSER_WIP\na3\n');
    expect(existsSync(w.worktreePath)).toBe(true);
  });

  it('merging a worktree with no changes is a no-op success', async () => {
    const w = await wm.createWorktree(repo, 'main', 'codex', 'tsk_g');
    const before = sh(repo, 'git', 'rev-parse', 'main').trim();
    const res = await wm.mergeWorktree(repo, w.worktreePath, w.branch, 'main', true);
    expect(res).toEqual({ status: 'merged', commit: before });
  });
});

describe('resolveRepoRoot (what users paste into the UI)', () => {
  const wm = new WorktreeManager();
  const dirs: string[] = [];
  afterEach(() => cleanup(...dirs.splice(0)));

  it('accepts a subfolder of a repo and returns the repo root; tolerates surrounding spaces', async () => {
    const repo = makeRepo();
    dirs.push(repo);
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    expect(await wm.resolveRepoRoot(`  ${join(repo, 'src', 'deep')}  `)).toBe(repo);
    expect(await wm.currentBranch(repo)).toBe('main');
  });

  it('explains, in plain words, what is wrong with a folder that is not usable', async () => {
    const plain = makeTempDir('agg-plain-');
    const empty = makeTempDir('agg-empty-');
    dirs.push(plain, empty);
    sh(empty, 'git', 'init', '-q', '-b', 'main');

    const notGit = await wm.resolveRepoRoot(plain).catch((e) => e);
    expect(notGit).toBeInstanceOf(RepoPathError);
    expect(notGit.message).toMatch(/is not a git repository/);
    expect(notGit.message).toContain('git init');

    expect((await wm.resolveRepoRoot(join(plain, 'nope')).catch((e) => e)).message).toMatch(/folder doesn't exist/);
    expect((await wm.resolveRepoRoot('my-project').catch((e) => e)).message).toMatch(/not a full path/);
    expect((await wm.resolveRepoRoot(empty).catch((e) => e)).message).toMatch(/no commits yet/);
  });
});
