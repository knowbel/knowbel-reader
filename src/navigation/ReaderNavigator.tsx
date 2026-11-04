import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Redo2, Undo2 } from "lucide-react";
import { usePopover } from "../components/usePopover";

const IDLE_HIDE_MS = 1500;
const REVEAL_MARGIN_PX = 16;

interface ReaderNavigatorProps<Place> {
  ariaLabel: string;
  locationKey: string | number;
  locationLabel: string;
  // Nearest first, regardless of the reader's underlying location model.
  back: Place[];
  forward: Place[];
  placeLabel: (place: Place) => string;
  onBack: (steps: number) => void;
  onForward: (steps: number) => void;
  focusRequest: number;
  children: ReactNode;
}

// Both readers use the same floating control, history menu and reveal rules.
// Format-specific controls supply pages or sections without changing the shell.
export default function ReaderNavigator<Place>({ ariaLabel, locationKey, locationLabel,
  back, forward, placeLabel, onBack, onForward, focusRequest, children }: ReaderNavigatorProps<Place>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const [near, setNear] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const menu = usePopover();

  const idleTimerRef = useRef<number | undefined>(undefined);
  const reveal = () => {
    setActive(true);
    window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => setActive(false), IDLE_HIDE_MS);
  };
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  useEffect(() => () => window.clearTimeout(idleTimerRef.current), []);

  // Scrolling anywhere in the pane (scroll events don't bubble, but they do
  // pass through the capture phase), the pointer coming near, and a drag
  // on a page — hidden then, so it never sits over a selection being made
  // (a drag on the scrollbar isn't on a page, and keeps it up).
  useEffect(() => {
    const pane = rootRef.current?.parentElement;
    if (!pane) return;
    const handleScroll = () => revealRef.current();
    const handleMouseMove = (event: MouseEvent) => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      setNear(
        event.clientX >= rect.left - REVEAL_MARGIN_PX &&
          event.clientX <= rect.right + REVEAL_MARGIN_PX &&
          event.clientY >= rect.top - REVEAL_MARGIN_PX &&
          event.clientY <= rect.bottom + REVEAL_MARGIN_PX,
      );
    };
    const handleMouseLeave = () => setNear(false);
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button === 0 && (event.target as Element).closest?.(".page, .flow-document")) setDragging(true);
    };
    const handlePointerUp = () => setDragging(false);
    pane.addEventListener("scroll", handleScroll, { capture: true, passive: true });
    pane.addEventListener("wheel", handleScroll, { passive: true });
    pane.addEventListener("mousemove", handleMouseMove);
    pane.addEventListener("mouseleave", handleMouseLeave);
    pane.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      pane.removeEventListener("scroll", handleScroll, { capture: true });
      pane.removeEventListener("wheel", handleScroll);
      pane.removeEventListener("mousemove", handleMouseMove);
      pane.removeEventListener("mouseleave", handleMouseLeave);
      pane.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, []);

  // A new reading location, reached by scrolling, keyboard or a jump.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    revealRef.current();
  }, [locationKey]);

  // Not while the PDF is parked out of sight in Deep Dive.
  useEffect(() => {
    if (!focusRequest || rootRef.current?.closest(".pdf-pane-offscreen-host")) return;
    revealRef.current();
    rootRef.current?.querySelector<HTMLElement>("[data-navigation-location]")?.focus();
  }, [focusRequest]);

  const hasHistory = back.length > 0 || forward.length > 0;
  const visible = !dragging && (active || near || focused || menu.open);

  return (
    <div
      ref={rootRef}
      className={`page-nav${visible ? " page-nav--visible" : ""}`}
      role="toolbar"
      aria-label={ariaLabel}
      // Kept up while typing a page number or moving through it by keyboard
      // — not just because a button clicked with the mouse kept the focus.
      onFocus={(event) => setFocused(event.target.matches(":focus-visible"))}
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node)) setFocused(false);
      }}
    >
      {hasHistory ? (
        <>
          <button
            type="button"
            className="page-nav-button"
            onClick={() => onBack(1)}
            disabled={back.length === 0}
            title={back.length > 0 ? `Back to ${placeLabel(back[0])} (⌘←)` : "Back (⌘←)"}
            aria-label={back.length > 0 ? `Back to ${placeLabel(back[0])}` : "Back"}
          >
            <Undo2 width={14} height={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="page-nav-button"
            onClick={() => onForward(1)}
            disabled={forward.length === 0}
            title={forward.length > 0 ? `Forward to ${placeLabel(forward[0])} (⌘→)` : "Forward (⌘→)"}
            aria-label={forward.length > 0 ? `Forward to ${placeLabel(forward[0])}` : "Forward"}
          >
            <Redo2 width={14} height={14} aria-hidden="true" />
          </button>
          <div className="page-nav-anchor" ref={menu.ref}>
            <button
              type="button"
              className={`page-nav-button page-nav-caret${menu.open ? " active" : ""}`}
              onClick={() => menu.setOpen((open) => !open)}
              title="Places you've jumped between"
              aria-label="Places you've jumped between"
              aria-haspopup="menu"
              aria-expanded={menu.open}
            >
              <ChevronDown width={14} height={14} aria-hidden="true" />
            </button>
            {menu.open ? (
              <div className="page-nav-menu" role="menu">
                {[...forward].reverse().map((place, index) => (
                  <button
                    key={`forward-${index}`}
                    type="button"
                    role="menuitem"
                    className="page-nav-menu-item"
                    onClick={() => {
                      menu.setOpen(false);
                      onForward(forward.length - index);
                    }}
                  >
                    <Redo2 width={12} height={12} aria-hidden="true" />
                    {placeLabel(place)}
                  </button>
                ))}
                <div className="page-nav-menu-item page-nav-menu-current" aria-current="location">
                  <span className="page-nav-menu-dot" aria-hidden="true" />
                  {locationLabel} · here
                </div>
                {back.map((place, index) => (
                  <button
                    key={`back-${index}`}
                    type="button"
                    role="menuitem"
                    className="page-nav-menu-item"
                    onClick={() => {
                      menu.setOpen(false);
                      onBack(index + 1);
                    }}
                  >
                    <Undo2 width={12} height={12} aria-hidden="true" />
                    {placeLabel(place)}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <span className="page-nav-divider" role="separator" />
        </>
      ) : null}
      {children}
    </div>
  );
}
