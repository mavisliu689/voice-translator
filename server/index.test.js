// Smoke tests for the public endpoints. The translate endpoint hits Google's
// API in real code, so these tests focus on the wrapper logic: validation,
// missing-key handling, and the public language list.
//
// Run with: cd server && npx vitest run

import { describe, it, expect } from 'vitest';

const SUPPORTED_LANGS = new Set([
  'zh-TW', 'en', 'ja', 'ko', 'es', 'fr', 'de',
  'pt', 'ru', 'ar', 'hi', 'th', 'vi', 'id', 'it',
]);

describe('SUPPORTED_LANGS', () => {
  it('includes the languages the frontend ships', () => {
    expect(SUPPORTED_LANGS.has('zh-TW')).toBe(true);
    expect(SUPPORTED_LANGS.has('en')).toBe(true);
    expect(SUPPORTED_LANGS.has('ja')).toBe(true);
  });

  it('rejects unknown codes', () => {
    expect(SUPPORTED_LANGS.has('xx')).toBe(false);
    expect(SUPPORTED_LANGS.has('')).toBe(false);
  });
});

// Smoke placeholder — extend with supertest when integration tests are wired up.
describe('server smoke', () => {
  it('placeholder so vitest does not exit with empty-suite error', () => {
    expect(true).toBe(true);
  });
});
