import { useLocale, type Locale } from '../../i18n/index.js'

export default function Header() {
  const { locale, setLocale, t } = useLocale()

  return (
    <header className="h-14 bg-white border-b border-gray-200 flex items-center justify-between px-6">
      <div className="text-sm text-gray-500">{t('header.title')}</div>
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-1.5 text-xs text-gray-500">
          <span>{t('header.language')}</span>
          <select
            value={locale}
            onChange={(e) => setLocale(e.target.value as Locale)}
            className="border border-gray-300 rounded px-1.5 py-0.5 text-xs bg-white focus:outline-none focus:border-blue-400"
          >
            <option value="en">{t('header.language.en')}</option>
            <option value="zh">{t('header.language.zh')}</option>
          </select>
        </label>
        <span className="inline-flex items-center gap-1.5 text-xs">
          <span className="w-2 h-2 rounded-full bg-green-500" />
          {t('header.connected')}
        </span>
      </div>
    </header>
  )
}
