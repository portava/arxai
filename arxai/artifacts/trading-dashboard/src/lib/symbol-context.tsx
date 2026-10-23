import React, { createContext, useContext, useEffect, useState } from "react";
import { ALL_SYMBOLS } from "@/lib/design-tokens";

interface SymbolContextValue {
  active: string;
  setActive: (s: string) => void;
  recent: string[];
}

const SymbolContext = createContext<SymbolContextValue | null>(null);

const STORAGE_KEY = "highroll.activeSymbol";
const RECENT_KEY = "highroll.recentSymbols";

export function SymbolProvider({ children }: { children: React.ReactNode }) {
  const [active, setActiveState] = useState<string>(() => {
    if (typeof window === "undefined") return ALL_SYMBOLS[0]!;
    return localStorage.getItem(STORAGE_KEY) || ALL_SYMBOLS[0]!;
  });
  const [recent, setRecent] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    } catch {
      return [];
    }
  });

  const setActive = (s: string) => {
    setActiveState(s);
    localStorage.setItem(STORAGE_KEY, s);
    setRecent((prev) => {
      const next = [s, ...prev.filter((x) => x !== s)].slice(0, 5);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      return next;
    });
  };

  useEffect(() => {
    if (!recent.length && active) {
      setRecent([active]);
      localStorage.setItem(RECENT_KEY, JSON.stringify([active]));
    }
  }, [active, recent.length]);

  return (
    <SymbolContext.Provider value={{ active, setActive, recent }}>
      {children}
    </SymbolContext.Provider>
  );
}

export function useActiveSymbol(): SymbolContextValue {
  const ctx = useContext(SymbolContext);
  if (!ctx) throw new Error("useActiveSymbol must be used within SymbolProvider");
  return ctx;
}

export function getCurrentSession(): "ASIA" | "LONDON" | "NEW_YORK" | "OFF" {
  const utcHour = new Date().getUTCHours();
  if (utcHour >= 0 && utcHour < 7) return "ASIA";
  if (utcHour >= 7 && utcHour < 13) return "LONDON";
  if (utcHour >= 13 && utcHour < 21) return "NEW_YORK";
  return "OFF";
}
