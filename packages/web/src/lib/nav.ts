export type View =
  | { kind: 'overview' }
  | { kind: 'chat'; chatId?: string }
  | { kind: 'approvals' }
  | { kind: 'tasks' }
  | { kind: 'task'; id: string };

export type Nav = (v: View) => void;
