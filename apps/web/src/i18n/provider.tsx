import { useEffect, useState, type ReactNode } from "react";
import { currentLocale, I18nContext, rememberLocale } from "./context";
import { HTML_LANG, MESSAGES, type Locale } from "./messages";

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(currentLocale);

  useEffect(() => {
    rememberLocale(locale, false);
    document.documentElement.lang = HTML_LANG[locale];
    document.querySelector('meta[name="description"]')?.setAttribute("content", MESSAGES[locale].meta.description);
  }, [locale]);

  const setLocale = (next: Locale) => {
    rememberLocale(next, true);
    setLocaleState(next);
  };

  return <I18nContext.Provider value={{ locale, t: MESSAGES[locale], setLocale }}>{children}</I18nContext.Provider>;
}
