import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

// Keep the source DOM and its scroll position alive when the shared dive
// view moves between source/answer and parent/child answer panes.
export default function PersistentFlowPane({ children, workspace, dive, focused, guidedQuestions }: {
  children: ReactNode;
  workspace: RefObject<HTMLDivElement>;
  dive: RefObject<HTMLDivElement>;
  focused: string | null;
  guidedQuestions: boolean;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  if (!host.current) { host.current = document.createElement("div"); host.current.className = "persistent-flow-pane"; }
  const offscreen = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const move = () => {
      const target = focused ? dive.current ?? offscreen.current : workspace.current;
      if (target === host.current?.parentNode) return;
      const scroll = host.current!.querySelector(".flow-scroll");
      const top = scroll?.scrollTop ?? 0;
      target?.appendChild(host.current!);
      if (scroll) scroll.scrollTop = top;
    };
    move();
    // A lazy dive view can commit its root slot after this effect.
    if (focused && !dive.current) {
      const observer = new MutationObserver(() => { move(); if (dive.current) observer.disconnect(); });
      const sourceWorkspace = document.querySelector(".native-workspace");
      if (sourceWorkspace) observer.observe(sourceWorkspace, { childList: true, subtree: true });
      return () => observer.disconnect();
    }
  }, [focused, guidedQuestions, workspace, dive]);
  useLayoutEffect(() => () => host.current?.remove(), []);
  return <><div ref={offscreen} hidden />{createPortal(children, host.current)}</>;
}
