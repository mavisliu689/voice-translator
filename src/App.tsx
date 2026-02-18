import { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, MicOff, Volume2, ArrowRightLeft, Copy, AlertCircle, Shield, Settings, BookmarkPlus, Share2, LayoutGrid } from 'lucide-react';

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

// Speech recognition language hint mapping
const speechLangMap: Record<string, string> = {
  'zh-TW': 'zh-TW', 'zh-CN': 'zh-CN', 'en': 'en-US', 'ja': 'ja-JP',
  'ko': 'ko-KR', 'es': 'es-ES', 'fr': 'fr-FR', 'de': 'de-DE',
  'pt': 'pt-BR', 'ru': 'ru-RU', 'th': 'th-TH', 'vi': 'vi-VN',
  'id': 'id-ID', 'it': 'it-IT',
};

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
  }>>([]);
  const [currentSentence, setCurrentSentence] = useState('');

  const recognitionRef = useRef<any>(null);
  const [isSupported, setIsSupported] = useState(false);
  const restartTimeoutRef = useRef<any>(null);
  const sentenceTimeoutRef = useRef<any>(null);
  const isListeningRef = useRef(false);
  const targetLangRef = useRef(targetLang);
  const sourceLangRef = useRef(sourceLang);

  // Keep refs in sync
  useEffect(() => { isListeningRef.current = isListening; }, [isListening]);
  useEffect(() => { targetLangRef.current = targetLang; }, [targetLang]);
  useEffect(() => { sourceLangRef.current = sourceLang; }, [sourceLang]);

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
  const translateText = async (text: string, target: string, source?: string): Promise<{ translation: string; detectedLang: string } | null> => {
    if (!text) return null;
    setIsTranslating(true);
    setError('');

    try {
      const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';
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
      const newItem = {
        id: Date.now(),
        source: text,
        translation: result.translation,
        detectedLang: result.detectedLang,
        targetLang: target,
        timestamp: new Date().toISOString()
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
      recognition.lang = sourceLang !== 'auto' ? (speechLangMap[sourceLang] || sourceLang) : '';
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

  // ── EMBED MODE UI ────────────────────────────────────────────────────────────
  if (isEmbed) {
    return (
      <div className="h-screen w-screen flex flex-col overflow-hidden" style={{ background: '#1a1a1a', color: '#fff', fontFamily: 'system-ui, sans-serif' }}>

        {/* Top bar */}
        <div className="flex items-center justify-between px-4 py-3 flex-shrink-0" style={{ background: '#1a1a1a' }}>
          <button className="p-1.5 rounded-lg hover:bg-white/10 transition-colors">
            <Settings className="w-5 h-5" style={{ color: '#aaa' }} />
          </button>
          <span className="font-semibold text-base tracking-wide" style={{ color: '#fff' }}>History</span>
          <button className="p-1.5 rounded-lg hover:bg-white/10 transition-colors">
            <LayoutGrid className="w-4 h-4" style={{ color: '#aaa' }} />
          </button>
        </div>

        {/* Error banner */}
        {error && (
          <div className="mx-3 mb-2 px-3 py-2 rounded-lg flex items-start gap-2 flex-shrink-0" style={{ background: '#3a1a1a', border: '1px solid #7f3232' }}>
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: '#f87171' }} />
            <span className="text-xs" style={{ color: '#fca5a5' }}>{error}</span>
          </div>
        )}

        {/* Recognizing indicator */}
        {(currentSentence || interimText) && (
          <div className="mx-3 mb-2 px-3 py-2 rounded-lg flex items-start gap-2 flex-shrink-0" style={{ background: '#2a2a1a', border: '1px solid #5a5a20' }}>
            <div className="animate-pulse mt-0.5">
              <Mic className="w-4 h-4" style={{ color: '#caca50' }} />
            </div>
            <span className="text-xs" style={{ color: '#e0e080' }}>
              {currentSentence}
              {interimText && <span style={{ color: '#a0a040', fontStyle: 'italic' }}> {interimText}</span>}
            </span>
          </div>
        )}

        {/* Translation history — scrollable, with floating mic */}
        <div className="flex-1 overflow-y-auto px-3 pb-2 relative" style={{ scrollbarWidth: 'thin', scrollbarColor: '#444 transparent' }}>
          {translationHistory.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-3" style={{ color: '#555' }}>
              <div className="w-16 h-16 rounded-full flex items-center justify-center" style={{ background: '#2a2a2a' }}>
                <Mic className="w-7 h-7" style={{ color: '#4CAF50' }} />
              </div>
              <p className="text-sm">Tap the mic to start translating</p>
            </div>
          ) : (
            <div className="space-y-3 py-2">
              {translationHistory.map((item) => (
                <div
                  key={item.id}
                  className="rounded-2xl p-4"
                  style={{ background: '#2a2a2a' }}
                >
                  {/* Source text row */}
                  <div className="flex items-start gap-3 mb-3">
                    <button
                      onClick={() => speakText(item.source, item.detectedLang)}
                      className="flex-shrink-0 mt-0.5 w-7 h-7 flex items-center justify-center rounded-full transition-colors hover:bg-white/10"
                      title="Play source"
                    >
                      {/* Green triangle play button */}
                      <svg width="12" height="14" viewBox="0 0 12 14" fill="none">
                        <path d="M1 1L11 7L1 13V1Z" fill="#4CAF50" />
                      </svg>
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs mb-1" style={{ color: '#888' }}>
                        {langName(item.detectedLang)}
                        {sourceLang === 'auto' && <span style={{ color: '#4CAF50' }}> · auto</span>}
                      </p>
                      <p className="text-sm leading-snug" style={{ color: '#bbb' }}>{item.source}</p>
                    </div>
                  </div>

                  {/* Divider */}
                  <div className="mb-3" style={{ height: 1, background: '#3a3a3a' }} />

                  {/* Translation row */}
                  <div className="flex items-start gap-3">
                    <button
                      onClick={() => speakText(item.translation, item.targetLang)}
                      className="flex-shrink-0 mt-0.5 w-7 h-7 flex items-center justify-center rounded-full transition-colors hover:bg-white/10"
                      title="Play translation"
                    >
                      <svg width="12" height="14" viewBox="0 0 12 14" fill="none">
                        <path d="M1 1L11 7L1 13V1Z" fill="#4CAF50" />
                      </svg>
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs mb-1" style={{ color: '#888' }}>{langName(item.targetLang)}</p>
                      <p className="text-base font-bold leading-snug" style={{ color: '#fff' }}>{item.translation}</p>
                    </div>
                    {/* Share + Bookmark icons bottom-right */}
                    <div className="flex flex-col gap-1.5 flex-shrink-0 self-end">
                      <button
                        onClick={() => { navigator.clipboard.writeText(item.translation); setCopiedItem({ id: item.id, type: 'translation' }); setTimeout(() => setCopiedItem(null), 2000); }}
                        className="p-1 rounded hover:bg-white/10 transition-colors"
                        title="Copy"
                      >
                        <Share2 className="w-3.5 h-3.5" style={{ color: copiedItem?.id === item.id && copiedItem?.type === 'translation' ? '#4CAF50' : '#666' }} />
                      </button>
                      <button className="p-1 rounded hover:bg-white/10 transition-colors" title="Bookmark">
                        <BookmarkPlus className="w-3.5 h-3.5" style={{ color: '#666' }} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Floating mic button — sits between history and bottom bar */}
        <div className="flex justify-center flex-shrink-0 -mb-6 z-10 relative">
          <button
            onClick={toggleListening}
            disabled={!isSupported}
            className="w-14 h-14 rounded-full flex items-center justify-center shadow-lg transition-all focus:outline-none"
            style={{
              background: isListening ? '#e53935' : '#4CAF50',
              boxShadow: isListening
                ? '0 0 0 0 rgba(229,57,53,0.4)'
                : '0 4px 24px rgba(76,175,80,0.4)',
            }}
            title={isListening ? 'Stop' : 'Start recording'}
          >
            {isListening ? (
              <MicOff className="w-6 h-6 text-white" />
            ) : (
              <Mic className="w-6 h-6 text-white" />
            )}
            {/* Pulse ring when listening */}
            {isListening && (
              <span
                className="absolute w-14 h-14 rounded-full animate-ping"
                style={{ background: 'rgba(229,57,53,0.25)', pointerEvents: 'none' }}
              />
            )}
          </button>
        </div>

        {/* Bottom fixed bar */}
        <div className="flex-shrink-0 pt-8 pb-3 px-3" style={{ background: '#1a1a1a' }}>
          {/* Text input */}
          <div
            className="flex items-center gap-2 rounded-2xl px-4 py-3 mb-3"
            style={{ background: '#2a2a2a' }}
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
              placeholder="Enter text to translate"
              className="flex-1 bg-transparent text-sm outline-none"
              style={{ color: '#fff', caretColor: '#4CAF50' }}
            />
            {sourceText.trim() && (
              <button
                onClick={() => { translateAndAddToHistory(sourceText.trim(), targetLang, sourceLang); setSourceText(''); }}
                className="flex-shrink-0 px-3 py-1 rounded-xl text-xs font-semibold transition-colors"
                style={{ background: '#4CAF50', color: '#fff' }}
              >
                Go
              </button>
            )}
          </div>

          {/* Language selector row */}
          <div className="flex items-center gap-2">
            {/* Source lang */}
            <div className="flex-1">
              <select
                value={sourceLang}
                onChange={(e) => setSourceLang(e.target.value)}
                className="w-full appearance-none text-center text-xs font-medium rounded-xl px-2 py-2.5 outline-none transition-colors"
                style={{ background: '#2a2a2a', color: '#fff', border: '1px solid #3a3a3a' }}
              >
                <option value="auto">Auto detect</option>
                {languages.map(lang => (
                  <option key={lang.code} value={lang.code}>{lang.name}</option>
                ))}
              </select>
              {sourceLang !== 'auto' && (
                <p className="text-center text-xs mt-0.5" style={{ color: '#666' }}>{langRegion(sourceLang)}</p>
              )}
              {sourceLang === 'auto' && detectedLang && (
                <p className="text-center text-xs mt-0.5" style={{ color: '#4CAF50' }}>{langName(detectedLang)}</p>
              )}
            </div>

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
              style={{ background: '#2a2a2a', color: sourceLang === 'auto' ? '#444' : '#4CAF50' }}
              title={sourceLang === 'auto' ? 'Cannot swap in auto-detect mode' : 'Swap languages'}
            >
              <ArrowRightLeft className="w-4 h-4" />
            </button>

            {/* Target lang */}
            <div className="flex-1">
              <select
                value={targetLang}
                onChange={(e) => setTargetLang(e.target.value)}
                className="w-full appearance-none text-center text-xs font-medium rounded-xl px-2 py-2.5 outline-none transition-colors"
                style={{ background: '#2a2a2a', color: '#fff', border: '1px solid #3a3a3a' }}
              >
                {languages.map(lang => (
                  <option key={lang.code} value={lang.code}>{lang.name}</option>
                ))}
              </select>
              <p className="text-center text-xs mt-0.5" style={{ color: '#666' }}>{langRegion(targetLang)}</p>
            </div>
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
                <option value="auto">🔍 自動偵測</option>
                {languages.map(lang => (
                  <option key={lang.code} value={lang.code}>{lang.name}</option>
                ))}
              </select>
              {sourceLang === 'auto' && detectedLang && (
                <span className="text-xs text-green-600 font-medium">偵測到: {langName(detectedLang)}</span>
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
