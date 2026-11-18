// Permission catalogue shared by server (enforcement) and renderer (UI hints only).
// The server is the only security boundary; the renderer uses these just to hide controls.

export const PERMS = {
  'users.approve': 'Approve join requests',
  'users.manage': 'Edit members (role, manager, title, disable)',
  'roles.manage': 'Create and edit roles',
  'org.view_all': 'See the full organisation chart',
  'chat.message_anyone': 'Message anyone in the workspace',
  'chat.create_groups': 'Create group chats',
  'tasks.assign_any': 'Assign tasks to anyone',
  'tasks.view_all': 'See every task in the workspace',
  'analytics.view_all': 'See everyone\'s performance analytics',
  'storage.manage': 'Manage storage, duplicates, cleanup and backups',
  'audit.view': 'View the security audit log',
  'workspace.settings': 'Change workspace settings and join code',
} as const;

export type Perm = keyof typeof PERMS;
export const ALL_PERMS = Object.keys(PERMS) as Perm[];

export function isPerm(x: unknown): x is Perm {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(PERMS, x);
}

export interface RoleTemplate { name: string; rank: number; color: string; perms: Perm[] }

// Seeded on workspace creation. Admins can rename, delete or add more.
export const DEFAULT_ROLES: RoleTemplate[] = [
  { name: 'Owner', rank: 100, color: '#FF8A00', perms: [...ALL_PERMS] },
  { name: 'Manager', rank: 80, color: '#6A2BFF', perms: ['users.approve', 'org.view_all', 'chat.message_anyone', 'chat.create_groups', 'tasks.assign_any', 'tasks.view_all', 'analytics.view_all'] },
  { name: 'HR', rank: 70, color: '#FF1F56', perms: ['users.approve', 'users.manage', 'org.view_all', 'chat.message_anyone', 'chat.create_groups', 'analytics.view_all'] },
  { name: 'Team Leader', rank: 60, color: '#1F6BFF', perms: ['chat.create_groups'] },
  { name: 'Employee', rank: 20, color: '#3FB98B', perms: [] },
];

export const TASK_STATUS = ['todo', 'in_progress', 'submitted', 'changes', 'done', 'cancelled'] as const;
export type TaskStatus = typeof TASK_STATUS[number];
export const TASK_PRIORITY = ['low', 'normal', 'high', 'urgent'] as const;
export type TaskPriority = typeof TASK_PRIORITY[number];
