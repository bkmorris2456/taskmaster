import { useEffect, useState } from 'react';
import type {
  TaskRepository,
  WorkspaceSnapshot,
} from '../../data/local/taskRepository';

export function useWorkspace(repository: TaskRepository, retry: number) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; value: WorkspaceSnapshot }
    | { kind: 'error'; error: unknown }
  >({ kind: 'loading' });
  useEffect(() => {
    const subscription = repository.observe(
      (value) => setState({ kind: 'ready', value }),
      (error: unknown) => setState({ kind: 'error', error }),
    );
    return () => subscription.unsubscribe();
  }, [repository, retry]);
  return state;
}
