import { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, MicOff, Volume2, ArrowRightLeft, Copy, AlertCircle, Shield, BarChart3, ChevronLeft, LogOut, UserPlus, Trash2, Users, Settings, Sparkles, Zap } from 'lucide-react';
import {
  languages,
  langName,
  getBrowserLangCode,
  getBrowserLangName,
  speechLangMap,
} from './lib/languages';
import {
  AUTH_TOKEN_KEY,
  AUTH_USERNAME_KEY,
  ApiError,
  translate,
  login as apiLogin,
  makeAuthedFetch,
  fetchUsageSummary,
  fetchUsageRecent,
  fetchAdmins as apiFetchAdmins,
  createAdmin,
  deleteAdmin,
  fetchSettings,
  updateSettings,
  fetchLiveStatus,
  updateLiveSettings,
  type AppSettings,
  type TranslationModel,
  type LiveSettingsUpdate,
} from './lib/api';
import {
  useIsEmbed,
  useLockBodyScroll,
  useParentMessages,
  postTranslationResultToParent,
  injectPulseStyleOnce,
} from './hooks/useEmbedMode';
import { useLiveTranslate, type LiveStatus, type LiveAudioSource } from './hooks/useLiveTranslate';
import type { TranslationHistoryItem, Admin, UsageSummary, UsageRecord } from './types';

injectPulseStyleOnce();

// Monotonic history id: one final event split into several sentences submits
// them in the same millisecond, and raw Date.now() would collide — duplicate
// React keys and an order-degenerate insert below (1).
let lastHistoryId = 0;
const nextHistoryId = () => (lastHistoryId = Math.max(lastHistoryId + 1, Date.now()));

// Insert a history item by submission order (id = submission sequence, newest
// first): with retry/backoff a later-submitted sentence can finish translating
// first, and plain prepend would then show utterances out of order (F2).
const insertHistoryItem = (prev: TranslationHistoryItem[], item: TranslationHistoryItem): TranslationHistoryItem[] => {
  const idx = prev.findIndex(h => h.id < item.id);
  return (idx === -1 ? [...prev, item] : [...prev.slice(0, idx), item, ...prev.slice(idx)]).slice(0, 20);
};

const VoiceTranslator = () => {
  const isEmbed = useIsEmbed();

  const [isListening, setIsListening] = useState(false);
  const [sourceText, setSourceText] = useState('');
  const [interimText, setInterimText] = useState('');
  const [interimTranslation, setInterimTranslation] = useState('');
  const [liveSubtitle, setLiveSubtitle] = useState(true);
  const [sourceLang, setSourceLang] = useState('auto');
  const [targetLang, setTargetLang] = useState('en');
  const [, setIsTranslating] = useState(false);
  const [copiedItem, setCopiedItem] = useState<{ id: number; type: 'source' | 'translation' } | null>(null);
  const [error, setError] = useState('');
  const [micPermission, setMicPermission] = useState('prompt');
  const [detectedLang, setDetectedLang] = useState<string | null>(null);

  const [translationHistory, setTranslationHistory] = useState<TranslationHistoryItem[]>([]);
  const [currentSentence, setCurrentSentence] = useState('');

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const [isSupported, setIsSupported] = useState(false);
  const restartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentenceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interimTranslateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastInterimTranslatedRef = useRef('');
  // Last un-finalized interim transcript, so onend/stop can fold it into the
  // sentence buffer instead of the browser silently discarding it (Fix 1).
  const pendingInterimRef = useRef('');
  // Timestamp of the most recent recognition.start(), to throttle onend-driven
  // restarts: a long session restarts immediately, a just-started one (no-speech
  // loop) is padded out to 1s (Fix 2).
  const lastStartAtRef = useRef(0);
  // Submission-time de-dup: sentenceTimeout and stopListening can each flush the
  // same sentence once (double-flush). Guarding at submission (not completion)
  // keeps the duplicate from hitting the API, history, and the embed parent
  // alike; a same-text submission within 2s is dropped, so legitimate repeats
  // spoken later still record. Map (not just the last submission) because a
  // multi-sentence final under StrictMode's double-invoked updater interleaves
  // A,B,A,B — which slips past a last-only guard (B, 2).
  const lastSubmitRef = useRef(new Map<string, number>()); // text → submittedAt
  // Bumped to cancel in-flight translations on mode switch / unmount — the retry
  // loop compares after every await and bails silently on mismatch. Deliberately
  // NOT bumped by stopListening: a sentence finished before Stop should still
  // complete its translation (F1).
  const translateRunRef = useRef(0);
  const isListeningRef = useRef(false);
  const targetLangRef = useRef(targetLang);
  const sourceLangRef = useRef(sourceLang);
  const liveSubtitleRef = useRef(liveSubtitle);
  const currentSentenceRef = useRef('');
  const stopListeningRef = useRef<(() => void) | null>(null);

  // Embed-specific state
  const [embedView, setEmbedView] = useState<'translate' | 'usage'>('translate');
  const [showLangPicker, setShowLangPicker] = useState<'source' | 'target' | null>(null);
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [usageRecent, setUsageRecent] = useState<UsageRecord[]>([]);
  const [usagePeriod, setUsagePeriod] = useState<'week' | 'month' | 'all'>('week');

  // Auth & admin management state
  const [authToken, setAuthToken] = useState<string | null>(() => localStorage.getItem(AUTH_TOKEN_KEY));
  const [authUsername, setAuthUsername] = useState<string | null>(() => localStorage.getItem(AUTH_USERNAME_KEY));
  const [usageSubView, setUsageSubView] = useState<'usage' | 'admins' | 'settings'>('usage');
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [loginError, setLoginError] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [admins, setAdmins] = useState<Admin[]>([]);
  const [newAdminForm, setNewAdminForm] = useState({ username: '', password: '' });
  const [adminActionError, setAdminActionError] = useState('');
  const [adminActionBusy, setAdminActionBusy] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [settingsNotice, setSettingsNotice] = useState('');

  // Live Translate (Gemini 3.5 Live) — high-quality realtime mode
  const [liveMode, setLiveMode] = useState(false);
  const [liveAvailable, setLiveAvailable] = useState(false);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('idle');
  const [liveAudioSource, setLiveAudioSource] = useState<LiveAudioSource>('mic');
  const [liveCapDraft, setLiveCapDraft] = useState(''); // admin cost-cap input draft
  const liveBusyRef = useRef(false); // true while a Live session is connecting/active

  // Keep refs in sync
  useEffect(() => { isListeningRef.current = isListening; }, [isListening]);
  useEffect(() => { targetLangRef.current = targetLang; }, [targetLang]);
  useEffect(() => { sourceLangRef.current = sourceLang; }, [sourceLang]);
  useEffect(() => { liveSubtitleRef.current = liveSubtitle; }, [liveSubtitle]);
  useEffect(() => { currentSentenceRef.current = currentSentence; }, [currentSentence]);

  useLockBodyScroll(isEmbed);
  // Ignore parent-driven target changes while a Live session is running — the
  // session's target is fixed at connect time, so a mid-session change would
  // silently produce wrong-language output. (Reads liveBusyRef rather than
  // liveStatus so the guard is always current regardless of when it re-binds.)
  useParentMessages({ onSetTargetLang: (lang) => { if (!liveBusyRef.current) setTargetLang(lang); } });

  useEffect(() => {
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      setIsSupported(true);
    }
    checkMicrophonePermission();
  }, []);

  const checkMicrophonePermission = async () => {
    try {
      if (navigator.permissions) {
        const permission = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        setMicPermission(permission.state);
        permission.addEventListener('change', () => setMicPermission(permission.state));
      }
    } catch { /* ignore */ }
  };

  const requestMicrophonePermission = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
      setMicPermission('granted');
      setError('');
      return true;
    } catch (err) {
      const e = err as Error & { name: string };
      setMicPermission('denied');
      if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        setError('麥克風權限被拒絕。請在瀏覽器設定中允許使用麥克風。');
      } else if (e.name === 'NotFoundError') {
        setError('找不到麥克風設備。');
      } else {
        setError('無法存取麥克風：' + e.message);
      }
      return false;
    }
  };

  // Translate using backend API.
  // Retry 429 (rate limit) and network errors with backoff — a burst of fast
  // speech trips the per-minute limit, and retrying recovers the sentence
  // rather than dropping it. 3 attempts total: fail → wait 3s → wait 6s (Fix 3).
  const translateText = async (text: string, target: string, source?: string) => {
    if (!text) return null;
    const run = translateRunRef.current; // cancellation token for this call (F1)
    setIsTranslating(true);
    setError('');
    const backoffs = [3000, 6000];
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await translate(text, target, source);
          if (translateRunRef.current !== run) return null; // cancelled while awaiting
          return result;
        } catch (err) {
          if (translateRunRef.current !== run) return null; // cancelled: no error UI
          const retryable =
            (err instanceof ApiError && err.status === 429) ||
            err instanceof TypeError; // fetch() rejects with TypeError on network failure
          if (retryable && attempt < backoffs.length) {
            await new Promise(r => setTimeout(r, backoffs[attempt]));
            if (translateRunRef.current !== run) return null; // cancelled during backoff
            continue;
          }
          const msg = err instanceof Error ? err.message : String(err);
          // 429 = rate limited (often just talking fast); show the backend's gentle
          // notice as-is rather than framing it as a hard "翻譯失敗".
          if (err instanceof ApiError && err.status === 429) setError(msg);
          else if (msg.includes('ECONNREFUSED')) setError('無法連接到翻譯服務');
          else if (msg.includes('Network')) setError('網路連線失敗');
          else setError(`翻譯失敗: ${msg}`);
          return null;
        }
      }
    } finally {
      setIsTranslating(false);
    }
  };

  const translateAndAddToHistory = useCallback(async (text: string, target: string, source?: string) => {
    // Same-text submission within 2s = double-flush; drop it before it costs an
    // API call or reaches history/postMessage (B, 2).
    const now = Date.now();
    const submittedAt = lastSubmitRef.current.get(text);
    if (submittedAt !== undefined && now - submittedAt < 2000) return;
    for (const [t, at] of lastSubmitRef.current) {
      if (now - at >= 2000) lastSubmitRef.current.delete(t); // prune expired entries
    }
    lastSubmitRef.current.set(text, now);
    // Capture the ordering key + timestamp at submission, not completion (F2).
    const id = nextHistoryId();
    const timestamp = new Date().toISOString();

    const result = await translateText(text, target, source);
    if (result) {
      setDetectedLang(result.detectedLang);

      // Auto-switch target language if detected source matches current target
      const detectedBase = result.detectedLang.split('-')[0].toLowerCase();
      const targetBase = target.split('-')[0].toLowerCase();
      if (detectedBase === targetBase && sourceLangRef.current === 'auto') {
        // Switch target to a complementary language: Chinese<->English
        const isZh = detectedBase === 'zh';
        const newTarget = isZh ? 'en' : 'zh-TW';
        setTargetLang(newTarget);
        // Re-translate with new target
        const retried = await translateText(text, newTarget, source);
        if (retried) {
          const newItem = {
            id,
            source: text,
            translation: retried.translation,
            detectedLang: retried.detectedLang,
            targetLang: newTarget,
            timestamp,
            char_count: retried.char_count ?? 0,
            estimated_cost_usd: retried.estimated_cost_usd ?? 0,
          };
          setTranslationHistory(prev => insertHistoryItem(prev, newItem));
          postTranslationResultToParent(newItem);
        }
        return;
      }

      const newItem = {
        id,
        source: text,
        translation: result.translation,
        detectedLang: result.detectedLang,
        targetLang: target,
        timestamp,
        char_count: result.char_count ?? 0,
        estimated_cost_usd: result.estimated_cost_usd ?? 0,
      };
      setTranslationHistory(prev => insertHistoryItem(prev, newItem));
      postTranslationResultToParent(newItem);
    }
  }, []);

  // ── Live Translate (Gemini 3.5 Live) ──────────────────────────────────────
  // Commit a finalized Live utterance straight to history (translation already
  // came back from the model — no extra /api/translate call needed).
  const addLiveItemToHistory = useCallback((source: string, translation: string, target: string) => {
    if (!source && !translation) return;
    const item = {
      id: nextHistoryId(), // monotonic — rapid commits in the same ms must not collide (1)
      source,
      translation,
      detectedLang: 'auto',
      targetLang: target, // the language THIS session translated into (not the live ref)
      timestamp: new Date().toISOString(),
      char_count: 0,
      estimated_cost_usd: 0,
    };
    // turnComplete is the authoritative utterance boundary — no content de-dup,
    // which would wrongly drop legitimate repeats like 「好」「謝謝」.
    setTranslationHistory(prev => [item, ...prev].slice(0, 20));
    postTranslationResultToParent(item);
  }, []);

  const { start: liveStart, stop: liveStop } = useLiveTranslate({
    onPartial: (s, t) => { setCurrentSentence(s); setInterimTranslation(t); },
    onCommit: (s, t, target) => { addLiveItemToHistory(s, t, target); setCurrentSentence(''); setInterimTranslation(''); },
    onError: (m) => setError(m),
    onStatus: (st) => setLiveStatus(st),
  });

  // Fetch public Live availability once (the embed has no auth but still needs
  // to know whether to offer the mode, and why it's locked if so).
  useEffect(() => {
    fetchLiveStatus().then(s => setLiveAvailable(s.available));
  }, []);

  // Keep liveBusyRef in sync for the parent-message guard above.
  useEffect(() => { liveBusyRef.current = liveStatus === 'live' || liveStatus === 'connecting'; }, [liveStatus]);

  // Keep the admin cost-cap input in sync with loaded settings.
  useEffect(() => {
    if (appSettings) setLiveCapDraft(String(appSettings.live_cost_cap_usd ?? 100));
  }, [appSettings]);

  const toggleLive = useCallback(async () => {
    if (liveStatus === 'connecting' || liveStatus === 'live') { liveStop(); return; }
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
      setError('高品質翻譯需要在 HTTPS 網站上使用。');
      return;
    }
    // Re-check availability at click time — admin may have hit the kill switch or
    // the monthly cap may have locked Live since the page loaded.
    const st = await fetchLiveStatus();
    if (!st.available) {
      setLiveAvailable(false);
      setError(st.reason || '高品質翻譯目前無法使用。');
      return;
    }
    setError(''); setCurrentSentence(''); setInterimText(''); setInterimTranslation('');
    await liveStart(targetLang, liveAudioSource, true);
  }, [liveStart, liveStop, liveStatus, targetLang, liveAudioSource]);

  // Switch between free (Web Speech) and high-quality (Live) modes, stopping
  // whatever is currently running first.
  const switchLiveMode = useCallback((toLive: boolean) => {
    if (liveMode === toLive) return;
    // Cancel older in-flight translations (esp. retries sleeping in backoff) so
    // stale free-mode results don't land mid-Live-session. Bumped BEFORE the
    // stop below, so the sentence that stop flushes still completes (F1).
    translateRunRef.current++;
    if (isListeningRef.current) stopListeningRef.current?.();
    if (liveStatus === 'live' || liveStatus === 'connecting') liveStop();
    setCurrentSentence(''); setInterimText(''); setInterimTranslation(''); setError('');
    setLiveMode(toLive);
  }, [liveMode, liveStatus, liveStop]);

  // Debounced live-subtitle preview: translate the in-progress (interim) speech
  // so users see the translation update as they speak, before the sentence finalizes.
  const scheduleInterimTranslation = useCallback((text: string) => {
    if (interimTranslateTimeoutRef.current) clearTimeout(interimTranslateTimeoutRef.current);
    interimTranslateTimeoutRef.current = setTimeout(async () => {
      const trimmed = text.trim();
      if (!trimmed || trimmed === lastInterimTranslatedRef.current) return;
      lastInterimTranslatedRef.current = trimmed;
      try {
        const result = await translate(trimmed, targetLangRef.current, sourceLangRef.current);
        // Drop stale results: only show if still listening and this text is still the latest
        if (result && isListeningRef.current && lastInterimTranslatedRef.current === trimmed) {
          setInterimTranslation(result.translation);
        }
      } catch { /* preview errors are non-fatal */ }
      // 1100ms: only translate the live-subtitle preview on a real speech pause,
      // not on every interim result — this is the main source of request volume
      // for long sentences (esp. languages without ./。/?/！ sentence breaks like
      // Thai), which is what trips the backend rate limit (429).
    }, 1100);
  }, []);

  const toggleListening = async () => {
    if (!isSupported) {
      setError('您的瀏覽器不支援語音識別功能。請使用 Chrome、Edge 或 Safari。');
      return;
    }
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
      setError('語音識別需要在 HTTPS 網站上使用。');
      return;
    }
    if (isListening) {
      stopListening();
    } else {
      const ok = await requestMicrophonePermission();
      if (ok) startListening();
    }
  };

  // Arm the 1200ms "sentence finished" flush: if no further speech arrives,
  // translate whatever is buffered and clear it. Shared by the onresult final
  // branch and the onend interim-fold path (Fix 1).
  const armSentenceFlush = () => {
    if (sentenceTimeoutRef.current) clearTimeout(sentenceTimeoutRef.current);
    sentenceTimeoutRef.current = setTimeout(() => {
      setCurrentSentence(prev => {
        if (prev?.trim()) translateAndAddToHistory(prev.trim(), targetLangRef.current, sourceLangRef.current);
        return '';
      });
      setInterimTranslation('');
      lastInterimTranslatedRef.current = '';
    }, 1200);
  };

  // Fold any un-finalized interim into the sentence buffer and re-arm the flush,
  // so text the browser never finalized isn't dropped when its session ends
  // (Fix 1). Also cancels the pending live-subtitle preview debounce — it refers
  // to interim text that has just been folded (E2).
  const foldPendingInterim = () => {
    const pending = pendingInterimRef.current.trim();
    if (!pending) return;
    pendingInterimRef.current = '';
    if (interimTranslateTimeoutRef.current) { clearTimeout(interimTranslateTimeoutRef.current); interimTranslateTimeoutRef.current = null; }
    setInterimText('');
    setCurrentSentence(prev => (prev ? prev + ' ' + pending : pending));
    armSentenceFlush();
  };

  // Fold any pending interim into the buffered sentence and submit it NOW with
  // an explicit source language. Used by Stop (current language) and by a
  // source-language switch, which must tag the remnant with the OLD language —
  // the deferred 1200ms flush would read sourceLangRef after it already points
  // at the new one and mistranslate (3).
  const flushBufferedSentence = (source: string) => {
    const pending = pendingInterimRef.current.trim();
    pendingInterimRef.current = '';
    setInterimText('');
    setInterimTranslation('');
    lastInterimTranslatedRef.current = '';

    setCurrentSentence(prev => {
      const combined = pending ? (prev ? prev + ' ' + pending : pending) : prev;
      if (combined?.trim()) translateAndAddToHistory(combined.trim(), targetLangRef.current, source);
      return '';
    });

    if (sentenceTimeoutRef.current) { clearTimeout(sentenceTimeoutRef.current); sentenceTimeoutRef.current = null; }
    if (interimTranslateTimeoutRef.current) { clearTimeout(interimTranslateTimeoutRef.current); interimTranslateTimeoutRef.current = null; }
  };

  const startListening = () => {
    try {
      const SpeechRecognitionCtor = window.webkitSpeechRecognition || window.SpeechRecognition;
      if (!SpeechRecognitionCtor) {
        setError('您的瀏覽器不支援語音識別功能。');
        return;
      }
      // A restart timer armed for the old instance would call start() on the new
      // one (already started → throws → pointless full rebuild); kill it (E1).
      if (restartTimeoutRef.current) { clearTimeout(restartTimeoutRef.current); restartTimeoutRef.current = null; }
      if (recognitionRef.current) {
        // Rebuilding (e.g. to apply a source-language change): fold the old
        // instance's pending interim into the sentence buffer, then fully detach
        // before stop(). A late final from the dying instance would otherwise
        // clobber the new session's pending interim and mix old-language text
        // into the new sentence (C).
        foldPendingInterim();
        recognitionRef.current.onresult = null;
        recognitionRef.current.onend = null;
        recognitionRef.current.onerror = null;
        try { recognitionRef.current.stop(); } catch { /* */ }
        recognitionRef.current = null;
      }

      const recognition = new SpeechRecognitionCtor();
      recognition.continuous = true;
      recognition.interimResults = true;
      // When auto-detect, use browser language as speech recognition hint (empty string falls back to OS default which is unreliable)
      const effectiveLang = sourceLang !== 'auto' ? sourceLang : getBrowserLangCode();
      recognition.lang = speechLangMap[effectiveLang] || effectiveLang;
      recognition.maxAlternatives = 1;
      recognitionRef.current = recognition;

      recognition.onstart = () => {
        setIsListening(true);
        setError('');
      };

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        let finalTranscript = '';
        let interimTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalTranscript += transcript;
          } else {
            interimTranscript += transcript;
          }
        }

        if (finalTranscript) {
          const newText = finalTranscript.trim();
          const sentenceEnders = /[。！？.!?\n]/g;
          const currentTarget = targetLangRef.current;

          setCurrentSentence(prev => {
            const combined = prev ? prev + ' ' + newText : newText;
            const parts = combined.split(sentenceEnders);

            if (parts.length > 1) {
              for (let i = 0; i < parts.length - 1; i++) {
                const sentence = parts[i].trim();
                if (sentence) translateAndAddToHistory(sentence, currentTarget, sourceLangRef.current);
              }
              return parts[parts.length - 1].trim();
            }
            // 連續講話常沒有句尾標點、也等不到 3 秒靜音,句子會無限累積不送出;
            // 超過長度上限就強制斷句送翻譯（也順帶防超過後端 5000 字元上限）。
            // ponytail: 固定 50 字上限,若要按語意斷句再升級。StrictMode 的
            // updater 雙呼叫由提交時刻的 de-dup guard 吸收。
            if (combined.length >= 50) {
              translateAndAddToHistory(combined, currentTarget, sourceLangRef.current);
              return '';
            }
            return combined;
          });

          armSentenceFlush();

          // A final supersedes the buffered interim — but the same event may
          // already carry the NEXT utterance's interim; keep that one (D).
          pendingInterimRef.current = interimTranscript;
          // Cancel the pending preview debounce: it refers to interim text the
          // final result just replaced (E2).
          if (interimTranslateTimeoutRef.current) { clearTimeout(interimTranslateTimeoutRef.current); interimTranslateTimeoutRef.current = null; }
          setInterimText('');
          setInterimTranslation('');
          lastInterimTranslatedRef.current = '';
        } else if (interimTranscript) {
          setInterimText(interimTranscript);
          // Remember the latest un-finalized interim so onend/stop can fold it
          // into the sentence buffer instead of the browser discarding it (Fix 1).
          pendingInterimRef.current = interimTranscript;
          // User is still speaking: push the pending flush out so a folded
          // remnant isn't translated as a fragment mid-utterance (E3).
          if (sentenceTimeoutRef.current && currentSentenceRef.current) armSentenceFlush();
          if (liveSubtitleRef.current) {
            const preview = currentSentenceRef.current
              ? currentSentenceRef.current + ' ' + interimTranscript
              : interimTranscript;
            scheduleInterimTranslation(preview);
          }
        }
      };

      recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
        switch (event.error) {
          case 'not-allowed':
            setError('麥克風權限被拒絕。');
            setMicPermission('denied');
            setIsListening(false);
            break;
          case 'no-speech':
          case 'network':
            break;
          case 'audio-capture':
            setError('找不到麥克風。');
            setIsListening(false);
            break;
          default:
            if (event.error !== 'aborted') {
              setError(`語音識別錯誤: ${event.error}`);
              setIsListening(false);
            }
        }
      };

      recognition.onend = () => {
        // Fold any un-finalized interim before the browser discards it on
        // session end — otherwise the phrase spoken right before onend is lost;
        // the re-armed flush emits it if no further speech follows (Fix 1).
        foldPendingInterim();

        if (isListeningRef.current) {
          if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current);
          // Restart immediately after a long session; only pad up to 1s when the
          // session was just started (no-speech loop) to avoid a hot restart loop.
          // This replaces the fixed 250ms delay that dropped ~250ms of speech on
          // every recognizer cycle (Fix 2).
          const delay = Math.max(0, 1000 - (Date.now() - lastStartAtRef.current));
          restartTimeoutRef.current = setTimeout(() => {
            if (isListeningRef.current && recognitionRef.current) {
              lastStartAtRef.current = Date.now();
              try { recognitionRef.current.start(); } catch {
                try { startListening(); } catch { setIsListening(false); }
              }
            }
          }, delay);
        } else {
          setIsListening(false);
        }
      };

      lastStartAtRef.current = Date.now();
      recognition.start();
    } catch (err) {
      setError('無法啟動語音識別：' + (err instanceof Error ? err.message : String(err)));
      setIsListening(false);
    }
  };

  const stopListening = () => {
    setIsListening(false);

    // Fold + submit the trailing phrase so speech right before Stop isn't
    // dropped (Fix 1).
    flushBufferedSentence(sourceLangRef.current);

    if (restartTimeoutRef.current) { clearTimeout(restartTimeoutRef.current); restartTimeoutRef.current = null; }

    if (recognitionRef.current) {
      // Detach everything before stop(): the fold above already captured the
      // tail, a late final would re-enter the emptied sentence buffer and
      // translate the same speech a second time (A), and a late onstart would
      // flip the UI back to "listening" after a quick start→stop (5).
      recognitionRef.current.onstart = null;
      recognitionRef.current.onresult = null;
      recognitionRef.current.onend = null;
      recognitionRef.current.onerror = null;
      try { recognitionRef.current.stop(); } catch { /* */ }
      recognitionRef.current = null;
    }
  };

  // Keep the latest stopListening in a ref so mode-switch logic can stop an
  // in-progress Web Speech session without ordering/closure hazards.
  useEffect(() => { stopListeningRef.current = stopListening; });

  // recognition.lang is baked in at construction (Web Speech API can't switch
  // languages on a live instance), so a source-language change mid-session is
  // silently ignored — the running recognizer keeps decoding with the OLD
  // language (e.g. still "listening in Chinese" after the user picks Thai).
  // Rebuild the recognizer so the new language hint actually takes effect.
  const prevSourceLangRef = useRef(sourceLang);
  useEffect(() => {
    if (prevSourceLangRef.current === sourceLang) return;
    const oldLang = prevSourceLangRef.current;
    prevSourceLangRef.current = sourceLang;
    if (isListeningRef.current) {
      // Submit any old-language remnant NOW, explicitly tagged with the OLD
      // source: sourceLangRef already points at the new language, so a deferred
      // flush would send old-language text as the new one (3). This empties the
      // buffers, making the rebuild's foldPendingInterim a no-op.
      flushBufferedSentence(oldLang);
      startListening();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceLang]);

  const speakText = (text: string, lang: string) => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = speechLangMap[lang] || lang;
      u.rate = 0.9;
      window.speechSynthesis.speak(u);
    }
  };

  useEffect(() => {
    return () => {
      // Cancel in-flight translations/retries (F1). Mutable counter, not a DOM
      // node ref — reading the latest value at cleanup is exactly the intent.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      translateRunRef.current++;
      isListeningRef.current = false;
      if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current);
      if (sentenceTimeoutRef.current) clearTimeout(sentenceTimeoutRef.current);
      if (interimTranslateTimeoutRef.current) clearTimeout(interimTranslateTimeoutRef.current);
      if (recognitionRef.current) {
        // Same detach discipline as stopListening, minus the tail-flush — an
        // unmounting component must not fire one last translation (5).
        recognitionRef.current.onstart = null;
        recognitionRef.current.onresult = null;
        recognitionRef.current.onend = null;
        recognitionRef.current.onerror = null;
        try { recognitionRef.current.stop(); } catch { /* */ }
        recognitionRef.current = null;
      }
    };
  }, []);

  // ── Auth helpers ──────────────────────────────────────────────────────────
  const persistAuth = useCallback((token: string | null, username: string | null) => {
    setAuthToken(token);
    setAuthUsername(username);
    if (token) localStorage.setItem(AUTH_TOKEN_KEY, token);
    else localStorage.removeItem(AUTH_TOKEN_KEY);
    if (username) localStorage.setItem(AUTH_USERNAME_KEY, username);
    else localStorage.removeItem(AUTH_USERNAME_KEY);
  }, []);

  const handleLogout = useCallback(() => {
    persistAuth(null, null);
    setUsageSubView('usage');
    setUsageSummary(null);
    setUsageRecent([]);
    setAdmins([]);
  }, [persistAuth]);

  const authTokenRef = useRef(authToken);
  useEffect(() => { authTokenRef.current = authToken; }, [authToken]);

  // Memoise an authed-fetch tied to the current token ref; recreated only when
  // the logout handler identity changes (i.e. essentially once).
  const authedFetch = useCallback(
    (url: string, init?: RequestInit) =>
      makeAuthedFetch(() => authTokenRef.current, handleLogout)(url, init),
    [handleLogout],
  );

  const handleLogin = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!loginForm.username.trim() || !loginForm.password) {
      setLoginError('請輸入帳號與密碼');
      return;
    }
    setLoginBusy(true);
    setLoginError('');
    try {
      const data = await apiLogin(loginForm.username, loginForm.password);
      persistAuth(data.token, data.username);
      setLoginForm({ username: '', password: '' });
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : '無法連線到伺服器');
    } finally {
      setLoginBusy(false);
    }
  }, [loginForm, persistAuth]);

  // Fetch usage data when switching to usage view (requires auth)
  const fetchUsageData = useCallback(async () => {
    if (!authToken) return;
    try {
      const [summary, recent] = await Promise.all([
        fetchUsageSummary(authedFetch, usagePeriod),
        fetchUsageRecent(authedFetch),
      ]);
      if (summary) setUsageSummary(summary);
      setUsageRecent(recent);
    } catch {
      // Silently fail - usage is informational
    }
  }, [authToken, authedFetch, usagePeriod]);

  const fetchAdmins = useCallback(async () => {
    if (!authToken) return;
    try {
      setAdmins(await apiFetchAdmins(authedFetch));
    } catch { /* ignore */ }
  }, [authToken, authedFetch]);

  const handleAddAdmin = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    setAdminActionError('');
    if (!newAdminForm.username.trim() || !newAdminForm.password) {
      setAdminActionError('請輸入帳號與密碼');
      return;
    }
    setAdminActionBusy(true);
    try {
      await createAdmin(authedFetch, newAdminForm.username, newAdminForm.password);
      setNewAdminForm({ username: '', password: '' });
      fetchAdmins();
    } catch (err) {
      setAdminActionError(err instanceof Error ? err.message : '無法連線到伺服器');
    } finally {
      setAdminActionBusy(false);
    }
  }, [authedFetch, fetchAdmins, newAdminForm]);

  const handleDeleteAdmin = useCallback(async (id: number, username: string) => {
    if (!window.confirm(`確定要刪除管理員「${username}」嗎？`)) return;
    setAdminActionError('');
    try {
      await deleteAdmin(authedFetch, id);
      fetchAdmins();
    } catch (err) {
      setAdminActionError(err instanceof Error ? err.message : '無法連線到伺服器');
    }
  }, [authedFetch, fetchAdmins]);

  const loadSettings = useCallback(async () => {
    if (!authToken) return;
    setSettingsError('');
    try {
      const s = await fetchSettings(authedFetch);
      if (s) setAppSettings(s);
    } catch {
      setSettingsError('無法載入設定');
    }
  }, [authToken, authedFetch]);

  const handleChangeModel = useCallback(async (model: TranslationModel) => {
    if (!appSettings || appSettings.active_model === model) return;
    setSettingsBusy(true);
    setSettingsError('');
    setSettingsNotice('');
    try {
      await updateSettings(authedFetch, model);
      setAppSettings(s => (s ? { ...s, active_model: model } : s));
      setSettingsNotice(model === 'premium' ? '已切換為高品質模式' : '已切換為標準模式');
      window.setTimeout(() => setSettingsNotice(''), 2500);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : '儲存失敗');
    } finally {
      setSettingsBusy(false);
    }
  }, [appSettings, authedFetch]);

  useEffect(() => {
    if (embedView !== 'usage' || !authToken) return;
    if (usageSubView === 'usage') fetchUsageData();
    else if (usageSubView === 'admins') fetchAdmins();
    else if (usageSubView === 'settings') loadSettings();
  }, [embedView, authToken, usageSubView, fetchUsageData, fetchAdmins, loadSettings]);

  const handleSaveLiveSettings = useCallback(async (update: LiveSettingsUpdate) => {
    setSettingsBusy(true); setSettingsError(''); setSettingsNotice('');
    try {
      await updateLiveSettings(authedFetch, update);
      setSettingsNotice('已更新即時翻譯設定');
      window.setTimeout(() => setSettingsNotice(''), 2500);
      await loadSettings();
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : '儲存失敗');
    } finally {
      setSettingsBusy(false);
    }
  }, [authedFetch, loadSettings]);

  // Unified "recording" state + mic handler across free (Web Speech) and Live modes.
  const recActive = liveMode ? (liveStatus === 'connecting' || liveStatus === 'live') : isListening;
  const liveBusy = liveStatus === 'connecting' || liveStatus === 'live';
  // While a Live session runs its target language is fixed at connect time, so lock
  // the target picker; the source is auto-detected in Live mode, so lock that too.
  const lockTarget = liveBusy;
  const lockSource = liveMode;
  const onMicClick = () => { if (liveMode) toggleLive(); else toggleListening(); };

  // ── EMBED MODE UI ────────────────────────────────────────────────────────────
  if (isEmbed) {

    // ── USAGE VIEW (admin-protected) ──
    if (embedView === 'usage') {
      const containerStyle: React.CSSProperties = { height: '100dvh', background: '#faf9f6', color: '#2d2d2d', fontFamily: 'system-ui, sans-serif', touchAction: 'none' };

      // Not authenticated → login form
      if (!authToken) {
        return (
          <div className="h-screen w-screen flex flex-col overflow-hidden fixed inset-0" style={containerStyle}>
            <div className="flex items-center gap-3 px-5 py-4 flex-shrink-0">
              <button onClick={() => setEmbedView('translate')} className="p-1.5 rounded-xl transition-colors" style={{ color: '#888888' }}>
                <ChevronLeft className="w-5 h-5" />
              </button>
              <span className="text-xs tracking-widest uppercase" style={{ color: '#888888', letterSpacing: '0.15em' }}>後台登入</span>
            </div>
            <div className="flex-1 overflow-y-auto px-5 pb-6 flex flex-col items-center justify-center">
              <form onSubmit={handleLogin} className="w-full max-w-sm rounded-2xl p-6" style={{ background: '#ffffff', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                <p className="text-xs tracking-widest uppercase mb-5 text-center" style={{ color: '#888888', letterSpacing: '0.15em' }}>請輸入管理員帳號</p>
                <input
                  type="text"
                  autoComplete="username"
                  placeholder="帳號"
                  value={loginForm.username}
                  onChange={(e) => setLoginForm(f => ({ ...f, username: e.target.value }))}
                  className="w-full px-4 py-3 rounded-xl text-base outline-none mb-3"
                  style={{ background: '#faf9f6', border: '1px solid #e8e4df', color: '#2d2d2d' }}
                />
                <input
                  type="password"
                  autoComplete="current-password"
                  placeholder="密碼"
                  value={loginForm.password}
                  onChange={(e) => setLoginForm(f => ({ ...f, password: e.target.value }))}
                  className="w-full px-4 py-3 rounded-xl text-base outline-none mb-4"
                  style={{ background: '#faf9f6', border: '1px solid #e8e4df', color: '#2d2d2d' }}
                />
                {loginError && (
                  <div className="mb-3 px-3 py-2 rounded-xl text-sm" style={{ background: '#fef2f2', color: '#c75050', border: '1px solid #fecaca' }}>
                    {loginError}
                  </div>
                )}
                <button
                  type="submit"
                  disabled={loginBusy}
                  className="w-full py-3 rounded-xl font-medium transition-all disabled:opacity-60"
                  style={{ background: '#c8956c', color: '#ffffff' }}
                >
                  {loginBusy ? '登入中...' : '登入'}
                </button>
              </form>
            </div>
          </div>
        );
      }

      const topBar = (
        <>
          <div className="flex items-center justify-between gap-3 px-5 py-4 flex-shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <button onClick={() => setEmbedView('translate')} className="p-1.5 rounded-xl transition-colors flex-shrink-0" style={{ color: '#888888' }}>
                <ChevronLeft className="w-5 h-5" />
              </button>
              <span className="text-xs tracking-widest uppercase truncate" style={{ color: '#888888', letterSpacing: '0.15em' }}>
                {usageSubView === 'usage' ? '用量統計' : usageSubView === 'admins' ? '管理員管理' : '系統設定'}
              </span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="text-xs" style={{ color: '#888888' }}>{authUsername}</span>
              <button onClick={handleLogout} className="p-1.5 rounded-xl transition-colors" style={{ color: '#888888' }} title="登出">
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Sub-view tabs */}
          <div className="flex gap-2 px-5 mb-4 flex-shrink-0">
            {([['usage', '用量', BarChart3], ['admins', '管理員', Users], ['settings', '設定', Settings]] as const).map(([key, label, Icon]) => (
              <button
                key={key}
                onClick={() => setUsageSubView(key)}
                className="px-4 py-1.5 rounded-full text-sm transition-all flex items-center gap-1.5"
                style={{
                  background: usageSubView === key ? '#c8956c' : '#ffffff',
                  color: usageSubView === key ? '#ffffff' : '#888888',
                  fontWeight: usageSubView === key ? 600 : 400,
                  boxShadow: usageSubView === key ? 'none' : '0 1px 3px rgba(0,0,0,0.06)',
                }}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </div>
        </>
      );

      // ── Admins sub-view ──
      if (usageSubView === 'admins') {
        return (
          <div className="h-screen w-screen flex flex-col overflow-hidden fixed inset-0" style={containerStyle}>
            {topBar}
            <div className="flex-1 overflow-y-auto px-5 pb-6" style={{ scrollbarWidth: 'thin', scrollbarColor: '#e8e4df transparent', touchAction: 'pan-y', WebkitOverflowScrolling: 'touch' } as React.CSSProperties}>
              {/* New admin form */}
              <form onSubmit={handleAddAdmin} className="rounded-2xl p-5 mb-5" style={{ background: '#ffffff', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                <p className="text-xs tracking-widest uppercase mb-4" style={{ color: '#888888', letterSpacing: '0.15em' }}>新增管理員</p>
                <input
                  type="text"
                  placeholder="帳號（3-32 字元）"
                  value={newAdminForm.username}
                  onChange={(e) => setNewAdminForm(f => ({ ...f, username: e.target.value }))}
                  className="w-full px-4 py-3 rounded-xl text-base outline-none mb-3"
                  style={{ background: '#faf9f6', border: '1px solid #e8e4df', color: '#2d2d2d' }}
                />
                <input
                  type="password"
                  placeholder="密碼（至少 6 字元）"
                  value={newAdminForm.password}
                  onChange={(e) => setNewAdminForm(f => ({ ...f, password: e.target.value }))}
                  className="w-full px-4 py-3 rounded-xl text-base outline-none mb-3"
                  style={{ background: '#faf9f6', border: '1px solid #e8e4df', color: '#2d2d2d' }}
                />
                {adminActionError && (
                  <div className="mb-3 px-3 py-2 rounded-xl text-sm" style={{ background: '#fef2f2', color: '#c75050', border: '1px solid #fecaca' }}>
                    {adminActionError}
                  </div>
                )}
                <button
                  type="submit"
                  disabled={adminActionBusy}
                  className="w-full py-3 rounded-xl font-medium transition-all flex items-center justify-center gap-2 disabled:opacity-60"
                  style={{ background: '#c8956c', color: '#ffffff' }}
                >
                  <UserPlus className="w-4 h-4" />
                  {adminActionBusy ? '處理中...' : '新增'}
                </button>
              </form>

              {/* Admin list */}
              <p className="text-xs tracking-widest uppercase mb-3" style={{ color: '#888888', letterSpacing: '0.15em' }}>現有管理員（{admins.length}）</p>
              <div className="space-y-2">
                {admins.length === 0 ? (
                  <p className="text-sm py-6 text-center" style={{ color: '#888888' }}>載入中...</p>
                ) : (
                  admins.map(admin => (
                    <div key={admin.id} className="rounded-2xl p-4 flex items-center justify-between" style={{ background: '#ffffff', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                      <div className="min-w-0">
                        <p className="text-sm" style={{ color: '#2d2d2d' }}>
                          {admin.username}
                          {admin.username === authUsername && <span className="ml-2 text-xs" style={{ color: '#c8956c' }}>（你）</span>}
                        </p>
                        <p className="text-xs mt-0.5" style={{ color: '#888888' }}>
                          建立於 {admin.created_at ? new Date(admin.created_at + 'Z').toLocaleString('zh-TW', { year: 'numeric', month: 'short', day: 'numeric' }) : '—'}
                        </p>
                      </div>
                      <button
                        onClick={() => handleDeleteAdmin(admin.id, admin.username)}
                        disabled={admin.username === authUsername}
                        className="p-2 rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        style={{ color: '#c75050' }}
                        title={admin.username === authUsername ? '無法刪除自己' : '刪除'}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        );
      }

      // ── Settings sub-view ──
      if (usageSubView === 'settings') {
        const currentModel = appSettings?.active_model ?? 'basic';
        const geminiReady = appSettings?.gemini_configured ?? false;

        const modelOptions: Array<{
          key: TranslationModel;
          title: string;
          desc: string;
          cost: string;
          Icon: typeof Zap;
          disabled?: boolean;
          disabledReason?: string;
        }> = [
          {
            key: 'basic',
            title: import.meta.env.DEV ? '標準（Google Translate）' : '標準',
            desc: '速度快、每月前 50 萬字免費。適合一般使用。',
            cost: '$0.002 / 字元（超過免費額度後）',
            Icon: Zap,
          },
          {
            key: 'premium',
            title: import.meta.env.DEV ? '高品質（Gemini 2.5 Flash）' : '高品質',
            desc: '準確度與自動偵測語言較佳，回應略慢約 0.5–1 秒。',
            cost: '約 $0.0004 / 字元（依 token 計費，無免費額度）',
            Icon: Sparkles,
            disabled: !geminiReady,
            disabledReason: '伺服器尚未設定 GEMINI_API_KEY',
          },
        ];

        return (
          <div className="h-screen w-screen flex flex-col overflow-hidden fixed inset-0" style={containerStyle}>
            {topBar}
            <div className="flex-1 overflow-y-auto px-5 pb-6" style={{ scrollbarWidth: 'thin', scrollbarColor: '#e8e4df transparent', touchAction: 'pan-y', WebkitOverflowScrolling: 'touch' } as React.CSSProperties}>
              <p className="text-xs tracking-widest uppercase mb-4" style={{ color: '#888888', letterSpacing: '0.15em' }}>翻譯引擎</p>

              {settingsError && (
                <div className="mb-3 px-3 py-2 rounded-xl text-sm" style={{ background: '#fef2f2', color: '#c75050', border: '1px solid #fecaca' }}>
                  {settingsError}
                </div>
              )}
              {settingsNotice && (
                <div className="mb-3 px-3 py-2 rounded-xl text-sm" style={{ background: '#f0f9eb', color: '#5a8a3a', border: '1px solid #d4e9c5' }}>
                  {settingsNotice}
                </div>
              )}

              <div className="space-y-3">
                {modelOptions.map(opt => {
                  const isActive = currentModel === opt.key;
                  const Icon = opt.Icon;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => !opt.disabled && handleChangeModel(opt.key)}
                      disabled={opt.disabled || settingsBusy}
                      className="w-full text-left rounded-2xl p-5 transition-all disabled:cursor-not-allowed"
                      style={{
                        background: '#ffffff',
                        border: isActive ? '2px solid #c8956c' : '2px solid transparent',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                        opacity: opt.disabled ? 0.5 : 1,
                      }}
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                          style={{ background: isActive ? '#c8956c' : '#faf9f6', color: isActive ? '#ffffff' : '#c8956c' }}
                        >
                          <Icon className="w-5 h-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <p className="text-sm font-medium" style={{ color: '#2d2d2d' }}>{opt.title}</p>
                            {isActive && (
                              <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: '#c8956c', color: '#ffffff' }}>使用中</span>
                            )}
                          </div>
                          <p className="text-xs mb-2" style={{ color: '#666666' }}>{opt.desc}</p>
                          <p className="text-xs" style={{ color: '#888888' }}>{opt.cost}</p>
                          {opt.disabled && opt.disabledReason && (
                            <p className="text-xs mt-2" style={{ color: '#c75050' }}>{opt.disabledReason}</p>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="mt-6 px-4 py-3 rounded-xl text-xs" style={{ background: '#fef9ef', color: '#8a6a3a', border: '1px solid #f0d9b5' }}>
                提示：切換後立即生效，所有訪客（包含 iframe 嵌入站點）會使用新引擎。可在「用量」分頁查看各引擎的字元數與成本。
              </div>

              {/* ── 高品質翻譯（Gemini 3.5 Live）控制 ── */}
              <div className="mt-8">
                <p className="text-xs tracking-widest uppercase mb-4" style={{ color: '#888888', letterSpacing: '0.15em' }}>高品質翻譯（Live）</p>
                <div className="rounded-2xl p-5 space-y-4" style={{ background: '#ffffff', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                  {/* Kill switch */}
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm" style={{ color: '#2d2d2d' }}>啟用即時語音翻譯</p>
                      <p className="text-xs mt-0.5" style={{ color: '#888888' }}>關閉後所有訪客將無法使用高品質模式</p>
                    </div>
                    <button
                      type="button"
                      disabled={settingsBusy || !appSettings?.gemini_configured}
                      onClick={() => handleSaveLiveSettings({ live_translate_enabled: !appSettings?.live_translate_enabled })}
                      className="relative w-12 h-7 rounded-full transition-colors flex-shrink-0 disabled:opacity-40"
                      style={{ background: appSettings?.live_translate_enabled ? '#c8956c' : '#e8e4df' }}
                      title={appSettings?.gemini_configured ? '' : '伺服器未設定 GEMINI_API_KEY'}
                    >
                      <span className="absolute top-1 w-5 h-5 rounded-full bg-white transition-all" style={{ left: appSettings?.live_translate_enabled ? 24 : 4 }} />
                    </button>
                  </div>

                  {/* Monthly cost cap */}
                  <div className="pt-3" style={{ borderTop: '1px solid #f0ede8' }}>
                    <p className="text-sm mb-1" style={{ color: '#2d2d2d' }}>每月成本上限（USD）</p>
                    <p className="text-xs mb-2" style={{ color: '#888888' }}>本月 Live 花費達上限時自動鎖定，0 表示不限制</p>
                    <div className="flex items-center gap-2">
                      <span style={{ color: '#888888' }}>$</span>
                      <input
                        type="number" min="0" step="1"
                        value={liveCapDraft}
                        onChange={(e) => setLiveCapDraft(e.target.value)}
                        className="w-28 px-3 py-2 rounded-xl text-base outline-none"
                        style={{ background: '#faf9f6', border: '1px solid #e8e4df', color: '#2d2d2d' }}
                      />
                      <button
                        type="button"
                        disabled={settingsBusy || liveCapDraft === '' || Number(liveCapDraft) === appSettings?.live_cost_cap_usd}
                        onClick={() => handleSaveLiveSettings({ live_cost_cap_usd: Number(liveCapDraft) })}
                        className="px-4 py-2 rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
                        style={{ background: '#c8956c', color: '#fff' }}
                      >儲存</button>
                    </div>
                  </div>

                  {/* This month's Live spend */}
                  <div className="pt-3 flex items-center justify-between" style={{ borderTop: '1px solid #f0ede8' }}>
                    <span className="text-xs" style={{ color: '#888888' }}>本月 Live 花費</span>
                    <span className="text-sm" style={{ color: '#2d2d2d' }}>
                      ${(appSettings?.live_month_cost_usd ?? 0).toFixed(2)}
                      <span className="text-xs ml-1" style={{ color: '#888888' }}>/ ${appSettings?.live_cost_cap_usd ?? 0}</span>
                    </span>
                  </div>

                  {appSettings && !appSettings.live_available && appSettings.live_locked_reason && (
                    <div className="px-3 py-2 rounded-xl text-xs" style={{ background: '#fef2f2', color: '#c75050', border: '1px solid #fecaca' }}>
                      {appSettings.live_locked_reason}
                    </div>
                  )}
                </div>
                <div className="mt-3 px-4 py-3 rounded-xl text-xs" style={{ background: '#fef9ef', color: '#8a6a3a', border: '1px solid #f0d9b5' }}>
                  Live 按音訊分鐘計費（$2.3/分鐘），公開嵌入站點也會使用。達月上限會自動鎖定，可隨時用上方開關手動停用。
                </div>
              </div>
            </div>
          </div>
        );
      }

      // ── Usage sub-view (default) ──
      const summary = usageSummary;
      const totalRequests = summary?.total_requests ?? 0;
      const totalChars = summary?.total_chars ?? 0;
      const estimatedCost = summary?.estimated_cost_usd ?? summary?.total_cost_estimated ?? 0;
      const freeRemaining = summary?.free_remaining ?? 0;
      const freeLimit = summary?.free_limit ?? summary?.free_tier_limit ?? 500000;
      const freePercent = freeLimit > 0 ? Math.min(100, ((freeLimit - freeRemaining) / freeLimit) * 100) : 0;

      return (
        <div className="h-screen w-screen flex flex-col overflow-hidden fixed inset-0" style={containerStyle}>
          {topBar}

          {/* Period tabs */}
          <div className="flex gap-2 px-5 mb-5 flex-shrink-0">
            {([['week', '本週'], ['month', '本月'], ['all', '全部']] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setUsagePeriod(key)}
                className="px-4 py-1.5 rounded-full text-xs transition-all"
                style={{
                  background: usagePeriod === key ? '#f0ede8' : 'transparent',
                  color: usagePeriod === key ? '#2d2d2d' : '#888888',
                  fontWeight: usagePeriod === key ? 600 : 400,
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto px-5 pb-6" style={{ scrollbarWidth: 'thin', scrollbarColor: '#e8e4df transparent', touchAction: 'pan-y', WebkitOverflowScrolling: 'touch' } as React.CSSProperties}>

            {/* Stats grid */}
            <div className="grid grid-cols-2 gap-3 mb-6">
              {[
                { value: totalRequests.toLocaleString(), label: '總請求數' },
                { value: totalChars.toLocaleString(), label: '總字元數' },
                { value: `$${estimatedCost.toFixed(3)}`, label: '估算費用' },
                { value: freeRemaining.toLocaleString(), label: '免費額度剩餘' },
              ].map((card, i) => (
                <div key={i} className="rounded-2xl p-5" style={{ background: '#ffffff', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                  <p className="text-2xl font-light mb-1" style={{ color: '#2d2d2d' }}>{card.value}</p>
                  <p className="text-xs" style={{ color: '#888888' }}>{card.label}</p>
                </div>
              ))}
            </div>

            {/* Free quota progress bar */}
            <div className="rounded-2xl p-5 mb-6" style={{ background: '#ffffff', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
              <div className="flex justify-between items-center mb-3">
                <p className="text-xs" style={{ color: '#888888' }}>免費額度使用進度</p>
                <p className="text-xs" style={{ color: '#2d2d2d' }}>{freePercent.toFixed(1)}%</p>
              </div>
              <div className="w-full h-2 rounded-full" style={{ background: '#f0ede8' }}>
                <div
                  className="h-2 rounded-full transition-all duration-500"
                  style={{ width: `${freePercent}%`, background: '#c8956c' }}
                />
              </div>
            </div>

            {/* Recent translations */}
            <div className="mb-2">
              <p className="text-xs tracking-widest uppercase mb-3" style={{ color: '#888888', letterSpacing: '0.15em' }}>最近翻譯</p>
              <div className="space-y-2">
                {usageRecent.length === 0 ? (
                  <p className="text-sm py-6 text-center" style={{ color: '#888888' }}>暫無記錄</p>
                ) : (
                  usageRecent.map((record, idx) => (
                    <div key={idx} className="rounded-2xl p-4" style={{ background: '#ffffff', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm" style={{ color: '#2d2d2d' }}>
                          {langName(record.source_lang || '?')} <span style={{ color: '#e8e4df' }}>&rarr;</span> {langName(record.target_lang || '?')}
                        </span>
                        <span className="text-xs" style={{ color: '#888888' }}>
                          {record.timestamp ? new Date(record.timestamp).toLocaleString('zh-TW', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs" style={{ color: '#888888' }}>{record.char_count ?? 0}字</span>
                        <span className="text-xs" style={{ color: '#888888' }}>~${(record.estimated_cost_usd ?? 0).toFixed(4)}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      );
    }

    // ── TRANSLATE VIEW (embed) ──

    // Language picker overlay
    const langPickerOverlay = showLangPicker && (
      <div
        className="fixed inset-0 z-50 flex items-end justify-center"
        style={{ background: 'rgba(0,0,0,0.3)' }}
        onClick={() => setShowLangPicker(null)}
      >
        <div
          className="w-full max-w-md rounded-t-3xl p-6 pb-8"
          style={{ background: '#ffffff' }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex justify-center mb-4">
            <div className="w-10 h-1 rounded-full" style={{ background: '#e8e4df' }} />
          </div>
          <p className="text-xs tracking-widest uppercase mb-5 text-center" style={{ color: '#888888', letterSpacing: '0.15em' }}>
            {showLangPicker === 'source' ? '來源語言' : '目標語言'}
          </p>
          <div className="space-y-1 max-h-[50vh] overflow-y-auto" style={{ scrollbarWidth: 'thin', scrollbarColor: '#e8e4df transparent' }}>
            {showLangPicker === 'source' && (
              <button
                onClick={() => { setSourceLang('auto'); setShowLangPicker(null); }}
                className="w-full text-left px-4 py-3 rounded-2xl text-lg transition-colors"
                style={{
                  background: sourceLang === 'auto' ? 'rgba(200,149,108,0.1)' : 'transparent',
                  color: sourceLang === 'auto' ? '#c8956c' : '#2d2d2d',
                }}
              >
                自動偵測
              </button>
            )}
            {languages.map(lang => {
              const isActive = showLangPicker === 'source'
                ? sourceLang === lang.code
                : targetLang === lang.code;
              return (
                <button
                  key={lang.code}
                  onClick={() => {
                    if (showLangPicker === 'source') setSourceLang(lang.code);
                    else setTargetLang(lang.code);
                    setShowLangPicker(null);
                  }}
                  className="w-full text-left px-4 py-3 rounded-2xl text-lg transition-colors"
                  style={{
                    background: isActive ? 'rgba(200,149,108,0.1)' : 'transparent',
                    color: isActive ? '#c8956c' : '#2d2d2d',
                  }}
                >
                  {lang.name}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );

    return (
      <div className="h-screen w-screen flex flex-col overflow-hidden fixed inset-0" style={{ height: '100dvh', background: '#faf9f6', color: '#2d2d2d', fontFamily: 'system-ui, sans-serif', touchAction: 'none' }}>

        {langPickerOverlay}

        {/* Top bar */}
        <div className="flex items-center justify-between px-5 py-4 flex-shrink-0" style={{ borderBottom: '1px solid #e8e4df' }}>
          <span className="text-xs tracking-widest uppercase" style={{ color: '#888888', letterSpacing: '0.15em' }}>翻譯 Translate</span>
          <button
            onClick={() => setEmbedView('usage')}
            className="p-2 rounded-xl transition-colors"
            style={{ color: '#888888' }}
          >
            <BarChart3 className="w-4 h-4" />
          </button>
        </div>

        {/* Error banner */}
        {error && (
          <div className="mx-5 mt-3 mb-3 px-4 py-3 rounded-2xl flex items-start gap-3 flex-shrink-0" style={{ background: '#fef2f2', border: '1px solid #fecaca' }}>
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: '#c75050' }} />
            <span className="text-sm" style={{ color: '#c75050' }}>{error}</span>
          </div>
        )}

        {/* Live speech recognition indicator */}
        {/* Shrinkable (no flex-shrink-0): in a short embed iframe this box gives up
            height first, so the mic/stop button row is never clipped off-screen. */}
        {(currentSentence || interimText) && (
          <div className="mx-5 mt-3 mb-3 px-4 py-3 rounded-2xl flex items-start gap-3 overflow-y-auto" style={{ background: '#ffffff', border: '1px solid #e8e4df', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', maxHeight: '7rem', minHeight: '3rem' }}>
            <div className="animate-pulse mt-0.5">
              <Mic className="w-4 h-4" style={{ color: '#c8956c' }} />
            </div>
            <div className="flex-1">
              <p className="text-xs tracking-wider uppercase mb-1" style={{ color: '#c8956c', letterSpacing: '0.1em' }}>正在識別...</p>
              <p className="text-sm" style={{ color: '#2d2d2d' }}>
                {currentSentence}
                {interimText && <span style={{ color: '#888888', fontStyle: 'italic' }}> {interimText}</span>}
              </p>
              {liveSubtitle && interimTranslation && (
                <p className="text-sm mt-1.5 pt-1.5" style={{ color: '#7a9a7e', borderTop: '1px dashed #e8e4df' }}>
                  {interimTranslation}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Translation history -- scrollable */}
        <div className="flex-1 overflow-y-auto px-5 pb-3" style={{ scrollbarWidth: 'thin', scrollbarColor: '#e8e4df transparent', touchAction: 'pan-y', WebkitOverflowScrolling: 'touch' } as React.CSSProperties}>
          {translationHistory.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-4">
              <div className="w-20 h-20 rounded-full flex items-center justify-center" style={{ background: 'rgba(200,149,108,0.1)' }}>
                <Mic className="w-8 h-8" style={{ color: '#c8956c' }} />
              </div>
              <p className="text-sm tracking-wider text-center" style={{ color: '#888888' }}>輕觸開始翻譯<br />Tap to start translating</p>
            </div>
          ) : (
            <div className="space-y-4 py-2">
              {translationHistory.map((item) => (
                <div
                  key={item.id}
                  className="rounded-2xl p-6"
                  style={{ background: '#ffffff', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}
                >
                  {/* Source text */}
                  <div className="flex items-start gap-3 mb-4">
                    <button
                      onClick={() => speakText(item.source, item.detectedLang)}
                      className="flex-shrink-0 mt-1 w-8 h-8 flex items-center justify-center rounded-full transition-colors"
                      style={{ background: 'rgba(200,149,108,0.1)' }}
                      title="Play source"
                    >
                      <svg width="10" height="12" viewBox="0 0 10 12" fill="none">
                        <path d="M1 1L9 6L1 11V1Z" fill="#c8956c" />
                      </svg>
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs mb-1.5 tracking-wider uppercase" style={{ color: '#888888', letterSpacing: '0.1em' }}>
                        {langName(item.detectedLang)}
                        {sourceLang === 'auto' && <span style={{ color: '#c8956c' }}> &middot; auto</span>}
                      </p>
                      <p className="text-sm italic leading-relaxed" style={{ color: '#888888' }}>{item.source}</p>
                    </div>
                  </div>

                  {/* Divider */}
                  <div className="mb-4" style={{ height: 1, background: '#e8e4df' }} />

                  {/* Translation */}
                  <div className="flex items-start gap-3">
                    <button
                      onClick={() => speakText(item.translation, item.targetLang)}
                      className="flex-shrink-0 mt-1 w-8 h-8 flex items-center justify-center rounded-full transition-colors"
                      style={{ background: 'rgba(200,149,108,0.1)' }}
                      title="Play translation"
                    >
                      <svg width="10" height="12" viewBox="0 0 10 12" fill="none">
                        <path d="M1 1L9 6L1 11V1Z" fill="#c8956c" />
                      </svg>
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs mb-1.5 tracking-wider uppercase" style={{ color: '#888888', letterSpacing: '0.1em' }}>{langName(item.targetLang)}</p>
                      <p className="text-xl font-light leading-snug" style={{ color: '#2d2d2d' }}>{item.translation}</p>
                    </div>
                    {/* Copy button */}
                    <button
                      onClick={() => { navigator.clipboard.writeText(item.translation); setCopiedItem({ id: item.id, type: 'translation' }); setTimeout(() => setCopiedItem(null), 2000); }}
                      className="flex-shrink-0 self-end p-1.5 rounded-lg transition-colors"
                      title="Copy"
                    >
                      <Copy className="w-3.5 h-3.5" style={{ color: copiedItem?.id === item.id && copiedItem?.type === 'translation' ? '#c8956c' : '#888888' }} />
                    </button>
                  </div>

                </div>
              ))}
            </div>
          )}
        </div>

        {/* Mic button - centered floating */}
        <div className="flex justify-center flex-shrink-0 py-3 z-10 relative">
          <div className="relative flex items-center justify-center">
            {/* Emanating ripple rings while recording — rendered BEHIND the button
                (siblings, not children) so the animated, scaling overlay never sits
                on top of the interactive button and steals taps/clicks. */}
            {recActive && (
              <>
                <span
                  className="absolute inset-0 w-16 h-16 rounded-full rec-ring"
                  style={{ background: 'rgba(199,80,80,0.35)', pointerEvents: 'none' }}
                />
                <span
                  className="absolute inset-0 w-16 h-16 rounded-full rec-ring rec-ring-delay"
                  style={{ background: 'rgba(199,80,80,0.25)', pointerEvents: 'none' }}
                />
              </>
            )}
            <button
              onClick={onMicClick}
              disabled={!liveMode && !isSupported}
              className="w-16 h-16 rounded-full flex items-center justify-center shadow-lg transition-all focus:outline-none relative z-10"
              style={{
                background: recActive ? '#c75050' : '#c8956c',
                boxShadow: recActive
                  ? '0 4px 24px rgba(199,80,80,0.45)'
                  : '0 4px 20px rgba(200,149,108,0.3)',
              }}
              title={recActive ? '錄音中，輕觸停止 / Recording, tap to stop' : '輕觸開始 / Tap to start'}
            >
              {/* Keep the mic lit while recording (a crossed-out mic reads as "muted") */}
              <Mic className="w-6 h-6 text-white relative z-10" />
              {/* Blinking REC dot badge (opacity-only animation, no layout shift) */}
              {recActive && (
                <span
                  className="absolute -top-0.5 -right-0.5 flex items-center justify-center rounded-full rec-blink z-20"
                  style={{ width: 14, height: 14, background: '#fff', pointerEvents: 'none' }}
                >
                  <span style={{ width: 7, height: 7, borderRadius: '9999px', background: '#c75050' }} />
                </span>
              )}
            </button>
          </div>
        </div>

        {/* Mode toggle (免費 Web Speech / 高品質 Live) + status */}
        <div className="flex flex-col items-center gap-1.5 flex-shrink-0 pb-2 px-5">
          {liveAvailable && (
            <div className="flex items-center gap-1 p-0.5 rounded-full" style={{ background: '#f0ede8' }}>
              {([[false, '一般'], [true, '高品質']] as const).map(([val, label]) => (
                <button
                  key={label}
                  onClick={() => switchLiveMode(val)}
                  className="px-3 py-1 rounded-full text-xs transition-all flex items-center gap-1"
                  style={{
                    background: liveMode === val ? '#c8956c' : 'transparent',
                    color: liveMode === val ? '#fff' : '#888888',
                    fontWeight: liveMode === val ? 600 : 400,
                  }}
                >
                  {val && <Sparkles className="w-3 h-3" />}{label}
                </button>
              ))}
            </div>
          )}

          {liveMode && !recActive && (
            <div className="flex items-center gap-2 text-xs" style={{ color: '#888888' }}>
              <span>音源</span>
              {([['mic', '麥克風'], ['tab', '分頁音訊']] as const).map(([val, label]) => (
                <button
                  key={val}
                  onClick={() => setLiveAudioSource(val)}
                  className="px-2.5 py-0.5 rounded-full transition-colors"
                  style={{
                    background: liveAudioSource === val ? 'rgba(200,149,108,0.15)' : 'transparent',
                    color: liveAudioSource === val ? '#c8956c' : '#aaaaaa',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {liveMode && liveStatus === 'connecting' && (
            <span className="text-xs" style={{ color: '#c8956c' }}>連線中…</span>
          )}

          {!liveMode && (
            <button
              onClick={() => setLiveSubtitle(v => !v)}
              className="flex items-center gap-1.5 text-xs px-3 py-1 rounded-full transition-colors"
              style={{
                color: liveSubtitle ? '#7a9a7e' : '#aaaaaa',
                background: liveSubtitle ? 'rgba(122,154,126,0.1)' : 'transparent',
              }}
              title="即時翻譯字幕（邊說邊翻，會增加翻譯用量）"
            >
              <Zap className="w-3 h-3" />
              即時字幕 {liveSubtitle ? '開' : '關'}
            </button>
          )}
        </div>

        {/* Bottom bar */}
        <div className="flex-shrink-0 pb-4 px-5 pt-1" style={{ background: '#faf9f6', borderTop: '1px solid #e8e4df' }}>
          {/* Text input */}
          <div
            className="flex items-center gap-2 rounded-full px-5 py-3.5 mb-4"
            style={{ background: '#f0ede8' }}
          >
            <input
              type="text"
              value={sourceText}
              onChange={(e) => setSourceText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && sourceText.trim()) {
                  translateAndAddToHistory(sourceText.trim(), targetLang, sourceLang);
                  setSourceText('');
                }
              }}
              placeholder="輸入文字翻譯 / Type to translate..."
              className="flex-1 bg-transparent text-base outline-none"
              style={{ color: '#2d2d2d', caretColor: '#c8956c' }}
            />
            {sourceText.trim() && (
              <button
                onClick={() => { translateAndAddToHistory(sourceText.trim(), targetLang, sourceLang); setSourceText(''); }}
                className="flex-shrink-0 px-4 py-1.5 rounded-full text-sm font-medium transition-colors"
                style={{ background: '#c8956c', color: '#fff' }}
              >
                Go
              </button>
            )}
          </div>

          {/* Language selector row - text buttons */}
          <div className="flex items-center justify-center gap-3">
            {/* Source lang button */}
            <button
              onClick={() => setShowLangPicker('source')}
              disabled={lockSource}
              className="text-lg transition-colors hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ color: '#888888' }}
              title={lockSource ? '即時模式自動偵測來源語言' : undefined}
            >
              {lockSource ? '自動偵測' : (sourceLang === 'auto' ? `自動${detectedLang ? ` (${langName(detectedLang)})` : ''}` : langName(sourceLang))}
            </button>

            {/* Swap button */}
            <button
              onClick={() => {
                if (sourceLang !== 'auto') {
                  const tmp = sourceLang;
                  setSourceLang(targetLang);
                  setTargetLang(tmp);
                }
              }}
              disabled={sourceLang === 'auto' || lockSource || lockTarget}
              className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed"
              style={{ color: (sourceLang === 'auto' || lockSource || lockTarget) ? '#e8e4df' : '#c8956c' }}
              title={sourceLang === 'auto' ? 'Cannot swap in auto-detect mode' : 'Swap languages'}
            >
              <ArrowRightLeft className="w-4 h-4" />
            </button>

            {/* Target lang button */}
            <button
              onClick={() => setShowLangPicker('target')}
              disabled={lockTarget}
              className="text-lg transition-colors hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ color: '#2d2d2d' }}
              title={lockTarget ? '即時翻譯進行中無法切換語言，請先停止' : undefined}
            >
              {langName(targetLang)}
            </button>
          </div>

          {/* Auto-detect caveat: Web Speech API can't auto-detect — it listens in
              the browser language, so non-matching speech (e.g. Thai) barely
              recognizes. Nudge the user to pick the real source language. */}
          {sourceLang === 'auto' && (
            <p className="text-center text-xs mt-2 px-2" style={{ color: '#b0a99f' }}>
              語音辨識使用{getBrowserLangName()}；如說其他語言，請點左側指定來源語言
            </p>
          )}
        </div>
      </div>
    );
  }

  // ── NORMAL MODE UI (unchanged) ────────────────────────────────────────────────
  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden" style={{ background: '#faf9f6' }}>
      <div className="flex-1 flex flex-col h-full overflow-auto">
        <div className="flex-1 flex flex-col p-3 sm:p-4 md:p-6 lg:p-8" style={{ background: '#faf9f6' }}>
          {/* Title */}
          <h1 className="text-xl sm:text-2xl md:text-3xl font-bold text-center mb-4 sm:mb-6 md:mb-8" style={{ color: '#c8956c' }}>
            AI 即時語音翻譯工具
          </h1>

          {/* Mic permission warning */}
          {micPermission === 'denied' && (
            <div className="mb-3 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
              <div className="flex items-start gap-3">
                <Shield className="w-5 h-5 text-yellow-600 mt-1" />
                <div className="text-sm text-yellow-800">
                  <p className="font-semibold mb-1">需要麥克風權限</p>
                  <p>請在瀏覽器設定中允許麥克風存取，然後重新整理頁面。</p>
                </div>
              </div>
            </div>
          )}

          {/* Language selectors */}
          <div className="flex items-center justify-center gap-2 sm:gap-4 mb-4 flex-wrap">
            <div className="flex flex-col items-center gap-1">
              <select
                value={lockSource ? 'auto' : sourceLang}
                onChange={(e) => setSourceLang(e.target.value)}
                disabled={lockSource}
                className="px-2 sm:px-4 py-1.5 sm:py-2 text-sm sm:text-base border-2 rounded-lg focus:outline-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ borderColor: '#e8e4df' }}
                title={lockSource ? '即時模式自動偵測來源語言' : undefined}
              >
                <option value="auto">🔍 自動偵測 ({getBrowserLangName()})</option>
                {languages.map(lang => (
                  <option key={lang.code} value={lang.code}>{lang.name}</option>
                ))}
              </select>
              {sourceLang === 'auto' && detectedLang && (
                <span className="text-xs text-green-600 font-medium">偵測到: {langName(detectedLang)}</span>
              )}
              {sourceLang === 'auto' && !detectedLang && (
                <span className="text-xs text-gray-400">語音識別使用{getBrowserLangName()}，翻譯時自動偵測</span>
              )}
            </div>

            <button
              onClick={() => {
                if (sourceLang !== 'auto') {
                  const tmp = sourceLang;
                  setSourceLang(targetLang);
                  setTargetLang(tmp);
                }
              }}
              disabled={sourceLang === 'auto' || lockSource || lockTarget}
              className={`p-2 rounded-lg transition-colors ${(sourceLang === 'auto' || lockSource || lockTarget) ? 'text-gray-300 cursor-not-allowed' : 'hover:bg-gray-100 text-gray-600'}`}
              title={sourceLang === 'auto' ? '自動偵測模式無法交換' : '交換語言'}
            >
              <ArrowRightLeft className="w-5 h-5" />
            </button>

            <select
              value={targetLang}
              onChange={(e) => setTargetLang(e.target.value)}
              disabled={lockTarget}
              className="px-2 sm:px-4 py-1.5 sm:py-2 text-sm sm:text-base border-2 rounded-lg focus:outline-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ borderColor: '#e8e4df' }}
              title={lockTarget ? '即時翻譯進行中無法切換語言，請先停止' : undefined}
            >
              {languages.map(lang => (
                <option key={lang.code} value={lang.code}>{lang.name}</option>
              ))}
            </select>
          </div>

          {/* Error */}
          {error && (
            <div className="mb-3 p-2 sm:p-3 bg-red-50 border border-red-200 rounded-lg">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <div className="text-red-600 text-sm whitespace-pre-line">{error}</div>
              </div>
            </div>
          )}

          {/* Current sentence being recognized */}
          {(currentSentence || interimText) && (
            <div className="mb-3 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
              <div className="flex items-start gap-2">
                <div className="animate-pulse"><Mic className="w-5 h-5 text-yellow-600" /></div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-yellow-800 mb-1">正在識別...</p>
                  <p className="text-sm text-yellow-700">
                    {currentSentence}
                    {interimText && <span className="text-yellow-500 italic"> {interimText}</span>}
                  </p>
                  {liveSubtitle && interimTranslation && (
                    <p className="text-sm text-green-700 mt-1.5 pt-1.5 border-t border-dashed border-yellow-200">
                      {interimTranslation}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Translation history */}
          <div className="flex-1 overflow-hidden flex flex-col mb-3">
            <div className="flex justify-between items-center mb-2">
              <h2 className="text-sm font-semibold text-gray-700">翻譯記錄</h2>
              {translationHistory.length > 0 && (
                <span className="text-xs text-gray-500">共 {translationHistory.length} 條</span>
              )}
            </div>

            <div className="flex-1 overflow-y-auto space-y-2 p-2 rounded-lg border" style={{ background: '#ffffff', borderColor: '#e8e4df' }}>
              {translationHistory.length === 0 ? (
                <div className="text-center py-8 text-gray-400">
                  <p className="text-sm">還沒有翻譯記錄</p>
                  <p className="text-xs mt-1">開始說話或輸入文字吧！</p>
                </div>
              ) : (
                translationHistory.map(item => (
                  <div key={item.id} className="bg-white rounded-lg p-3 shadow-sm hover:shadow-md transition-shadow">
                    <div className="flex flex-col gap-2">
                      <div className="flex justify-between items-start gap-2">
                        <div className="flex-1">
                          <p className="text-xs text-gray-500 mb-1">
                            {langName(item.detectedLang)}
                            <span className="ml-1 text-green-600">(自動偵測)</span>
                          </p>
                          <p className="text-sm sm:text-base text-gray-800">{item.source}</p>
                        </div>
                        <div className="flex gap-1 flex-shrink-0">
                          <button onClick={() => speakText(item.source, item.detectedLang)} className="p-1 hover:bg-gray-100 rounded" title="朗讀原文">
                            <Volume2 className="w-3 h-3 text-gray-500" />
                          </button>
                          <button onClick={() => { navigator.clipboard.writeText(item.source); setCopiedItem({ id: item.id, type: 'source' }); setTimeout(() => setCopiedItem(null), 2000); }} className="p-1 hover:bg-gray-100 rounded" title="複製原文">
                            <Copy className={`w-3 h-3 ${copiedItem?.id === item.id && copiedItem?.type === 'source' ? 'text-green-600' : 'text-gray-500'}`} />
                          </button>
                        </div>
                      </div>
                      <div className="border-t"></div>
                      <div className="flex justify-between items-start gap-2">
                        <div className="flex-1">
                          <p className="text-xs text-gray-500 mb-1">{langName(item.targetLang)}</p>
                          <p className="text-sm sm:text-base text-gray-700">{item.translation}</p>
                        </div>
                        <div className="flex gap-1 flex-shrink-0">
                          <button onClick={() => speakText(item.translation, item.targetLang)} className="p-1 hover:bg-gray-100 rounded" title="朗讀翻譯">
                            <Volume2 className="w-3 h-3 text-gray-500" />
                          </button>
                          <button onClick={() => { navigator.clipboard.writeText(item.translation); setCopiedItem({ id: item.id, type: 'translation' }); setTimeout(() => setCopiedItem(null), 2000); }} className="p-1 hover:bg-gray-100 rounded" title="複製翻譯">
                            <Copy className={`w-3 h-3 ${copiedItem?.id === item.id && copiedItem?.type === 'translation' ? 'text-green-600' : 'text-gray-500'}`} />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Manual input */}
          <div className="mb-3 p-3 rounded-lg border" style={{ background: '#ffffff', borderColor: '#e8e4df' }}>
            <label className="text-xs font-medium text-gray-700 mb-2 block">手動輸入{sourceLang === 'auto' ? '（自動偵測語言）' : `（${langName(sourceLang)}）`}</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={sourceText}
                onChange={(e) => setSourceText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && sourceText.trim()) {
                    translateAndAddToHistory(sourceText.trim(), targetLang, sourceLang);
                    setSourceText('');
                  }
                }}
                placeholder="輸入任何語言的文字，按 Enter 翻譯..."
                className="flex-1 px-3 py-2 text-sm border rounded-lg focus:outline-none"
                style={{ borderColor: '#e8e4df' }}
              />
              <button
                onClick={() => { if (sourceText.trim()) { translateAndAddToHistory(sourceText.trim(), targetLang, sourceLang); setSourceText(''); } }}
                disabled={!sourceText.trim()}
                className="px-4 py-2 text-white rounded-lg disabled:bg-gray-300 disabled:cursor-not-allowed text-sm transition-colors"
                style={{ background: '#c8956c' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#b8855c')}
                onMouseLeave={(e) => (e.currentTarget.style.background = '#c8956c')}
              >
                翻譯
              </button>
            </div>
          </div>

          {/* Mode toggle (免費 Web Speech / 高品質 Live) */}
          {liveAvailable && (
            <div className="flex justify-center items-center gap-3 mb-3 flex-wrap">
              <div className="flex items-center gap-1 p-0.5 rounded-lg" style={{ background: '#f0ede8' }}>
                {([[false, '一般'], [true, '高品質']] as const).map(([val, label]) => (
                  <button
                    key={label}
                    onClick={() => switchLiveMode(val)}
                    className="px-3 py-1.5 rounded-md text-sm transition-all flex items-center gap-1"
                    style={{
                      background: liveMode === val ? '#c8956c' : 'transparent',
                      color: liveMode === val ? '#fff' : '#888888',
                      fontWeight: liveMode === val ? 600 : 400,
                    }}
                  >
                    {val && <Sparkles className="w-3.5 h-3.5" />}{label}
                  </button>
                ))}
              </div>
              {liveMode && !recActive && (
                <div className="flex items-center gap-2 text-sm" style={{ color: '#888888' }}>
                  <span>音源</span>
                  {([['mic', '麥克風'], ['tab', '分頁音訊']] as const).map(([val, label]) => (
                    <button
                      key={val}
                      onClick={() => setLiveAudioSource(val)}
                      className="px-2.5 py-1 rounded-md transition-colors"
                      style={{
                        background: liveAudioSource === val ? 'rgba(200,149,108,0.15)' : 'transparent',
                        color: liveAudioSource === val ? '#c8956c' : '#aaaaaa',
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              {liveMode && liveStatus === 'connecting' && (
                <span className="text-sm" style={{ color: '#c8956c' }}>連線中…</span>
              )}
            </div>
          )}

          {/* Controls */}
          <div className="flex justify-center gap-2 sm:gap-4 flex-wrap">
            <button
              onClick={onMicClick}
              disabled={!liveMode && !isSupported}
              className={`flex items-center gap-1 sm:gap-2 px-4 sm:px-6 py-2 sm:py-3 text-sm sm:text-base rounded-lg font-medium transition-all ${
                recActive ? 'bg-red-500 hover:bg-red-600 text-white'
                  : (liveMode || isSupported) ? 'text-white'
                    : 'bg-gray-300 text-gray-500 cursor-not-allowed'
              }`}
              style={!recActive && (liveMode || isSupported) ? { background: '#c8956c' } : undefined}
            >
              {recActive
                ? <><MicOff className="w-5 h-5" /> 停止</>
                : <><Mic className="w-5 h-5" /> {liveMode ? '開始即時翻譯' : '開始語音輸入'}</>}
            </button>

            <button
              onClick={() => {
                setSourceText(''); setInterimText(''); setCurrentSentence(''); setInterimTranslation('');
                setTranslationHistory([]); setError(''); setDetectedLang(null);
                pendingInterimRef.current = ''; // stale interim must not resurface via onend fold (D)
                lastInterimTranslatedRef.current = '';
                if (sentenceTimeoutRef.current) { clearTimeout(sentenceTimeoutRef.current); sentenceTimeoutRef.current = null; }
                // A pending preview debounce would repaint the cleared subtitle and burn an API call (4).
                if (interimTranslateTimeoutRef.current) { clearTimeout(interimTranslateTimeoutRef.current); interimTranslateTimeoutRef.current = null; }
              }}
              className="px-4 sm:px-6 py-2 sm:py-3 text-sm sm:text-base bg-gray-200 hover:bg-gray-300 rounded-lg font-medium transition-colors"
            >
              清除
            </button>

            {!liveMode && (
              <button
                onClick={() => setLiveSubtitle(v => !v)}
                className={`flex items-center gap-1 sm:gap-2 px-4 sm:px-6 py-2 sm:py-3 text-sm sm:text-base rounded-lg font-medium transition-colors ${
                  liveSubtitle ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-500'
                }`}
                title="即時翻譯字幕（邊說邊翻，會增加翻譯用量）"
              >
                <Zap className="w-4 h-4" /> 即時字幕 {liveSubtitle ? '開' : '關'}
              </button>
            )}
          </div>

          {/* Browser support notice */}
          {!isSupported && (
            <div className="mt-3 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
              <p className="text-sm text-yellow-800">您的瀏覽器不支援語音識別。請使用 Chrome、Edge 或 Safari。</p>
            </div>
          )}

          {/* Instructions */}
          <div className="mt-auto pt-4">
            <div className="p-3 rounded-lg" style={{ background: 'rgba(200,149,108,0.08)' }}>
              <p className="text-xs sm:text-sm font-semibold mb-1" style={{ color: '#2d2d2d' }}>使用說明：</p>
              <ul className="text-xs sm:text-sm space-y-0.5" style={{ color: '#888888' }}>
                <li>• 語言自動偵測，您只需選擇翻譯目標語言</li>
                <li>• 點擊麥克風按鈕開始語音輸入（首次需允許麥克風權限）</li>
                <li>• 也可以直接在文字框輸入或貼上任何語言的文字</li>
                <li>• 點擊喇叭圖標可朗讀，點擊複製按鈕可複製</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default VoiceTranslator;
