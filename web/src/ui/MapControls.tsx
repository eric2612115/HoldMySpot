/**
 * The round buttons on the right edge: switch between the tilted street view
 * and the top-down overview, and "back to me" (like a map app's locate
 * button), which flies to the player's position from either view.
 */
export function MapControls({
  overview,
  locating,
  hidden,
  onToggleView,
  onLocate,
}: {
  overview: boolean;
  locating: boolean;
  hidden: boolean;
  onToggleView: () => void;
  onLocate: () => void;
}) {
  return (
    <div className={`map-controls${hidden ? ' is-hidden' : ''}`}>
      <button type="button" className="map-button" onClick={onToggleView} aria-label={overview ? 'Back to the street view' : 'Show every task on a map'} title={overview ? 'Street view' : 'Overview'}>
        {overview ? (
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
            <path d="M4 7.5l8 4.5 8-4.5M12 12v9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 6.5l6-2.5 6 2.5 6-2.5v13.5l-6 2.5-6-2.5-6 2.5z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
            <path d="M9 4v13.5M15 6.5V20" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
        )}
        <span>{overview ? '3D' : 'Map'}</span>
      </button>
      <button type="button" className={`map-button is-locate${locating ? ' is-busy' : ''}`} onClick={onLocate} aria-label="Back to me" title="Back to me">
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="4.2" fill="currentColor" />
          <circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
