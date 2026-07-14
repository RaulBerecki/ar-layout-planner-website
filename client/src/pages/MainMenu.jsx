import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../AuthContext';
import { api } from '../api';
import ModelViewer from '../components/ModelViewer';
import { generateThumbnail } from '../utils/thumbnail';

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(dateStr) {
  // Postgres TIMESTAMPTZ arrives as an ISO string, e.g. "2026-07-12T17:36:28.000Z"
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? dateStr : d.toLocaleString();
}

export default function MainMenu() {
  const { user, logout } = useAuth();
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [previewFile, setPreviewFile] = useState(null);
  const [org, setOrg] = useState(null);
  const [copied, setCopied] = useState(false);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        let thumbnail = null;
        try {
          thumbnail = await generateThumbnail(await file.arrayBuffer());
        } catch {
          // thumbnail is optional — upload proceeds without one
        }
        await api.uploadFile(file, thumbnail);
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
      <header className="topbar">
        <div>
          <h1>AR Manufacturing Layout Planner</h1>
          <span className="muted">
            {org ? `${org.name} · 3D model library` : '3D model library'}
          </span>
        </div>
        <div className="topbar-right">
          <span className="muted">Signed in as <strong>{user?.username}</strong></span>
          <button className="btn ghost" onClick={logout}>Log out</button>
        </div>
      </header>

      <main className="content">
        {org && (
          <div className="org-banner">
            <div>
              <strong>{org.name}</strong>
              <span className="muted">
                {' '}· {org.member_count} member{org.member_count === 1 ? '' : 's'}
              </span>
            </div>
            <div className="invite-box">
              <span className="muted">Invite code:</span>
              <code className="invite-code">{org.invite_code}</code>
              <button className="btn small" onClick={copyInvite}>
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
        )}

        <div className="toolbar">
          <h2 className="section-title">GLB models</h2>
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
        </div>

        {error && <div className="form-error">{error}</div>}

        {loading ? (
          <div className="empty-state">Loading files…</div>
        ) : files.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📦</div>
            <h2>No models yet</h2>
            <p className="muted">Upload your first GLB file to get started.</p>
            <button
              className="btn primary"
              disabled={uploading}
              onClick={() => inputRef.current?.click()}
            >
              {uploading ? 'Uploading…' : 'Upload a file'}
            </button>
          </div>
        ) : (
          <table className="file-table">
            <thead>
              <tr>
                <th></th>
                <th>Name</th>
                <th>Size</th>
                <th>Uploaded by</th>
                <th>Uploaded at</th>
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
                  <td className="file-name">{file.original_name}</td>
                  <td>{formatSize(file.size_bytes)}</td>
                  <td>{file.uploaded_by}</td>
                  <td>{formatDate(file.uploaded_at)}</td>
                  <td className="row-actions">
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
                    {file.uploaded_by === user?.username && (
                      <button
                        className="btn small danger"
                        onClick={() => handleDelete(file)}
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>

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
