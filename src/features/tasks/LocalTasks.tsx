import type { RecurrenceSeries } from '../../domain/recurrence';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBlocker } from 'react-router';
import type { TaskRepository } from '../../data/local/taskRepository';
import type { Category, Group } from '../../domain/organization';
import { CategoryTree } from '../views/CategoryTree';
import { DateGroups } from '../views/DateGroups';
import { OrganizationForm } from './OrganizationForm';
import { OrganizationRepository } from '../../data/local/organizationRepository';
import { useTaskQuery } from '../query/useTaskQuery';
import { QueryControls } from '../query/QueryControls';
import { CompletionHistory } from './CompletionHistory';
import type { Task } from '../../domain/task';
import { persistenceMessage } from '../../domain/task';
import { EmptyState } from '../../components/EmptyState';
import { TaskForm } from './TaskForm';
import { TaskRow } from './TaskRow';
import type { TaskAction } from './TaskRow';
import { useWorkspace } from './useWorkspace';

export function LocalTasks({
  repository,
  kind = 'list',
}: {
  repository: TaskRepository;
  kind?: 'list' | 'categories' | 'date';
}) {
  const organizationRepository = new OrganizationRepository(
    repository.db,
    repository.ownerId,
  );

  const [createTarget, setCreateTarget] = useState<{
    categoryId: string | null;
    groupId: string | null;
  }>({ categoryId: null, groupId: null });
  const [createGeneration, setCreateGeneration] = useState(0);
  const [organizationEditor, setOrganizationEditor] = useState<
    | { kind: 'create-category' }
    | { kind: 'create-group'; parent: Category }
    | { kind: 'rename-category'; row: Category }
    | { kind: 'rename-group'; row: Group }
    | null
  >(null);
  const [organizationGeneration, setOrganizationGeneration] = useState(0);
  const [editGeneration, setEditGeneration] = useState(0);
  const [editingSeries, setEditingSeries] = useState<
    RecurrenceSeries | undefined
  >();
  const [editing, setEditing] = useState<Task | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [retry, setRetry] = useState(0);
  const state = useWorkspace(repository, retry);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [undo, setUndo] = useState<Task | null>(null);
  const [dirty, setDirty] = useState(false);
  const drafts = useRef(new Set<string>());
  const listRef = useRef<HTMLDivElement>(null);
  const markDirty = useCallback((key: string, value: boolean) => {
    if (value) drafts.current.add(key);
    else drafts.current.delete(key);
    setDirty(drafts.current.size > 0);
  }, []);
  const quickDirty = useCallback(
    (value: boolean) => markDirty('quick-add', value),
    [markDirty],
  );
  const editDirty = useCallback(
    (value: boolean) => markDirty('edit', value),
    [markDirty],
  );
  const organizationDirty = useCallback(
    (value: boolean) => markDirty('organization', value),
    [markDirty],
  );
  const blocker = useBlocker(dirty || busy);
  useEffect(() => {
    if (blocker.state === 'blocked') {
      if (
        !busyRef.current &&
        window.confirm('Leave this view and discard unsaved drafts?')
      )
        blocker.proceed();
      else blocker.reset();
    }
  }, [blocker]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty, busy]);
  // Do not let a service-worker update reload over drafts or an in-flight write.
  useEffect(() => {
    const preventUpdate = (event: Event) => {
      if (dirty || busyRef.current) event.preventDefault();
    };
    window.addEventListener('taskmaster:before-update', preventUpdate);
    return () =>
      window.removeEventListener('taskmaster:before-update', preventUpdate);
  }, [dirty]);

  async function run(
    operation: () => Promise<unknown>,
    message: string,
  ): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await operation();
      setNotice(message);
      return true;
    } catch (failure) {
      setError(persistenceMessage(failure));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function act(task: Task, action: TaskAction) {
    if (
      action === 'reopenStandalone' &&
      !window.confirm(
        'Reopen this historical occurrence as a standalone task? The current recurring series will continue unchanged.',
      )
    )
      return false;

    const saved = await run(
      async () => {
        const updated = await repository[action](task);
        if (action === 'complete') setUndo(updated);
        if (action === 'reopen' && undo?.id === task.id) setUndo(null);
      },
      action === 'delete'
        ? 'Task deleted. You can restore it from Deleted.'
        : action === 'complete'
          ? 'Task completed. Undo is available.'
          : action === 'restore'
            ? 'Task restored.'
            : 'Task reopened.',
    );
    if (saved) listRef.current?.focus();
    return saved;
  }

  const snapshot = state.kind === 'ready' ? state.value : null;
  const { query, change, tasks, issue, preferenceNotice, status, calendar } =
    useTaskQuery(
      `taskmaster:preferences:${repository.db.name}:${repository.ownerId}:${kind}:v1`,
      snapshot,
      kind === 'date',
      deleted,
    );
  const dateMode = query.dateMode;
  const view = deleted ? 'deleted' : status;

  function startEdit(task: Task) {
    if (
      !drafts.current.has('edit') ||
      window.confirm('Discard unsaved edits and edit this task?')
    ) {
      setEditGeneration((value) => value + 1);
      setEditingSeries(
        snapshot?.series.find((row) => row.id === task.seriesId),
      );
      setEditing(task);
    }
  }
  function renderRows(items: Task[]) {
    return items.length ? (
      <ul>
        {items.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            busy={busy}
            act={act}
            startEdit={startEdit}
            series={snapshot?.series.find((row) => row.id === task.seriesId)}
          />
        ))}
      </ul>
    ) : (
      <p className="px-4 py-3 text-xs text-muted">No tasks here.</p>
    );
  }
  function addTask(categoryId: string | null, groupId: string | null) {
    if (
      drafts.current.has('quick-add') &&
      !window.confirm('Discard this unsaved task draft?')
    )
      return;
    setCreateTarget({ categoryId, groupId });
    setCreateGeneration((value) => value + 1);
  }
  function manage(
    entityKind: 'category' | 'group',
    row: Category | Group,
    action: 'rename' | 'delete' | 'create-group',
  ) {
    if (action === 'delete') {
      if (
        window.confirm(
          `Delete ${entityKind} “${row.name}”? Tasks and completion history will be preserved; assignments will be removed.`,
        )
      ) {
        void run(async () => {
          if (entityKind === 'category')
            await organizationRepository.deleteCategory(row);
          else if ('categoryId' in row)
            await organizationRepository.deleteGroup(row);
        }, 'Organization deleted. Tasks were preserved.');
      }
      return;
    }
    if (
      drafts.current.has('organization') &&
      !window.confirm('Discard this unsaved organizational name?')
    )
      return;
    setOrganizationGeneration((value) => value + 1);
    if (action === 'create-group')
      setOrganizationEditor({ kind: 'create-group', parent: row });
    else if (entityKind === 'category')
      setOrganizationEditor({ kind: 'rename-category', row });
    else if ('categoryId' in row)
      setOrganizationEditor({ kind: 'rename-group', row });
  }

  return (
    <section className="text-sm" aria-label="Local tasks">
      <div className="border-b border-line px-5 py-4 sm:px-8">
        <p className="mb-4 text-xs leading-6 text-muted">
          Local-only test workspace. No account or cloud backup. Use test data
          only.
        </p>
        {createTarget.categoryId && (
          <p className="mb-2 text-xs text-muted">
            Creating in:{' '}
            {snapshot?.categories.find(
              (row) => row.id === createTarget.categoryId,
            )?.name ?? 'Unavailable category'}
            {createTarget.groupId
              ? ` / ${snapshot?.groups.find((row) => row.id === createTarget.groupId)?.name ?? 'Unavailable group'}`
              : ''}
          </p>
        )}
        <TaskForm
          key={createGeneration}
          focusOnMount={createGeneration > 0}
          initialCategoryId={createTarget.categoryId}
          initialGroupId={createTarget.groupId}
          categories={snapshot?.categories ?? []}
          groups={snapshot?.groups ?? []}
          busy={busy || state.kind !== 'ready'}
          dirtyChanged={quickDirty}
          save={(input) =>
            run(() => repository.create(input), 'Task saved locally.')
          }
        />
        <p className="mt-3 text-xs leading-6 text-muted">
          {snapshot
            ? `${snapshot.pendingCount} changes retained locally · Not synced`
            : 'Opening local storage…'}
        </p>
      </div>
      <div
        className="flex flex-wrap gap-2 border-b border-line px-4 py-3"
        aria-label="Task status"
      >
        {(['active', 'completed', 'all', 'deleted'] as const).map((mode) => (
          <button
            key={mode}
            className="action"
            aria-pressed={view === mode}
            disabled={busy}
            onClick={() => {
              const editingDraft = [...drafts.current].some(
                (key) => key === 'edit',
              );
              if (
                !editingDraft ||
                window.confirm(
                  'Discard unsaved edits and change task status view?',
                )
              ) {
                setEditing(null);
                setDeleted(mode === 'deleted');
                if (mode !== 'deleted')
                  change({ ...query, status: mode, statusExplicit: true });
              }
            }}
          >
            {mode === 'active'
              ? 'Active'
              : mode === 'completed'
                ? 'Completed'
                : mode === 'all'
                  ? 'All'
                  : 'Deleted'}
          </button>
        ))}
      </div>
      {kind === 'date' && (
        <div className="px-4 py-3">
          <label className="block text-xs text-muted">
            Group dates by
            <select
              aria-label="Group dates by"
              className="field ml-2 max-w-full"
              value={dateMode}
              disabled={busy}
              onChange={(event) => {
                const value = event.target.value;
                if (
                  value === 'due' ||
                  value === 'created' ||
                  value === 'completed'
                ) {
                  change({ ...query, dateMode: value });
                }
              }}
            >
              <option value="due">Due date</option>
              <option value="created">Creation date</option>
              <option value="completed">Completion date</option>
            </select>
          </label>
        </div>
      )}
      <QueryControls
        query={query}
        change={change}
        categories={snapshot?.categories ?? []}
        groups={snapshot?.groups ?? []}
      />
      {preferenceNotice && (
        <p role="status" className="p-4 text-xs text-muted">
          {preferenceNotice}
        </p>
      )}
      {issue && (
        <p role="alert" className="p-4 text-error">
          {issue}
        </p>
      )}
      {kind === 'date' &&
        dateMode === 'completed' &&
        !deleted &&
        status === 'active' && (
          <p className="p-4 text-xs text-muted">
            Active tasks have no current completion date. Select Completed or
            All to see completion-date groups.
          </p>
        )}
      {kind === 'categories' && (
        <button
          className="action m-4"
          disabled={busy || !snapshot}
          onClick={() => {
            if (
              !drafts.current.has('organization') ||
              window.confirm('Discard this unsaved organizational name?')
            ) {
              setOrganizationGeneration((value) => value + 1);
              setOrganizationEditor({ kind: 'create-category' });
            }
          }}
        >
          New category
        </button>
      )}
      {organizationEditor && (
        <OrganizationForm
          key={organizationGeneration}
          label={
            organizationEditor.kind === 'create-category'
              ? 'Category name'
              : organizationEditor.kind === 'create-group'
                ? `Group name in ${organizationEditor.parent.name}`
                : 'Rename name'
          }
          initialName={
            'row' in organizationEditor ? organizationEditor.row.name : ''
          }
          busy={busy}
          dirtyChanged={organizationDirty}
          cancel={() => setOrganizationEditor(null)}
          save={async (name) => {
            const saved = await run(async () => {
              switch (organizationEditor.kind) {
                case 'create-category':
                  await organizationRepository.createCategory(name);
                  break;
                case 'create-group':
                  await organizationRepository.createGroup(
                    organizationEditor.parent,
                    name,
                  );
                  break;
                case 'rename-category':
                  await organizationRepository.renameCategory(
                    organizationEditor.row,
                    name,
                  );
                  break;
                case 'rename-group':
                  await organizationRepository.renameGroup(
                    organizationEditor.row,
                    name,
                  );
                  break;
              }
            }, 'Organization saved locally.');
            if (saved) {
              setOrganizationEditor(null);
              listRef.current?.focus();
            }
            return saved;
          }}
        />
      )}
      {editing && (
        <div className="border-b border-line p-4">
          <TaskForm
            key={`${editing.id}:${editGeneration}`}
            task={editing}
            {...(editingSeries ? { series: editingSeries } : {})}
            categories={snapshot?.categories ?? []}
            groups={snapshot?.groups ?? []}
            busy={busy}
            dirtyChanged={editDirty}
            save={async (input) => {
              const saved = await run(
                () => repository.edit(editing, input),
                'Task changes saved locally.',
              );
              if (saved) {
                setEditing(null);
                listRef.current?.focus();
              }
              return saved;
            }}
            cancel={() => {
              setEditing(null);
              listRef.current?.focus();
            }}
          />
        </div>
      )}
      <div className="px-5 py-2 sm:px-8">
        <p role="status" aria-live="polite" className="text-xs leading-6">
          {notice}
        </p>
        {undo && (
          <button
            className="action my-2"
            disabled={busy}
            onClick={() => {
              void act(undo, 'reopen');
            }}
          >
            Undo completion: {undo.title}
          </button>
        )}
        {error && (
          <p role="alert" className="py-2 text-sm text-error">
            {error}
          </p>
        )}
        {state.kind === 'error' && (
          <div role="alert" className="py-3 text-error">
            <p>{persistenceMessage(state.error)}</p>
            <button
              className="action mt-2"
              onClick={() => setRetry((value) => value + 1)}
            >
              Retry storage
            </button>
          </div>
        )}
      </div>
      <div
        ref={listRef}
        tabIndex={-1}
        aria-label={`${view} tasks`}
        className="focus-visible:outline-accent"
      >
        {state.kind === 'ready' && tasks.length === 0 && (
          <p className="px-4 py-2 text-xs text-muted" role="status">
            No tasks match the current query.
          </p>
        )}
        {state.kind === 'ready' &&
          (kind === 'categories' && view !== 'deleted' ? (
            <CategoryTree
              categories={state.value.categories}
              groups={state.value.groups}
              tasks={tasks}
              busy={busy}
              rows={renderRows}
              addTask={addTask}
              manage={manage}
            />
          ) : kind === 'date' && view !== 'deleted' ? (
            <DateGroups
              tasks={tasks}
              mode={dateMode}
              today={calendar.today}
              zone={calendar.zone}
              rows={renderRows}
            />
          ) : tasks.length ? (
            renderRows(tasks)
          ) : (
            <EmptyState
              title={
                view === 'active'
                  ? 'Nothing on your list.'
                  : view === 'completed'
                    ? 'No completed tasks.'
                    : view === 'all'
                      ? 'No tasks.'
                      : 'No deleted tasks.'
              }
              description={
                view === 'active'
                  ? 'Enter a title above to capture a task.'
                  : view === 'completed'
                    ? 'Completed tasks stay here until reopened or deleted. Completion records remain in history.'
                    : view === 'all'
                      ? 'All nondeleted tasks appear here. Enter a title above to capture a task.'
                      : 'Deleted tasks can be restored here. Nothing is permanently removed.'
              }
            />
          ))}
      </div>
      {snapshot && <CompletionHistory events={snapshot.events} />}
    </section>
  );
}
