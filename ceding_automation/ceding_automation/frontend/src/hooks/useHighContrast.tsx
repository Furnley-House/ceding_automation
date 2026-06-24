import { createContext, useContext, useState, useEffect, ReactNode } from "react";

interface HighContrastContextType {
  enabled: boolean;
  toggle: () => void;
}

const HighContrastContext = createContext<HighContrastContextType>({
  enabled: false,
  toggle: () => {},
});

export function HighContrastProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState<boolean>(() => {
    return localStorage.getItem("fh-high-contrast") === "true";
  });

  useEffect(() => {
    localStorage.setItem("fh-high-contrast", String(enabled));
    if (enabled) {
      document.documentElement.setAttribute("data-contrast", "high");
    } else {
      document.documentElement.removeAttribute("data-contrast");
    }
  }, [enabled]);

  const toggle = () => setEnabled((v) => !v);

  return (
    <HighContrastContext.Provider value={{ enabled, toggle }}>
      {children}
    </HighContrastContext.Provider>
  );
}

export function useHighContrast() {
  return useContext(HighContrastContext);
}
