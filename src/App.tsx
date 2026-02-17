import { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, MicOff, Volume2, Copy, AlertCircle, Shield } from 'lucide-react';

const languages = [
  { code: 'zh-TW', name: '繁體中文' },
  { code: 'zh-CN', name: '简体中文' },
  { code: 'en', name: 'English' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'pt', name: 'Português' },
  { code: 'ru', name: 'Русский' },
  { code: 'th', name: 'ไทย' },
  { code: 'vi', name: 'Tiếng Việt' },
  { code: 'id', name: 'Bahasa Indonesia' },
  { code: 'it', name: 'Italiano' },
];

// Language name lookup
const langName = (code: string) => languages.find(l => l.code === code)?.name || code;

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

  // Keep refs in sync
  useEffect(() => { isListeningRef.current = isListening; }, [isListening]);
  useEffect(() => { targetLangRef.current = targetLang; }, [targetLang]);

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

  // Translate using backend API - source is auto-detected (not sent)
  const translateText = async (text: string, target: string): Promise<{ translation: string; detectedLang: string } | null> => {
    if (!text) return null;
    setIsTranslating(true);
    setError('');

    try {
      const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';
      const response = await fetch(`${BACKEND_URL}/api/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, target }) // No source = auto-detect
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

  const translateAndAddToHistory = useCallback(async (text: string, target: string) => {
    const result = await translateText(text, target);
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
      // Use a broad language hint but let auto-detect handle it
      recognition.lang = ''; // Empty = browser default, usually works for multi-language
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
                if (sentence) translateAndAddToHistory(sentence, currentTarget);
              }
              return parts[parts.length - 1].trim();
            }
            return combined;
          });

          if (sentenceTimeoutRef.current) clearTimeout(sentenceTimeoutRef.current);
          sentenceTimeoutRef.current = setTimeout(() => {
            setCurrentSentence(prev => {
              if (prev?.trim()) translateAndAddToHistory(prev.trim(), targetLangRef.current);
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
            // Silent restart via onend
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
      if (prev?.trim()) translateAndAddToHistory(prev.trim(), targetLangRef.current);
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

  return (
    <div className="h-screen w-screen bg-gradient-to-br from-blue-50 to-purple-50 flex flex-col overflow-hidden">
      <div className="flex-1 flex flex-col h-full overflow-auto">
        <div className={`bg-white flex-1 flex flex-col ${isEmbed ? 'p-2 sm:p-3' : 'p-3 sm:p-4 md:p-6 lg:p-8'}`}>
          {/* Title - hidden in embed mode */}
          {!isEmbed && (
            <h1 className="text-xl sm:text-2xl md:text-3xl font-bold text-center mb-4 sm:mb-6 md:mb-8 bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
              AI 即時語音翻譯工具
            </h1>
          )}

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

          {/* Target language selector + detected language display */}
          <div className="flex items-center justify-center gap-2 sm:gap-4 mb-4 flex-wrap">
            {detectedLang && (
              <div className="flex items-center gap-1 px-3 py-1.5 bg-green-50 border border-green-200 rounded-lg text-sm">
                <span className="text-green-700">🔍 偵測:</span>
                <span className="font-medium text-green-800">{langName(detectedLang)}</span>
              </div>
            )}
            <span className="text-gray-500 text-sm">→</span>
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
            <label className="text-xs font-medium text-gray-700 mb-2 block">手動輸入（自動偵測語言）</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={sourceText}
                onChange={(e) => setSourceText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && sourceText.trim()) {
                    translateAndAddToHistory(sourceText.trim(), targetLang);
                    setSourceText('');
                  }
                }}
                placeholder="輸入任何語言的文字，按 Enter 翻譯..."
                className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={() => { if (sourceText.trim()) { translateAndAddToHistory(sourceText.trim(), targetLang); setSourceText(''); } }}
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

          {/* Instructions - hidden in embed mode */}
          {!isEmbed && (
            <div className="mt-auto pt-4">
              <div className="p-3 bg-blue-50 rounded-lg">
                <p className="text-xs sm:text-sm text-blue-800 font-semibold mb-1">💡 使用說明：</p>
                <ul className="text-xs sm:text-sm text-blue-700 space-y-0.5">
                  <li>• 語言自動偵測，您只需選擇翻譯目標語言</li>
                  <li>• 點擊麥克風按鈕開始語音輸入（首次需允許麥克風權限）</li>
                  <li>• 也可以直接在文字框輸入或貼上任何語言的文字</li>
                  <li>• 點擊喇叭圖標可朗讀，點擊複製按鈕可複製</li>
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default VoiceTranslator;
