import type { ReactNode } from 'react';
import type { Category, Group } from '../../domain/organization';
import type { Task } from '../../domain/task';

interface Props {
  categories: Category[];
  groups: Group[];
  tasks: Task[];
  busy: boolean;
  rows: (tasks: Task[]) => ReactNode;
  addTask: (categoryId: string | null, groupId: string | null) => void;
  manage: (
    kind: 'category' | 'group',
    row: Category | Group,
    action: 'rename' | 'delete' | 'create-group',
  ) => void;
}

export function CategoryTree({
  categories,
  groups,
  tasks,
  busy,
  rows,
  addTask,
  manage,
}: Props) {
  const count = (items: Task[]) =>
    `${items.filter((task) => task.completed).length}/${items.length} completed (shown)`;
  return (
    <div>
      <section aria-label="Uncategorized" className="border-b border-line">
        <div className="flex flex-wrap items-center justify-between px-4 py-2">
          <h2 className="text-sm">
            Uncategorized{' '}
            <span className="text-xs text-muted">
              {count(tasks.filter((task) => !task.categoryId))}
            </span>
          </h2>
          <button
            className="row-action"
            disabled={busy}
            onClick={() => addTask(null, null)}
          >
            Add task
          </button>
        </div>
        {rows(tasks.filter((task) => !task.categoryId))}
      </section>
      {categories
        .filter((category) => !category.deletedAt)
        .map((category) => {
          const assigned = tasks.filter(
            (task) => task.categoryId === category.id,
          );
          return (
            <details
              key={category.id}
              open
              className="border-b border-line"
              aria-label={`Category: ${category.name}`}
            >
              <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-semibold">
                {category.name}{' '}
                <span className="text-xs font-normal text-muted">
                  {count(assigned)}
                </span>
              </summary>
              <div className="flex flex-wrap gap-1 px-4">
                <button
                  className="row-action"
                  disabled={busy}
                  onClick={() => addTask(category.id, null)}
                >
                  Add task
                </button>
                <button
                  className="row-action"
                  disabled={busy}
                  onClick={() => manage('category', category, 'create-group')}
                >
                  New group
                </button>
                <button
                  className="row-action"
                  disabled={busy}
                  onClick={() => manage('category', category, 'rename')}
                >
                  Rename category
                </button>
                <button
                  className="row-action"
                  disabled={busy}
                  onClick={() => manage('category', category, 'delete')}
                >
                  Delete category
                </button>
              </div>
              <div className="border-l border-line pl-3 sm:ml-4">
                {rows(assigned.filter((task) => !task.groupId))}
                {groups
                  .filter(
                    (group) =>
                      !group.deletedAt && group.categoryId === category.id,
                  )
                  .map((group) => {
                    const members = assigned.filter(
                      (task) => task.groupId === group.id,
                    );
                    return (
                      <details
                        key={group.id}
                        open
                        aria-label={`Group: ${group.name}`}
                        className="border-t border-line"
                      >
                        <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm">
                          {group.name}{' '}
                          <span className="text-xs text-muted">
                            {count(members)}
                          </span>
                        </summary>
                        <div className="flex flex-wrap gap-1 px-4">
                          <button
                            className="row-action"
                            disabled={busy}
                            onClick={() => addTask(category.id, group.id)}
                          >
                            Add task
                          </button>
                          <button
                            className="row-action"
                            disabled={busy}
                            onClick={() => manage('group', group, 'rename')}
                          >
                            Rename group
                          </button>
                          <button
                            className="row-action"
                            disabled={busy}
                            onClick={() => manage('group', group, 'delete')}
                          >
                            Delete group
                          </button>
                        </div>
                        {rows(members)}
                      </details>
                    );
                  })}
              </div>
            </details>
          );
        })}
      {categories.every((category) => category.deletedAt) && (
        <p className="px-4 py-4 text-xs text-muted">
          No categories yet. Create a category to organize tasks.
        </p>
      )}
    </div>
  );
}
