import { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Volume2, ArrowRightLeft, Copy, AlertCircle, Shield } from 'lucide-react';

const VoiceTranslator = () => {
  const [isListening, setIsListening] = useState(false);
  const [sourceText, setSourceText] = useState('');  // 保留但僅用於手動輸入
  const [interimText, setInterimText] = useState(''); // 臨時識別的文字
  const [sourceLang, setSourceLang] = useState('zh-TW');
  const [targetLang, setTargetLang] = useState('en');
  const [, setIsTranslating] = useState(false);
  const [copiedItem, setCopiedItem] = useState<{ id: number; type: 'source' | 'translation' } | null>(null); // 追蹤哪個項目和類型被複製
  const [error, setError] = useState('');
  const [micPermission, setMicPermission] = useState('prompt'); // 'granted', 'denied', 'prompt'

  // 翻譯歷史記錄
  const [translationHistory, setTranslationHistory] = useState<Array<{
    id: number;
    source: string;
    translation: string;
    sourceLang: string;
    targetLang: string;
    timestamp: string;
  }>>([]);
  const [currentSentence, setCurrentSentence] = useState(''); // 當前正在組成的句子

  const recognitionRef = useRef<any>(null);
  const [isSupported, setIsSupported] = useState(false);
  const restartTimeoutRef = useRef<any>(null);
  const sentenceTimeoutRef = useRef<any>(null); // 句子結束計時器

  // 檢查瀏覽器是否支援語音識別和麥克風權限
  useEffect(() => {
    // 檢查語音識別支援
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      setIsSupported(true);
    }

    // 檢查麥克風權限狀態
    checkMicrophonePermission();
  }, []);

  // 檢查麥克風權限
  const checkMicrophonePermission = async () => {
    try {
      if (navigator.permissions) {
        const permission = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        setMicPermission(permission.state);

        permission.addEventListener('change', () => {
          setMicPermission(permission.state);
        });
      }
    } catch (err) {
      console.log('無法檢查權限狀態:', err);
    }
  };

  // 請求麥克風權限
  const requestMicrophonePermission = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop()); // 立即停止串流
      setMicPermission('granted');
      setError('');
      return true;
    } catch (err) {
      console.error('麥克風權限請求失敗:', err);
      setMicPermission('denied');

      const error = err as Error & { name: string };
      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        setError('麥克風權限被拒絕。請在瀏覽器設定中允許使用麥克風。');
      } else if (error.name === 'NotFoundError') {
        setError('找不到麥克風設備。請確認您的設備已連接麥克風。');
      } else if (error.name === 'NotReadableError') {
        setError('麥克風正在被其他應用程式使用。');
      } else {
        setError('無法存取麥克風：' + error.message);
      }
      return false;
    }
  };

  // Google Cloud Translation API
  const translateText = async (text: string, source: string, target: string): Promise<string> => {
    if (!text) return '';

    setIsTranslating(true);
    setError('');

    try {
      // 從環境變數取得 API Key
      const API_KEY = import.meta.env.VITE_GOOGLE_TRANSLATE_API_KEY;

      if (!API_KEY) {
        throw new Error('Google Translation API Key 未設定。請在 .env 檔案中設定 VITE_GOOGLE_TRANSLATE_API_KEY');
      }

      // 語言代碼映射（確保與 Google Translate API 相容）
      const languageMap: { [key: string]: string } = {
        'zh-TW': 'zh-TW',  // 繁體中文
        'en': 'en',        // 英文
        'ja': 'ja'         // 日文
      };

      const sourceLanguage = languageMap[source] || source;
      const targetLanguage = languageMap[target] || target;

      // 呼叫 Google Cloud Translation API
      const response = await fetch(
        `https://translation.googleapis.com/language/translate/v2?key=${API_KEY}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            q: text,
            source: sourceLanguage,
            target: targetLanguage,
            format: 'text'
          })
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || '翻譯請求失敗');
      }

      const data = await response.json();

      if (data.data?.translations?.[0]?.translatedText) {
        return data.data.translations[0].translatedText;
      } else {
        throw new Error('無法取得翻譯結果');
      }
    } catch (err) {
      console.error('Translation error:', err);
      const errorMessage = err instanceof Error ? err.message : String(err);

      // 根據錯誤類型提供更詳細的錯誤訊息
      if (errorMessage.includes('API Key')) {
        setError('請設定 Google Translation API Key（詳見下方說明）');
      } else if (errorMessage.includes('403')) {
        setError('API Key 無效或沒有啟用 Translation API');
      } else if (errorMessage.includes('429')) {
        setError('API 請求次數超過限制，請稍後再試');
      } else if (errorMessage.includes('Network')) {
        setError('網路連線失敗，請檢查網路連線');
      } else {
        setError(`翻譯失敗: ${errorMessage}`);
      }
      return '';
    } finally {
      setIsTranslating(false);
    }
  };

  // 翻譯並加入歷史記錄
  const translateAndAddToHistory = async (text: string, source: string, target: string) => {
    // 檢查是否已經存在相同的文字（避免重複）
    const isDuplicate = translationHistory.some(
      item => item.source === text && 
      item.sourceLang === source && 
      item.targetLang === target &&
      // 檢查是否在最近5秒內建立的
      (Date.now() - item.id) < 5000
    );
    
    if (isDuplicate) {
      console.log('避免重複翻譯:', text);
      return;
    }
    
    const translation = await translateText(text, source, target);
    if (translation) {
      const newItem = {
        id: Date.now(),
        source: text,
        translation: translation,
        sourceLang: source,
        targetLang: target,
        timestamp: new Date().toISOString()
      };
      setTranslationHistory(prev => {
        // 再次檢查避免競爭狀態
        const exists = prev.some(
          item => item.source === text && 
          (Date.now() - item.id) < 5000
        );
        if (exists) {
          return prev;
        }
        return [newItem, ...prev].slice(0, 20);
      });
    }
  };

  // 開始/停止語音識別
  const toggleListening = async () => {
    if (!isSupported) {
      setError('您的瀏覽器不支援語音識別功能。請使用Chrome、Edge或Safari瀏覽器。');
      return;
    }

    // 檢查HTTPS
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
      setError('語音識別需要在HTTPS網站上使用。');
      return;
    }

    if (isListening) {
      stopListening();
    } else {
      // 先請求麥克風權限
      const hasPermission = await requestMicrophonePermission();
      if (hasPermission) {
        startListening();
      }
    }
  };

  const startListening = () => {
    try {
      const SpeechRecognition = window.webkitSpeechRecognition || window.SpeechRecognition;

      // 如果已經有實例，先停止它
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
          recognitionRef.current = null;
        } catch (e) {
          // 忽略錯誤
        }
      }

      // 創建新實例
      const recognition = new SpeechRecognition();

      // 配置語音識別 - 使用最穩定的設定
      recognition.continuous = true; // 改回 true 但會適時重啟
      recognition.interimResults = true; // 顯示即時結果
      recognition.lang = sourceLang === 'zh-TW' ? 'zh-TW' : sourceLang === 'ja' ? 'ja-JP' : 'en-US';
      recognition.maxAlternatives = 1;

      // 儲存實例
      recognitionRef.current = recognition;

      recognition.onstart = () => {
        setIsListening(true);
        setError('');
        console.log('語音識別已開始');
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
          // 確定的文字
          const newText = finalTranscript.trim();

          // 檢查是否包含句子結束標點
          const sentenceEnders = /[。！？.!?\n]/g;

          // 更新當前句子
          setCurrentSentence(prev => {
            const combined = prev ? prev + ' ' + newText : newText;
            
            // 分割句子
            const parts = combined.split(sentenceEnders);
            
            // 如果有完整的句子（除了最後一部分）
            if (parts.length > 1) {
              // 處理所有完整的句子（不包括最後一部分）
              for (let i = 0; i < parts.length - 1; i++) {
                const sentence = parts[i].trim();
                if (sentence) {
                  // 翻譯並加入歷史
                  translateAndAddToHistory(sentence, sourceLang, targetLang);
                }
              }
              // 返回最後一部分（可能是空的或未完成的句子）
              return parts[parts.length - 1].trim();
            }
            
            return combined;
          });

          // 設定計時器：如果3秒內沒有新輸入，視為句子結束
          if (sentenceTimeoutRef.current) {
            clearTimeout(sentenceTimeoutRef.current);
          }
          sentenceTimeoutRef.current = setTimeout(() => {
            setCurrentSentence(prev => {
              if (prev && prev.trim()) {
                translateAndAddToHistory(prev.trim(), sourceLang, targetLang);
              }
              return '';
            });
          }, 3000);

          setInterimText(''); // 清除臨時文字
        } else if (interimTranscript) {
          // 臨時文字：即時顯示但不翻譯
          setInterimText(interimTranscript);
          console.log('識別中:', interimTranscript);
        }
      };

      recognition.onerror = (event: any) => {
        console.error('語音識別錯誤:', event.error);

        // 詳細的錯誤處理
        switch(event.error) {
          case 'not-allowed':
            setError('麥克風權限被拒絕。請按照以下步驟操作：\n1. 點擊網址列旁的鎖頭圖標\n2. 找到「麥克風」設定\n3. 選擇「允許」\n4. 重新整理頁面');
            setMicPermission('denied');
            setIsListening(false);
            break;
          case 'no-speech':
            // 沒有檢測到語音時自動重啟（如果仍在監聽狀態）
            if (isListening) {
              console.log('沒有檢測到語音，重新啟動...');
              setTimeout(() => {
                if (recognitionRef.current && isListening) {
                  try {
                    recognitionRef.current.start();
                  } catch (e) {
                    console.log('重啟時發生錯誤:', e);
                  }
                }
              }, 100);
            }
            break;
          case 'audio-capture':
            setError('找不到麥克風。請確認麥克風已正確連接。');
            setIsListening(false);
            break;
          case 'network':
            // 網路錯誤是 Chrome 的常見問題，特別是在長時間連接後
            console.log('網路錯誤 - 這是 Chrome 語音識別的已知問題');
            // 不顯示錯誤，靜默處理
            // onend 事件會自動觸發並重啟
            break;
          case 'aborted':
            console.log('語音識別被中斷');
            break;
          case 'service-not-allowed':
            setError('語音識別服務不可用。請確認使用HTTPS連接。');
            setIsListening(false);
            break;
          default:
            setError(`語音識別錯誤: ${event.error}`);
            setIsListening(false);
        }
      };

      recognition.onend = () => {
        console.log('語音識別已結束');
        // 如果仍在監聽狀態，自動重啟
        if (isListening) {
          console.log('自動重啟語音識別...');
          // 清除舊的 timeout
          if (restartTimeoutRef.current) {
            clearTimeout(restartTimeoutRef.current);
          }
          // 短暫延遲後重啟，避免太頻繁
          restartTimeoutRef.current = setTimeout(() => {
            if (isListening) {
              try {
                // 直接啟動新的識別會話
                if (recognitionRef.current) {
                  recognitionRef.current.start();
                  console.log('語音識別已重啟');
                }
              } catch (e) {
                // 如果失敗，嘗試創建新實例
                console.log('重啟失敗，創建新實例...');
                try {
                  startListening();
                } catch (err) {
                  console.error('無法重新啟動:', err);
                  setIsListening(false);
                  setError('語音識別暫時不可用，請重新點擊開始');
                }
              }
            }
          }, 250); // 增加延遲時間到 250ms
        } else {
          setIsListening(false);
        }
      };

      recognition.onspeechend = () => {
        console.log('語音輸入結束');
        // 語音結束後會觸發onend，然後自動重啟
      };

      recognition.onaudiostart = () => {
        console.log('音訊捕獲開始');
      };

      recognition.onaudioend = () => {
        console.log('音訊捕獲結束');
      };

      // 啟動識別
      recognition.start();
    } catch (err) {
      console.error('啟動語音識別失敗:', err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError('無法啟動語音識別：' + errorMessage);
      setIsListening(false);
    }
  };

  const stopListening = () => {
    setIsListening(false); // 先設定狀態，防止自動重啟
    setInterimText(''); // 清除臨時文字

    // 處理未完成的句子
    if (currentSentence && currentSentence.trim()) {
      translateAndAddToHistory(currentSentence.trim(), sourceLang, targetLang);
      setCurrentSentence('');
    }

    // 清除所有 timeout
    if (restartTimeoutRef.current) {
      clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }
    if (sentenceTimeoutRef.current) {
      clearTimeout(sentenceTimeoutRef.current);
      sentenceTimeoutRef.current = null;
    }

    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
        recognitionRef.current = null; // 清除引用
      } catch (e) {
        console.log('停止語音識別時發生錯誤:', e);
      }
    }
  };

  // 交換語言
  const swapLanguages = () => {
    setSourceLang(targetLang);
    setTargetLang(sourceLang);
    // 交換歷史記錄的語言
    setTranslationHistory(prev => prev.map(item => ({
      ...item,
      source: item.translation,
      translation: item.source,
      sourceLang: item.targetLang,
      targetLang: item.sourceLang
    })));
    setInterimText(''); // 清除臨時文字
  };


  // 文字轉語音
  const speakText = (text: string, lang: string) => {
    if ('speechSynthesis' in window) {
      // 停止當前播放
      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = lang === 'zh-TW' ? 'zh-TW' : lang === 'ja' ? 'ja-JP' : 'en-US';
      utterance.rate = 0.9; // 稍微慢一點
      utterance.pitch = 1.0;
      utterance.volume = 1.0;

      window.speechSynthesis.speak(utterance);
    }
  };

  // 不再自動翻譯手動輸入，改為按 Enter 或點擊按鈕才翻譯

  // 清理 effect
  useEffect(() => {
    return () => {
      // 組件卸載時清理
      if (restartTimeoutRef.current) {
        clearTimeout(restartTimeoutRef.current);
      }
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch (e) {
          // 忽略錯誤
        }
      }
    };
  }, []);

  const languages = [
    { code: 'zh-TW', name: '繁體中文' },
    { code: 'en', name: 'English' },
    { code: 'ja', name: '日本語' }
  ];

  return (
    <div className="h-screen w-screen bg-gradient-to-br from-blue-50 to-purple-50 flex flex-col overflow-hidden">
      <div className="flex-1 flex flex-col h-full overflow-auto">
        <div className="bg-white flex-1 flex flex-col p-3 sm:p-4 md:p-6 lg:p-8">
          <h1 className="text-xl sm:text-2xl md:text-3xl font-bold text-center mb-4 sm:mb-6 md:mb-8 bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
            AI 即時語音翻譯工具
          </h1>

          {/* 權限狀態提示 */}
          {micPermission === 'denied' && (
            <div className="mb-3 sm:mb-4 p-3 sm:p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
              <div className="flex items-start gap-3">
                <Shield className="w-5 h-5 text-yellow-600 mt-1" />
                <div className="text-sm text-yellow-800">
                  <p className="font-semibold mb-2">需要麥克風權限</p>
                  <p>請按照以下步驟允許麥克風存取：</p>
                  <ol className="list-decimal list-inside mt-2 space-y-1">
                    <li>點擊瀏覽器網址列的 🔒 鎖頭或 ⓘ 圖標</li>
                    <li>找到「麥克風」或「Microphone」設定</li>
                    <li>選擇「允許」或「Allow」</li>
                    <li>重新整理此頁面（按 F5）</li>
                  </ol>
                </div>
              </div>
            </div>
          )}

          {/* 語言選擇器 */}
          <div className="flex items-center justify-center gap-2 sm:gap-4 mb-4 sm:mb-6 flex-wrap">
            <select
              value={sourceLang}
              onChange={(e) => setSourceLang(e.target.value)}
              className="px-2 sm:px-4 py-1.5 sm:py-2 text-sm sm:text-base border-2 border-gray-200 rounded-lg focus:outline-none focus:border-blue-500 transition-colors"
            >
              {languages.map(lang => (
                <option key={lang.code} value={lang.code}>{lang.name}</option>
              ))}
            </select>

            <button
              onClick={swapLanguages}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              title="交換語言"
            >
              <ArrowRightLeft className="w-5 h-5 text-gray-600" />
            </button>

            <select
              value={targetLang}
              onChange={(e) => setTargetLang(e.target.value)}
              className="px-2 sm:px-4 py-1.5 sm:py-2 text-sm sm:text-base border-2 border-gray-200 rounded-lg focus:outline-none focus:border-blue-500 transition-colors"
            >
              {languages.filter(l => l.code !== sourceLang).map(lang => (
                <option key={lang.code} value={lang.code}>{lang.name}</option>
              ))}
            </select>
          </div>

          {/* 錯誤訊息 */}
          {error && (
            <div className="mb-3 sm:mb-4 p-2 sm:p-3 bg-red-50 border border-red-200 rounded-lg">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <div className="text-red-600 text-sm whitespace-pre-line">{error}</div>
              </div>
            </div>
          )}

          {/* 當前句子顯示 */}
          {(currentSentence || interimText) && (
            <div className="mb-4 p-3 sm:p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
              <div className="flex items-start gap-2">
                <div className="animate-pulse">
                  <Mic className="w-5 h-5 text-yellow-600" />
                </div>
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

          {/* 翻譯歷史 */}
          <div className="flex-1 overflow-hidden flex flex-col mb-4">
            <div className="flex justify-between items-center mb-2">
              <h2 className="text-sm sm:text-base font-semibold text-gray-700">翻譯記錄</h2>
              {translationHistory.length > 0 && (
                <span className="text-xs text-gray-500">
                  共 {translationHistory.length} 條
                </span>
              )}
            </div>

            <div className="flex-1 overflow-y-auto space-y-2 sm:space-y-3 p-2 bg-gray-50 rounded-lg border border-gray-200">
              {translationHistory.length === 0 ? (
                <div className="text-center py-8 text-gray-400">
                  <p className="text-sm">還沒有翻譯記錄</p>
                  <p className="text-xs mt-1">開始說話或輸入文字吧！</p>
                </div>
              ) : (
                translationHistory.map(item => (
                  <div key={item.id} className="bg-white rounded-lg p-3 shadow-sm hover:shadow-md transition-shadow">
                    <div className="flex flex-col gap-2">
                      {/* 原文區塊 */}
                      <div className="flex justify-between items-start gap-2">
                        <div className="flex-1">
                          <p className="text-xs text-gray-500 mb-1">{languages.find(l => l.code === item.sourceLang)?.name}</p>
                          <p className="text-sm sm:text-base text-gray-800">{item.source}</p>
                        </div>
                        <div className="flex gap-1 flex-shrink-0">
                          <button
                            onClick={() => speakText(item.source, item.sourceLang)}
                            className="p-1 hover:bg-gray-100 rounded transition-colors"
                            title="朗讀原文"
                          >
                            <Volume2 className="w-3 h-3 text-gray-500" />
                          </button>
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(item.source);
                              setCopiedItem({ id: item.id, type: 'source' });
                              setTimeout(() => setCopiedItem(null), 2000);
                            }}
                            className="p-1 hover:bg-gray-100 rounded transition-colors"
                            title="複製原文"
                          >
                            <Copy className={`w-3 h-3 ${copiedItem?.id === item.id && copiedItem?.type === 'source' ? 'text-green-600' : 'text-gray-500'}`} />
                          </button>
                        </div>
                      </div>
                      
                      {/* 分隔線 */}
                      <div className="border-t"></div>
                      
                      {/* 翻譯區塊 */}
                      <div className="flex justify-between items-start gap-2">
                        <div className="flex-1">
                          <p className="text-xs text-gray-500 mb-1">{languages.find(l => l.code === item.targetLang)?.name}</p>
                          <p className="text-sm sm:text-base text-gray-700">{item.translation}</p>
                        </div>
                        <div className="flex gap-1 flex-shrink-0">
                          <button
                            onClick={() => speakText(item.translation, item.targetLang)}
                            className="p-1 hover:bg-gray-100 rounded transition-colors"
                            title="朗讀翻譯"
                          >
                            <Volume2 className="w-3 h-3 text-gray-500" />
                          </button>
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(item.translation);
                              setCopiedItem({ id: item.id, type: 'translation' });
                              setTimeout(() => setCopiedItem(null), 2000);
                            }}
                            className="p-1 hover:bg-gray-100 rounded transition-colors"
                            title="複製翻譯"
                          >
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

          {/* 手動輸入區 */}
          <div className="mb-4 p-3 sm:p-4 bg-white rounded-lg border border-gray-200">
            <label className="text-xs sm:text-sm font-medium text-gray-700 mb-2 block">手動輸入</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={sourceText}
                onChange={(e) => setSourceText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && sourceText.trim()) {
                    translateAndAddToHistory(sourceText.trim(), sourceLang, targetLang);
                    setSourceText('');
                  }
                }}
                placeholder="輸入文字後按 Enter 鍵翻譯..."
                className="flex-1 px-3 py-2 text-sm sm:text-base border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 transition-colors"
              />
              <button
                onClick={() => {
                  if (sourceText.trim()) {
                    translateAndAddToHistory(sourceText.trim(), sourceLang, targetLang);
                    setSourceText('');
                  }
                }}
                disabled={!sourceText.trim()}
                className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors text-sm"
              >
                翻譯
              </button>
            </div>
          </div>

          {/* 控制按鈕 */}
          <div className="flex justify-center gap-2 sm:gap-4 flex-wrap">
            <button
              onClick={toggleListening}
              disabled={!isSupported}
              className={`flex items-center gap-1 sm:gap-2 px-4 sm:px-6 py-2 sm:py-3 text-sm sm:text-base rounded-lg font-medium transition-all ${
                isListening
                  ? 'bg-red-500 hover:bg-red-600 text-white'
                  : isSupported
                    ? 'bg-blue-500 hover:bg-blue-600 text-white'
                    : 'bg-gray-300 text-gray-500 cursor-not-allowed'
              }`}
            >
              {isListening ? (
                <>
                  <MicOff className="w-5 h-5" />
                  停止錄音
                </>
              ) : (
                <>
                  <Mic className="w-5 h-5" />
                  開始語音輸入
                </>
              )}
            </button>

            <button
              onClick={() => {
                setSourceText('');
                setInterimText('');
                setCurrentSentence('');
                setTranslationHistory([]);
                setError('');
                if (sentenceTimeoutRef.current) {
                  clearTimeout(sentenceTimeoutRef.current);
                  sentenceTimeoutRef.current = null;
                }
              }}
              className="px-4 sm:px-6 py-2 sm:py-3 text-sm sm:text-base bg-gray-200 hover:bg-gray-300 rounded-lg font-medium transition-colors"
            >
              清除
            </button>
          </div>

          {/* 瀏覽器支援提示 */}
          {!isSupported && (
            <div className="mt-3 sm:mt-4 p-2 sm:p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
              <p className="text-sm text-yellow-800">
                您的瀏覽器不支援語音識別。請使用以下瀏覽器：
                Chrome、Edge、Safari (macOS/iOS) 或其他基於Chromium的瀏覽器。
              </p>
            </div>
          )}

          {/* 說明文字 */}
          <div className="mt-auto pt-4 sm:pt-6">
          <div className="p-3 sm:p-4 bg-blue-50 rounded-lg">
            <p className="text-xs sm:text-sm text-blue-800 font-semibold mb-1 sm:mb-2">
              💡 使用說明：
            </p>
            <ul className="text-xs sm:text-sm text-blue-700 space-y-0.5 sm:space-y-1">
              <li>• 點擊麥克風按鈕開始語音輸入（首次使用需允許麥克風權限）</li>
              <li>• 也可以直接在文字框輸入或貼上文字</li>
              <li>• 支援中文、英文、日文三種語言互譯</li>
              <li>• 點擊喇叭圖標可朗讀文字內容</li>
              <li>• 點擊複製按鈕可複製翻譯結果</li>
            </ul>
          </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default VoiceTranslator;