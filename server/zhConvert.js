// Traditional-Chinese enforcement.
// The app is Traditional-Chinese-only (zh-CN was removed). Google Translate /
// Gemini / Gemini Live occasionally emit Simplified characters even with a
// zh-TW target, so we run Chinese output through OpenCC (Mainland Simplified →
// Taiwan Traditional) as a hard guarantee. Non-Chinese text (Thai, English, …)
// passes through unchanged, so this is safe to apply to any transcript.
import * as OpenCC from 'opencc-js';

// `to: 'tw'` = Taiwan-standard Traditional character variants WITHOUT vocabulary
// substitution (we don't want to second-guess the translator's word choices —
// only kill Simplified glyphs). Converter is built once and reused.
const convert = OpenCC.Converter({ from: 'cn', to: 'tw' });

export function toTraditional(text) {
  if (!text) return text;
  try { return convert(text); } catch { return text; }
}
