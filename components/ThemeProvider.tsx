"use client";

import { useEffect } from "react";
import { applyTheme, loadTheme, THEME_CHANGED_EVENT } from "@/lib/theme";

export default function ThemeProvider() {
  useEffect(() => {
    const refresh = () => applyTheme(loadTheme());
    refresh();
    window.addEventListener(THEME_CHANGED_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(THEME_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  return null;
}
