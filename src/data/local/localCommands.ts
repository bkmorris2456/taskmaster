import type {
  EntityChange,
  EntityRead,
  CommandPayload,
  OrganizationPayload,
} from './database';
import type { TaskDatabase } from './database';
import { TaskError } from '../../domain/task';

export interface Runtime {
  uuid: () => string;
  now: () => Date;
  timeZone: () => string;
}
export const localRuntime: Runtime = {
  uuid: () => crypto.randomUUID(),
  now: () => new Date(),
  timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
};

export function mutationTime(
  clock: Runtime,
  previous: { updatedAt: string }[] = [],
) {
  const now = clock.now().getTime();
  if (!Number.isFinite(now))
    throw new TaskError('The device clock is invalid. Nothing was saved.');
  return new Date(
    Math.max(now, ...previous.map((row) => Date.parse(row.updatedAt) + 1)),
  ).toISOString();
}

// Called only inside the caller's read-write transaction. One command represents
// every affected entity; stable dependencies include unchanged parent reads.
export async function appendCommand(
  db: TaskDatabase,
  ownerId: string,
  clock: Runtime,
  operationId: string,
  time: string,
  payload: CommandPayload | OrganizationPayload,
  changes: EntityChange[],
  reads: EntityRead[],
  taskId: string | null,
) {
  let meta = await db.meta.get('workspace');
  if (meta && meta.ownerId !== ownerId)
    throw new TaskError(
      'Local workspace identity mismatch. Nothing was saved.',
    );
  meta ??= { key: 'workspace', ownerId, deviceId: clock.uuid(), sequence: 0 };
  const primary = changes[0];
  if (!primary) throw new TaskError('No changes were recorded.');
  const dependencies = [...new Set(reads.map((row) => row.lastOperationId))];
  await db.outbox.add({
    id: operationId,
    protocolVersion: 2,
    ownerId,
    deviceId: meta.deviceId,
    taskId,
    createdAt: time,
    sequence: meta.sequence + 1,
    dependsOn: primary.base?.lastOperationId ?? null,
    expectedRevision: primary.base?.revision ?? null,
    base: primary.base,
    result: primary.result,
    payload,
    status: 'pending',
    dependencies,
    reads,
    changes,
  });
  await db.meta.put({ ...meta, sequence: meta.sequence + 1 });
}

export function entityRead(
  kind: EntityRead['kind'],
  row: EntityChange['result'],
): EntityRead {
  return {
    kind,
    id: row.id,
    revision: row.revision,
    localRevision: row.localRevision,
    lastOperationId: row.lastOperationId,
  };
}
