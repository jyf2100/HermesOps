import { useState, useEffect, useCallback } from "react";

export type Theme = "cyberpunk" | "dark" | "light";

const THEME_ORDER: Theme[] = ["cyberpunk", "dark", "light"];

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    const saved = localStorage.getItem("admin_theme");
    if (saved === "cyberpunk" || saved === "dark" || saved === "light") return saved;
    return "cyberpunk";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("admin_theme", theme);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
  }, []);

  const cycleTheme = useCallback(() => {
    setThemeState((prev) => {
      const idx = THEME_ORDER.indexOf(prev);
      return THEME_ORDER[(idx + 1) % THEME_ORDER.length];
    });
  }, []);

  return { theme, setTheme, cycleTheme } as const;
}
