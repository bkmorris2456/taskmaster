import { afterAll, beforeAll, expect, it } from 'vitest';
import { NativeDatabaseHarness } from './nativeHarness';
import { randomUUID } from 'node:crypto';
import {
  DatabaseHarness,
  array,
  object,
  ownerA,
  ownerB,
  quote,
  sql,
  sqlAsync,
} from './harness';
import {
  recurrenceCases,
  occurrenceIdentityCases,
} from '../fixtures/recurrence';
import { nextOccurrence, successorId } from '../../src/domain/recurrence';
import { civilDate } from '../../src/domain/dates';
import type { Frequency } from '../../src/domain/recurrence';
import type { CloudResult } from '../../src/data/remote/contract';

const db = process.env.TASKMASTER_NATIVE_SUPABASE
  ? new NativeDatabaseHarness()
  : new DatabaseHarness();
beforeAll(() => db.start());
afterAll(() => db.stop());
const applied = (result: Record<string, unknown>) =>
  expect(
    result.status,
    `SQL state: ${String(result.sqlstate)} ${String(result.message)}`,
  ).toBe('applied' satisfies CloudResult['status']);
async function create(
  title = 'Task',
  input: Record<string, unknown> = {},
  owner = ownerA,
) {
  const id = randomUUID();
  const seriesId = input.recurrence ? randomUUID() : null;
  const command = await db.command(
    { kind: 'create', input: { title, ...input } },
    id,
    { id, seriesId },
    owner,
  );
  const response = await db.apply(command, owner);
  applied(response);
  return { id, seriesId, command, response };
}
async function current(id: string, owner = ownerA) {
  const row = (await db.rows('tasks', owner)).find((row) => row.id === id);
  if (!row) throw new Error('Task missing');
  return row;
}
async function complete(id: string, instant = '2026-10-24T12:00:00.000Z') {
  const task = await current(id);
  const series = (await db.rows('recurrence_series')).find(
    (row) => row.id === task.series_id,
  );
  const operation = randomUUID();
  const event: Record<string, unknown> = {
    id: randomUUID(),
    ownerId: ownerA,
    taskId: id,
    operationId: operation,
    kind: 'completion',
    occurredAt: instant,
    timeZone: series?.time_zone ?? 'UTC',
    snapshot: {},
  };
  if (series) {
    const frequency = series.frequency;
    if (
      frequency !== 'daily' &&
      frequency !== 'weekly' &&
      frequency !== 'monthly'
    )
      throw new Error('Invalid fixture frequency');
    const config: {
      frequency: Frequency;
      anchorDate: string;
      timeZone: string;
    } = {
      frequency,
      anchorDate: String(series.anchor_date),
      timeZone: String(series.time_zone),
    };
    const day = civilDate(instant, config.timeZone);
    const due = nextOccurrence(config, String(task.occurrence_date), day);
    event.recurrence = {
      seriesId: series.id,
      occurrenceDate: task.occurrence_date,
      successorId: successorId(String(series.id), due, operation),
      successorDate: due,
      ...config,
      completionDate: day,
      scheduleRevision: series.schedule_revision,
    };
  }
  const command = await db.command({ kind: 'complete', event }, id);
  command.id = operation;
  return command;
}
async function reverse(id: string, standalone = false) {
  const task = await current(id);
  const operation = randomUUID();
  const event = {
    id: randomUUID(),
    ownerId: ownerA,
    taskId: id,
    operationId: operation,
    kind: 'reversal',
    occurredAt: '2026-10-24T13:00:00.000Z',
    timeZone: 'UTC',
    reversesEventId: task.current_completion_id,
  };
  const c = await db.command(
    { kind: standalone ? 'reopen-standalone' : 'reopen', event },
    id,
  );
  c.id = operation;
  return c;
}
async function page(
  cursor = 0,
  watermark?: number,
  page_size = 500,
  owner = ownerA,
) {
  return object(
    (
      await db.request(
        'rpc/pull_changes',
        {
          cursor,
          ...(watermark === undefined ? {} : { watermark }),
          page_size,
        },
        db.token(owner),
      )
    ).value,
  );
}

it('applies all migrations and uses non-login, non-bypass definer ownership with forced RLS', () => {
  const result = JSON.parse(
    sql(
      db.url,
      `select json_build_object('tables',(select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ('public','taskmaster_private') and c.relrowsecurity and c.relforcerowsecurity),'unsafe',(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner where n.nspname='public' and p.prosecdef and (r.rolsuper or r.rolbypassrls or r.rolcanlogin or not coalesce(p.proconfig @> array['search_path=""'],false))),'member',pg_has_role('authenticator','taskmaster_executor','MEMBER'));`,
    ),
  ) as unknown;
  expect(result).toEqual({ tables: 8, unsafe: 0, member: false });
});
it('executes actual legacy v1 create/edit commands without accepting projected field forgery', async () => {
  const id = randomUUID();
  const createCommand = {
    id: randomUUID(),
    protocolVersion: 1,
    ownerId: ownerA,
    deviceId: randomUUID(),
    taskId: id,
    expectedRevision: null,
    base: null,
    result: { id, title: 'FORGED', completed: true },
    payload: { kind: 'create', input: { title: 'Legacy', priority: 'normal' } },
  };
  applied(await db.apply(createCommand));
  let row = await current(id);
  expect(row.title).toBe('Legacy');
  expect(row.completed).toBe(false);
  expect(row.priority).toBe('normal');
  const edited = {
    ...createCommand,
    id: randomUUID(),
    expectedRevision: row.revision,
    payload: {
      kind: 'edit',
      input: { title: 'Legacy edit', description: 'description' },
    },
  };
  applied(await db.apply(edited));
  row = await current(id);
  expect(row.title).toBe('Legacy edit');
  expect(row.revision).toBe(2);
});
it('denies anonymous and AAL1 reads/RPCs on every business and protocol surface', async () => {
  await create('Protected');
  for (const table of [
    'tasks',
    'categories',
    'groups',
    'recurrence_series',
    'completion_events',
  ]) {
    expect([401, 403]).toContain(
      (await db.request(table, undefined, null)).http,
    );
    const result = await db.request(table, undefined, db.token(ownerA, 'aal1'));
    expect(result.http).toBe(200);
    expect(result.value).toEqual([]);
  }
  for (const rpc of ['pull_changes', 'get_receipt', 'apply_command']) {
    const args =
      rpc === 'get_receipt'
        ? { operation_id: randomUUID() }
        : rpc === 'apply_command'
          ? { command: { id: randomUUID() } }
          : {};
    expect([401, 403]).toContain(
      (await db.request(`rpc/${rpc}`, args, null)).http,
    );
    expect(
      (await db.request(`rpc/${rpc}`, args, db.token(ownerA, 'aal1'))).http,
    ).toBe(403);
  }
});
it('real PostgREST rejects invalid JWT signatures and unsigned tokens', async () => {
  expect(
    (
      await db.request(
        'tasks',
        undefined,
        db.token(ownerA, 'aal2', 'wrong-test-key'),
      )
    ).http,
  ).toBe(401);
  const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ role: 'authenticated', sub: ownerA, aal: 'aal2' })).toString('base64url')}.`;
  expect((await db.request('tasks', undefined, unsigned)).http).toBe(401);
});
it('isolates owners including receipts, feed pages and forged owner fields', async () => {
  const a = await create('Owner A');
  const b = await create('Owner B', {}, ownerB);
  expect((await db.rows('tasks', ownerB)).some((row) => row.id === a.id)).toBe(
    false,
  );
  expect((await db.rows('tasks')).some((row) => row.id === b.id)).toBe(false);
  expect(
    (
      await db.request(
        'rpc/get_receipt',
        { operation_id: a.command.id },
        db.token(ownerB),
      )
    ).value,
  ).toBeNull();
  expect(
    array((await page(0, undefined, 500, ownerB)).changes).every(
      (change) => object(object(change).state).ownerId === ownerB,
    ),
  ).toBe(true);
  const forged = { ...a.command, id: randomUUID(), ownerId: ownerB };
  expect(
    (await db.request('rpc/apply_command', { command: forged })).http,
  ).toBe(403);
});
it('revokes direct insert/update/delete and private/helper execution privileges', async () => {
  for (const table of [
    'tasks',
    'categories',
    'groups',
    'recurrence_series',
    'completion_events',
  ]) {
    expect(
      (
        await db.request(table, {
          owner_id: ownerA,
          id: randomUUID(),
        })
      ).http,
    ).toBe(403);
    for (const method of ['PATCH', 'DELETE']) {
      const result = await fetch(`${db.api}/${table}?owner_id=eq.${ownerA}`, {
        method,
        headers: {
          ...db.headers,
          Authorization: `Bearer ${db.token()}`,
          'Content-Type': 'application/json',
        },
        ...(method === 'PATCH'
          ? { body: JSON.stringify({ id: randomUUID() }) }
          : {}),
      });
      expect(result.status).toBe(403);
    }
  }
  expect(
    sql(
      db.url,
      `select has_schema_privilege('authenticated','taskmaster_private','USAGE') or has_function_privilege('authenticated','taskmaster_private.store(text,jsonb,uuid,timestamptz)','EXECUTE');`,
    ),
  ).toBe('f');
  const response = await fetch(`${db.api}/sync_receipts`, {
    headers: {
      ...db.headers,
      Authorization: `Bearer ${db.token()}`,
      'Accept-Profile': 'taskmaster_private',
    },
  });
  expect(response.status).toBe(406);
});
it('stores stable receipts, retries exact commands and rejects ID reuse with changed payload', async () => {
  const item = await create('Retry');
  expect(await db.apply(item.command)).toEqual(item.response);
  const changed = {
    ...item.command,
    payload: { kind: 'create', input: { title: 'different' } },
  };
  expect(await db.apply(changed)).toMatchObject({
    status: 'validation',
    code: 'operation_id_reused',
  });
  expect(
    (await db.request('rpc/get_receipt', { operation_id: item.command.id }))
      .value,
  ).toEqual(item.response);
});
it('serializes simultaneous duplicate requests so only one task and feed item are created', async () => {
  const id = randomUUID();
  const command = await db.command(
    { kind: 'create', input: { title: 'Concurrent retry' } },
    id,
    { id },
  );
  const responses = await Promise.all(
    Array.from({ length: 6 }, () => db.apply(command)),
  );
  responses.forEach((result) => expect(result).toEqual(responses[0]));
  expect((await db.rows('tasks')).filter((row) => row.id === id)).toHaveLength(
    1,
  );
  expect(
    sql(
      db.url,
      `select count(*) from taskmaster_private.sync_changes where operation_id=${quote(command.id)}::uuid;`,
    ),
  ).toBe('1');
});
it('returns authoritative state on stale revisions and retains conflict receipts', async () => {
  const item = await create('Original');
  const edit = await db.command(
    { kind: 'edit', input: { title: 'Winner' } },
    item.id,
  );
  const stale = {
    ...edit,
    id: randomUUID(),
    payload: { kind: 'edit', input: { title: 'Loser' } },
  };
  applied(await db.apply(edit));
  const result = await db.apply(stale);
  expect(result).toMatchObject({
    status: 'conflict',
    code: 'revision_conflict',
  });
  expect(JSON.stringify(result.authoritative)).toContain('Winner');
  expect(await db.apply(stale)).toEqual(result);
  expect((await current(item.id)).title).toBe('Winner');
});
it('rejects missing required read revisions and unacknowledged dependencies', async () => {
  const item = await create();
  const edit = await db.command(
    { kind: 'edit', input: { title: 'Bad' } },
    item.id,
  );
  edit.reads = [];
  expect(await db.apply(edit)).toMatchObject({ status: 'conflict' });
  const pending = await db.command(
    { kind: 'edit', input: { title: 'Bad' } },
    item.id,
  );
  pending.dependencies = [randomUUID()];
  expect(await db.apply(pending)).toMatchObject({ status: 'conflict' });
  expect((await current(item.id)).title).toBe('Task');
});
it.each([
  { kind: 'execute_sql', input: 'drop table public.tasks' },
  { kind: 'create', input: { title: '', ownerId: ownerB } },
  { kind: 'create', input: { title: '', priority: 'urgent' } },
  { kind: 'create', input: { title: 'Bad date', dueDate: '2026-02-30' } },
  { kind: 'create', input: { title: 42 } },
  {
    kind: 'create',
    input: {
      title: 'Bad recurrence',
      recurrence: {
        frequency: 'hourly',
        anchorDate: '2026-10-21',
        timeZone: 'UTC',
      },
    },
  },
])('validates malformed/unsupported payload %# atomically', async (payload) => {
  const id = randomUUID();
  const command = await db.command(payload, id, { id, seriesId: randomUUID() });
  const before = (await page()).watermark;
  expect(await db.apply(command)).toMatchObject({ status: 'validation' });
  expect((await db.rows('tasks')).some((row) => row.id === id)).toBe(false);
  expect((await page()).watermark).toBe(before);
});
it('rejects unknown protocol versions, oversized requests and arrays instead of allowing unbounded batches', async () => {
  const id = randomUUID();
  const command = await db.command(
    { kind: 'create', input: { title: 'Version' } },
    id,
    { id },
  );
  expect(await db.apply({ ...command, protocolVersion: 99 })).toMatchObject({
    status: 'validation',
  });
  expect(
    (
      await db.request('rpc/apply_command', {
        command: Array(51).fill(command),
      })
    ).http,
  ).toBe(400);
  expect(
    (
      await db.request('rpc/apply_command', {
        command: {
          ...command,
          payload: { kind: 'create', input: { title: 'x'.repeat(270000) } },
        },
      })
    ).http,
  ).toBe(400);
});
it('creates and renames categories/groups and validates same-owner task hierarchy', async () => {
  const cat = randomUUID();
  applied(
    await db.apply(
      await db.command(
        {
          kind: 'organization',
          entityKind: 'category',
          action: 'create',
          entityId: cat,
          name: 'Work',
          categoryId: null,
        },
        null,
        { id: cat },
      ),
    ),
  );
  const group = randomUUID();
  applied(
    await db.apply(
      await db.command(
        {
          kind: 'organization',
          entityKind: 'group',
          action: 'create',
          entityId: group,
          name: 'Core',
          categoryId: cat,
        },
        null,
        { id: group },
      ),
    ),
  );
  applied(
    await db.apply(
      await db.command(
        {
          kind: 'organization',
          entityKind: 'group',
          action: 'rename',
          entityId: group,
          name: 'Renamed',
          categoryId: cat,
        },
        null,
        { id: group },
      ),
    ),
  );
  const task = await create('Grouped', { groupId: group });
  expect((await current(task.id)).category_id).toBe(cat);
  const bad = await db.command(
    {
      kind: 'edit',
      input: { title: 'Invalid', categoryId: null, groupId: group },
    },
    task.id,
  );
  expect(await db.apply(bad)).toMatchObject({ status: 'validation' });
  const other = randomUUID();
  applied(
    await db.apply(
      await db.command(
        {
          kind: 'organization',
          entityKind: 'category',
          action: 'create',
          entityId: other,
          name: 'Other owner',
          categoryId: null,
        },
        null,
        { id: other },
        ownerB,
      ),
      ownerB,
    ),
  );
  expect(
    (
      await db.apply(
        await db.command(
          {
            kind: 'edit',
            input: { title: 'Cross owner', categoryId: other, groupId: null },
          },
          task.id,
        ),
      )
    ).status,
  ).toBe('conflict');
  expect(() =>
    sql(
      db.url,
      db.asOwner(
        ownerA,
        `insert into public.tasks(owner_id,id,title,category_id,last_operation_id) values(${quote(ownerA)},${quote(randomUUID())},'Invalid FK',${quote(other)},${quote(randomUUID())}); set constraints all immediate`,
        'taskmaster_executor',
      ),
    ),
  ).toThrow(/foreign key/);
});
it('preserves tasks/history through atomic group/category deletion and feed tombstones', async () => {
  const cat = randomUUID(),
    group = randomUUID();
  applied(
    await db.apply(
      await db.command(
        {
          kind: 'organization',
          entityKind: 'category',
          action: 'create',
          entityId: cat,
          name: 'Delete parent',
          categoryId: null,
        },
        null,
        { id: cat },
      ),
    ),
  );
  applied(
    await db.apply(
      await db.command(
        {
          kind: 'organization',
          entityKind: 'group',
          action: 'create',
          entityId: group,
          name: 'Delete group',
          categoryId: cat,
        },
        null,
        { id: group },
      ),
    ),
  );
  const task = await create('Preserved', { categoryId: cat, groupId: group });
  applied(await db.apply(await complete(task.id)));
  const events = await db.rows('completion_events');
  applied(
    await db.apply(
      await db.command(
        {
          kind: 'organization',
          entityKind: 'group',
          action: 'delete',
          entityId: group,
          name: null,
          categoryId: cat,
        },
        null,
        { id: group },
      ),
    ),
  );
  expect(await current(task.id)).toMatchObject({
    category_id: cat,
    group_id: null,
  });
  const deletion = await db.apply(
    await db.command(
      {
        kind: 'organization',
        entityKind: 'category',
        action: 'delete',
        entityId: cat,
        name: null,
        categoryId: null,
      },
      null,
      { id: cat },
    ),
  );
  applied(deletion);
  expect(await current(task.id)).toMatchObject({
    category_id: null,
    group_id: null,
    completed: true,
  });
  expect(await db.rows('completion_events')).toEqual(events);
  expect(
    array(deletion.changes).some(
      (value) =>
        object(value).kind === 'category' &&
        object(object(value).state).deletedAt !== null,
    ),
  ).toBe(true);
});
it('rolls back earlier cascade effects when a later required revision is missing', async () => {
  const cat = randomUUID(),
    group = randomUUID();
  applied(
    await db.apply(
      await db.command(
        {
          kind: 'organization',
          entityKind: 'category',
          action: 'create',
          entityId: cat,
          name: 'Rollback parent',
          categoryId: null,
        },
        null,
        { id: cat },
      ),
    ),
  );
  applied(
    await db.apply(
      await db.command(
        {
          kind: 'organization',
          entityKind: 'group',
          action: 'create',
          entityId: group,
          name: 'Rollback child',
          categoryId: cat,
        },
        null,
        { id: group },
      ),
    ),
  );
  const task = await create('Rollback cascade', {
    categoryId: cat,
    groupId: group,
  });
  const before = await db.rows('groups');
  const watermark = (await page()).watermark;
  const c = await db.command(
    {
      kind: 'organization',
      entityKind: 'category',
      action: 'delete',
      entityId: cat,
      name: null,
      categoryId: null,
    },
    null,
    { id: cat },
  );
  c.reads = c.reads.filter((read) => read.id !== task.id);
  expect(await db.apply(c)).toMatchObject({ status: 'conflict' });
  expect(await db.rows('groups')).toEqual(before);
  expect((await page()).watermark).toBe(watermark);
});
it('implements completion/reversal, tombstone restore and preserved history with server timestamps', async () => {
  const task = await create('History');
  applied(await db.apply(await complete(task.id)));
  applied(await db.apply(await reverse(task.id)));
  expect((await current(task.id)).completed).toBe(false);
  const events = await db.rows('completion_events');
  const deletion = await db.command({ kind: 'delete' }, task.id);
  applied(await db.apply(deletion));
  expect((await current(task.id)).deleted_at).not.toBeNull();
  applied(await db.apply(await db.command({ kind: 'restore' }, task.id)));
  expect((await current(task.id)).deleted_at).toBeNull();
  expect(await db.rows('completion_events')).toEqual(events);
  expect((await current(task.id)).revision).toBe(5);
});
it.each(recurrenceCases)(
  'PostgreSQL calendar parity: %s / %s / %s / %s',
  (frequency, anchor, occurrence, completion, next) => {
    expect(
      sql(
        db.url,
        `select taskmaster_private.next_occurrence(${quote(frequency)},${quote(anchor)}::date,${quote(occurrence)}::date,${quote(completion)}::date);`,
      ),
    ).toBe(next);
  },
);
it('matches the frozen cross-runtime UUID namespace fixture', () => {
  const fixture = occurrenceIdentityCases[1];
  expect(
    sql(
      db.url,
      `select taskmaster_private.occurrence_id(${quote(fixture[0])}::uuid,${quote(fixture[1])}::date,${quote(fixture[2])}::uuid);`,
    ),
  ).toBe(fixture[3]);
});
it('enforces one active occurrence, immutable dates, deferred graph integrity and atomic advance/undo', async () => {
  const task = await create('Recurring', {
    recurrence: {
      frequency: 'daily',
      anchorDate: '2026-10-21',
      timeZone: 'America/New_York',
    },
  });
  expect(() =>
    sql(
      db.url,
      db.asOwner(
        ownerA,
        `update public.tasks set occurrence_date=occurrence_date+1 where id=${quote(task.id)};`,
        'taskmaster_executor',
      ),
    ),
  ).toThrow(/Immutable/);
  expect(() =>
    sql(
      db.url,
      db.asOwner(
        ownerA,
        `insert into public.tasks(owner_id,id,title,series_id,occurrence_date,last_operation_id) values(${quote(ownerA)},${quote(randomUUID())},'Duplicate',${quote(task.seriesId ?? '')},'2026-10-21',${quote(randomUUID())});`,
        'taskmaster_executor',
      ),
    ),
  ).toThrow(/unique/);
  expect(() =>
    sql(
      db.url,
      db.asOwner(
        ownerA,
        `update public.tasks set deleted_at=clock_timestamp() where id=${quote(task.id)};set constraints all immediate;`,
        'taskmaster_executor',
      ),
    ),
  ).toThrow(/Invalid recurring/);
  applied(await db.apply(await complete(task.id)));
  let rows = (await db.rows('tasks')).filter(
    (row) => row.series_id === task.seriesId,
  );
  expect(rows.filter((row) => !row.completed && !row.deleted_at)).toHaveLength(
    1,
  );
  expect(rows.find((row) => !row.completed)?.due_date).toBe('2026-10-25');
  applied(await db.apply(await reverse(task.id)));
  rows = (await db.rows('tasks')).filter(
    (row) => row.series_id === task.seriesId,
  );
  expect(
    rows
      .filter((row) => !row.completed && !row.deleted_at)
      .map((row) => row.id),
  ).toEqual([task.id]);
});
it('detects competing offline completions without duplicate event/successor and preserves both receipts', async () => {
  const task = await create('Race', {
    recurrence: {
      frequency: 'monthly',
      anchorDate: '2026-01-31',
      timeZone: 'UTC',
    },
  });
  const first = await complete(task.id);
  const second = await complete(task.id, '2026-10-25T12:00:00Z');
  const result = await Promise.all([db.apply(first), db.apply(second)]);
  expect(result.map((row) => row.status).sort()).toEqual([
    'applied',
    'conflict',
  ]);
  const conflict = result.find((row) => row.status === 'conflict');
  expect(conflict).toMatchObject({
    code: 'already_completed',
    timestampDisagrees: true,
  });
  expect(
    (await db.rows('completion_events')).filter(
      (row) => row.task_id === task.id && row.kind === 'completion',
    ),
  ).toHaveLength(1);
  expect(
    (await db.rows('tasks')).filter(
      (row) =>
        row.series_id === task.seriesId && !row.completed && !row.deleted_at,
    ),
  ).toHaveLength(1);
  expect(await db.apply(first)).toEqual(result[0]);
  expect(await db.apply(second)).toEqual(result[1]);
});
it('blocks changed-successor undo, allows explicit standalone reopen, reanchors immutably and disables', async () => {
  const task = await create('Guard', {
    recurrence: {
      frequency: 'weekly',
      anchorDate: '2026-10-19',
      timeZone: 'UTC',
    },
  });
  applied(await db.apply(await complete(task.id)));
  let next = (await db.rows('tasks')).find(
    (row) =>
      row.series_id === task.seriesId && !row.completed && !row.deleted_at,
  );
  if (!next) throw new Error('No successor');
  applied(
    await db.apply(
      await db.command(
        { kind: 'edit', input: { title: 'Edited next' } },
        String(next.id),
      ),
    ),
  );
  expect((await db.apply(await reverse(task.id))).status).toBe('conflict');
  applied(await db.apply(await reverse(task.id, true)));
  expect((await current(task.id)).series_id).toBeNull();
  next = await current(String(next.id));
  const c = await db.command(
    {
      kind: 'edit',
      input: {
        title: 'New anchor',
        recurrence: {
          frequency: 'monthly',
          anchorDate: '2026-10-31',
          timeZone: 'UTC',
        },
      },
    },
    String(next.id),
  );
  applied(await db.apply(c));
  expect((await current(String(next.id))).deleted_at).not.toBeNull();
  const replacement = (await db.rows('tasks')).find(
    (row) =>
      row.series_id === task.seriesId && !row.completed && !row.deleted_at,
  );
  if (!replacement) throw new Error('No replacement');
  expect(replacement.occurrence_date).toBe('2026-10-31');
  applied(
    await db.apply(
      await db.command(
        { kind: 'edit', input: { title: 'Standalone', recurrence: null } },
        String(replacement.id),
      ),
    ),
  );
  expect((await current(String(replacement.id))).series_id).toBeNull();
});
it('paginates against a fixed committed watermark and retries pages without skipping tombstones/history', async () => {
  const boundary = Number((await page()).watermark);
  let cursor = 0;
  const ids: number[] = [];
  do {
    const p = await page(cursor, boundary, 3);
    expect(p.watermark).toBe(boundary);
    const repeated = await page(cursor, boundary, 3);
    expect(repeated).toEqual(p);
    for (const change of array(p.changes))
      ids.push(Number(object(change).sequence));
    cursor = Number(p.cursor);
  } while (cursor < boundary);
  expect(ids).toEqual(Array.from({ length: boundary }, (_, i) => i + 1));
  expect(
    (await db.request('rpc/pull_changes', { cursor: 0, page_size: 501 })).http,
  ).toBe(400);
  expect((await db.request('rpc/pull_changes', { cursor: -1 })).http).toBe(400);
});
it('never exposes an uncommitted sequence or skips a delayed earlier writer', async () => {
  const before = Number((await page()).watermark);
  const id = randomUUID();
  const first = await db.command(
    { kind: 'create', input: { title: 'Delayed writer' } },
    id,
    { id },
  );
  const delayed = sqlAsync(
    db.url,
    `set application_name='taskmaster_delayed';${db.asOwner(ownerA, `select public.apply_command(${quote(JSON.stringify(first))}::jsonb);select pg_sleep(1)`)}`,
  );
  let sleeping = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      sql(
        db.url,
        "select exists(select 1 from pg_stat_activity where application_name='taskmaster_delayed' and wait_event='PgSleep');",
      ) === 't'
    ) {
      sleeping = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(sleeping).toBe(true);
  expect((await page()).watermark).toBe(before);
  const otherId = randomUUID();
  const second = await db.command(
    { kind: 'create', input: { title: 'Later writer' } },
    otherId,
    { id: otherId },
  );
  const committed = db.apply(second);
  await delayed;
  applied(await committed);
  expect((await page(before, before)).changes).toEqual([]);
  const fresh = await page(before);
  expect(array(fresh.changes).map((change) => object(change).sequence)).toEqual(
    [before + 1, before + 2],
  );
});

it('keeps service-role writes revoked and migration-only schema creation privileges closed', () => {
  expect(
    sql(
      db.url,
      "select has_table_privilege('service_role','public.tasks','INSERT,UPDATE,DELETE') or has_schema_privilege('taskmaster_executor','public','CREATE');",
    ),
  ).toBe('f');
});
it('honors declared dependencies when undo would otherwise see an untouched successor', async () => {
  const task = await create('Dependent undo', {
    recurrence: {
      frequency: 'daily',
      anchorDate: '2026-10-21',
      timeZone: 'UTC',
    },
  });
  applied(await db.apply(await complete(task.id)));
  await create('Dependent command');
  expect(await db.apply(await reverse(task.id))).toMatchObject({
    status: 'conflict',
  });
});
it('validates Unicode UTF-16 limits and case/normalization-equivalent category names', async () => {
  const id = randomUUID();
  expect(
    await db.apply(
      await db.command(
        { kind: 'create', input: { title: '😀'.repeat(121) } },
        id,
        { id },
      ),
    ),
  ).toMatchObject({ status: 'validation' });
  await create('😀'.repeat(120));
  const cat = randomUUID();
  applied(
    await db.apply(
      await db.command(
        {
          kind: 'organization',
          entityKind: 'category',
          action: 'create',
          entityId: cat,
          name: 'Café',
          categoryId: null,
        },
        null,
        { id: cat },
      ),
    ),
  );
  const duplicate = randomUUID();
  expect(
    await db.apply(
      await db.command(
        {
          kind: 'organization',
          entityKind: 'category',
          action: 'create',
          entityId: duplicate,
          name: 'Cafe\u0301',
          categoryId: null,
        },
        null,
        { id: duplicate },
      ),
    ),
  ).toMatchObject({ status: 'validation' });
});
it('independently rejects new assignments to deleted parents and mismatched same-owner groups', async () => {
  const cat = randomUUID();
  applied(
    await db.apply(
      await db.command(
        {
          kind: 'organization',
          entityKind: 'category',
          action: 'create',
          entityId: cat,
          name: 'Dead parent',
          categoryId: null,
        },
        null,
        { id: cat },
      ),
    ),
  );
  applied(
    await db.apply(
      await db.command(
        {
          kind: 'organization',
          entityKind: 'category',
          action: 'delete',
          entityId: cat,
          name: null,
          categoryId: null,
        },
        null,
        { id: cat },
      ),
    ),
  );
  expect(() =>
    sql(
      db.url,
      db.asOwner(
        ownerA,
        `insert into public.tasks(owner_id,id,title,category_id,last_operation_id) values(${quote(ownerA)},${quote(randomUUID())},'Dead assignment',${quote(cat)},${quote(randomUUID())});set constraints all immediate;`,
        'taskmaster_executor',
      ),
    ),
  ).toThrow(/Deleted parent/);
});
it('propagates recurring template cascades without rewriting completion snapshots', async () => {
  const cat = randomUUID();
  applied(
    await db.apply(
      await db.command(
        {
          kind: 'organization',
          entityKind: 'category',
          action: 'create',
          entityId: cat,
          name: 'Recurring parent',
          categoryId: null,
        },
        null,
        { id: cat },
      ),
    ),
  );
  const task = await create('Cascade series', {
    categoryId: cat,
    recurrence: {
      frequency: 'daily',
      anchorDate: '2026-10-21',
      timeZone: 'UTC',
    },
  });
  applied(await db.apply(await complete(task.id)));
  const events = await db.rows('completion_events');
  applied(
    await db.apply(
      await db.command(
        {
          kind: 'organization',
          entityKind: 'category',
          action: 'delete',
          entityId: cat,
          name: null,
          categoryId: null,
        },
        null,
        { id: cat },
      ),
    ),
  );
  expect(
    (await db.rows('recurrence_series')).find((row) => row.id === task.seriesId)
      ?.category_id,
  ).toBeNull();
  expect(await db.rows('completion_events')).toEqual(events);
});
it('validates DST dates in PostgreSQL against the client series-zone conversion', () => {
  for (const instant of [
    '2026-03-08T06:59:59Z',
    '2026-03-08T07:00:00Z',
    '2026-11-01T05:30:00Z',
    '2026-11-01T06:30:00Z',
  ])
    expect(
      sql(
        db.url,
        `select to_char(${quote(instant)}::timestamptz at time zone 'America/New_York','YYYY-MM-DD');`,
      ),
    ).toBe(civilDate(instant, 'America/New_York'));
});
it('rejects forged advancement and rolls back a simulated failed forward migration', async () => {
  const task = await create('Forged advance', {
    recurrence: {
      frequency: 'daily',
      anchorDate: '2026-10-21',
      timeZone: 'UTC',
    },
  });
  const c = await complete(task.id);
  c.payload = {
    ...c.payload,
    event: { ...object(c.payload.event), recurrence: {} },
  };
  const before = (await page()).watermark;
  expect(await db.apply(c)).toMatchObject({ status: 'validation' });
  expect((await page()).watermark).toBe(before);
  expect(() =>
    sql(
      db.url,
      "begin;alter table public.tasks add column migration_probe text;do $$begin raise exception 'Injected forward migration failure';end$$;commit;",
    ),
  ).toThrow(/Injected forward/);
  expect(
    sql(
      db.url,
      "select count(*) from information_schema.columns where table_schema='public' and table_name='tasks' and column_name='migration_probe';",
    ),
  ).toBe('0');
  expect((await current(task.id)).completed).toBe(false);
});

it.each(['\t\n', '\u00a0\u2000', '\ufeff'])(
  'rejects whitespace-only titles using the same trim semantics as the local domain: %j',
  async (title) => {
    const id = randomUUID();
    expect(
      await db.apply(
        await db.command({ kind: 'create', input: { title } }, id, { id }),
      ),
    ).toMatchObject({ status: 'validation' });
  },
);
it('validates event fields even for an already-completed recurring task', async () => {
  const task = await create('Validate duplicate', {
    recurrence: {
      frequency: 'daily',
      anchorDate: '2026-10-21',
      timeZone: 'UTC',
    },
  });
  const first = await complete(task.id);
  applied(await db.apply(first));
  const operation = randomUUID();
  const event = {
    ...object(first.payload.event),
    ownerId: ownerB,
    operationId: operation,
  };
  const command = await db.command({ kind: 'complete', event }, task.id);
  command.id = operation;
  expect(await db.apply(command)).toMatchObject({ status: 'validation' });
});

it('passes all 18 native pgTAP companion assertions on the real PostgreSQL engine', async () => {
  const { readFile } = await import('node:fs/promises');
  const output = sql(
    db.url,
    await readFile('supabase/tests/phase6.test.sql', 'utf8'),
  );
  expect(output).not.toMatch(/^not ok/m);
  expect(
    output.split('\n').filter((line) => /^ok \d+/.test(line)),
  ).toHaveLength(18);
});

it('bounds large feed pages by bytes while retaining a contiguous cursor prefix', async () => {
  const cursor = Number((await page()).watermark);
  for (let index = 0; index < 40; index++)
    await create(`Large page ${index}`, { description: '漢'.repeat(10000) });
  const first = await page(cursor);
  expect(first.hasMore).toBe(true);
  expect(array(first.changes).length).toBeLessThan(40);
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(1048576);
  const second = await page(Number(first.cursor), Number(first.watermark));
  expect(second.hasMore).toBe(false);
  const all = [...array(first.changes), ...array(second.changes)].map(
    (change) => Number(object(change).sequence),
  );
  expect(all).toEqual(
    Array.from({ length: 40 }, (_, index) => cursor + index + 1),
  );
});

it.each(['daily', 'weekly', 'monthly'])(
  'rejects PostgreSQL recurrence overflow for %s without wrapping dates',
  (frequency) => {
    expect(() =>
      sql(
        db.url,
        `select taskmaster_private.next_occurrence(${quote(frequency)},'9999-12-31','9999-12-31','9999-12-31');`,
      ),
    ).toThrow(/Invalid date|Date outside/);
  },
);

it('defaults omitted pull cursor to zero and rejects explicit null without advancing it', async () => {
  const omitted = await db.request('rpc/pull_changes', {});
  expect(omitted.http).toBe(200);
  expect(omitted.value).toEqual(await page());
  expect((await db.request('rpc/pull_changes', { cursor: null })).http).toBe(
    400,
  );
  expect(await page()).toEqual(omitted.value);
});
it.each([
  { cursor: 'invalid' },
  { cursor: 1.5 },
  { cursor: 9007199254740992 },
  { cursor: 0, watermark: -1 },
  { cursor: 0, watermark: 9007199254740992 },
  { cursor: 0, page_size: null },
])('rejects malformed pull bounds %j', async (body) => {
  expect((await db.request('rpc/pull_changes', body)).http).toBe(400);
});
it('returns a deterministic empty initial feed and caught-up page', async () => {
  const empty = await db.request('rpc/pull_changes', {}, db.emptyToken());
  expect(empty.value).toEqual({
    protocolVersion: 1,
    cursor: 0,
    watermark: 0,
    hasMore: false,
    changes: [],
  });
  const boundary = Number((await page()).watermark);
  expect(await page(boundary, boundary)).toEqual({
    protocolVersion: 1,
    cursor: boundary,
    watermark: boundary,
    hasMore: false,
    changes: [],
  });
});
it('identifies unavailable reads without disclosing whether another owner holds the identity', async () => {
  const foreign = await create('Private foreign task', {}, ownerB);
  for (const id of [randomUUID(), foreign.id]) {
    const command = await db.command(
      { kind: 'edit', input: { title: 'Attempt' } },
      id,
    );
    command.reads = [
      { kind: 'task', id, revision: 1, lastOperationId: randomUUID() },
    ];
    command.dependencies = [];
    const response = await db.apply(command);
    expect(response).toMatchObject({
      status: 'conflict',
      code: 'revision_conflict',
      authoritative: [{ kind: 'task', id, state: null }],
    });
    expect(await db.apply(command)).toEqual(response);
    expect(JSON.stringify(response)).not.toContain('Private foreign task');
  }
});
it('identifies unavailable primary entities and parents even when their read is omitted', async () => {
  const missing = randomUUID();
  const command = await db.command(
    { kind: 'edit', input: { title: 'Attempt' } },
    missing,
  );
  expect(await db.apply(command)).toMatchObject({
    status: 'conflict',
    authoritative: [{ kind: 'task', id: missing, state: null }],
  });
  const category = randomUUID();
  const id = randomUUID();
  const createCommand = await db.command(
    {
      kind: 'create',
      input: { title: 'Missing parent', categoryId: category },
    },
    id,
    { id },
  );
  expect(await db.apply(createCommand)).toMatchObject({
    status: 'conflict',
    authoritative: [{ kind: 'category', id: category, state: null }],
  });
  expect((await db.rows('tasks')).some((row) => row.id === id)).toBe(false);
});
it('returns a tombstone for an edit racing deletion without resurrecting the task', async () => {
  const task = await create('Delete versus edit');
  const edit = await db.command(
    { kind: 'edit', input: { title: 'Retained intent' } },
    task.id,
  );
  applied(await db.apply(await db.command({ kind: 'delete' }, task.id)));
  const response = await db.apply(edit);
  expect(response).toMatchObject({
    status: 'conflict',
    authoritative: [
      {
        kind: 'task',
        id: task.id,
        state: { id: task.id, title: 'Delete versus edit' },
      },
    ],
  });
  expect(
    object(object(array(response.authoritative)[0]).state).deletedAt,
  ).not.toBeNull();
  expect((await current(task.id)).title).toBe('Delete versus edit');
});

it.each(['daily', 'weekly', 'monthly'])(
  'rolls back the entire %s completion when no successor fits the supported calendar',
  async (frequency) => {
    const task = await create('Calendar boundary', {
      recurrence: { frequency, anchorDate: '9999-12-31', timeZone: 'UTC' },
    });
    const before = await current(task.id);
    const boundary = Number((await page()).watermark);
    const command = await db.command(
      {
        kind: 'complete',
        event: {
          id: randomUUID(),
          taskId: task.id,
          operationId: 'placeholder',
          kind: 'completion',
          occurredAt: '9999-12-31T12:00:00Z',
          timeZone: 'UTC',
          recurrence: {},
        },
      },
      task.id,
    );
    command.payload.event = {
      ...object(command.payload.event),
      operationId: command.id,
    };
    const result = await db.apply(command);
    expect(result.status).toBe('validation');
    expect(await current(task.id)).toEqual(before);
    expect((await page()).watermark).toBe(boundary);
    expect(
      (await db.rows('completion_events')).some(
        (row) => row.task_id === task.id,
      ),
    ).toBe(false);
    expect(await db.apply(command)).toEqual(result);
  },
);
it('identifies an unavailable category without inventing a successful rename', async () => {
  const id = randomUUID();
  const command = await db.command(
    {
      kind: 'organization',
      entityKind: 'category',
      action: 'rename',
      entityId: id,
      name: 'Retained name',
    },
    null,
  );
  expect(await db.apply(command)).toMatchObject({
    status: 'conflict',
    authoritative: [{ kind: 'category', id, state: null }],
  });
});
it('returns the deleted group tombstone for a new assignment with current revisions', async () => {
  const cat = randomUUID();
  const group = randomUUID();
  for (const [entityKind, entityId, categoryId] of [
    ['category', cat, null],
    ['group', group, cat],
  ]) {
    applied(
      await db.apply(
        await db.command(
          {
            kind: 'organization',
            entityKind,
            entityId,
            categoryId,
            action: 'create',
            name: String(entityId),
          },
          null,
        ),
      ),
    );
  }
  applied(
    await db.apply(
      await db.command(
        {
          kind: 'organization',
          entityKind: 'group',
          entityId: group,
          action: 'delete',
        },
        null,
      ),
    ),
  );
  const id = randomUUID();
  const command = await db.command(
    {
      kind: 'create',
      input: { title: 'Assignment intent', categoryId: cat, groupId: group },
    },
    id,
    { id },
  );
  const response = await db.apply(command);
  expect(response).toMatchObject({
    status: 'conflict',
    authoritative: [{ kind: 'group', id: group, state: { id: group } }],
  });
  expect(
    object(object(array(response.authoritative)[0]).state).deletedAt,
  ).not.toBeNull();
  expect((await db.rows('tasks')).some((row) => row.id === id)).toBe(false);
});
it('rejects an oversized organizational cascade before modifying its child groups', () => {
  // Rollback-only operator fixture; no administrative mutation escapes this test transaction.
  const cat = randomUUID();
  const op = randomUUID();
  const response = sql(
    db.url,
    db
      .asOwner(
        ownerA,
        `
    insert into public.categories(owner_id,id,name,last_operation_id) values(${quote(ownerA)},${quote(cat)},${quote(cat)},${quote(op)});
    insert into public.groups(owner_id,id,category_id,name,last_operation_id)
      select ${quote(ownerA)},gen_random_uuid(),${quote(cat)},'Bounded group '||n,${quote(op)} from generate_series(1,2000) n;
    select public.apply_command(${quote(JSON.stringify({ id: randomUUID(), protocolVersion: 2, result: {}, reads: [{ kind: 'category', id: cat, revision: 1 }], changes: [], dependencies: [], payload: { kind: 'organization', entityKind: 'category', entityId: cat, action: 'delete' } }))}::jsonb)->>'status';
    select count(*) from public.groups where category_id=${quote(cat)} and deleted_at is not null;
    rollback
  `,
        'taskmaster_executor',
      )
      .replace(/; commit;$/, ';'),
  );
  expect(response.split('\n').slice(-2)).toEqual(['validation', '0']);
});

it('keeps the two managed Auth bridges private and limited to request identity/assurance reads', () => {
  const bridgeCount = sql(
    db.url,
    `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='taskmaster_private' and p.proname in ('current_user_id','current_aal') and p.prosecdef and p.proconfig @> array['search_path=""'] and p.pronargs=0 and p.provolatile='s' and not has_function_privilege('authenticated',p.oid,'EXECUTE') and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('service_role',p.oid,'EXECUTE') and has_function_privilege('taskmaster_executor',p.oid,'EXECUTE');`,
  );
  expect(bridgeCount).toBe('2');
  expect(
    sql(
      db.url,
      `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='taskmaster_private' or (n.nspname='public' and p.proname in ('apply_command','pull_changes','get_receipt'))) and p.proname not in ('current_user_id','current_aal') and p.prosrc ~ 'auth[.](uid|jwt)[[:space:]]*[(]';`,
    ),
  ).toBe('0');
  expect(
    sql(
      db.url,
      `select pg_has_role('taskmaster_executor','authenticated','MEMBER') or pg_has_role('authenticated','taskmaster_executor','MEMBER') or pg_has_role('anon','taskmaster_executor','MEMBER') or pg_has_role('service_role','taskmaster_executor','MEMBER');`,
    ),
  ).toBe('f');
});
it.runIf(Boolean(process.env.TASKMASTER_NATIVE_SUPABASE))(
  'verifies native GoTrue password/TOTP assurance, factor status and incorrect-code rejection for three isolated users',
  () => {
    if (!(db instanceof NativeDatabaseHarness))
      throw new Error('Native harness required');
    expect(db.authEvidence).toEqual(
      Array.from({ length: 3 }, () => ({
        passwordAAL: 'aal1',
        totpAAL: 'aal2',
        verifiedFactor: true,
        invalidCodeRejected: true,
      })),
    );
  },
);
it.runIf(Boolean(process.env.TASKMASTER_NATIVE_SUPABASE))(
  'verifies managed ownership, seven recorded migrations and absence of executor access to the managed Auth schema',
  () => {
    expect(
      sql(
        db.url,
        `select string_agg(version,',' order by version) from supabase_migrations.schema_migrations;`,
      ),
    ).toBe(
      '20261024000100,20261024000200,20261024000300,20261024000400,20261024000500,20261024000600,20261024000700',
    );
    expect(
      sql(
        db.url,
        `select pg_get_userbyid(nspowner) from pg_namespace where nspname='auth';`,
      ),
    ).toBe('supabase_admin');
    expect(
      sql(
        db.url,
        `select has_schema_privilege('taskmaster_executor','auth','USAGE');`,
      ),
    ).toBe('f');
    expect(
      sql(
        db.url,
        `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner where n.nspname='taskmaster_private' and p.proname in ('current_user_id','current_aal') and r.rolname='postgres' and p.prosrc in (' SELECT auth.uid(); ',' SELECT auth.jwt()->>''aal''; ');`,
      ),
    ).toBe('2');
  },
);
it('creates future migration-owned tables and sequences with no implicit API-role privileges', () => {
  const name = `taskmaster_acl_${randomUUID().replaceAll('-', '')}`;
  expect(
    sql(
      db.url,
      `begin; create table public.${name}(id integer); create sequence public.${name}_seq; select count(*) from (values ('anon'),('authenticated'),('service_role')) roles(name) where has_table_privilege(name,'public.${name}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') or has_sequence_privilege(name,'public.${name}_seq','USAGE,SELECT,UPDATE'); rollback;`,
    ),
  ).toBe('0');
});
