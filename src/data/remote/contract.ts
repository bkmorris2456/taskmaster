// Phase 6 wire contract only. There is no network client or reconciliation here.
import type { LocalCommand, EntityRead } from '../local/database';
import type { Task, CompletionEvent } from '../../domain/task';
import type { Category, Group } from '../../domain/organization';
import type {
  RecurrenceSeries,
  RecurringCompletion,
} from '../../domain/recurrence';

type ServerMetadata = {
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  lastOperationId: string;
};
type Canonical<T> = Omit<
  T,
  'revision' | 'localRevision' | 'timestampsProvisional'
> &
  ServerMetadata;
export type CloudTask = Canonical<Task>;
export type CloudCategory = Canonical<Category>;
export type CloudGroup = Canonical<Group>;
export type CloudSeries = Canonical<RecurrenceSeries>;
export type CloudEntity = CloudTask | CloudCategory | CloudGroup | CloudSeries;
export interface CloudRead extends Omit<EntityRead, 'revision'> {
  revision: number;
}
// Legacy and v2 local envelopes are accepted by the server, with referenced server
// revisions/dependencies frozen before sending. Projections never authorize writes.
export type CloudCommand = LocalCommand;
export type CloudEvent =
  | (Omit<Extract<CompletionEvent, { kind: 'completion' }>, 'recurrence'> & {
      recurrence: RecurringCompletion | null;
    })
  | Extract<CompletionEvent, { kind: 'reversal' }>;
export interface CloudChange {
  sequence: number;
  kind: 'task' | 'category' | 'group' | 'series' | 'event';
  id: string;
  state: CloudEntity | CloudEvent;
  operationId?: string;
}
// Omitted cursor starts at zero; explicit null is rejected. Preserve watermark
// unchanged across subsequent pages; null/omitted watermark captures a fresh bound.
export interface PullChangesArguments {
  cursor?: number;
  watermark?: number | null;
  page_size?: number;
}
export interface CloudPage {
  protocolVersion: 1;
  cursor: number;
  watermark: number;
  hasMore: boolean;
  changes: CloudChange[];
}
export type CloudResult =
  | {
      status: 'applied';
      operationId: string;
      watermark: number;
      changes: CloudChange[];
    }
  | {
      status: 'conflict';
      code: 'revision_conflict' | 'already_completed';
      watermark?: number;
      changes?: CloudChange[];
      operationId?: string;
      authoritative: { kind: string; id: string; state: CloudEntity | null }[];
      canonicalEvent?: CloudEvent;
      timestampDisagrees?: boolean;
      submittedOccurredAt?: string;
    }
  | {
      status: 'validation';
      code: 'invalid_command' | 'operation_id_reused';
      operationId?: string;
      sqlstate?: string;
      message?: string;
    };
