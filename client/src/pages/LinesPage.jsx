import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { api } from '../api';
import AppHeader from '../components/AppHeader';

// Printed side length of a new line's QR code; 18 cm fits on an A4 page with margins.
const DEFAULT_SIZE_CM = 18;

function accessLabel(permissions) {
  if (permissions.includes('line.edit')) return 'Can edit';
  if (permissions.includes('line.view')) return 'View only';
  return 'No access';
}

export default function LinesPage() {
  const { can } = useAuth();
  const canManage = can('lines.manage');
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [size, setSize] = useState(DEFAULT_SIZE_CM);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null); // { id, name, size } of the row being edited

  const load = async () => {
    try {
      const data = await api.listLines();
      setLines(data.lines);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const createLine = async (e) => {
    e.preventDefault();
    setCreating(true);
    setError('');
    try {
      await api.createLine({ name, markerSizeCm: Number(size) });
      setName('');
      setSize(DEFAULT_SIZE_CM);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const saveEdit = async () => {
    setError('');
    try {
      await api.updateLine(editing.id, { name: editing.name, markerSizeCm: Number(editing.size) });
      setEditing(null);
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteLine = async (line) => {
    const ok = window.confirm(
      `Delete "${line.name}"?\n\nIts printed QR code will stop working and any per-line roles on it are removed.`
    );
    if (!ok) return;
    try {
      await api.deleteLine(line.id);
      setLines((prev) => prev.filter((l) => l.id !== line.id));
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="main-page">
      <AppHeader subtitle="Production lines" />

      <main className="content">
        {canManage && (
          <form className="panel" onSubmit={createLine}>
            <h2 className="section-title">New production line</h2>
            <div className="form-row">
              <label className="grow">
                Name
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Line 1 - Assembly"
                  maxLength={80}
                  required
                />
              </label>
              <label>
                QR code size (cm)
                <input
                  type="number"
                  min="5"
                  max="100"
                  step="0.5"
                  value={size}
                  onChange={(e) => setSize(e.target.value)}
                  required
                />
              </label>
              <button className="btn primary" disabled={creating || !name.trim()}>
                {creating ? 'Creating…' : 'Create line'}
              </button>
            </div>
            <p className="muted">
              Each line gets its own QR code. Print it at this size and stick it next to the line:
              the AR app recognises it and anchors the line's layout to it. Up to 18 cm fits on A4.
            </p>
          </form>
        )}

        {error && <div className="form-error">{error}</div>}

        {loading ? (
          <div className="empty-state">Loading lines…</div>
        ) : lines.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🏭</div>
            <h2>No production lines yet</h2>
            <p className="muted">
              {canManage
                ? 'Create the first line above.'
                : "There are no lines you can see yet. Ask an administrator for access."}
            </p>
          </div>
        ) : (
          <table className="file-table">
            <thead>
              <tr>
                <th>Line</th>
                <th>Code</th>
                <th>QR size</th>
                <th>Your role</th>
                <th>Access</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) =>
                editing?.id === line.id ? (
                  <tr key={line.id}>
                    <td>
                      <input
                        className="table-input"
                        value={editing.name}
                        maxLength={80}
                        onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                      />
                    </td>
                    <td>
                      <code className="line-code">{line.code}</code>
                    </td>
                    <td>
                      <input
                        className="table-input narrow"
                        type="number"
                        min="5"
                        max="100"
                        step="0.5"
                        value={editing.size}
                        onChange={(e) => setEditing({ ...editing, size: e.target.value })}
                      />{' '}
                      cm
                    </td>
                    <td colSpan={2}></td>
                    <td className="row-actions">
                      <button className="btn small primary" onClick={saveEdit}>
                        Save
                      </button>
                      <button className="btn small" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </td>
                  </tr>
                ) : (
                  <tr key={line.id}>
                    <td className="file-name">{line.name}</td>
                    <td>
                      <code className="line-code">{line.code}</code>
                    </td>
                    <td>{line.marker_size_cm} cm</td>
                    <td>{line.role}</td>
                    <td>{accessLabel(line.permissions)}</td>
                    <td className="row-actions">
                      <Link className="btn small primary" to={`/lines/${line.id}/print`}>
                        Print QR
                      </Link>
                      {canManage && (
                        <>
                          <button
                            className="btn small"
                            onClick={() =>
                              setEditing({ id: line.id, name: line.name, size: line.marker_size_cm })
                            }
                          >
                            Edit
                          </button>
                          <button className="btn small danger" onClick={() => deleteLine(line)}>
                            Delete
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}
