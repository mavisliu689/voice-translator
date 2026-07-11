import { useCallback, useEffect, useRef } from 'react';
import { liveWsUrl } from '../lib/api';

export type LiveStatus = 'idle' | 'connecting' | 'live' | 'error';
export type LiveAudioSource = 'mic' | 'tab';

export interface UseLiveTranslateParams {
  /** Running (incremental) source + translation for the live preview. */
  onPartial: (source: string, translation: string) => void;
  /** A finalized utterance ready to commit. `target` is the language this session
   *  actually translated into (the live targetLang may have changed since). */
  onCommit: (source: string, translation: string, target: string) => void;
  onError: (message: string) => void;
  onStatus: (status: LiveStatus) => void;
}

export interface UseLiveTranslate {
  start: (target: string, source: LiveAudioSource, rawMic: boolean) => Promise<void>;
  stop: () => void;
}

function humanizeMediaError(err: unknown): string {
  const e = err as { name?: string; message?: string };
  if (e?.name === 'NotAllowedError' || e?.name === 'PermissionDeniedError') return '麥克風／音訊權限被拒絕。';
  if (e?.name === 'NotFoundError') return '找不到音訊裝置。';
  return e?.message || '無法取得音訊來源。';
}

/**
 * Streams microphone or tab audio to the backend Live Translate bridge and
 * surfaces incremental source/translation transcripts. The audio graph stays
 * alive across the Gemini session time-limit ('limit'); only the WebSocket is
 * re-established, so a long meeting keeps translating seamlessly.
 */
export function useLiveTranslate(params: UseLiveTranslateParams): UseLiveTranslate {
  // Keep callbacks in a ref so start/stop can stay stable (no effect churn / stale closures).
  const cbRef = useRef(params);
  useEffect(() => { cbRef.current = params; });

  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const srcNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startedRef = useRef(false); // user intends to be running (false = intentional stop)
  const readyRef = useRef(false);   // Gemini session ready → ok to pump audio
  const retryRef = useRef(0);
  const targetRef = useRef('zh-TW');
  const curInRef = useRef('');
  const curOutRef = useRef('');

  const commit = useCallback(() => {
    const s = curInRef.current.trim();
    const t = curOutRef.current.trim();
    if (s || t) cbRef.current.onCommit(s, t, targetRef.current);
    curInRef.current = '';
    curOutRef.current = '';
  }, []);

  const stop = useCallback(() => {
    startedRef.current = false;
    readyRef.current = false;
    if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
    commit();
    try { nodeRef.current?.disconnect(); } catch { /* */ }
    try { srcNodeRef.current?.disconnect(); } catch { /* */ }
    try { if (ctxRef.current && ctxRef.current.state !== 'closed') ctxRef.current.close(); } catch { /* */ }
    try { streamRef.current?.getTracks().forEach(t => t.stop()); } catch { /* */ }
    try { wsRef.current?.close(); } catch { /* */ }
    nodeRef.current = null;
    srcNodeRef.current = null;
    ctxRef.current = null;
    streamRef.current = null;
    wsRef.current = null;
    cbRef.current.onStatus('idle');
  }, [commit]);

  const connectWs = useCallback((target: string) => {
    cbRef.current.onStatus('connecting');
    const ws = new WebSocket(liveWsUrl(target));
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onmessage = (ev) => {
      let m: { type: string; text?: string };
      try { m = JSON.parse(ev.data as string); } catch { return; }
      switch (m.type) {
        case 'ready':
          readyRef.current = true;
          retryRef.current = 0;
          cbRef.current.onStatus('live');
          break;
        case 'input':
          curInRef.current += m.text || '';
          cbRef.current.onPartial(curInRef.current, curOutRef.current);
          break;
        case 'output':
          curOutRef.current += m.text || '';
          cbRef.current.onPartial(curInRef.current, curOutRef.current);
          // Gemini can go a very long time without turnComplete during continuous
          // speech (meetings), leaving the utterance stuck in the preview forever.
          // Force-commit past a length cap; buffers reset so nothing is duplicated.
          // ponytail: fixed 80-char cap, tune if commits feel too chunky/choppy
          if (curInRef.current.length >= 80) commit();
          break;
        case 'turnComplete':
          commit();
          break;
        case 'limit':
          // Session time-limit reached; server will close. Commit & let onclose reconnect.
          readyRef.current = false;
          commit();
          break;
        case 'idle':
          // Server ended the session after a stretch of no audio (e.g. tab-share
          // was stopped). End quietly — do NOT reconnect into a dead audio source.
          stop();
          break;
        case 'disabled':
          // Admin kill switch / cost cap reached. End and surface why; no reconnect.
          cbRef.current.onError(m.text || '高品質翻譯已停用');
          stop();
          break;
        case 'error':
          cbRef.current.onError(m.text || '即時翻譯發生錯誤');
          stop();
          break;
        default:
          break;
      }
    };

    ws.onclose = () => {
      readyRef.current = false;
      if (!startedRef.current) return; // intentional stop
      if (retryRef.current < 5) {
        retryRef.current++;
        reconnectTimerRef.current = setTimeout(() => {
          if (startedRef.current) connectWs(targetRef.current);
        }, 400);
      } else {
        cbRef.current.onError('即時翻譯連線中斷，請重試。');
        stop();
      }
    };

    ws.onerror = () => { /* surfaced via onclose */ };
  }, [commit, stop]);

  const getStream = useCallback(async (source: LiveAudioSource, rawMic: boolean): Promise<MediaStream> => {
    if (source === 'tab') {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      if (!s.getAudioTracks().length) {
        s.getTracks().forEach(t => t.stop());
        throw new Error('未取得分頁音訊：請在分享視窗勾選「分享分頁音訊」。');
      }
      // Keep the video track (muted) instead of stopping it: Chrome fires the
      // native "stop sharing" event reliably on the VIDEO track, which we listen
      // for in start() to end the session — and stop billing — cleanly.
      s.getVideoTracks().forEach(t => { t.enabled = false; });
      return s;
    }
    const off = rawMic;
    return navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: !off, noiseSuppression: !off, autoGainControl: !off },
    });
  }, []);

  const start = useCallback(async (target: string, source: LiveAudioSource, rawMic: boolean) => {
    if (startedRef.current) return;
    cbRef.current.onStatus('connecting');
    try {
      const stream = await getStream(source, rawMic);
      streamRef.current = stream;

      const Ctx = window.AudioContext
        || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx({ sampleRate: 16000 });
      ctxRef.current = ctx;
      await ctx.audioWorklet.addModule('/live-translate-worklet.js');

      const srcNode = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'pcm-worklet');
      node.port.onmessage = (e: MessageEvent) => {
        const ws = wsRef.current;
        if (readyRef.current && ws && ws.readyState === WebSocket.OPEN) ws.send(e.data as ArrayBuffer);
      };
      srcNode.connect(node);
      node.connect(ctx.destination); // silent (worklet writes no output); only to keep it pulling
      srcNodeRef.current = srcNode;
      nodeRef.current = node;

      // Stop cleanly if ANY track ends — mic unplugged, or tab-share stopped from
      // the browser's own UI (which fires 'ended' on the video track, not audio).
      stream.getTracks().forEach(t => t.addEventListener('ended', () => stop()));

      startedRef.current = true;
      targetRef.current = target;
      retryRef.current = 0;
      curInRef.current = '';
      curOutRef.current = '';
      connectWs(target);
    } catch (err) {
      cbRef.current.onError(humanizeMediaError(err));
      stop();
    }
  }, [getStream, connectWs, stop]);

  // Clean up on unmount.
  useEffect(() => stop, [stop]);

  return { start, stop };
}
