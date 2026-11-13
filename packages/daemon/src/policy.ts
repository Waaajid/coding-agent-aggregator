import { isAbsolute, relative, resolve } from 'node:path';
import type { ApprovalPolicy } from '@aggregator/shared';

export type ToolClass = 'read' | 'edit' | 'shell' | 'other';
export type PolicyDecision = 'allow' | 'ask';

const EDIT_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit', 'apply_patch', 'str_replace_editor']);
const SHELL_TOOLS = new Set(['bash', 'shell', 'exec', 'run_command']);
const READ_TOOLS = new Set(['read', 'glob', 'grep', 'ls', 'notebookread']);

export function classifyTool(toolName: string): ToolClass {
  const n = toolName.toLowerCase();
  if (SHELL_TOOLS.has(n)) return 'shell';
  if (EDIT_TOOLS.has(n)) return 'edit';
  if (READ_TOOLS.has(n)) return 'read';
  return 'other';
}

// Single, side-effect-free commands. Anything with shell metacharacters never matches.
const SAFE_COMMANDS: RegExp[] = [
  /^(ls|pwd|whoami|date|echo|cat|head|tail|wc|which|true)(\s+[\w./@:=,+-]+)*$/,
  /^git\s+(status|diff|log|show|branch|rev-parse|ls-files)(\s+[\w./@:=,^~%-]+)*$/,
  /^(npm|pnpm|yarn)\s+(test|run\s+(test|lint|typecheck|build))(\s+[\w./@:=-]+)*$/,
  /^(tsc|vitest|jest|pytest|eslint)(\s+[\w./@:=-]+)*$/,
];
const SHELL_META = /[;&|<>`$()\n\r\\]/;

export function isSafeShellCommand(command: string): boolean {
  const c = command.trim();
  if (!c || SHELL_META.test(c)) return false;
  // Safe commands only ever touch worktree-relative paths.
  if (c.split(/\s+/).slice(1).some((a) => a.startsWith('/') || a.startsWith('~') || a.includes('..'))) return false;
  return SAFE_COMMANDS.some((re) => re.test(c));
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(root, target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export interface PolicyInput {
  policy: ApprovalPolicy;
  toolName: string;
  worktreePath: string;
  command?: string;
  filePath?: string;
}

/**
 * - ask_all:   everything except pure reads needs a human.
 * - ask_shell: edits inside the worktree are automatic; shell commands need a human.
 * - auto_edit: like ask_shell, but side-effect-free shell commands (tests, git status...) are automatic too.
 * Edits that land outside the worktree always need a human, whatever the policy.
 */
export function decidePolicy(input: PolicyInput): PolicyDecision {
  const kind = classifyTool(input.toolName);
  if (kind === 'read') return 'allow';
  if (kind === 'edit') {
    if (input.filePath && !isInside(input.worktreePath, input.filePath)) return 'ask';
    return input.policy === 'ask_all' ? 'ask' : 'allow';
  }
  if (kind === 'shell') {
    if (input.policy === 'auto_edit' && input.command && isSafeShellCommand(input.command)) return 'allow';
    return 'ask';
  }
  return 'ask';
}
