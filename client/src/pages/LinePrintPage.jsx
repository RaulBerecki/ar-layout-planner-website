import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';

// Printable A4 sheet with a line's QR code at its exact physical size. The AR app registers
// the same image at that size, so the printout must not be scaled.
export default function LinePrintPage() {
  const { id } = useParams();
  const [line, setLine] = useState(null);
  const [qrUrl, setQrUrl] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let objectUrl = null;
    let cancelled = false;
    (async () => {
      try {
        const { lines } = await api.listLines();
        const found = lines.find((l) => String(l.id) === id);
        if (!found) throw new Error("This line doesn't exist, or you don't have access to it.");
        objectUrl = await api.getLineQrUrl(found.id);
        if (!cancelled) {
          setLine(found);
          setQrUrl(objectUrl);
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);

  const size = line ? `${line.marker_size_cm}cm` : undefined;

  return (
    <div className="print-page">
      <div className="print-toolbar no-print">
        <Link className="btn" to="/lines">
          ← Back to lines
        </Link>
        <button className="btn primary" onClick={() => window.print()} disabled={!qrUrl}>
          Print
        </button>
        <span className="muted">Print at 100% scale ("Actual size"), not "Fit to page".</span>
      </div>

      {error && <div className="form-error no-print">{error}</div>}

      {line && qrUrl && (
        <div className="print-sheet">
          <h1 className="print-title">{line.name}</h1>
          <img
            className="print-qr"
            src={qrUrl}
            alt={`QR code for ${line.name}`}
            style={{ width: size, height: size }}
          />
          <p className="print-code">{line.code}</p>
          <div className="print-ruler" />
          <p className="print-ruler-label">10 cm</p>
          <p className="print-note">
            The square must measure <strong>{line.marker_size_cm} cm</strong> and the ruler 10 cm.
            If it measures differently, set this line's QR code size to the measured value.
            Stick it flat next to the line, where it won't be moved.
          </p>
        </div>
      )}
    </div>
  );
}
