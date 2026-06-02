import type { Admin, TranslateResult, UsageRecord, UsageSummary } from '../types';

export const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL ?? '') as string;
export const AUTH_TOKEN_KEY = 'vt_admin_token';
export const AUTH_USERNAME_KEY = 'vt_admin_username';

// ─── Public: translation ───────────────────────────────────────────────────

export async function translate(
  text: string,
  target: string,
  source?: string,
): Promise<TranslateResult> {
  const body: Record<string, string> = { text, target };
  if (source && source !== 'auto') body.source = source;

  const res = await fetch(`${BACKEND_URL}/api/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}) as { error?: string });
    throw new Error(errorData.error || '翻譯請求失敗');
  }

  const data = await res.json();
  if (!data.success || !data.translation) {
    throw new Error('無法取得翻譯結果');
  }
  return {
    translation: data.translation,
    detectedLang: data.detectedSourceLanguage || data.source || '?',
    char_count: data.char_count ?? 0,
    estimated_cost_usd: data.estimated_cost_usd ?? 0,
  };
}

// ─── Auth ──────────────────────────────────────────────────────────────────

export interface LoginResponse {
  token: string;
  username: string;
}

export async function login(username: string, password: string): Promise<LoginResponse> {
  const res = await fetch(`${BACKEND_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '登入失敗');
  return data as LoginResponse;
}

// ─── Authed fetch factory ──────────────────────────────────────────────────

export function makeAuthedFetch(getToken: () => string | null, onUnauthorized: () => void) {
  return async function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = { ...((init.headers as Record<string, string>) || {}) };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { ...init, headers });
    if (res.status === 401) onUnauthorized();
    return res;
  };
}

// ─── Usage (protected) ─────────────────────────────────────────────────────

export async function fetchUsageSummary(
  authedFetch: (u: string, i?: RequestInit) => Promise<Response>,
  period: 'week' | 'month' | 'all',
): Promise<UsageSummary | null> {
  const query = period !== 'all' ? `?period=${period}` : '';
  const res = await authedFetch(`${BACKEND_URL}/api/usage/summary${query}`);
  return res.ok ? (res.json() as Promise<UsageSummary>) : null;
}

export async function fetchUsageRecent(
  authedFetch: (u: string, i?: RequestInit) => Promise<Response>,
): Promise<UsageRecord[]> {
  const res = await authedFetch(`${BACKEND_URL}/api/usage/recent`);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : data.records || [];
}

// ─── Admins (protected) ────────────────────────────────────────────────────

export async function fetchAdmins(
  authedFetch: (u: string, i?: RequestInit) => Promise<Response>,
): Promise<Admin[]> {
  const res = await authedFetch(`${BACKEND_URL}/api/admins`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.admins || [];
}

export async function createAdmin(
  authedFetch: (u: string, i?: RequestInit) => Promise<Response>,
  username: string,
  password: string,
): Promise<void> {
  const res = await authedFetch(`${BACKEND_URL}/api/admins`, {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || '新增失敗');
  }
}

export async function deleteAdmin(
  authedFetch: (u: string, i?: RequestInit) => Promise<Response>,
  id: number,
): Promise<void> {
  const res = await authedFetch(`${BACKEND_URL}/api/admins/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || '刪除失敗');
  }
}

// ─── Settings (protected) ──────────────────────────────────────────────────

export type TranslationModel = 'basic' | 'premium';

export interface AppSettings {
  active_model: TranslationModel;
  gemini_configured: boolean;
  available_models: TranslationModel[];
}

export async function fetchSettings(
  authedFetch: (u: string, i?: RequestInit) => Promise<Response>,
): Promise<AppSettings | null> {
  const res = await authedFetch(`${BACKEND_URL}/api/settings`);
  if (!res.ok) return null;
  return res.json() as Promise<AppSettings>;
}

export async function updateSettings(
  authedFetch: (u: string, i?: RequestInit) => Promise<Response>,
  active_model: TranslationModel,
): Promise<void> {
  const res = await authedFetch(`${BACKEND_URL}/api/settings`, {
    method: 'PUT',
    body: JSON.stringify({ active_model }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || '儲存失敗');
  }
}
