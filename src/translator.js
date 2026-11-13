// Korean <-> Japanese translation.
// Default backend is the Claude API. Set TRANSLATOR=mock to run without an API key
// (useful for local UI development and automated tests).
import Anthropic from "@anthropic-ai/sdk";

export const LANGS = {
  ko: { name: "Korean", native: "한국어", speech: "ko-KR" },
  ja: { name: "Japanese", native: "日本語", speech: "ja-JP" },
};

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const MODE = (process.env.TRANSLATOR || "claude").toLowerCase();
const MAX_INPUT_CHARS = 1000;
// Cost guard: at most this many API calls per day (Korea/Japan date). 0 = unlimited.
const DAILY_LIMIT = Number(process.env.DAILY_TRANSLATION_LIMIT ?? 2000);

const usage = { day: "", count: 0, warned: false };
const today = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10); // UTC+9
function takeDailyQuota() {
  const d = today();
  if (usage.day !== d) Object.assign(usage, { day: d, count: 0, warned: false });
  if (DAILY_LIMIT > 0 && usage.count >= DAILY_LIMIT) return false;
  usage.count++;
  return true;
}

const SYSTEM_PROMPT = `You are a real-time interpreter inside a Korean–Japanese language exchange app.
Two people are chatting or talking on a call; each speaks their native language and reads your translation.

Rules:
- Translate the text in <text> from the source language into the target language.
- Output ONLY the translation. No quotes, notes, romanization, or explanations.
- Keep the speaker's tone and politeness level (반말/존댓말, タメ口/敬語). Casual stays casual, polite stays polite.
- Keep names, emoji, URLs and numbers as they are. Translate slang and internet expressions into natural equivalents.
- Speech-recognition text may lack punctuation or contain small recognition errors: translate the most likely intended meaning and add natural punctuation.
- If the text is already in the target language, return it unchanged.
- Use the <context> (recent conversation) only to resolve pronouns, omitted subjects and tone. Never translate the context itself.`;

let client = null;
function getClient() {
  // The SDK resolves credentials from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile.
  if (!client) client = new Anthropic();
  return client;
}

// Small LRU cache so repeated phrases ("ㅋㅋㅋ", "ありがとう") don't cost an API call each time.
const cache = new Map();
const CACHE_MAX = 500;
function cacheGet(key) {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}
function cacheSet(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Translate text between Korean and Japanese.
 * @param {string} text
 * @param {"ko"|"ja"} from
 * @param {"ko"|"ja"} to
 * @param {{speaker: string, text: string}[]} [context] recent lines of the conversation (oldest first)
 * @returns {Promise<{text: string, ok: boolean, error?: string}>}
 */
export async function translate(text, from, to, context = []) {
  const input = String(text || "").trim().slice(0, MAX_INPUT_CHARS);
  if (!input) return { text: "", ok: true };
  if (from === to) return { text: input, ok: true };

  // Only cache context-free lookups for short phrases; longer lines depend on context.
  const cacheKey = input.length <= 20 ? `${from}>${to}:${input}` : null;
  if (cacheKey) {
    const hit = cacheGet(cacheKey);
    if (hit !== undefined) return { text: hit, ok: true };
  }

  if (MODE === "mock") {
    const out = `[${from}→${to}] ${input}`;
    if (cacheKey) cacheSet(cacheKey, out);
    return { text: out, ok: true };
  }

  if (!takeDailyQuota()) {
    if (!usage.warned) console.warn(`[translate] daily limit of ${DAILY_LIMIT} reached`);
    usage.warned = true;
    return { text: "", ok: false, error: "daily_limit" };
  }

  const contextBlock = context.length
    ? `<context>\n${context.map((c) => `${escapeXml(c.speaker)}: ${escapeXml(c.text)}`).join("\n")}\n</context>\n\n`
    : "";

  try {
    const response = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      // Translation is latency-sensitive and simple: keep effort low.
      output_config: { effort: "low" },
      // If the model declines, the API retries the same request on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content:
            `${contextBlock}Source language: ${LANGS[from].name}\nTarget language: ${LANGS[to].name}\n\n` +
            `<text>\n${escapeXml(input)}\n</text>`,
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      return { text: "", ok: false, error: "refusal" };
    }

    const out = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (cacheKey && out) cacheSet(cacheKey, out);
    return { text: out, ok: true };
  } catch (error) {
    let reason = "unknown";
    if (error instanceof Anthropic.AuthenticationError) reason = "auth";
    else if (error instanceof Anthropic.RateLimitError) reason = "rate_limit";
    else if (error instanceof Anthropic.BadRequestError) reason = "bad_request";
    else if (error instanceof Anthropic.APIError) reason = `api_${error.status ?? "error"}`;
    else if (error instanceof Anthropic.AnthropicError) reason = "config"; // e.g. no credentials configured
    console.error(`[translate] ${reason}:`, error?.message || error);
    return { text: "", ok: false, error: reason };
  }
}

export const translatorInfo = { mode: MODE, model: MODE === "mock" ? null : MODEL, dailyLimit: DAILY_LIMIT, usage };
