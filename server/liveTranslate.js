// ---------------------------------------------------------------------------
// Gemini 3.5 Live Translate — WebSocket bridge (production integration)
// ---------------------------------------------------------------------------
// 把瀏覽器的即時音訊串流橋接到 gemini-3.5-live-translate-preview，回傳原文/譯文
// 逐字稿。API key 全程留在後端（瀏覽器只連到本服務的 same-origin WebSocket）。
//
// 這是一個「無 auth、可被公開 embed 訪客觸發、按音訊分鐘真實計費」的端點，因此
// 成本/濫用防護是設計核心：
//   - 全域併發上限 + per-IP 併發上限（攔截「同時開大量 session 衝破月上限」）
//   - 成本上限判斷會納入「進行中 session 的 in-flight 成本」（見 getInFlightCostUsd）
//   - 單次 session 10 分鐘硬上限 + 無音訊 inactivity 自動結束
//   - maxPayload 限制單一音訊幀大小
//   - kill switch / 月上限變更可立即中斷所有進行中 session（closeAllLiveSessions）
//   - 計費與「是否有逐字稿產出」解耦：只要送過音訊就按 wall-clock 計費
//
// Protocol（瀏覽器 ⇄ 本服務，path = /ws/live-translate?target=zh-TW）：
//   client → server : binary frames = raw 16-bit PCM @16kHz mono（每 100ms 一塊）
//   server → client : JSON { type, text? }
//     ready | input | output | turnComplete | limit | idle | disabled | error | closed
// ---------------------------------------------------------------------------

import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';
import { toTraditional } from './zhConvert.js';

const MODEL = 'gemini-3.5-live-translate-preview';

// Customer-facing price per audio-minute. Raw Gemini Live cost is ~$0.023/min;
// we bill at 100× as the service price, so this is the figure that gets logged,
// shown to the admin, and compared against the monthly cap.
export const LIVE_COST_PER_MINUTE = 0.023 * 100; // = 2.3 USD/min (100× markup)

// 單次 session 硬上限：Live API session 本身約 10–15 分鐘上限，這裡保守 10 分鐘。
const LIVE_MAX_SESSION_MS = 10 * 60 * 1000;

// 無音訊（client 停止送幀，例如分頁停止分享）→ 自動結束，避免殭屍 session 持續計費。
const INACTIVITY_MS = 30 * 1000;

// 併發上限（成本的真正防線；可由環境變數覆寫）。
const MAX_CONCURRENT = Number(process.env.LIVE_MAX_CONCURRENT) || 25;
const MAX_CONCURRENT_PER_IP = Number(process.env.LIVE_MAX_CONCURRENT_PER_IP) || 3;

// 單一音訊幀上限：100ms@16k 16-bit = 3200B，給足餘裕。超過即斷線。
const MAX_FRAME_BYTES = 16 * 1024;

/**
 * Attach the Live Translate WebSocket bridge to an existing http.Server.
 *
 * @returns {{ wss: import('ws').WebSocketServer, getInFlightCostUsd: () => number, closeAllLiveSessions: (reason?: string) => void }}
 */
export function attachLiveTranslate(server, { supportedLangs, getLiveStatus, logUsage, allowedOrigins }) {
  const API_KEY = process.env.GEMINI_API_KEY;
  const ai = API_KEY ? new GoogleGenAI({ apiKey: API_KEY }) : null;

  // Registry of live sessions for concurrency limits, in-flight cost, and kill-all.
  /** @type {Set<{ startedAt: number, clientWs: import('ws').WebSocket, teardown: () => void }>} */
  const active = new Set();
  /** @type {Map<string, number>} */
  const perIp = new Map();

  const ipOf = (req) =>
    String(req.headers['cf-connecting-ip'] || req.socket?.remoteAddress || 'unknown');

  const originAllowed = (origin) => {
    if (!allowedOrigins || allowedOrigins.includes('*')) return true;
    if (!origin) return true; // same-origin / non-browser may omit; per-IP limit still applies
    return allowedOrigins.includes(origin);
  };

  // Conservative in-flight cost = sum of already-elapsed billable minutes of every
  // active session. Fed into the monthly-cap check so concurrent sessions can't all
  // slip under the cap by being individually cheap at connect time.
  const getInFlightCostUsd = () => {
    let cost = 0;
    const now = Date.now();
    for (const s of active) {
      const ms = Math.min(LIVE_MAX_SESSION_MS, now - s.startedAt);
      cost += (ms / 60000) * LIVE_COST_PER_MINUTE;
    }
    return cost;
  };

  const wss = new WebSocketServer({ server, path: '/ws/live-translate', maxPayload: MAX_FRAME_BYTES });

  wss.on('connection', async (clientWs, req) => {
    const send = (obj) => { if (clientWs.readyState === clientWs.OPEN) clientWs.send(JSON.stringify(obj)); };
    const reject = (type, text) => { send({ type, text }); try { clientWs.close(); } catch { /* */ } };

    // Attach 'error'/'close' listeners FIRST, before any check or async work. ws
    // enforces maxPayload from the moment of upgrade, so an oversized/malformed
    // frame (or a raw socket reset) emits 'error' on clientWs — with no listener,
    // Node throws an uncaughtException and crashes the whole process (an
    // unauthenticated remote DoS). `teardown` is a reassignable holder: a no-op
    // until a real session is reserved, then the full cleanup.
    let teardown = () => {};
    clientWs.on('error', (e) => { console.error('[live] socket error:', e?.message || e); teardown(); });
    clientWs.on('close', () => teardown());

    if (!ai) return reject('error', '高品質翻譯服務未設定（缺少 GEMINI_API_KEY）');
    if (!originAllowed(req.headers.origin)) return reject('error', '來源網域未授權');

    const ip = ipOf(req);
    if (active.size >= MAX_CONCURRENT) return reject('error', '即時翻譯目前使用人數已滿，請稍後再試');
    if ((perIp.get(ip) || 0) >= MAX_CONCURRENT_PER_IP) return reject('error', '同時連線數過多，請稍後再試');

    // Cap check INCLUDING in-flight cost of other active sessions.
    const status = getLiveStatus();
    if (!status.enabled) {
      const type = status.reason && status.reason.includes('關閉') ? 'disabled' : 'error';
      return reject(type, status.reason || '高品質翻譯目前已停用');
    }

    const target = new URL(req.url, 'http://localhost').searchParams.get('target') || 'zh-TW';
    if (!supportedLangs.has(target)) return reject('error', `不支援的目標語言: ${target}`);

    // ── Reserve the slot BEFORE the async connect to avoid a check-then-act race. ──
    const startedAt = Date.now();
    const sessionRec = { startedAt, clientWs, teardown: null };
    active.add(sessionRec);
    perIp.set(ip, (perIp.get(ip) || 0) + 1);

    let session = null;
    let closed = false;
    let outputChars = 0;
    let audioFrames = 0;
    let limitTimer = null;
    let idleTimer = null;

    const finishUsage = () => {
      const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      // Bill any session that actually streamed audio — Gemini charges per minute
      // regardless of whether a transcript came back (decoupled from outputChars).
      if (seconds > 0 && audioFrames > 0) {
        try {
          logUsage({ target, chars: outputChars, seconds, costUsd: (seconds / 60) * LIVE_COST_PER_MINUTE });
        } catch (e) { console.error('[live] logUsage 失敗:', e?.message || e); }
      }
    };

    // Promote the no-op holder registered at the top to the real cleanup now that
    // a slot is reserved. The 'error'/'close' listeners above call through to it.
    teardown = () => {
      if (closed) return;
      closed = true;
      if (limitTimer) { clearTimeout(limitTimer); limitTimer = null; }
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      active.delete(sessionRec);
      const n = (perIp.get(ip) || 1) - 1;
      if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);
      finishUsage();
      try { session?.close(); } catch { /* */ }
    };
    sessionRec.teardown = teardown;

    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        send({ type: 'idle' });
        teardown();
        try { clientWs.close(); } catch { /* */ }
      }, INACTIVITY_MS);
    };

    try {
      session = await ai.live.connect({
        model: MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          translationConfig: { targetLanguageCode: target, echoTargetLanguage: true },
        },
        callbacks: {
          onopen: () => send({ type: 'ready' }),
          onmessage: (message) => {
            const c = message?.serverContent;
            if (!c) return;
            // Force Traditional Chinese on both transcripts (no-op for non-Chinese).
            if (c.inputTranscription?.text) send({ type: 'input', text: toTraditional(c.inputTranscription.text) });
            if (c.outputTranscription?.text) {
              outputChars += c.outputTranscription.text.length;
              send({ type: 'output', text: toTraditional(c.outputTranscription.text) });
            }
            if (c.turnComplete) send({ type: 'turnComplete' });
          },
          onerror: (e) => {
            console.error('[live] Gemini error:', e?.message || e);
            if (closed) return;
            send({ type: 'error', text: '即時翻譯連線發生錯誤' });
            teardown(); // release the slot / bill immediately rather than waiting for idle timer
            try { clientWs.close(); } catch { /* */ }
          },
          // Gemini closing on its own (its own session limit / upstream issue): tear
          // down and close the client socket so the front-end can reconnect cleanly
          // instead of being stuck with a half-open, silent session.
          onclose: () => { if (!closed) { send({ type: 'closed' }); teardown(); try { clientWs.close(); } catch { /* */ } } },
        },
      });
    } catch (err) {
      console.error('[live] connect 失敗:', err?.message || err);
      teardown(); // releases the reserved slot
      return reject('error', '無法連線即時翻譯服務，請稍後再試');
    }

    if (closed) { try { session.close(); } catch { /* */ } return; } // client bailed during connect

    limitTimer = setTimeout(() => {
      send({ type: 'limit' });
      teardown();
      try { clientWs.close(); } catch { /* */ }
    }, LIVE_MAX_SESSION_MS);
    resetIdle();

    clientWs.on('message', (data, isBinary) => {
      if (!session || !isBinary || closed) return;
      audioFrames++;
      resetIdle();
      try {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        session.sendRealtimeInput({ audio: { data: buf.toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
      } catch (e) {
        console.error('[live] 送音訊失敗:', e?.message || e);
      }
    });
    // ('close'/'error' listeners were registered before the connect await above.)
  });

  // Immediately end every active session (admin kill switch / cap lowered below spend
  // / graceful shutdown). teardown() bills the elapsed time synchronously before close.
  const closeAllLiveSessions = (reason) => {
    for (const s of [...active]) {
      try { if (s.clientWs.readyState === s.clientWs.OPEN) s.clientWs.send(JSON.stringify({ type: 'disabled', text: reason || '即時翻譯已停用' })); } catch { /* */ }
      try { s.teardown?.(); } catch { /* */ }
      try { s.clientWs.close(); } catch { /* */ }
    }
  };

  console.log(`🔌 Live Translate WebSocket 掛載於 /ws/live-translate（併發上限 ${MAX_CONCURRENT}，每IP ${MAX_CONCURRENT_PER_IP}）`);
  return { wss, getInFlightCostUsd, closeAllLiveSessions };
}
