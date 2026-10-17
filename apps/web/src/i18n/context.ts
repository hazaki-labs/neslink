import { createContext, useContext } from "react";
import { LOCALES, MESSAGES, type Locale, type Messages } from "./messages";

const STORAGE_KEY = "neslink:locale";

/** The saved choice, else the first browser language we support, else English. */
function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && (LOCALES as readonly string[]).includes(saved)) return saved as Locale;
  } catch {
    // Storage blocked; fall through to the browser languages.
  }
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = tag.toLowerCase().split("-")[0];
    if ((LOCALES as readonly string[]).includes(base)) return base as Locale;
  }
  return "en";
}

let current: Locale = detectLocale();

/** The locale in effect, for the provider's first render. */
export function currentLocale(): Locale {
  return current;
}

/** Called by the provider when the locale changes. */
export function rememberLocale(locale: Locale, persist: boolean): void {
  current = locale;
  if (!persist) return;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Not remembered across visits, but still switches now.
  }
}

/** Messages for code outside React (e.g. generating a default player name). */
export function messages(): Messages {
  return MESSAGES[current];
}

export interface I18n {
  locale: Locale;
  t: Messages;
  setLocale: (locale: Locale) => void;
}

export const I18nContext = createContext<I18n | null>(null);

export function useI18n(): I18n {
  const i18n = useContext(I18nContext);
  if (!i18n) throw new Error("useI18n must be used inside <I18nProvider>");
  return i18n;
}
