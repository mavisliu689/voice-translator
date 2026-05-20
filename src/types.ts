export interface TranslationHistoryItem {
  id: number;
  source: string;
  translation: string;
  detectedLang: string;
  targetLang: string;
  timestamp: string;
  char_count?: number;
  estimated_cost_usd?: number;
}

export interface TranslateResult {
  translation: string;
  detectedLang: string;
  char_count?: number;
  estimated_cost_usd?: number;
}

export interface Admin {
  id: number;
  username: string;
  created_at: string;
}

export interface UsageSummary {
  total_chars: number;
  total_cost_estimated: number;
  estimated_cost_usd?: number;
  actual_cost: number;
  total_requests: number;
  free_remaining: number;
  free_tier_limit: number;
  free_limit?: number;
  month: string;
}

export interface UsageRecord {
  id: number;
  timestamp: string;
  source_lang: string;
  target_lang: string;
  char_count: number;
  estimated_cost_usd: number;
}
