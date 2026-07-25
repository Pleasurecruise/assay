import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import en from "@/locales/en.json";
import zhCN from "@/locales/zh-CN.json";
import {
  PREFERENCE_STORAGE_KEYS,
  readLocalPreference,
  removeLocalPreference,
  writeLocalPreference,
} from "@/lib/preferences";

export type Language = "en" | "zh-CN";
export type TranslationKey = keyof typeof en;
export type TranslationFunction = (
  key: TranslationKey,
  variables?: Readonly<Record<string, string | number>>,
) => string;

type LocaleShape = Record<TranslationKey, string>;
type ExactLocale<T extends LocaleShape> = T & Record<Exclude<keyof T, TranslationKey>, never>;

function defineLocale<T extends LocaleShape>(locale: ExactLocale<T>): T {
  return locale;
}

const locales = {
  en: defineLocale(en),
  "zh-CN": defineLocale(zhCN),
} satisfies Record<Language, LocaleShape>;

interface I18nContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: TranslationFunction;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function initialLanguage(): Language {
  const saved =
    readLocalPreference(PREFERENCE_STORAGE_KEYS.language) ??
    readLocalPreference(PREFERENCE_STORAGE_KEYS.legacyLanguage);
  const language =
    saved === "en" || saved === "zh-CN"
      ? saved
      : navigator.language.toLowerCase().startsWith("zh")
        ? "zh-CN"
        : "en";
  document.documentElement.lang = language;
  return language;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(initialLanguage);
  const setLanguage = useCallback((nextLanguage: Language) => {
    document.documentElement.lang = nextLanguage;
    setLanguageState(nextLanguage);
    if (writeLocalPreference(PREFERENCE_STORAGE_KEYS.language, nextLanguage)) {
      removeLocalPreference(PREFERENCE_STORAGE_KEYS.legacyLanguage);
    }
  }, []);

  const value = useMemo<I18nContextValue>(() => {
    const dictionary = locales[language];
    return {
      language,
      setLanguage,
      t(key, variables = {}) {
        return Object.entries(variables).reduce(
          (message, [name, variable]) => message.replaceAll(`{{${name}}}`, String(variable)),
          dictionary[key],
        );
      },
    };
  }, [language, setLanguage]);

  return <I18nContext value={value}>{children}</I18nContext>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (context === null) {
    throw new Error("useI18n must be used inside I18nProvider");
  }
  return context;
}

type CheckId =
  | "param-robustness"
  | "data-availability"
  | "cost-stress"
  | "regime-dependency"
  | "homogeneity-decay";

const CHECK_LABEL_KEYS = {
  "param-robustness": "check.param-robustness",
  "data-availability": "check.data-availability",
  "cost-stress": "check.cost-stress",
  "regime-dependency": "check.regime-dependency",
  "homogeneity-decay": "check.homogeneity-decay",
} as const satisfies Record<CheckId, TranslationKey>;

const SHORT_CHECK_LABEL_KEYS = {
  "param-robustness": "check.short.param-robustness",
  "data-availability": "check.short.data-availability",
  "cost-stress": "check.short.cost-stress",
  "regime-dependency": "check.short.regime-dependency",
  "homogeneity-decay": "check.short.homogeneity-decay",
} as const satisfies Record<CheckId, TranslationKey>;

export function checkLabel(t: TranslationFunction, id: CheckId, short = false) {
  return t(short ? SHORT_CHECK_LABEL_KEYS[id] : CHECK_LABEL_KEYS[id]);
}

export function conclusionLabel(
  t: TranslationFunction,
  conclusion:
    | "pass"
    | "pass_with_reservations"
    | "fail"
    | "insufficient_evidence"
    | "not_applicable",
) {
  const key = `conclusion.${conclusion}` as const;
  return t(key);
}
