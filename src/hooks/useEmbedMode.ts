import { useEffect, useMemo } from 'react';

// Detect embed mode from URL once on mount.
export function useIsEmbed(): boolean {
  return useMemo(() => new URLSearchParams(window.location.search).get('mode') === 'embed', []);
}

// Lock body scroll when embedded to prevent iOS bounce / parent page scroll.
export function useLockBodyScroll(active: boolean): void {
  useEffect(() => {
    if (!active) return;
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
  }, [active]);
}

// Listen for postMessage commands from a parent frame (e.g. SET_TARGET_LANG).
export function useParentMessages(handlers: { onSetTargetLang?: (lang: string) => void }): void {
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const { type, payload } = event.data || {};
      if (type === 'SET_TARGET_LANG' && payload?.lang) {
        handlers.onSetTargetLang?.(payload.lang);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [handlers]);
}

// Broadcast a translation result to the parent frame.
export function postTranslationResultToParent(payload: unknown): void {
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'TRANSLATION_RESULT', payload }, '*');
  }
}

// Inject the pulse keyframes used by embed UI exactly once.
const PULSE_STYLE_ID = 'embed-pulse-style';
export function injectPulseStyleOnce(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(PULSE_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PULSE_STYLE_ID;
  style.textContent = `
    @keyframes softPulse {
      0%, 100% { transform: scale(1); opacity: 0.5; }
      50% { transform: scale(1.35); opacity: 0; }
    }
    .soft-pulse { animation: softPulse 2s ease-in-out infinite; }

    /* Emanating "ripple" rings — classic recording indicator */
    @keyframes recRing {
      0%   { transform: scale(1);   opacity: 0.6; }
      100% { transform: scale(2.1); opacity: 0;   }
    }
    .rec-ring { animation: recRing 1.5s cubic-bezier(0.2, 0.6, 0.4, 1) infinite; }
    .rec-ring-delay { animation-delay: 0.75s; }

    /* Blinking REC dot */
    @keyframes recBlink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.2; }
    }
    .rec-blink { animation: recBlink 1s ease-in-out infinite; }
  `;
  document.head.appendChild(style);
}
