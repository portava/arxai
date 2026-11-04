// The networked alerts journey is deliberately not part of a shell geometry fixture.
export function AlertsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  return open ? <div role="region" aria-label="Fixture alerts"><button onClick={onClose}>Close fixture alerts</button></div> : null;
}
