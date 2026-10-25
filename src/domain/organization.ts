import { TaskError } from './task';

export interface Category {
  id: string;
  ownerId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  revision: number | null;
  localRevision: number;
  timestampsProvisional: boolean;
  lastOperationId: string;
}

export interface Group extends Category {
  categoryId: string;
}
export type OrganizationKind = 'category' | 'group';

export function organizationName(value: string) {
  const name = value.trim();
  if (!name) throw new TaskError('Enter a name.');
  if (name.length > 80)
    throw new TaskError('Keep the name within 80 characters.');
  return name;
}

export function nameKey(value: string) {
  return value.normalize('NFC').toLowerCase();
}
