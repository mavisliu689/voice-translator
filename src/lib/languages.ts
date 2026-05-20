// Supported languages — keep in sync with server SUPPORTED_LANGS / /api/languages.
export const languages = [
  { code: 'zh-TW', name: '繁體中文', region: 'Taiwan' },
  { code: 'zh-CN', name: '简体中文', region: 'China' },
  { code: 'en', name: 'English', region: 'US' },
  { code: 'ja', name: 'Japanese', region: 'Japan' },
  { code: 'ko', name: 'Korean', region: 'Korea' },
  { code: 'es', name: 'Spanish', region: 'Spain' },
  { code: 'fr', name: 'French', region: 'France' },
  { code: 'de', name: 'German', region: 'Germany' },
  { code: 'pt', name: 'Portuguese', region: 'Brazil' },
  { code: 'ru', name: 'Russian', region: 'Russia' },
  { code: 'th', name: 'Thai', region: 'Thailand' },
  { code: 'vi', name: 'Vietnamese', region: 'Vietnam' },
  { code: 'id', name: 'Indonesian', region: 'Indonesia' },
  { code: 'it', name: 'Italian', region: 'Italy' },
] as const;

export const langName = (code: string): string =>
  languages.find((l) => l.code === code)?.name || code;

// Resolve browser language to our closest supported language code.
export const getBrowserLangCode = (): string => {
  const nav = navigator.language || 'en';
  const exact = languages.find((l) => l.code.toLowerCase() === nav.toLowerCase());
  if (exact) return exact.code;
  const prefix = nav.split('-')[0].toLowerCase();
  const partial = languages.find(
    (l) => l.code.toLowerCase() === prefix || l.code.toLowerCase().startsWith(prefix + '-'),
  );
  return partial?.code || 'en';
};

export const getBrowserLangName = (): string => langName(getBrowserLangCode());

// Speech recognition language hint mapping (BCP-47).
export const speechLangMap: Record<string, string> = {
  'zh-TW': 'zh-TW',
  'zh-CN': 'zh-CN',
  en: 'en-US',
  ja: 'ja-JP',
  ko: 'ko-KR',
  es: 'es-ES',
  fr: 'fr-FR',
  de: 'de-DE',
  pt: 'pt-BR',
  ru: 'ru-RU',
  th: 'th-TH',
  vi: 'vi-VN',
  id: 'id-ID',
  it: 'it-IT',
};
