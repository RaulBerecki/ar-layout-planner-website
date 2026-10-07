import { useState } from 'react';

// Lets a person correct what the AI suggested. The AI's answer is a starting point, not
// the final word: whatever is saved here replaces it and is marked as human-edited.
export default function ModelDetailsDialog({ file, categories, onSave, onClose }) {
  const [displayName, setDisplayName] = useState(file.display_name || file.original_name);
  const [category, setCategory] = useState(file.category || '');
  const [tags, setTags] = useState((file.tags || []).join(', '));
  const [description, setDescription] = useState(file.description || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await onSave({
        display_name: displayName,
        category: category || null,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        description,
      });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="details-modal" onClick={(e) => e.stopPropagation()}>
        <div className="viewer-header">
          <strong className="viewer-title">Model details</strong>
          <button className="btn small" onClick={onClose}>
            Close ✕
          </button>
        </div>

        <form className="auth-form details-form" onSubmit={submit}>
          <label>
            Name
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={120}
              required
            />
          </label>
          <label>
            Category
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Not set</option>
              {categories.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Tags
            <input
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="separated by commas, e.g. robot, welding, 6-axis"
            />
          </label>
          <label>
            Description
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
            />
          </label>

          <div className="muted details-source">
            {file.ai_status === 'ready' && (
              <>
                Suggested by AI ({file.ai_model}), confidence {file.ai_confidence}. Correct
                anything that is wrong — your version is kept.
              </>
            )}
            {file.ai_status === 'edited' && <>Edited by a member of your organization.</>}
            {file.ai_status === 'failed' && <>The AI could not describe this model: {file.ai_error}</>}
            {file.ai_status === 'none' && <>No AI description yet.</>}
          </div>

          {error && <div className="form-error">{error}</div>}

          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </form>
      </div>
    </div>
  );
}
