import { useEffect, useState, type ChangeEvent } from 'react';
import { stampPhoto, type StampInfo } from './stamp';

/**
 * One photo: take it with the camera or pick a file, then see it before it is
 * sent. `name` tags the inputs (data-photo) so a test can hand them a file.
 * With `stamp`, the app draws the code, the time and the shop on the photo
 * (D-159) and the preview shows the stamped photo that will be sent.
 */
export function PhotoField({ name, label, hint, file, onFile, disabled, stamp }: { name: string; label: string; hint: string; file: File | null; onFile: (f: File | null) => void; disabled?: boolean; stamp?: StampInfo | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [stamping, setStamping] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    e.target.value = '';
    if (!f) return;
    setProblem(null);
    if (!stamp) {
      onFile(f);
      return;
    }
    setStamping(true);
    stampPhoto(f, stamp)
      .then(onFile)
      .catch((err: unknown) => setProblem(err instanceof Error ? err.message : 'The photo could not be prepared.'))
      .finally(() => setStamping(false));
  };
  const off = disabled || stamping;
  return (
    <div className={`q-photo${file ? ' has-photo' : ''}${file && stamp ? ' is-stamped' : ''}`}>
      <div className="q-photo__frame">
        {url ? (
          <img src={url} alt={label} />
        ) : (
          <svg width="30" height="30" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 8h3l2-2.5h6L17 8h3v11H4z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            <circle cx="12" cy="13" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
          </svg>
        )}
      </div>
      <div className="q-photo__body">
        <strong>{label}</strong>
        <span>{problem ?? (stamping ? 'Adding the stamp…' : file ? (stamp ? 'Stamped by the app · ready to send' : `${file.name || 'Photo'} · ready to send`) : hint)}</span>
        <div className="q-photo__buttons">
          <label className={`q-chipbtn${off ? ' is-disabled' : ''}`}>
            Take photo
            <input className="q-file" type="file" accept="image/*" capture="environment" onChange={pick} disabled={off} data-photo={`${name}-camera`} />
          </label>
          <label className={`q-chipbtn${off ? ' is-disabled' : ''}`}>
            {file ? 'Choose another' : 'Upload'}
            <input className="q-file" type="file" accept="image/jpeg,image/png,image/webp,image/*" onChange={pick} disabled={off} data-photo={name} />
          </label>
        </div>
      </div>
    </div>
  );
}
