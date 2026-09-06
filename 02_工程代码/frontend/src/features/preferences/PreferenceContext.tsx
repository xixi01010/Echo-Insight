import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";

export type AppearanceMode = "light" | "dark" | "system";
export type AccentTone = "echo" | "indigo" | "cyan" | "purple" | "green";
export type ProjectSort = "updated" | "name";
export type ContentDensity = "comfortable" | "compact";
export type AiOutputStyle = "concise" | "standard" | "detailed";

interface Preferences {
  appearance: AppearanceMode;
  accent: AccentTone;
  projectSort: ProjectSort;
  density: ContentDensity;
  aiOutputStyle: AiOutputStyle;
  showRiskBadges: boolean;
  favoriteProjectIds: string[];
}

interface PreferenceContextValue extends Preferences {
  updatePreference: <Key extends keyof Preferences>(key: Key, value: Preferences[Key]) => void;
  toggleFavoriteProject: (projectId: string) => void;
  resetPreferences: () => void;
}

const STORAGE_KEY = "echo-insight-ui-preferences-v2";
const DEFAULT_PREFERENCES: Preferences = {
  appearance: "light",
  accent: "echo",
  projectSort: "updated",
  density: "comfortable",
  aiOutputStyle: "standard",
  showRiskBadges: true,
  favoriteProjectIds: [],
};

const PreferenceContext = createContext<PreferenceContextValue | null>(null);

export function PreferenceProvider({ children }: PropsWithChildren) {
  const [preferences, setPreferences] = useState<Preferences>(readPreferences);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  }, [preferences]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyAppearance = () => {
      const resolvedTheme = preferences.appearance === "system"
        ? media.matches ? "dark" : "light"
        : preferences.appearance;
      document.documentElement.dataset.theme = resolvedTheme;
      document.documentElement.dataset.accent = preferences.accent;
      document.documentElement.dataset.density = preferences.density;
    };
    applyAppearance();
    media.addEventListener("change", applyAppearance);
    return () => media.removeEventListener("change", applyAppearance);
  }, [preferences.accent, preferences.appearance, preferences.density]);

  const value = useMemo<PreferenceContextValue>(() => ({
    ...preferences,
    updatePreference: (key, value) => {
      setPreferences((current) => ({ ...current, [key]: value }));
    },
    toggleFavoriteProject: (projectId) => {
      setPreferences((current) => ({
        ...current,
        favoriteProjectIds: current.favoriteProjectIds.includes(projectId)
          ? current.favoriteProjectIds.filter((id) => id !== projectId)
          : [...current.favoriteProjectIds, projectId],
      }));
    },
    resetPreferences: () => setPreferences(DEFAULT_PREFERENCES),
  }), [preferences]);

  return <PreferenceContext.Provider value={value}>{children}</PreferenceContext.Provider>;
}

export function usePreferences(): PreferenceContextValue {
  const context = useContext(PreferenceContext);
  if (!context) throw new Error("usePreferences must be used inside PreferenceProvider.");
  return context;
}

function readPreferences(): Preferences {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<Preferences>;
    return {
      appearance: isOneOf(stored.appearance, ["light", "dark", "system"]) ? stored.appearance : DEFAULT_PREFERENCES.appearance,
      accent: isOneOf(stored.accent, ["echo", "indigo", "cyan", "purple", "green"]) ? stored.accent : DEFAULT_PREFERENCES.accent,
      projectSort: isOneOf(stored.projectSort, ["updated", "name"]) ? stored.projectSort : DEFAULT_PREFERENCES.projectSort,
      density: isOneOf(stored.density, ["comfortable", "compact"]) ? stored.density : DEFAULT_PREFERENCES.density,
      aiOutputStyle: isOneOf(stored.aiOutputStyle, ["concise", "standard", "detailed"]) ? stored.aiOutputStyle : DEFAULT_PREFERENCES.aiOutputStyle,
      showRiskBadges: typeof stored.showRiskBadges === "boolean" ? stored.showRiskBadges : DEFAULT_PREFERENCES.showRiskBadges,
      favoriteProjectIds: Array.isArray(stored.favoriteProjectIds) ? stored.favoriteProjectIds.filter((id): id is string => typeof id === "string") : DEFAULT_PREFERENCES.favoriteProjectIds,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function isOneOf<Value extends string>(value: unknown, values: readonly Value[]): value is Value {
  return typeof value === "string" && values.includes(value as Value);
}
