import { Fragment, useEffect, useState } from 'react';
import { useAuth } from '../AuthContext';
import { api } from '../api';
import AppHeader from '../components/AppHeader';

// Organization administration: invite code, custom roles and each member's roles
// (one organization role, optionally a different role on specific lines).
export default function MembersPage() {
  const { user, can, refreshUser } = useAuth();
  const canManage = can('members.manage');
  const [permissions, setPermissions] = useState([]);
  const [roles, setRoles] = useState([]);
  const [members, setMembers] = useState([]);
  const [lines, setLines] = useState([]);
  const [org, setOrg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newRoleName, setNewRoleName] = useState('');
  const [expanded, setExpanded] = useState(null); // member whose per-line roles are open
  const [copied, setCopied] = useState(false);

  const load = async () => {
    try {
      const [p, r, m, l, o] = await Promise.all([
        api.listPermissions(),
        api.listRoles(),
        api.listMembers(),
        api.listLines(),
        api.getOrg(),
      ]);
      setPermissions(p.permissions);
      setRoles(r.roles);
      setMembers(m.members);
      setLines(l.lines);
      setOrg(o.organization);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (canManage) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage]);

  // Runs a change, then reloads everything so the page always shows what the server stored.
  const run = async (action) => {
    setError('');
    try {
      await action();
    } catch (err) {
      setError(err.message);
    }
    await load();
  };

  const roleName = (roleId) => roles.find((r) => r.id === roleId)?.name ?? '—';
  const isAdminRole = (roleId) => roles.some((r) => r.id === roleId && r.is_builtin_admin);
  const linePermissions = permissions.filter((p) => p.scope === 'line');
  const orgPermissions = permissions.filter((p) => p.scope === 'org');
  const columns = [...linePermissions, ...orgPermissions];
  // First column of each permission group gets a divider line
  const groupStart = (i) => i === 0 || i === linePermissions.length;

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(org.invite_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable; the code is visible to copy manually
    }
  };

  const createRole = (e) => {
    e.preventDefault();
    const name = newRoleName.trim();
    if (!name) return;
    run(async () => {
      await api.createRole({ name, permissions: ['line.view'] });
      setNewRoleName('');
    });
  };

  const togglePermission = (role, key) => {
    const next = role.permissions.includes(key)
      ? role.permissions.filter((p) => p !== key)
      : [...role.permissions, key];
    run(() => api.updateRole(role.id, { permissions: next }));
  };

  const renameRole = (role) => {
    const name = window.prompt('New name for this role:', role.name);
    if (name === null || !name.trim() || name.trim() === role.name) return;
    run(() => api.updateRole(role.id, { name: name.trim() }));
  };

  const deleteRole = (role) => {
    if (!window.confirm(`Delete the role "${role.name}"?`)) return;
    run(() => api.deleteRole(role.id));
  };

  const changeMemberRole = (member, roleId) =>
    run(async () => {
      await api.setMemberRole(member.id, roleId);
      // Changing your own role changes what this page (and the menu) may show.
      if (member.id === user?.id) await refreshUser();
    });

  const changeLineRole = (member, lineId, value) =>
    run(() => api.setMemberLineRole(member.id, lineId, value === '' ? null : Number(value)));

  if (!canManage) {
    return (
      <div className="main-page">
        <AppHeader subtitle="Members & roles" />
        <main className="content">
          <div className="empty-state">
            <div className="empty-icon">🔒</div>
            <h2>No access</h2>
            <p className="muted">Only members who can manage members and roles can open this page.</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="main-page">
      <AppHeader subtitle="Members & roles" />

      <main className="content">
        {error && <div className="form-error">{error}</div>}

        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : (
          <>
            {org && (
              <section className="panel">
                <h2 className="section-title">Invite members</h2>
                <div className="panel-row">
                  <div className="invite-box">
                    <span className="muted">Invite code:</span>
                    <code className="invite-code">{org.invite_code}</code>
                    <button className="btn small" onClick={copyInvite}>
                      {copied ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                  <label className="inline-label">
                    New members get the role
                    <select
                      value={org.default_role_id ?? ''}
                      onChange={(e) => run(() => api.setDefaultRole(Number(e.target.value)))}
                    >
                      {roles
                        .filter((r) => !r.is_builtin_admin)
                        .map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
              </section>
            )}

            <section className="panel">
              <div className="toolbar">
                <h2 className="section-title">Roles</h2>
                <form className="inline-form-row" onSubmit={createRole}>
                  <input
                    placeholder="New role name"
                    value={newRoleName}
                    maxLength={40}
                    onChange={(e) => setNewRoleName(e.target.value)}
                  />
                  <button className="btn small primary" disabled={!newRoleName.trim()}>
                    + Add role
                  </button>
                </form>
              </div>
              <div className="table-scroll">
                <table className="file-table roles-table">
                  <thead>
                    <tr>
                      <th rowSpan={2}>Role</th>
                      <th colSpan={linePermissions.length} className="group group-start">
                        On each line
                      </th>
                      <th colSpan={orgPermissions.length} className="group group-start">
                        In the organization
                      </th>
                      <th rowSpan={2} className="group-start">Members</th>
                      <th rowSpan={2}></th>
                    </tr>
                    <tr>
                      {columns.map((p, i) => (
                        <th
                          key={p.key}
                          className={`check-cell${groupStart(i) ? ' group-start' : ''}`}
                          title={p.label}
                        >
                          {p.short}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {roles.map((role) => (
                      <tr key={role.id}>
                        <td className="role-name">
                          {role.name}
                          {(role.is_builtin_admin || role.is_default) && (
                            <div className="role-tags">
                              {role.is_builtin_admin && <span className="badge">built-in</span>}
                              {role.is_default && <span className="badge">new members</span>}
                            </div>
                          )}
                        </td>
                        {columns.map((p, i) => (
                          <td
                            key={p.key}
                            className={`check-cell${groupStart(i) ? ' group-start' : ''}`}
                          >
                            <input
                              type="checkbox"
                              checked={role.permissions.includes(p.key)}
                              disabled={role.is_builtin_admin}
                              onChange={() => togglePermission(role, p.key)}
                              aria-label={`${role.name}: ${p.label}`}
                              title={p.label}
                            />
                          </td>
                        ))}
                        <td className="group-start members-cell">
                          {role.member_count}
                          {role.line_assignments > 0 && (
                            <div className="muted">+{role.line_assignments} on lines</div>
                          )}
                        </td>
                        <td className="row-actions">
                          {!role.is_builtin_admin && (
                            <>
                              <button className="btn small" onClick={() => renameRole(role)}>
                                Rename
                              </button>
                              <button className="btn small danger" onClick={() => deleteRole(role)}>
                                Delete
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted">
                "On each line" permissions come from a member's organization role, unless you give
                them a different role on a specific line (Members, below). Administrator always has
                every permission and full access to every line.
              </p>
            </section>

            <section className="panel">
              <h2 className="section-title">Members</h2>
              <table className="file-table">
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Organization role</th>
                    <th>Role on lines</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((member) => {
                    const overrides = Object.keys(member.line_roles).length;
                    const memberIsAdmin = isAdminRole(member.role_id);
                    const open = expanded === member.id && !memberIsAdmin;
                    return (
                      <Fragment key={member.id}>
                        <tr>
                          <td className="file-name">
                            {member.username}
                            {member.id === user?.id && <span className="badge">you</span>}
                          </td>
                          <td>
                            <select
                              value={member.role_id ?? ''}
                              onChange={(e) => changeMemberRole(member, Number(e.target.value))}
                            >
                              {roles.map((r) => (
                                <option key={r.id} value={r.id}>
                                  {r.name}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            {memberIsAdmin ? (
                              <span className="muted">Full access to every line</span>
                            ) : lines.length === 0 ? (
                              <span className="muted">No lines yet</span>
                            ) : (
                              <button
                                className="btn small"
                                onClick={() => setExpanded(open ? null : member.id)}
                              >
                                {overrides === 0
                                  ? 'Same on every line'
                                  : `Different on ${overrides} line${overrides === 1 ? '' : 's'}`}{' '}
                                {open ? '▲' : '▼'}
                              </button>
                            )}
                          </td>
                        </tr>
                        {open && (
                          <tr className="sub-row">
                            <td colSpan={3}>
                              <table className="line-roles-table">
                                <tbody>
                                  {lines.map((line) => (
                                    <tr key={line.id}>
                                      <td>{line.name}</td>
                                      <td>
                                        <select
                                          value={member.line_roles[line.id] ?? ''}
                                          onChange={(e) =>
                                            changeLineRole(member, line.id, e.target.value)
                                          }
                                        >
                                          <option value="">
                                            Same as organization role ({roleName(member.role_id)})
                                          </option>
                                          {roles
                                            .filter((r) => !r.is_builtin_admin)
                                            .map((r) => (
                                              <option key={r.id} value={r.id}>
                                                {r.name}
                                              </option>
                                            ))}
                                        </select>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
