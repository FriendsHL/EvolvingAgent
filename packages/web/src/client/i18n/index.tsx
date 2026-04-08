/**
 * Tiny i18n provider for the dashboard.
 *
 * Design notes:
 * - Two locales (en / zh). EN is the source of truth — its dict typing
 *   defines the canonical key set. ZH is `Partial`, so missing keys
 *   transparently fall back to EN.
 * - `t(key, fallback?, vars?)` never throws on a missing key — it returns
 *   the explicit fallback, or the EN string, or the key itself. This lets
 *   us roll the i18n out across pages incrementally without breaking any
 *   page that hasn't been touched yet.
 * - Locale persists in localStorage under `ea-locale`. The first visit
 *   defaults to the browser's preferred language if it starts with `zh`,
 *   otherwise EN.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { en, type TranslationKey } from './locales/en.js'
import { zh } from './locales/zh.js'

export type Locale = 'en' | 'zh'

const DICTS: Record<Locale, Partial<Record<TranslationKey, string>>> = {
  en,
  zh,
}

const STORAGE_KEY = 'ea-locale'

function detectInitialLocale(): Locale {
  if (typeof window === 'undefined') return 'en'
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (saved === 'en' || saved === 'zh') return saved
  } catch {
    // localStorage may be disabled in privacy mode.
  }
  const nav = window.navigator?.language ?? ''
  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

interface LocaleContextValue {
  locale: Locale
  setLocale: (l: Locale) => void
  t: (key: string, fallback?: string, vars?: Record<string, string | number>) => string
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = vars[name]
    return v === undefined ? `{${name}}` : String(v)
  })
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectInitialLocale)

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, locale)
    } catch {
      // Ignore — non-fatal.
    }
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
    }
  }, [locale])

  const setLocale = useCallback((l: Locale) => setLocaleState(l), [])

  const t = useCallback(
    (key: string, fallback?: string, vars?: Record<string, string | number>): string => {
      const dict = DICTS[locale]
      const fromLocale = dict[key as TranslationKey]
      if (fromLocale !== undefined) return interpolate(fromLocale, vars)
      // Fallback chain: explicit fallback → EN dict → raw key.
      if (fallback !== undefined) return interpolate(fallback, vars)
      const fromEn = en[key as TranslationKey]
      if (fromEn !== undefined) return interpolate(fromEn, vars)
      return key
    },
    [locale],
  )

  const value = useMemo<LocaleContextValue>(() => ({ locale, setLocale, t }), [locale, setLocale, t])

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext)
  if (!ctx) {
    // Be forgiving: outside a Provider, fall back to EN with no-op setter.
    return {
      locale: 'en',
      setLocale: () => {},
      t: (key, fallback) => fallback ?? en[key as TranslationKey] ?? key,
    }
  }
  return ctx
}

/** Convenience hook — most call sites only need `t`. */
export function useT() {
  return useLocale().t
}
