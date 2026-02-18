import { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, MicOff, Volume2, ArrowRightLeft, Copy, AlertCircle, Shield, BarChart3, ChevronLeft } from 'lucide-react';

const languages = [
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
];

// Language name lookup
const langName = (code: string) => languages.find(l => l.code === code)?.name || code;
const langRegion = (code: string) => languages.find(l => l.code === code)?.region || code;

// Resolve browser language to our closest supported language code
const getBrowserLangCode = (): string => {
  const nav = navigator.language || 'en';
  // Exact match first (e.g. zh-TW, zh-CN)
  const exact = languages.find(l => l.code.toLowerCase() === nav.toLowerCase());
  if (exact) return exact.code;
  // Prefix match (e.g. "en-GB" → "en", "ja" → "ja")
  const prefix = nav.split('-')[0].toLowerCase();
  const partial = languages.find(l => l.code.toLowerCase() === prefix || l.code.toLowerCase().startsWith(prefix + '-'));
  return partial?.code || 'en';
};

// Get a display name for the browser language
const getBrowserLangName = (): string => langName(getBrowserLangCode());

// Speech recognition language hint mapping
const speechLangMap: Record<string, string> = {
  'zh-TW': 'zh-TW', 'zh-CN': 'zh-CN', 'en': 'en-US', 'ja': 'ja-JP',
  'ko': 'ko-KR', 'es': 'es-ES', 'fr': 'fr-FR', 'de': 'de-DE',
  'pt': 'pt-BR', 'ru': 'ru-RU', 'th': 'th-TH', 'vi': 'vi-VN',
  'id': 'id-ID', 'it': 'it-IT',
};

// Pulse keyframes injected once
const pulseStyleId = 'embed-pulse-style';
if (typeof document !== 'undefined' && !document.getElementById(pulseStyleId)) {
  const style = document.createElement('style');
  style.id = pulseStyleId;
  style.textContent = `
    @keyframes softPulse {
      0%, 100% { transform: scale(1); opacity: 0.5; }
      50% { transform: scale(1.35); opacity: 0; }
    }
    .soft-pulse {
      animation: softPulse 2s ease-in-out infinite;
    }
  `;
  document.head.appendChild(style);
}

const VoiceTranslator = () => {
  // Check embed mode from URL
  const isEmbed = new URLSearchParams(window.location.search).get('mode') === 'embed';

  const [isListening, setIsListening] = useState(false);
  const [sourceText, setSourceText] = useState('');
  const [interimText, setInterimText] = useState('');
  const [sourceLang, setSourceLang] = useState('auto');
  const [targetLang, setTargetLang] = useState('en');
  const [, setIsTranslating] = useState(false);
  const [copiedItem, setCopiedItem] = useState<{ id: number; type: 'source' | 'translation' } | null>(null);
  const [error, setError] = useState('');
  const [micPermission, setMicPermission] = useState('prompt');
  const [detectedLang, setDetectedLang] = useState<string | null>(null);

  const [translationHistory, setTranslationHistory] = useState<Array<{
    id: number;
    source: string;
    translation: string;
    detectedLang: string;
    targetLang: string;
    timestamp: string;
    char_count?: number;
    estimated_cost_usd?: number;
  }>>([]);
  const [currentSentence, setCurrentSentence] = useState('');

  const recognitionRef = useRef<any>(null);
  const [isSupported, setIsSupported] = useState(false);
  const restartTimeoutRef = useRef<any>(null);
  const sentenceTimeoutRef = useRef<any>(null);
  const isListeningRef = useRef(false);
  const targetLangRef = useRef(targetLang);
  const sourceLangRef = useRef(sourceLang);

  // Embed-specific state
  const [embedView, setEmbedView] = useState<'translate' | 'usage'>('translate');
  const [showLangPicker, setShowLangPicker] = useState<'source' | 'target' | null>(null);
  const [usageSummary, setUsageSummary] = useState<any>(null);
  const [usageRecent, setUsageRecent] = useState<any[]>([]);
  const [usagePeriod, setUsagePeriod] = useState<'week' | 'month' | 'all'>('week');

  // Keep refs in sync
  useEffect(() => { isListeningRef.current = isListening; }, [isListening]);
  useEffect(() => { targetLangRef.current = targetLang; }, [targetLang]);
  useEffect(() => { sourceLangRef.current = sourceLang; }, [sourceLang]);

  // Lock body scroll in embed mode to prevent iOS bounce / page scroll
  useEffect(() => {
    if (!isEmbed) return;
    const html = document.documentElement;
    const body = document.body;
    const styles = 'overflow:hidden;position:fixed;width:100%;height:100%;';
    html.style.cssText += styles;
    body.style.cssText += styles;
    return () => {
      html.style.overflow = '';
      html.style.position = '';
      html.style.width = '';
      html.style.height = '';
      body.style.overflow = '';
      body.style.position = '';
      body.style.width = '';
      body.style.height = '';
    };
  }, [isEmbed]);

  useEffect(() => {
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      setIsSupported(true);
    }
    checkMicrophonePermission();
  }, []);

  // postMessage API for iframe communication
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const { type, payload } = event.data || {};
      if (type === 'SET_TARGET_LANG' && payload?.lang) {
        setTargetLang(payload.lang);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // Broadcast translation results to parent
  const postTranslationResult = useCallback((item: typeof translationHistory[0]) => {
    if (window.parent !== window) {
      window.parent.postMessage({
        type: 'TRANSLATION_RESULT',
        payload: item,
      }, '*');
    }
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

  // Translate using backend API
  const translateText = async (text: string, target: string, source?: string): Promise<{ translation: string; detectedLang: string; char_count?: number; estimated_cost_usd?: number } | null> => {
    if (!text) return null;
    setIsTranslating(true);
    setError('');

    try {
      const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? '';
      const body: Record<string, string> = { text, target };
      if (source && source !== 'auto') body.source = source;
      const response = await fetch(`${BACKEND_URL}/api/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || '翻譯請求失敗');
      }

      const data = await response.json();
      if (data.success && data.translation) {
        return {
          translation: data.translation,
          detectedLang: data.detectedSourceLanguage || data.source || '?',
          char_count: data.char_count ?? 0,
          estimated_cost_usd: data.estimated_cost_usd ?? 0,
        };
      }
      throw new Error('無法取得翻譯結果');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ECONNREFUSED')) setError('無法連接到翻譯服務');
      else if (msg.includes('Network')) setError('網路連線失敗');
      else setError(`翻譯失敗: ${msg}`);
      return null;
    } finally {
      setIsTranslating(false);
    }
  };

  const translateAndAddToHistory = useCallback(async (text: string, target: string, source?: string) => {
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
            id: Date.now(),
            source: text,
            translation: retried.translation,
            detectedLang: retried.detectedLang,
            targetLang: newTarget,
            timestamp: new Date().toISOString(),
            char_count: retried.char_count ?? 0,
            estimated_cost_usd: retried.estimated_cost_usd ?? 0,
          };
          setTranslationHistory(prev => {
            const exists = prev.some(item => item.source === text && (Date.now() - item.id) < 5000);
            if (exists) return prev;
            return [newItem, ...prev].slice(0, 20);
          });
          postTranslationResult(newItem);
        }
        return;
      }

      const newItem = {
        id: Date.now(),
        source: text,
        translation: result.translation,
        detectedLang: result.detectedLang,
        targetLang: target,
        timestamp: new Date().toISOString(),
        char_count: result.char_count ?? 0,
        estimated_cost_usd: result.estimated_cost_usd ?? 0,
      };
      setTranslationHistory(prev => {
        const exists = prev.some(item => item.source === text && (Date.now() - item.id) < 5000);
        if (exists) return prev;
        return [newItem, ...prev].slice(0, 20);
      });
      postTranslationResult(newItem);
    }
  }, [postTranslationResult]);

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

  const startListening = () => {
    try {
      const SpeechRecognition = window.webkitSpeechRecognition || window.SpeechRecognition;
      if (recognitionRef.current) {
        try { recognitionRef.current.stop(); } catch { /* */ }
        recognitionRef.current = null;
      }

      const recognition = new SpeechRecognition();
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

      recognition.onresult = (event: any) => {
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
            return combined;
          });

          if (sentenceTimeoutRef.current) clearTimeout(sentenceTimeoutRef.current);
          sentenceTimeoutRef.current = setTimeout(() => {
            setCurrentSentence(prev => {
              if (prev?.trim()) translateAndAddToHistory(prev.trim(), targetLangRef.current, sourceLangRef.current);
              return '';
            });
          }, 3000);

          setInterimText('');
        } else if (interimTranscript) {
          setInterimText(interimTranscript);
        }
      };

      recognition.onerror = (event: any) => {
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
        if (isListeningRef.current) {
          if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current);
          restartTimeoutRef.current = setTimeout(() => {
            if (isListeningRef.current && recognitionRef.current) {
              try { recognitionRef.current.start(); } catch {
                try { startListening(); } catch { setIsListening(false); }
              }
            }
          }, 250);
        } else {
          setIsListening(false);
        }
      };

      recognition.start();
    } catch (err) {
      setError('無法啟動語音識別：' + (err instanceof Error ? err.message : String(err)));
      setIsListening(false);
    }
  };

  const stopListening = () => {
    setIsListening(false);
    setInterimText('');

    setCurrentSentence(prev => {
      if (prev?.trim()) translateAndAddToHistory(prev.trim(), targetLangRef.current, sourceLangRef.current);
      return '';
    });

    if (restartTimeoutRef.current) { clearTimeout(restartTimeoutRef.current); restartTimeoutRef.current = null; }
    if (sentenceTimeoutRef.current) { clearTimeout(sentenceTimeoutRef.current); sentenceTimeoutRef.current = null; }

    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch { /* */ }
      recognitionRef.current = null;
    }
  };

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
      if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current);
      if (recognitionRef.current) { try { recognitionRef.current.stop(); } catch { /* */ } }
    };
  }, []);

  // Fetch usage data when switching to usage view
  const fetchUsageData = useCallback(async () => {
    const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? '';
    try {
      const [summaryRes, recentRes] = await Promise.all([
        fetch(`${BACKEND_URL}/api/usage/summary${usagePeriod !== 'all' ? `?period=${usagePeriod}` : ''}`),
        fetch(`${BACKEND_URL}/api/usage/recent`),
      ]);
      if (summaryRes.ok) {
        const summaryData = await summaryRes.json();
        setUsageSummary(summaryData);
      }
      if (recentRes.ok) {
        const recentData = await recentRes.json();
        setUsageRecent(Array.isArray(recentData) ? recentData : recentData.records || []);
      }
    } catch {
      // Silently fail - usage is informational
    }
  }, [usagePeriod]);

  useEffect(() => {
    if (embedView === 'usage') {
      fetchUsageData();
    }
  }, [embedView, fetchUsageData]);

  // ── EMBED MODE UI ────────────────────────────────────────────────────────────
  if (isEmbed) {

    // ── USAGE VIEW ──
    if (embedView === 'usage') {
      const summary = usageSummary || {};
      const totalRequests = summary.total_requests ?? 0;
      const totalChars = summary.total_chars ?? 0;
      const estimatedCost = summary.estimated_cost_usd ?? 0;
      const freeRemaining = summary.free_remaining ?? 0;
      const freeLimit = summary.free_limit ?? 500000;
      const freePercent = freeLimit > 0 ? Math.min(100, ((freeLimit - freeRemaining) / freeLimit) * 100) : 0;

      return (
        <div className="h-screen w-screen flex flex-col overflow-hidden fixed inset-0" style={{ background: '#000000', color: '#ffffff', fontFamily: 'system-ui, sans-serif', touchAction: 'none' }}>

          {/* Top bar */}
          <div className="flex items-center gap-3 px-5 py-4 flex-shrink-0">
            <button
              onClick={() => setEmbedView('translate')}
              className="p-1.5 rounded-xl hover:bg-white/5 transition-colors"
            >
              <ChevronLeft className="w-5 h-5" style={{ color: '#888' }} />
            </button>
            <span className="text-sm tracking-widest uppercase" style={{ color: '#666' }}>用量統計</span>
          </div>

          {/* Period tabs */}
          <div className="flex gap-2 px-5 mb-5 flex-shrink-0">
            {([['week', '本週'], ['month', '本月'], ['all', '全部']] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setUsagePeriod(key)}
                className="px-4 py-1.5 rounded-full text-sm transition-all"
                style={{
                  background: usagePeriod === key ? '#a78bfa' : '#111111',
                  color: usagePeriod === key ? '#000000' : '#888',
                  fontWeight: usagePeriod === key ? 600 : 400,
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto px-5 pb-6" style={{ scrollbarWidth: 'thin', scrollbarColor: '#333 transparent', touchAction: 'pan-y', WebkitOverflowScrolling: 'touch' } as React.CSSProperties}>

            {/* Stats grid */}
            <div className="grid grid-cols-2 gap-3 mb-6">
              {[
                { value: totalRequests.toLocaleString(), label: '總請求數' },
                { value: totalChars.toLocaleString(), label: '總字元數' },
                { value: `$${estimatedCost.toFixed(3)}`, label: '估算費用' },
                { value: freeRemaining.toLocaleString(), label: '免費額度剩餘' },
              ].map((card, i) => (
                <div key={i} className="rounded-2xl p-5" style={{ background: '#111111' }}>
                  <p className="text-2xl font-light mb-1" style={{ color: '#ffffff' }}>{card.value}</p>
                  <p className="text-xs" style={{ color: '#666' }}>{card.label}</p>
                </div>
              ))}
            </div>

            {/* Free quota progress bar */}
            <div className="rounded-2xl p-5 mb-6" style={{ background: '#111111' }}>
              <div className="flex justify-between items-center mb-3">
                <p className="text-xs" style={{ color: '#666' }}>免費額度使用進度</p>
                <p className="text-xs" style={{ color: '#888' }}>{freePercent.toFixed(1)}%</p>
              </div>
              <div className="w-full h-2 rounded-full" style={{ background: '#222' }}>
                <div
                  className="h-2 rounded-full transition-all duration-500"
                  style={{ width: `${freePercent}%`, background: 'linear-gradient(135deg, #a78bfa, #8b5cf6)' }}
                />
              </div>
            </div>

            {/* Recent translations */}
            <div className="mb-2">
              <p className="text-xs tracking-widest uppercase mb-3" style={{ color: '#666' }}>最近翻譯</p>
              <div className="space-y-2">
                {usageRecent.length === 0 ? (
                  <p className="text-sm py-6 text-center" style={{ color: '#444' }}>暫無記錄</p>
                ) : (
                  usageRecent.map((record: any, idx: number) => (
                    <div key={idx} className="rounded-2xl p-4" style={{ background: '#111111' }}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm" style={{ color: '#aaa' }}>
                          {langName(record.source_lang || '?')} <span style={{ color: '#555' }}>&rarr;</span> {langName(record.target_lang || '?')}
                        </span>
                        <span className="text-xs" style={{ color: '#444' }}>
                          {record.timestamp ? new Date(record.timestamp).toLocaleString('zh-TW', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs" style={{ color: '#666' }}>{record.char_count ?? 0}字</span>
                        <span className="text-xs" style={{ color: '#444' }}>~${(record.estimated_cost_usd ?? 0).toFixed(4)}</span>
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
        style={{ background: 'rgba(0,0,0,0.7)' }}
        onClick={() => setShowLangPicker(null)}
      >
        <div
          className="w-full max-w-md rounded-t-3xl p-6 pb-8"
          style={{ background: '#111111' }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex justify-center mb-4">
            <div className="w-10 h-1 rounded-full" style={{ background: '#333' }} />
          </div>
          <p className="text-sm tracking-widest uppercase mb-5 text-center" style={{ color: '#666' }}>
            {showLangPicker === 'source' ? '來源語言' : '目標語言'}
          </p>
          <div className="space-y-1 max-h-[50vh] overflow-y-auto" style={{ scrollbarWidth: 'thin', scrollbarColor: '#333 transparent' }}>
            {showLangPicker === 'source' && (
              <button
                onClick={() => { setSourceLang('auto'); setShowLangPicker(null); }}
                className="w-full text-left px-4 py-3 rounded-2xl text-lg transition-colors"
                style={{
                  background: sourceLang === 'auto' ? 'rgba(167,139,250,0.15)' : 'transparent',
                  color: sourceLang === 'auto' ? '#a78bfa' : '#aaa',
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
                    background: isActive ? 'rgba(167,139,250,0.15)' : 'transparent',
                    color: isActive ? '#a78bfa' : '#aaa',
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
      <div className="h-screen w-screen flex flex-col overflow-hidden fixed inset-0" style={{ background: '#000000', color: '#ffffff', fontFamily: 'system-ui, sans-serif', touchAction: 'none' }}>

        {langPickerOverlay}

        {/* Top bar */}
        <div className="flex items-center justify-between px-5 py-4 flex-shrink-0">
          <span className="text-sm tracking-widest uppercase" style={{ color: '#666' }}>翻譯</span>
          <button
            onClick={() => setEmbedView('usage')}
            className="p-2 rounded-xl hover:bg-white/5 transition-colors"
          >
            <BarChart3 className="w-4 h-4" style={{ color: '#666' }} />
          </button>
        </div>

        {/* Error banner */}
        {error && (
          <div className="mx-5 mb-3 px-4 py-3 rounded-2xl flex items-start gap-3 flex-shrink-0" style={{ background: '#1a0a0a', border: '1px solid rgba(248,113,113,0.2)' }}>
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: '#f87171' }} />
            <span className="text-sm" style={{ color: '#fca5a5' }}>{error}</span>
          </div>
        )}

        {/* Recognizing indicator - lavender purple tones */}
        {(currentSentence || interimText) && (
          <div className="mx-5 mb-3 px-4 py-3 rounded-2xl flex items-start gap-3 flex-shrink-0" style={{ background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.15)' }}>
            <div className="animate-pulse mt-0.5">
              <Mic className="w-4 h-4" style={{ color: '#a78bfa' }} />
            </div>
            <span className="text-sm" style={{ color: '#c4b5fd' }}>
              {currentSentence}
              {interimText && <span style={{ color: '#7c6bbd', fontStyle: 'italic' }}> {interimText}</span>}
            </span>
          </div>
        )}

        {/* Translation history -- scrollable */}
        <div className="flex-1 overflow-y-auto px-5 pb-3" style={{ scrollbarWidth: 'thin', scrollbarColor: '#222 transparent', touchAction: 'pan-y', WebkitOverflowScrolling: 'touch' } as React.CSSProperties}>
          {translationHistory.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-4">
              <div className="w-20 h-20 rounded-full flex items-center justify-center" style={{ background: 'rgba(167,139,250,0.1)' }}>
                <Mic className="w-8 h-8" style={{ color: '#a78bfa' }} />
              </div>
              <p className="text-base" style={{ color: '#444' }}>輕觸開始翻譯</p>
            </div>
          ) : (
            <div className="space-y-4 py-2">
              {translationHistory.map((item) => (
                <div
                  key={item.id}
                  className="rounded-3xl p-6"
                  style={{ background: '#111111' }}
                >
                  {/* Source text */}
                  <div className="flex items-start gap-3 mb-4">
                    <button
                      onClick={() => speakText(item.source, item.detectedLang)}
                      className="flex-shrink-0 mt-1 w-8 h-8 flex items-center justify-center rounded-full transition-colors hover:bg-white/5"
                      style={{ background: 'rgba(167,139,250,0.15)' }}
                      title="Play source"
                    >
                      <svg width="10" height="12" viewBox="0 0 10 12" fill="none">
                        <path d="M1 1L9 6L1 11V1Z" fill="#a78bfa" />
                      </svg>
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs mb-1.5" style={{ color: '#555' }}>
                        {langName(item.detectedLang)}
                        {sourceLang === 'auto' && <span style={{ color: '#a78bfa' }}> &middot; auto</span>}
                      </p>
                      <p className="text-base text-gray-400 leading-relaxed">{item.source}</p>
                    </div>
                  </div>

                  {/* Divider */}
                  <div className="mb-4" style={{ height: 1, background: '#1a1a1a' }} />

                  {/* Translation */}
                  <div className="flex items-start gap-3">
                    <button
                      onClick={() => speakText(item.translation, item.targetLang)}
                      className="flex-shrink-0 mt-1 w-8 h-8 flex items-center justify-center rounded-full transition-colors hover:bg-white/5"
                      style={{ background: 'rgba(167,139,250,0.15)' }}
                      title="Play translation"
                    >
                      <svg width="10" height="12" viewBox="0 0 10 12" fill="none">
                        <path d="M1 1L9 6L1 11V1Z" fill="#a78bfa" />
                      </svg>
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs mb-1.5" style={{ color: '#555' }}>{langName(item.targetLang)}</p>
                      <p className="text-2xl font-light leading-snug" style={{ color: '#ffffff' }}>{item.translation}</p>
                    </div>
                    {/* Copy button */}
                    <button
                      onClick={() => { navigator.clipboard.writeText(item.translation); setCopiedItem({ id: item.id, type: 'translation' }); setTimeout(() => setCopiedItem(null), 2000); }}
                      className="flex-shrink-0 self-end p-1.5 rounded-lg hover:bg-white/5 transition-colors"
                      title="Copy"
                    >
                      <Copy className="w-3.5 h-3.5" style={{ color: copiedItem?.id === item.id && copiedItem?.type === 'translation' ? '#a78bfa' : '#333' }} />
                    </button>
                  </div>

                  {/* Cost info */}
                  <div className="flex justify-end mt-3">
                    <span className="text-xs" style={{ color: '#333' }}>
                      ~${(item.estimated_cost_usd ?? 0).toFixed(3)} &middot; {item.char_count ?? 0}字
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Mic button - centered floating */}
        <div className="flex justify-center flex-shrink-0 py-3 z-10 relative">
          <button
            onClick={toggleListening}
            disabled={!isSupported}
            className="w-16 h-16 rounded-full flex items-center justify-center shadow-lg transition-all focus:outline-none relative"
            style={{
              background: isListening
                ? 'linear-gradient(135deg, #ef4444, #dc2626)'
                : 'linear-gradient(135deg, #a78bfa, #8b5cf6)',
              boxShadow: isListening
                ? '0 4px 30px rgba(239,68,68,0.3)'
                : '0 4px 30px rgba(167,139,250,0.3)',
            }}
            title={isListening ? 'Stop' : 'Start recording'}
          >
            {isListening ? (
              <MicOff className="w-6 h-6 text-white" />
            ) : (
              <Mic className="w-6 h-6 text-white" />
            )}
            {/* Soft pulse ring when listening */}
            {isListening && (
              <span
                className="absolute w-16 h-16 rounded-full soft-pulse"
                style={{ background: 'rgba(239,68,68,0.3)', pointerEvents: 'none' }}
              />
            )}
          </button>
        </div>

        {/* Bottom bar */}
        <div className="flex-shrink-0 pb-4 px-5 pt-1" style={{ background: '#000000' }}>
          {/* Text input */}
          <div
            className="flex items-center gap-2 rounded-full px-5 py-3.5 mb-4"
            style={{ background: '#1a1a1a' }}
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
              placeholder="輸入文字翻譯..."
              className="flex-1 bg-transparent text-base outline-none"
              style={{ color: '#ffffff', caretColor: '#a78bfa' }}
            />
            {sourceText.trim() && (
              <button
                onClick={() => { translateAndAddToHistory(sourceText.trim(), targetLang, sourceLang); setSourceText(''); }}
                className="flex-shrink-0 px-4 py-1.5 rounded-full text-sm font-medium transition-colors"
                style={{ background: 'linear-gradient(135deg, #a78bfa, #8b5cf6)', color: '#fff' }}
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
              className="text-lg transition-colors hover:opacity-80"
              style={{ color: '#888' }}
            >
              {sourceLang === 'auto' ? `自動${detectedLang ? ` (${langName(detectedLang)})` : ''}` : langName(sourceLang)}
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
              disabled={sourceLang === 'auto'}
              className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-full transition-colors"
              style={{ color: sourceLang === 'auto' ? '#333' : '#a78bfa' }}
              title={sourceLang === 'auto' ? 'Cannot swap in auto-detect mode' : 'Swap languages'}
            >
              <ArrowRightLeft className="w-4 h-4" />
            </button>

            {/* Target lang button */}
            <button
              onClick={() => setShowLangPicker('target')}
              className="text-lg transition-colors hover:opacity-80"
              style={{ color: '#ffffff' }}
            >
              {langName(targetLang)}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── NORMAL MODE UI (unchanged) ────────────────────────────────────────────────
  return (
    <div className="h-screen w-screen bg-gradient-to-br from-blue-50 to-purple-50 flex flex-col overflow-hidden">
      <div className="flex-1 flex flex-col h-full overflow-auto">
        <div className="bg-white flex-1 flex flex-col p-3 sm:p-4 md:p-6 lg:p-8">
          {/* Title */}
          <h1 className="text-xl sm:text-2xl md:text-3xl font-bold text-center mb-4 sm:mb-6 md:mb-8 bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
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
                value={sourceLang}
                onChange={(e) => setSourceLang(e.target.value)}
                className="px-2 sm:px-4 py-1.5 sm:py-2 text-sm sm:text-base border-2 border-gray-200 rounded-lg focus:outline-none focus:border-blue-500 transition-colors"
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
              disabled={sourceLang === 'auto'}
              className={`p-2 rounded-lg transition-colors ${sourceLang === 'auto' ? 'text-gray-300 cursor-not-allowed' : 'hover:bg-gray-100 text-gray-600'}`}
              title={sourceLang === 'auto' ? '自動偵測模式無法交換' : '交換語言'}
            >
              <ArrowRightLeft className="w-5 h-5" />
            </button>

            <select
              value={targetLang}
              onChange={(e) => setTargetLang(e.target.value)}
              className="px-2 sm:px-4 py-1.5 sm:py-2 text-sm sm:text-base border-2 border-gray-200 rounded-lg focus:outline-none focus:border-blue-500 transition-colors"
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

            <div className="flex-1 overflow-y-auto space-y-2 p-2 bg-gray-50 rounded-lg border border-gray-200">
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
          <div className="mb-3 p-3 bg-white rounded-lg border border-gray-200">
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
                className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={() => { if (sourceText.trim()) { translateAndAddToHistory(sourceText.trim(), targetLang, sourceLang); setSourceText(''); } }}
                disabled={!sourceText.trim()}
                className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed text-sm"
              >
                翻譯
              </button>
            </div>
          </div>

          {/* Controls */}
          <div className="flex justify-center gap-2 sm:gap-4 flex-wrap">
            <button
              onClick={toggleListening}
              disabled={!isSupported}
              className={`flex items-center gap-1 sm:gap-2 px-4 sm:px-6 py-2 sm:py-3 text-sm sm:text-base rounded-lg font-medium transition-all ${
                isListening ? 'bg-red-500 hover:bg-red-600 text-white'
                  : isSupported ? 'bg-blue-500 hover:bg-blue-600 text-white'
                    : 'bg-gray-300 text-gray-500 cursor-not-allowed'
              }`}
            >
              {isListening ? <><MicOff className="w-5 h-5" /> 停止錄音</> : <><Mic className="w-5 h-5" /> 開始語音輸入</>}
            </button>

            <button
              onClick={() => {
                setSourceText(''); setInterimText(''); setCurrentSentence('');
                setTranslationHistory([]); setError(''); setDetectedLang(null);
                if (sentenceTimeoutRef.current) { clearTimeout(sentenceTimeoutRef.current); sentenceTimeoutRef.current = null; }
              }}
              className="px-4 sm:px-6 py-2 sm:py-3 text-sm sm:text-base bg-gray-200 hover:bg-gray-300 rounded-lg font-medium transition-colors"
            >
              清除
            </button>
          </div>

          {/* Browser support notice */}
          {!isSupported && (
            <div className="mt-3 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
              <p className="text-sm text-yellow-800">您的瀏覽器不支援語音識別。請使用 Chrome、Edge 或 Safari。</p>
            </div>
          )}

          {/* Instructions */}
          <div className="mt-auto pt-4">
            <div className="p-3 bg-blue-50 rounded-lg">
              <p className="text-xs sm:text-sm text-blue-800 font-semibold mb-1">使用說明：</p>
              <ul className="text-xs sm:text-sm text-blue-700 space-y-0.5">
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
