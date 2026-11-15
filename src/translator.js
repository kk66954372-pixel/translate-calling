// Korean <-> Japanese translation.
// Default backend is the Claude API. Set TRANSLATOR=mock to run without an API key
// (useful for local UI development and automated tests).
import Anthropic from "@anthropic-ai/sdk";

export const LANGS = {
  ko: { name: "Korean", native: "한국어", speech: "ko-KR" },
  ja: { name: "Japanese", native: "日本語", speech: "ja-JP" },
};

// Chat messages are read closely (and are few): a stronger model. Call captions are most of the volume and
// flash by: a fast, inexpensive model. Chosen after comparing Opus / Sonnet / Haiku on 50 everyday and
// emotional ko<->ja lines (src/compare.js).
// Defaults keep the previous setup until the round-3 comparison is reviewed.
const CHAT_MODEL = process.env.CHAT_MODEL || process.env.CLAUDE_MODEL || "claude-opus-5-5";
const CAPTION_MODEL = process.env.CAPTION_MODEL || CHAT_MODEL;
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

// v1: the original interpreter prompt.
export const PROMPT_V1 = `You are a real-time interpreter inside a Korean–Japanese language exchange app.
Two people are chatting or talking on a call; each speaks their native language and reads your translation.

Rules:
- Translate the text in <text> from the source language into the target language.
- Output ONLY the translation. No quotes, notes, romanization, or explanations.
- Keep the speaker's tone and politeness level (반말/존댓말, タメ口/敬語). Casual stays casual, polite stays polite.
- Keep names, emoji, URLs and numbers as they are. Translate slang and internet expressions into natural equivalents.
- Speech-recognition text may lack punctuation or contain small recognition errors: translate the most likely intended meaning and add natural punctuation.
- If the text is already in the target language, return it unchanged.
- Use the <context> (recent conversation) only to resolve pronouns, omitted subjects and tone. Never translate the context itself.`;

// v2: also asks for the feeling and the way friends actually talk, not only the meaning.
export const PROMPT_V2 = `You are the interpreter between two friends, one Korean and one Japanese, who chat and call each other in a language exchange app. They are getting to know each other and sharing their feelings, so how something is said matters as much as what is said.

Translate the text in <text> from the source language into the target language, the way a native speaker of the target language would say it to a friend in the same situation.

- Output ONLY the translation: no quotes, notes, romanization or explanations.
- Keep the relationship and register: 반말 ↔ タメ口, 존댓말 ↔ 敬語. Casual lines stay just as casual, including greetings and reactions; never make a friendly line stiff or textbook-like.
- Keep the feeling and its strength: joy, excitement, teasing, sulking, comfort, apology, loneliness, affection. Do not soften, flatten or exaggerate it.
- Slang, internet expressions, interjections and laughter become what people of the same age would really use in the target language (e.g. 킹받네 → ムカつく〜 / ㄹㅇ → ガチで / 草 → ㅋㅋㅋ / エモい → 감성 터진다). Keep emoji as they are.
- Keep fillers and hesitations (음, 어, 아, えっと, あの, まあ) as natural equivalents; they are part of how the person sounds.
- Translate meaning, not words: avoid literal calques that a native speaker would not say. Do not add or drop content.
- Keep names and numbers. Speech-recognition text may lack punctuation or contain small errors: translate the most likely intended meaning and punctuate naturally.
- If the text is already in the target language, return it unchanged.
- Use the <context> (recent lines) only to understand who is meant, what was left out and the mood. Never translate the context itself.`;

// v3: v2 plus two rules found in testing (pronouns that sound rude or distant; laughter/crying marks).
export const PROMPT_V3 = `${PROMPT_V2}
- Pronouns: Japanese usually leaves "you" out; between friends use 君 or the person's name if one is needed, and never お前, あんた or あなた unless the source is just as rough or distant. In Korean, friends say 너 (or nothing), never 당신.
- Laughter and crying marks become the target language's own (ㅋㅋ, ㅎㅎ, ㅠㅠ ↔ w, 笑, 泣, (泣)); never leave the other language's marks untranslated.
- Put the translation, and nothing else, in the "translation" field.`;

// The answer comes back as {"translation": "..."} so that nothing but the translation can reach the screen.
const OUTPUT_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: { translation: { type: "string" } },
    required: ["translation"],
    additionalProperties: false,
  },
};

const PROMPTS = { v1: PROMPT_V1, v2: PROMPT_V2, v3: PROMPT_V3 };
const PROMPT_VERSION = PROMPTS[process.env.TRANSLATION_PROMPT] ? process.env.TRANSLATION_PROMPT : "v1";
const SYSTEM_PROMPT = PROMPTS[PROMPT_VERSION];
// v3 asks for {"translation": ...}; v1/v2 answer in plain text.
const USE_JSON = PROMPT_VERSION === "v3";

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
 * @param {{kind?: "chat"|"caption"}} [options]
 * @returns {Promise<{text: string, ok: boolean, error?: string}>}
 */
export async function translate(text, from, to, context = [], { kind = "chat" } = {}) {
  const input = String(text || "").trim().slice(0, MAX_INPUT_CHARS);
  if (!input) return { text: "", ok: true };
  if (from === to) return { text: input, ok: true };

  // Only cache context-free lookups for short phrases; longer lines depend on context.
  const cacheKey = input.length <= 20 ? `${kind}:${from}>${to}:${input}` : null;
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

  const model = kind === "caption" ? CAPTION_MODEL : CHAT_MODEL;
  const result = await callModel(model, input, from, to, context, { system: SYSTEM_PROMPT, json: USE_JSON });
  if (result.ok && cacheKey && result.text) cacheSet(cacheKey, result.text);
  return { text: result.text, ok: result.ok, ...(result.error ? { error: result.error } : {}) };
}

// Models with the server-side refusal fallback. Claude Haiku 5.5 has none (sending it would fail).
const HAS_FALLBACK = /^claude-(opus|sonnet|fable)-/;

/**
 * One translation request to a given model (no cache, no daily quota). Also used by the model comparison.
 * @returns {Promise<{text: string, ok: boolean, error?: string, usage?: {input: number, output: number}, ms: number}>}
 */
export async function callModel(model, input, from, to, context = [], { system = SYSTEM_PROMPT, json = false } = {}) {
  const contextBlock = context.length
    ? `<context>\n${context.map((c) => `${escapeXml(c.speaker)}: ${escapeXml(c.text)}`).join("\n")}\n</context>\n\n`
    : "";
  const started = Date.now();
  try {
    const response = await getClient().beta.messages.create({
      model,
      max_tokens: 4000,
      // Translation is latency-sensitive and simple: keep effort low.
      output_config: { effort: "low", ...(json ? { format: OUTPUT_FORMAT } : {}) },
      // If the model declines, the API retries the same request on a fallback model.
      ...(HAS_FALLBACK.test(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
      system,
      messages: [
        {
          role: "user",
          content:
            `${contextBlock}Source language: ${LANGS[from].name}\nTarget language: ${LANGS[to].name}\n\n` +
            `<text>\n${escapeXml(input)}\n</text>`,
        },
      ],
    });
    const ms = Date.now() - started;
    const usage = { input: response.usage?.input_tokens ?? 0, output: response.usage?.output_tokens ?? 0 };

    if (response.stop_reason === "refusal") return { text: "", ok: false, error: "refusal", usage, ms };

    let out = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (json) {
      try {
        out = String(JSON.parse(out).translation ?? "").trim();
      } catch {
        return { text: "", ok: false, error: "bad_output", usage, ms };
      }
    }
    return { text: out, ok: true, usage, ms };
  } catch (error) {
    let reason = "unknown";
    if (error instanceof Anthropic.AuthenticationError) reason = "auth";
    else if (error instanceof Anthropic.RateLimitError) reason = "rate_limit";
    else if (error instanceof Anthropic.BadRequestError) reason = /credit balance/i.test(error.message) ? "no_credit" : "bad_request";
    else if (error instanceof Anthropic.APIError && error.status === 402) reason = "no_credit";
    else if (error instanceof Anthropic.APIError) reason = `api_${error.status ?? "error"}`;
    else if (error instanceof Anthropic.AnthropicError) reason = "config"; // e.g. no credentials configured
    console.error(`[translate] ${model} ${reason}:`, error?.message || error);
    return { text: "", ok: false, error: reason, ms: Date.now() - started };
  }
}

export const translatorInfo = {
  mode: MODE,
  model: MODE === "mock" ? null : `chat ${CHAT_MODEL}, captions ${CAPTION_MODEL}, prompt ${PROMPT_VERSION}`,
  dailyLimit: DAILY_LIMIT,
  usage,
};
