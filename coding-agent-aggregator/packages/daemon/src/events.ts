import { EventEmitter } from 'node:events';
import type { ApprovalRecord, TaskRecord } from '@aggregator/shared';
import type { ChatMessage } from './db/chats.js';

export interface BusEvents {
  'task.created': [TaskRecord];
  'task.updated': [{ taskId: string; status: string; updatedAt: number }];
  'pty.data': [{ taskId: string; chunk: string; seq: number }];
  'approval.requested': [ApprovalRecord];
  'approval.resolved': [ApprovalRecord];
  'agent.rateLimited': [{ agent: string; resetAt: number | null; fallbackSuggested: string | null }];
  'chat.message': [ChatMessage];
  'chat.status': [{ chatId: string; busy: boolean }];
}

export class Bus extends EventEmitter<BusEvents> {}
