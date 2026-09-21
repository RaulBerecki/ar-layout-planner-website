import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import AppHeader from '../components/AppHeader';

// Opened when someone scans a line's QR code with a normal phone camera: the code in the
// address identifies the line.
export default function LineLandingPage() {
  const { code } = useParams();
  const [line, setLine] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .listLines()
      .then(({ lines }) => {
        const found = lines.find((l) => l.code === String(code).toUpperCase());
        if (found) setLine(found);
        else setError("This line doesn't exist, or you don't have access to it.");
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [code]);

  return (
    <div className="main-page">
      <AppHeader subtitle="Production line" />
      <main className="content">
        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : error ? (
          <div className="empty-state">
            <div className="empty-icon">🔒</div>
            <h2>Line not available</h2>
            <p className="muted">{error}</p>
            <Link className="btn" to="/lines">
              All lines
            </Link>
          </div>
        ) : (
          <div className="panel">
            <h2 className="section-title">{line.name}</h2>
            <p>
              Your role on this line: <strong>{line.role}</strong>
              {line.permissions.includes('line.edit') ? ' · you can edit its layout' : ' · view only'}
            </p>
            <p className="muted">
              To see this line in augmented reality, open the AR Manufacturing Layout Planner app on
              your phone and point the camera at this QR code.
            </p>
            <div className="row-actions start">
              <Link className="btn primary" to={`/lines/${line.id}/print`}>
                Print QR code
              </Link>
              <Link className="btn" to="/lines">
                All lines
              </Link>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
