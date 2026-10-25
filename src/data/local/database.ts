import type { RecurrenceSeries } from '../../domain/recurrence';
import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { Task, CompletionEvent, TaskInput } from '../../domain/task';
import { TaskError } from '../../domain/task';
import type {
  Category,
  Group,
  OrganizationKind,
} from '../../domain/organization';

export type CommandPayload =
  | { kind: 'create'; input: TaskInput }
  | { kind: 'edit'; input: TaskInput }
  | { kind: 'complete'; event: CompletionEvent }
  | { kind: 'reopen'; event: CompletionEvent }
  | { kind: 'reopen-standalone'; event: CompletionEvent }
  | { kind: 'delete' }
  | { kind: 'restore' };

export interface TaskCommandV1 {
  id: string;
  protocolVersion: 1;
  ownerId: string;
  deviceId: string;
  taskId: string;
  createdAt: string;
  sequence: number;
  dependsOn: string | null;
  expectedRevision: number | null;
  base: Task | null;
  result: Task;
  payload: CommandPayload;
  status: 'pending';
}

export type EntityRecord = Task | Category | Group | RecurrenceSeries;
export interface EntityRead {
  kind: 'task' | 'series' | OrganizationKind;
  id: string;
  revision: number | null;
  localRevision: number;
  lastOperationId: string;
}
export interface EntityChange {
  kind: 'task' | 'series' | OrganizationKind;
  base: EntityRecord | null;
  result: EntityRecord;
}
export interface OrganizationPayload {
  kind: 'organization';
  entityKind: OrganizationKind;
  action: 'create' | 'rename' | 'delete';
  entityId: string;
  name: string | null;
  categoryId: string | null;
}
export interface LocalCommandV2 {
  id: string;
  protocolVersion: 2;
  ownerId: string;
  deviceId: string;
  taskId: string | null;
  createdAt: string;
  sequence: number;
  dependsOn: string | null;
  expectedRevision: number | null;
  base: EntityRecord | null;
  result: EntityRecord;
  payload: CommandPayload | OrganizationPayload;
  status: 'pending';
  dependencies: string[];
  reads: EntityRead[];
  changes: EntityChange[];
}
export type LocalCommand = TaskCommandV1 | LocalCommandV2;

export interface WorkspaceMeta {
  key: 'workspace';
  ownerId: string;
  deviceId: string;
  sequence: number;
}

// Schema v1 is append-only history + projection + durable intent. No destructive
// populate/reset logic. Add future versions and transactional upgrade() functions.
export const schemaV1 = {
  tasks: 'id, ownerId, createdAt',
  canonicalTasks: 'id, ownerId',
  completionEvents: 'id, taskId, ownerId',
  outbox: 'id, &sequence, taskId',
  meta: 'key',
};

export const schemaV2 = {
  tasks: 'id, ownerId, createdAt, categoryId, groupId, dueDate',
  categories: 'id, ownerId',
  groups: 'id, ownerId, categoryId',
  canonicalCategories: 'id, ownerId',
  canonicalGroups: 'id, ownerId, categoryId',
};

export const schemaV3 = {
  recurrenceSeries: 'id, ownerId, activeTaskId',
  canonicalSeries: 'id, ownerId',
  tasks: 'id, ownerId, createdAt, categoryId, groupId, dueDate, seriesId',
};

export class TaskDatabase extends Dexie {
  readonly recurrenceSeries: Table<RecurrenceSeries, string>;
  readonly canonicalSeries: Table<RecurrenceSeries, string>;
  readonly tasks: Table<Task, string>;
  readonly canonicalTasks: Table<Task, string>;
  readonly completionEvents: Table<CompletionEvent, string>;
  readonly outbox: Table<LocalCommand, string>;
  readonly meta: Table<WorkspaceMeta, 'workspace'>;
  readonly categories: Table<Category, string>;
  readonly groups: Table<Group, string>;
  readonly canonicalCategories: Table<Category, string>;
  readonly canonicalGroups: Table<Group, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores(schemaV1);
    // Add stores/indexes only: existing rows, events and v1 commands are untouched.
    this.version(2).stores(schemaV2);
    this.version(3).stores(schemaV3);
    this.on('ready', () => {
      // Dexie encodes a logical schema version as native IDB version * 10.
      // It can otherwise open a newer additive schema in compatibility mode.
      if (this.backendDB().version > 30)
        throw new TaskError(
          'This database needs a newer Taskmaster version. No data was changed.',
        );
    });
    this.recurrenceSeries = this.table('recurrenceSeries');
    this.canonicalSeries = this.table('canonicalSeries');
    this.tasks = this.table('tasks');
    this.canonicalTasks = this.table('canonicalTasks');
    this.completionEvents = this.table('completionEvents');
    this.outbox = this.table('outbox');
    this.meta = this.table('meta');
    this.categories = this.table('categories');
    this.groups = this.table('groups');
    this.canonicalCategories = this.table('canonicalCategories');
    this.canonicalGroups = this.table('canonicalGroups');
  }
}
