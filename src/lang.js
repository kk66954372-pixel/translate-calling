// Which language is a piece of text in? Korean and Japanese use different scripts, so counting
// characters is reliable: Hangul → Korean; kana or kanji → Japanese. Text with neither (emoji, "ok",
// numbers) falls back to the speaker's own language.
const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/g;
const KANA = /[぀-ヿㇰ-ㇿｦ-ﾟ]/g;
const HAN = /[㐀-鿿豈-﫿]/g;

/** @returns {"ko"|"ja"} */
export function detectLang(text, fallback = "ko") {
  const s = String(text ?? "");
  const ko = (s.match(HANGUL) || []).length;
  const ja = (s.match(KANA) || []).length + (s.match(HAN) || []).length;
  if (ko > ja) return "ko";
  if (ja > ko) return "ja";
  return fallback;
}

export const otherLang = (lang) => (lang === "ko" ? "ja" : "ko");
