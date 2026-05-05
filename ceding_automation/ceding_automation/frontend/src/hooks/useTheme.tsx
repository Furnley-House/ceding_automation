import { createContext, useContext, useState, useEffect, ReactNode } from "react";

export type ThemeName = "ocean" | "furnley" | "forest" | "royal";

interface ThemeContextType {
  theme: ThemeName;
  setTheme: (theme: ThemeName) => void;
}

const ThemeContext = createContext<ThemeContextType>({ theme: "ocean", setTheme: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeName>(() => {
    return (localStorage.getItem("app-theme") as ThemeName) || "ocean";
  });

  useEffect(() => {
    localStorage.setItem("app-theme", theme);
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
