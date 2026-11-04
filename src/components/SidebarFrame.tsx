import type { ReactNode } from "react";

// All readers share the panel frame as well as its content and cards.
export default function SidebarFrame({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return <aside className="sidebar"><div className="sidebar-panel">
    <button type="button" className="sidebar-collapse-button" onClick={onClose}
      title="Collapse panel" aria-label="Collapse panel">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="15 6 9 12 15 18" />
      </svg>
    </button>
    {children}
  </div></aside>;
}
