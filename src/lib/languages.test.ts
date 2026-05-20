import { describe, it, expect, vi } from 'vitest';
import { langName, getBrowserLangCode, speechLangMap, languages } from './languages';

describe('languages', () => {
  it('exposes a non-empty language list', () => {
    expect(languages.length).toBeGreaterThan(0);
  });

  it('langName returns the display name for a known code', () => {
    expect(langName('en')).toBe('English');
    expect(langName('zh-TW')).toBe('繁體中文');
  });

  it('langName falls back to the code itself for unknown codes', () => {
    expect(langName('xx-XX')).toBe('xx-XX');
  });

  it('speechLangMap covers every supported language', () => {
    for (const lang of languages) {
      expect(speechLangMap[lang.code]).toBeDefined();
    }
  });

  describe('getBrowserLangCode', () => {
    it('returns exact match when navigator.language matches a known code', () => {
      vi.stubGlobal('navigator', { language: 'zh-TW' });
      expect(getBrowserLangCode()).toBe('zh-TW');
      vi.unstubAllGlobals();
    });

    it('falls back to prefix match (en-GB → en)', () => {
      vi.stubGlobal('navigator', { language: 'en-GB' });
      expect(getBrowserLangCode()).toBe('en');
      vi.unstubAllGlobals();
    });

    it('defaults to en for completely unsupported locales', () => {
      vi.stubGlobal('navigator', { language: 'xx-XX' });
      expect(getBrowserLangCode()).toBe('en');
      vi.unstubAllGlobals();
    });
  });
});
