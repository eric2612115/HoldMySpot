import { useEffect, useState, type ChangeEvent } from 'react';

/**
 * One photo: take it with the camera or pick a file, then see it before it is
 * sent. `name` tags the inputs (data-photo) so a test can hand them a file.
 */
export function PhotoField({ name, label, hint, file, onFile, disabled }: { name: string; label: string; hint: string; file: File | null; onFile: (f: File | null) => void; disabled?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
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
    if (f) onFile(f);
    e.target.value = '';
  };
  return (
    <div className={`q-photo${file ? ' has-photo' : ''}`}>
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
        <span>{file ? `${file.name || 'Photo'} · ready to send` : hint}</span>
        <div className="q-photo__buttons">
          <label className={`q-chipbtn${disabled ? ' is-disabled' : ''}`}>
            Take photo
            <input className="q-file" type="file" accept="image/*" capture="environment" onChange={pick} disabled={disabled} data-photo={`${name}-camera`} />
          </label>
          <label className={`q-chipbtn${disabled ? ' is-disabled' : ''}`}>
            {file ? 'Choose another' : 'Upload'}
            <input className="q-file" type="file" accept="image/jpeg,image/png,image/webp,image/*" onChange={pick} disabled={disabled} data-photo={name} />
          </label>
        </div>
      </div>
    </div>
  );
}
