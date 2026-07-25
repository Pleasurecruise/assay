export type ThemePreference = "dark" | "light";

export const PREFERENCE_STORAGE_KEYS = {
  language: "assay.language:v1",
  legacyLanguage: "assay.language",
  sidebar: "assay.sidebar:v1",
  theme: "assay.theme:v1",
} as const;

type PreferenceStorageKey = (typeof PREFERENCE_STORAGE_KEYS)[keyof typeof PREFERENCE_STORAGE_KEYS];

export function readLocalPreference(key: PreferenceStorageKey): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocalPreference(key: PreferenceStorageKey, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeLocalPreference(key: PreferenceStorageKey): boolean {
  try {
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function initialThemePreference(): ThemePreference {
  const stored = readLocalPreference(PREFERENCE_STORAGE_KEYS.theme);
  if (stored === "dark" || stored === "light") {
    return stored;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyThemePreference(theme: ThemePreference, persist = false): boolean {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
  return !persist || writeLocalPreference(PREFERENCE_STORAGE_KEYS.theme, theme);
}

export function initialSidebarPreference(): boolean {
  return readLocalPreference(PREFERENCE_STORAGE_KEYS.sidebar) === "open";
}

export function persistSidebarPreference(isOpen: boolean): boolean {
  return writeLocalPreference(PREFERENCE_STORAGE_KEYS.sidebar, isOpen ? "open" : "closed");
}
