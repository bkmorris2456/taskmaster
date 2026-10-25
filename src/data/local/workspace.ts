import { TaskDatabase } from './database';
import { TaskRepository } from './taskRepository';

// This harness is not an authenticated account or a production auth bypass.
export const localWorkspaceEnabled =
  import.meta.env.DEV || import.meta.env.MODE === 'local-preview';
const ownerId = '00000000-0000-4000-8000-000000000002';
let repository: TaskRepository | undefined;

export function getLocalWorkspace(): TaskRepository {
  if (!localWorkspaceEnabled)
    throw new Error('The synthetic local workspace is disabled in production.');
  repository ??= new TaskRepository(
    new TaskDatabase(`taskmaster:local-preview:${ownerId}`),
    ownerId,
  );
  return repository;
}
