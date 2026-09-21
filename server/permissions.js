// Everything a role can allow. Roles are custom combinations of these, created per organization.
//
// "line" permissions apply per production line: a member's organization role gives them everywhere,
// and a per-line role can replace it on a specific line. "org" permissions come only from the
// organization role.
export const PERMISSIONS = [
  { key: 'line.view', short: 'View', label: 'View lines and their layouts', scope: 'line' },
  { key: 'line.edit', short: 'Edit layout', label: 'Edit line layouts', scope: 'line' },
  { key: 'lines.manage', short: 'Manage lines', label: 'Create, rename and delete lines', scope: 'org' },
  { key: 'models.upload', short: 'Upload models', label: 'Upload and delete 3D models', scope: 'org' },
  { key: 'members.manage', short: 'Manage members', label: 'Manage members and roles', scope: 'org' },
];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);
export const LINE_PERMISSION_KEYS = PERMISSIONS.filter((p) => p.scope === 'line').map((p) => p.key);

// Roles every organization starts with. Administrator is built in: it always has every
// permission and cannot be edited or deleted, so an organization can't lock itself out.
export const DEFAULT_ROLES = [
  { key: 'admin', name: 'Administrator', permissions: PERMISSION_KEYS, builtinAdmin: true },
  { key: 'editor', name: 'Editor', permissions: ['line.view', 'line.edit', 'models.upload'] },
  { key: 'viewer', name: 'Viewer', permissions: ['line.view'] },
];
