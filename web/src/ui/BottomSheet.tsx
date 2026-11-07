import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A bottom sheet that slides up over the map. Drag the handle down (or tap
 * the map above it) to close. Reports its height so the map can frame the
 * selected point above it.
 */
export function BottomSheet({
  open,
  onClose,
  onHeight,
  children,
  label,
}: {
  open: boolean;
  onClose: () => void;
  onHeight?: (px: number) => void;
  children: ReactNode;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(0);
  const start = useRef<{ y: number; id: number } | null>(null);
  // The scrim closes the sheet only for a tap that also started on the scrim.
  // A tap on the map that opened the sheet must not close it with its own
  // follow-up click (touch screens send that click after the sheet is up).
  const pressedScrim = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || !onHeight) return;
    const ro = new ResizeObserver(() => onHeight(open ? el.getBoundingClientRect().height : 0));
    ro.observe(el);
    onHeight(open ? el.getBoundingClientRect().height : 0);
    return () => ro.disconnect();
  }, [open, onHeight]);

  useEffect(() => {
    if (!open) {
      // Do not leave keyboard focus inside a hidden sheet.
      const active = document.activeElement as HTMLElement | null;
      if (active && ref.current?.contains(active)) active.blur();
      return;
    }
    pressedScrim.current = false;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      <div
        className={`scrim${open ? ' is-open' : ''}`}
        onPointerDown={() => {
          pressedScrim.current = true;
        }}
        onClick={() => {
          if (pressedScrim.current) onClose();
          pressedScrim.current = false;
        }}
        aria-hidden="true"
      />
      <div
        ref={ref}
        className={`sheet${open ? ' is-open' : ''}${drag ? ' is-dragging' : ''}`}
        style={drag ? { transform: `translateY(${drag}px)` } : undefined}
        role="dialog"
        aria-modal="false"
        aria-label={label}
        aria-hidden={!open}
        inert={!open}
      >
        <div
          className="sheet__grip"
          onPointerDown={(e) => {
            start.current = { y: e.clientY, id: e.pointerId };
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!start.current || start.current.id !== e.pointerId) return;
            setDrag(Math.max(0, e.clientY - start.current.y));
          }}
          onPointerUp={(e) => {
            if (!start.current || start.current.id !== e.pointerId) return;
            const moved = e.clientY - start.current.y;
            start.current = null;
            setDrag(0);
            if (moved > 90) onClose();
          }}
        >
          <span className="sheet__handle" />
        </div>
        <div className="sheet__body">{children}</div>
      </div>
    </>
  );
}
