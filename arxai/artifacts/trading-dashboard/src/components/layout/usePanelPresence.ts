import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { PanelMode } from "./PanelController";

export function usePanelPresence(desired: PanelMode) {
  const ref = useRef<HTMLElement | null>(null);
  const rect = useRef<DOMRect | null>(null);
  const previous = useRef(desired);
  const [phase, setPhase] = useState<PanelMode | "opening" | "closing">(desired);
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  useLayoutEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const update = () => setReduced(media.matches);
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  useLayoutEffect(() => {
    if (reduced) { previous.current = desired; setPhase(desired); return; }
    if (previous.current === desired) return;
    previous.current = desired;
    setPhase(desired === "closed" ? "closing" : desired === "open" ? "opening" : "peek");
    if (desired === "peek") return;
    const timer = window.setTimeout(() => setPhase(desired), 200);
    return () => window.clearTimeout(timer);
  }, [desired, reduced]);
  useLayoutEffect(() => {
    if (phase === desired && desired !== "closed" && ref.current) rect.current = ref.current.getBoundingClientRect();
  });
  const snapshot = rect.current;
  const style: CSSProperties | undefined = phase === "closing" && snapshot ? {
    position: "fixed", top: snapshot.top, left: snapshot.left, width: snapshot.width, height: snapshot.height,
  } : undefined;
  const capture = () => { if (ref.current) rect.current = ref.current.getBoundingClientRect(); };
  return { ref, phase, style, reduced, capture };
}
