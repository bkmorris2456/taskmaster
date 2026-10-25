import { LocalTasks } from '../tasks/LocalTasks';
import {
  getLocalWorkspace,
  localWorkspaceEnabled,
} from '../../data/local/workspace';
import { EmptyState } from '../../components/EmptyState';

type ViewKind = 'list' | 'categories' | 'date';

const content = {
  list: {
    title: 'Big List',
    subtitle: 'Everything, in one place.',
  },
  categories: {
    title: 'Categories',
    subtitle: 'A place for each part of your day.',
  },
  date: {
    title: 'Date',
    subtitle: 'One day at a time.',
  },
} satisfies Record<ViewKind, { title: string; subtitle: string }>;

export function TaskView({ kind }: { kind: ViewKind }) {
  const view = content[kind];
  return (
    <>
      <header className="border-b border-line px-5 py-6 sm:px-8 sm:py-8">
        <h1
          tabIndex={-1}
          className="view-heading text-xl font-semibold tracking-tight sm:text-2xl"
        >
          {view.title}
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted">{view.subtitle}</p>
      </header>
      {localWorkspaceEnabled ? (
        <LocalTasks key={kind} kind={kind} repository={getLocalWorkspace()} />
      ) : (
        <EmptyState
          title="Local workspace disabled"
          description="Use the development server or an explicit local-preview build to try local task management. Account access is not available yet."
        />
      )}
    </>
  );
}
