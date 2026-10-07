import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../AuthContext';
import { api } from '../api';
import ModelViewer from '../components/ModelViewer';
import AppHeader from '../components/AppHeader';
import { generateThumbnail } from '../utils/thumbnail';
import ModelDetailsDialog from '../components/ModelDetailsDialog';

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSizeM(file) {
  if (file.width_m == null) return null;
  const fmt = (n) => (n < 1 ? `${Math.round(n * 100)} cm` : `${n.toFixed(2)} m`);
  return `${fmt(file.width_m)} × ${fmt(file.depth_m)} × ${fmt(file.height_m)}`;
}

function formatDate(dateStr) {
  // Postgres TIMESTAMPTZ arrives as an ISO string, e.g. "2026-07-12T17:36:28.000Z"
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? dateStr : d.toLocaleString();
}

export default function MainMenu() {
  const { user, logout, can } = useAuth();
  const canUpload = can('models.upload');
  // Uploaders delete their own models; member managers can delete any model.
  const canDelete = (file) =>
    can('members.manage') || (canUpload && file.uploaded_by === user?.username);
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [previewFile, setPreviewFile] = useState(null);
  const [org, setOrg] = useState(null);
  const [copied, setCopied] = useState(false);
  const [categories, setCategories] = useState([]);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [editing, setEditing] = useState(null); // model whose details are open for editing
  const inputRef = useRef(null);

  const loadFiles = async () => {
    try {
      const data = await api.listFiles();
      setFiles(data.files);
      setError('');
    } catch (err) {
      if (err.message.includes('token') || err.message.includes('authenticated')) {
        logout();
        return;
      }
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFiles();
    api.getOrg().then((data) => setOrg(data.organization)).catch(() => {});
    api
      .listCategories()
      .then((data) => {
        setCategories(data.categories);
        setAiEnabled(data.ai_enabled);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While a model is being analysed, ask the server again every few seconds until it is
  // done. Cheaper and simpler than a websocket for something that takes a few seconds.
  const analysing = files.some((f) => f.ai_status === 'pending');
  useEffect(() => {
    if (!analysing) return undefined;
    const timer = setInterval(loadFiles, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysing]);

  const describe = async (file) => {
    setFiles((current) =>
      current.map((f) => (f.id === file.id ? { ...f, ai_status: 'pending' } : f))
    );
    try {
      await api.describeFile(file.id);
    } catch (err) {
      setError(err.message);
      await loadFiles();
    }
  };

  const saveDetails = async (details) => {
    const { file } = await api.updateFileDetails(editing.id, details);
    setFiles((current) => current.map((f) => (f.id === file.id ? file : f)));
    setEditing(null);
  };

  const categoryLabel = (key) => categories.find((c) => c.key === key)?.label || key;

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(org.invite_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable; code is visible to copy manually
    }
  };

  const handleUpload = async (fileList) => {
    const selected = Array.from(fileList || []);
    if (selected.length === 0) return;
    setUploading(true);
    setError('');
    try {
      for (const file of selected) {
        // Both are optional: a model that fails to render still uploads, it just has
        // no preview and no AI catalogue entry.
        let rendered = {};
        try {
          rendered = await generateThumbnail(await file.arrayBuffer());
        } catch {
          // ignored on purpose
        }
        await api.uploadFile(file, rendered);
      }
      await loadFiles();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleThumbnail = (fileId, thumbnail) => {
    setFiles((prev) =>
      prev.map((f) => (f.id === fileId ? { ...f, thumbnail } : f))
    );
  };

  const handleDelete = async (file) => {
    if (!window.confirm(`Delete "${file.original_name}"?`)) return;
    try {
      await api.deleteFile(file.id);
      setFiles((prev) => prev.filter((f) => f.id !== file.id));
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="main-page">
      <AppHeader subtitle={org ? `${org.name} · 3D model library` : '3D model library'} />

      <main className="content">
        {org && (
          <div className="org-banner">
            <div>
              <strong>{org.name}</strong>
              <span className="muted">
                {' '}· {org.member_count} member{org.member_count === 1 ? '' : 's'}
              </span>
            </div>
            {/* The server only sends the invite code to members who can manage members */}
            {org.invite_code && (
              <div className="invite-box">
                <span className="muted">Invite code:</span>
                <code className="invite-code">{org.invite_code}</code>
                <button className="btn small" onClick={copyInvite}>
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            )}
          </div>
        )}

        <div className="toolbar">
          <h2 className="section-title">GLB models</h2>
          {canUpload && (
            <div>
              <input
                ref={inputRef}
                type="file"
                accept=".glb"
                multiple
                hidden
                onChange={(e) => handleUpload(e.target.files)}
              />
              <button
                className="btn primary"
                disabled={uploading}
                onClick={() => inputRef.current?.click()}
              >
                {uploading ? 'Uploading…' : '+ Upload GLB'}
              </button>
            </div>
          )}
        </div>

        {error && <div className="form-error">{error}</div>}

        {loading ? (
          <div className="empty-state">Loading files…</div>
        ) : files.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📦</div>
            <h2>No models yet</h2>
            {canUpload ? (
              <>
                <p className="muted">Upload your first GLB file to get started.</p>
                <button
                  className="btn primary"
                  disabled={uploading}
                  onClick={() => inputRef.current?.click()}
                >
                  {uploading ? 'Uploading…' : 'Upload a file'}
                </button>
              </>
            ) : (
              <p className="muted">Your organization hasn't uploaded any models yet.</p>
            )}
          </div>
        ) : (
          <div className="table-scroll">
            <table className="file-table models-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Model</th>
                  <th>Category</th>
                  <th>Real size</th>
                  <th>Uploaded</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {files.map((file) => (
                  <tr key={file.id}>
                    <td className="thumb-cell">
                      {file.thumbnail ? (
                        <img
                          className="thumb"
                          src={file.thumbnail}
                          alt=""
                          title="Click to preview"
                          onClick={() => setPreviewFile(file)}
                        />
                      ) : (
                        <div
                          className="thumb thumb-placeholder"
                          title="Click to preview"
                          onClick={() => setPreviewFile(file)}
                        >
                          ▦
                        </div>
                      )}
                    </td>
                    <td className="model-cell">
                      <div className="file-name">{file.display_name || file.original_name}</div>
                      {file.display_name && (
                        <div className="muted model-filename">{file.original_name}</div>
                      )}
                      {file.ai_status === 'pending' && (
                        <div className="muted ai-note">Analysing…</div>
                      )}
                      {file.ai_status === 'failed' && (
                        <div className="ai-note ai-failed" title={file.ai_error}>
                          Analysis failed
                        </div>
                      )}
                      {file.description && <div className="muted model-desc">{file.description}</div>}
                      {file.tags?.length > 0 && (
                        <div className="tag-row">
                          {file.tags.map((tag) => (
                            <span key={tag} className="tag">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td>
                      {file.category ? (
                        <span className="badge">{categoryLabel(file.category)}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                      {file.ai_status === 'ready' && file.ai_confidence !== 'high' && (
                        <div className="muted ai-note" title="How sure the AI was">
                          AI · {file.ai_confidence} confidence
                        </div>
                      )}
                    </td>
                    <td className="nowrap">{formatSizeM(file) || <span className="muted">—</span>}</td>
                    <td className="nowrap">
                      {file.uploaded_by}
                      <div className="muted model-filename">{formatDate(file.uploaded_at)}</div>
                      <div className="muted model-filename">{formatSize(file.size_bytes)}</div>
                    </td>
                    <td className="row-actions wrap">
                      <div className="action-group">
                        <button
                          className="btn small primary"
                          onClick={() => setPreviewFile(file)}
                        >
                          Preview
                        </button>
                        <button
                          className="btn small"
                          onClick={() => api.downloadFile(file.id)}
                        >
                          Download
                        </button>
                        {canUpload && (
                          <button className="btn small" onClick={() => setEditing(file)}>
                            Details
                          </button>
                        )}
                        {canUpload && aiEnabled && file.thumbnail && file.ai_status !== 'pending' && (
                          <button
                            className="btn small"
                            title="Let the AI suggest a name, category and tags for this model"
                            onClick={() => describe(file)}
                          >
                            {file.ai_status === 'none' ? 'Describe with AI' : 'Re-run AI'}
                          </button>
                        )}
                        {canDelete(file) && (
                          <button
                            className="btn small danger"
                            onClick={() => handleDelete(file)}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {editing && (
        <ModelDetailsDialog
          file={editing}
          categories={categories}
          onSave={saveDetails}
          onClose={() => setEditing(null)}
        />
      )}

      {previewFile && (
        <ModelViewer
          file={previewFile}
          onClose={() => setPreviewFile(null)}
          onThumbnail={handleThumbnail}
        />
      )}
    </div>
  );
}
