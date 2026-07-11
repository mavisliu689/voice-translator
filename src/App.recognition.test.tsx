// Web Speech (一般模式) 連續語音辨識邏輯的回歸測試，覆蓋掉字修復 Fix 1–4 與
// review 修正 A/B/C/F。不用 @testing-library/react（peer dep @testing-library/dom
// 未安裝），改用 react-dom createRoot + act，直接呼叫 rec.onresult / rec.onend
// 驅動辨識事件；計時全部走 vi.useFakeTimers，不留真實等待。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from './App';
import { ApiError, translate } from './lib/api';

vi.mock('./lib/api', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./lib/api')>();
  return {
    ...orig, // keep real ApiError so `err instanceof ApiError` works in App
    translate: vi.fn(),
    fetchLiveStatus: vi.fn().mockResolvedValue({ available: false, reason: null }),
  };
});

const translateMock = vi.mocked(translate);
const okResult = { translation: 'hello', detectedLang: 'zh-TW', char_count: 2, estimated_cost_usd: 0 };

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = '';
  maxAlternatives = 1;
  onstart: (() => void) | null = null;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn(() => { this.onstart?.(); });
  stop = vi.fn();
  constructor() { FakeRecognition.instances.push(this); }
}

// Build a SpeechRecognitionEvent-shaped object. Each result is an array whose
// [0].transcript is the text, tagged with isFinal.
const makeResultEvent = (items: Array<{ t: string; final: boolean }>, resultIndex = 0) => ({
  resultIndex,
  results: items.map(({ t, final }) => Object.assign([{ transcript: t }], { isFinal: final })),
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  FakeRecognition.instances = [];
  (window as unknown as Record<string, unknown>).webkitSpeechRecognition = FakeRecognition;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) },
  });
  translateMock.mockReset();
  translateMock.mockResolvedValue(okResult);
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.useRealTimers();
});

// Flush pending microtasks (promise .then chains) under fake timers.
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

const findButton = (text: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text));

async function renderAppAndStart() {
  await act(async () => {
    root = createRoot(container);
    root.render(<App />);
  });
  await flush(); // let fetchLiveStatus / permission effects settle
  const btn = findButton('開始語音輸入');
  expect(btn).toBeTruthy();
  await act(async () => { btn!.click(); });
  await flush(); // getUserMedia resolves → startListening() builds the recognizer
  await flush();
  expect(FakeRecognition.instances).toHaveLength(1);
  return FakeRecognition.instances[0];
}

// Turn off the live-subtitle preview so it can't call translate() — keeps the
// flush path as the only translation source, making assertions discriminating.
async function disableLiveSubtitle() {
  const toggle = findButton('即時字幕');
  expect(toggle).toBeTruthy();
  expect(toggle!.textContent).toContain('開');
  await act(async () => { toggle!.click(); });
  expect(findButton('即時字幕')!.textContent).toContain('關');
}

// Change the source-language <select> (the one with the 'auto' option) the way
// a user would, driving React's controlled onChange.
async function changeSourceLang() {
  const select = Array.from(container.querySelectorAll('select'))
    .find((s) => s.querySelector('option[value="auto"]'));
  expect(select).toBeTruthy();
  const firstLang = select!.querySelectorAll('option')[1] as HTMLOptionElement; // first non-auto
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(select!, firstLang.value);
    select!.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('Web Speech 辨識邏輯', () => {
  it('點擊麥克風後建立 recognition，interim 結果顯示在畫面上', async () => {
    const rec = await renderAppAndStart();
    expect(rec.start).toHaveBeenCalledTimes(1);
    expect(rec.continuous).toBe(true);
    expect(rec.interimResults).toBe(true);

    await act(async () => { rec.onresult?.(makeResultEvent([{ t: '你好世界', final: false }])); });
    expect(container.textContent).toContain('你好世界');
  });

  it('連續 final 結果累積進 currentSentence 並顯示', async () => {
    const rec = await renderAppAndStart();
    await act(async () => { rec.onresult?.(makeResultEvent([{ t: '今天天氣', final: true }])); });
    await act(async () => { rec.onresult?.(makeResultEvent([{ t: '很好', final: true }])); });
    expect(container.textContent).toContain('今天天氣 很好');
  });

  // ── Fix 1: onend 把未 finalize 的 interim 併入句子並最終送翻譯 ──
  it('Fix 1: interim 進來後 onend，殘句被 fold 並在 1200ms 後 flush 入 history', async () => {
    const rec = await renderAppAndStart();
    await disableLiveSubtitle(); // preview off → translate 只可能來自 flush 路徑
    // Interim only — never reaches isFinal. Web Speech would normally drop this
    // when the session ends; the fold path must preserve it.
    await act(async () => { rec.onresult?.(makeResultEvent([{ t: '早安', final: false }])); });
    expect(translateMock).not.toHaveBeenCalled();
    await act(async () => { rec.onend?.(); });
    await advance(1300); // past the 1200ms sentence flush
    await flush();

    expect(translateMock.mock.calls.some((c) => c[0] === '早安')).toBe(true);
    expect(container.textContent).toContain('共 1 條');
  });

  // ── Fix 2: onend 立即重啟（長 session）／節流到 1s（剛啟動） ──
  it('Fix 2: 長 session 結束後立即重啟', async () => {
    const rec = await renderAppAndStart();
    expect(rec.start).toHaveBeenCalledTimes(1);
    await advance(1500); // simulate a long session (>1s since start)
    await act(async () => { rec.onend?.(); });
    await advance(20); // delay should be ~0 → restart fires almost immediately
    expect(rec.start).toHaveBeenCalledTimes(2);
  });

  it('Fix 2: 剛啟動就被殺（no-speech 迴圈）延遲到滿 1s 才重啟', async () => {
    const rec = await renderAppAndStart();
    expect(rec.start).toHaveBeenCalledTimes(1);
    await act(async () => { rec.onend?.(); }); // fires with ~0ms since start → delay ≈ 1000
    await advance(500);
    expect(rec.start).toHaveBeenCalledTimes(1); // not yet
    await advance(600); // total 1100ms > 1000ms
    expect(rec.start).toHaveBeenCalledTimes(2);
  });

  // ── Fix 3: translateText 對 429/網路錯誤退避重試（最多 3 次） ──
  it('Fix 3: 429 兩次再成功——1 次→3s 後 2 次→再 6s 後 3 次，句子入 history', async () => {
    translateMock.mockReset();
    translateMock
      .mockRejectedValueOnce(new ApiError(429, '請稍候再試'))
      .mockRejectedValueOnce(new ApiError(429, '請稍候再試'))
      .mockResolvedValue(okResult);

    const rec = await renderAppAndStart();
    await disableLiveSubtitle();
    // Final with a sentence ender → submits '你好' immediately.
    await act(async () => { rec.onresult?.(makeResultEvent([{ t: '你好。', final: true }])); });
    await flush();
    expect(translateMock).toHaveBeenCalledTimes(1);
    await advance(3000); // first backoff elapses → attempt 2
    await flush();
    expect(translateMock).toHaveBeenCalledTimes(2);
    await advance(6000); // second backoff elapses → attempt 3 succeeds
    await flush();
    expect(translateMock).toHaveBeenCalledTimes(3);
    expect(translateMock.mock.calls.every((c) => c[0] === '你好')).toBe(true);
    expect(container.textContent).toContain('共 1 條');
    expect(container.textContent).toContain('你好');
  });

  it('Fix 3: 三次全 429——恰 3 次呼叫、顯示錯誤、不入 history', async () => {
    translateMock.mockReset();
    translateMock.mockRejectedValue(new ApiError(429, '請稍候再試'));

    const rec = await renderAppAndStart();
    await disableLiveSubtitle();
    await act(async () => { rec.onresult?.(makeResultEvent([{ t: '你好。', final: true }])); });
    await flush();
    await advance(3000);
    await advance(6000);
    await flush();
    await advance(10000); // no fourth attempt ever fires
    expect(translateMock).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain('請稍候再試'); // backend notice surfaced
    expect(container.textContent).toContain('還沒有翻譯記錄'); // nothing recorded
  });

  it('Fix 3: 網路錯誤（TypeError）也重試——失敗一次後成功入 history', async () => {
    translateMock.mockReset();
    translateMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(okResult);

    const rec = await renderAppAndStart();
    await disableLiveSubtitle();
    await act(async () => { rec.onresult?.(makeResultEvent([{ t: '你好。', final: true }])); });
    await flush();
    expect(translateMock).toHaveBeenCalledTimes(1);
    await advance(3000);
    await flush();
    expect(translateMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('共 1 條');
  });

  // ── B: 提交時刻去重（取代完成時刻的 history 比對） ──
  it('B: 同文 2s 內第二次提交被擋（translate 不再被呼叫），>2s 放行', async () => {
    const rec = await renderAppAndStart();
    await disableLiveSubtitle();

    await act(async () => { rec.onresult?.(makeResultEvent([{ t: '你好。', final: true }])); });
    await flush();
    expect(translateMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('共 1 條');

    // Same text within 2s → dropped at submission: no API call, no history.
    await act(async () => { rec.onresult?.(makeResultEvent([{ t: '你好。', final: true }])); });
    await flush();
    expect(translateMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('共 1 條');

    // Past the 2s window → legitimate repeat records.
    await advance(2500);
    await act(async () => { rec.onresult?.(makeResultEvent([{ t: '你好。', final: true }])); });
    await flush();
    expect(translateMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('共 2 條');
  });

  it('2: A,B,A,B 交錯提交全在 2s 內——Map guard 各擋重複，僅 A、B 兩筆', async () => {
    const rec = await renderAppAndStart();
    await disableLiveSubtitle();

    await act(async () => { rec.onresult?.(makeResultEvent([{ t: '你好。', final: true }])); });
    await flush();
    await advance(10); // distinct submission timestamps, still inside 2s
    await act(async () => { rec.onresult?.(makeResultEvent([{ t: '再見。', final: true }])); });
    await flush();
    await advance(10);
    // Repeats within 2s: the Map remembers BOTH earlier submissions (a
    // last-only guard would let the interleaved repeats through).
    await act(async () => { rec.onresult?.(makeResultEvent([{ t: '你好。', final: true }])); });
    await act(async () => { rec.onresult?.(makeResultEvent([{ t: '再見。', final: true }])); });
    await flush();

    expect(translateMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('共 2 條');
  });

  // ── 1: 同一 final split 出多句時 history id 單調遞增 ──
  it('1: 一個 final 事件含兩個斷句——兩筆 id 相異、顯示順序＝新→舊', async () => {
    const rec = await renderAppAndStart();
    await disableLiveSubtitle();
    const errSpy = vi.spyOn(console, 'error');

    // Both sentences submit in the same millisecond — raw Date.now() ids would
    // collide (duplicate React keys, order degenerates to completion order).
    await act(async () => { rec.onresult?.(makeResultEvent([{ t: '早安。午安。', final: true }])); });
    await flush();

    expect(container.textContent).toContain('共 2 條');
    // Newest-first display: the later sentence (午安) must render above 早安.
    const text = container.textContent!;
    expect(text.indexOf('午安')).toBeLessThan(text.indexOf('早安'));
    // No duplicate-key warning from React.
    expect(errSpy.mock.calls.flat().join(' ')).not.toContain('same key');
    errSpy.mockRestore();
  });

  // ── 6: 無句尾符的超長句強制 flush，避免超過後端 5000 字元上限 ──
  it('6: 超過 1000 字元且無句尾符的 final——立即送翻譯並清空緩衝', async () => {
    const rec = await renderAppAndStart();
    await disableLiveSubtitle();

    const long = 'あ'.repeat(1001); // no sentence enders
    await act(async () => { rec.onresult?.(makeResultEvent([{ t: long, final: true }])); });
    await flush(); // no timer advance: submission must be immediate

    expect(translateMock).toHaveBeenCalledTimes(1);
    expect(translateMock.mock.calls[0][0]).toBe(long);
    expect(container.textContent).toContain('共 1 條');
  });

  // ── 3+C: 語言切換——舊語言殘句立即以「舊」source 提交，舊 instance 完全 detach ──
  it('3+C: 切換來源語言時 interim 立即以舊語言送翻譯，舊 instance handler 全部拆除', async () => {
    const rec = await renderAppAndStart(); // starts with sourceLang 'auto'
    await disableLiveSubtitle();
    await act(async () => { rec.onresult?.(makeResultEvent([{ t: '早安', final: false }])); });

    await changeSourceLang(); // switches to the first concrete language

    expect(FakeRecognition.instances).toHaveLength(2);
    // Old instance fully detached: late events from it can no longer fire.
    expect(rec.onresult).toBeNull();
    expect(rec.onend).toBeNull();
    expect(rec.onerror).toBeNull();
    expect(rec.stop).toHaveBeenCalled();

    await flush(); // submitted at switch time — no 1200ms wait
    const call = translateMock.mock.calls.find((c) => c[0] === '早安');
    expect(call).toBeTruthy();
    // Tagged with the OLD source ('auto'); reading sourceLangRef at flush time
    // would wrongly give the newly selected language.
    expect(call![2]).toBe('auto');
    expect(container.textContent).toContain('共 1 條');
  });
});
