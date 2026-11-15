// Translation model comparison: the same sentences through several Claude models, with latency and cost.
// Runs once at server start when TRANSLATION_COMPARE=1 (so it uses the server's API key), and prints
// one JSON line per result, prefixed with "[compare]", to the log.
import { callModel, PROMPT_V1, PROMPT_V2 } from "./translator.js";

// $ per million tokens (input, output). Output includes thinking tokens.
const PRICES = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};

// Model + prompt combinations to compare (round 2: is a tuned Haiku close to Sonnet on feelings and tone?).
const CONFIGS = [
  { label: "sonnet-v2", model: "claude-sonnet-5-5", system: PROMPT_V2 },
  { label: "haiku-v1", model: "claude-haiku-5-5", system: PROMPT_V1 },
  { label: "haiku-v2", model: "claude-haiku-5-5", system: PROMPT_V2 },
];

const ctx = (speaker, text) => [{ speaker, text }];

// Everyday chat and call lines: casual/polite speech, slang, speech-recognition text without
// punctuation, omitted subjects that need the context, numbers and places, culture-bound phrases.
export const CASES = [
  { from: "ko", text: "안녕! 오늘 뭐 했어?" },
  { from: "ko", text: "처음 뵙겠습니다. 잘 부탁드립니다." },
  { from: "ko", text: "어제 친구랑 홍대에서 치맥 했는데 진짜 맛있었어 ㅋㅋ" },
  { from: "ko", text: "그거 완전 대박이다" },
  { from: "ko", text: "나 요즘 일본어 공부하고 있는데 경어가 너무 어려워" },
  { from: "ko", text: "혹시 주말에 시간 괜찮으세요?" },
  { from: "ko", text: "배고파 죽겠다" },
  { from: "ko", text: "다음 달에 도쿄 가는데 추천해 줄 만한 곳 있어?" },
  { from: "ko", text: "아 그게 아니라 내 말은 그러니까 내일 말고 모레 만나자는 거야" },
  { from: "ko", text: "눈치가 없다는 말 들어 본 적 있어?" },
  { from: "ko", text: "어 맞아 맞아 나도 그렇게 생각해" },
  { from: "ko", text: "어디 갔는데? 맛있었어?", context: ctx("ゆうき", "昨日ラーメン食べに行ったよ") },
  { from: "ko", text: "3시 반에 강남역 2번 출구에서 봐" },
  { from: "ko", text: "너무 피곤해서 오늘은 일찍 잘게 🥱" },
  { from: "ko", text: "수고하셨습니다!" },
  { from: "ja", text: "やっほー！元気？" },
  { from: "ja", text: "はじめまして。よろしくお願いします。" },
  { from: "ja", text: "マジで？それヤバくない？" },
  { from: "ja", text: "最近仕事が忙しくて全然寝れてないんだよね" },
  { from: "ja", text: "お疲れ様です。今日の会議の資料を送りました。" },
  { from: "ja", text: "来週の土曜日空いてる？" },
  { from: "ja", text: "韓国のドラマにハマってて、韓国語勉強し始めたんだ" },
  { from: "ja", text: "えっとねそれはちょっと違くてまあいいや後で説明する" },
  { from: "ja", text: "気を使わなくていいよ" },
  { from: "ja", text: "いつ来るの？案内するよ！", context: ctx("민수", "나 다음 달에 도쿄 가!") },
  { from: "ja", text: "推しのライブに行ってきた！最高だった😭" },
  { from: "ja", text: "よろしくね〜" },
  { from: "ja", text: "3時半に渋谷駅のハチ公前で待ち合わせしよう" },
  { from: "ja", text: "なるほど、そういうことか" },
  { from: "ja", text: "いただきます" },
  // Feelings: comfort, sulking, missing someone, teasing, apology, joy, disappointment.
  { from: "ko", text: "괜찮아, 네 잘못 아니야. 너무 자책하지 마" },
  { from: "ko", text: "아 진짜 너무해 ㅠㅠ 나만 빼고 놀러 간 거야?" },
  { from: "ko", text: "보고 싶었어! 왜 이렇게 연락이 없었어" },
  { from: "ko", text: "헐 대박 ㅋㅋㅋ 너 진짜 웃긴다" },
  { from: "ko", text: "미안해… 내가 말이 좀 심했지" },
  { from: "ko", text: "오늘 면접 떨어졌어. 좀 우울하네" },
  { from: "ko", text: "우와 축하해!!! 내 일처럼 기쁘다 🎉" },
  { from: "ko", text: "됐어, 그냥 신경 쓰지 마" },
  { from: "ko", text: "너랑 얘기하면 시간 가는 줄 모르겠어" },
  { from: "ko", text: "진짜? 아 섭섭하다…", context: ctx("ゆうき", "来月日本に帰ることになった") },
  { from: "ja", text: "ごめん、言い過ぎた" },
  { from: "ja", text: "嬉しすぎて泣きそう" },
  { from: "ja", text: "からかわないでよ〜" },
  { from: "ja", text: "え、待って、めっちゃ会いたい！" },
  { from: "ja", text: "大丈夫？無理しないでね" },
  { from: "ja", text: "もう知らない！" },
  { from: "ja", text: "うける笑 それな" },
  { from: "ja", text: "正直ちょっと寂しかったよ" },
  { from: "ja", text: "いつもありがとうね、ほんとに助かってる" },
  { from: "ja", text: "えーすごい！！おめでとう！頑張ってたもんね", context: ctx("민수", "나 이번 시험 붙었어!!") },
];

export async function runCompare() {
  console.log(`[compare] start ${CASES.length} cases x ${CONFIGS.length} configs`);
  const totals = Object.fromEntries(CONFIGS.map((c) => [c.label, { ms: 0, cost: 0, ok: 0, n: 0 }]));
  for (const [i, c] of CASES.entries()) {
    const to = c.from === "ko" ? "ja" : "ko";
    for (const { label, model, system } of CONFIGS) {
      const [pin, pout] = PRICES[model];
      const r = await callModel(model, c.text, c.from, to, c.context ?? [], { system });
      const cost = r.usage ? (r.usage.input * pin + r.usage.output * pout) / 1e6 : 0;
      const t = totals[label];
      Object.assign(t, { ms: t.ms + r.ms, cost: t.cost + cost, ok: t.ok + (r.ok ? 1 : 0), n: t.n + 1 });
      console.log(
        "[compare] " +
          JSON.stringify({ i, cfg: label, src: c.text, out: r.text, ok: r.ok, error: r.error, ms: r.ms, outTok: r.usage?.output, cost: Number(cost.toFixed(6)) }),
      );
    }
  }
  for (const [model, t] of Object.entries(totals)) {
    console.log(
      "[compare] " +
        JSON.stringify({ summary: model, ok: `${t.ok}/${t.n}`, avgMs: Math.round(t.ms / t.n), avgCost: Number((t.cost / t.n).toFixed(6)), totalCost: Number(t.cost.toFixed(4)) }),
    );
  }
  console.log("[compare] done");
}
