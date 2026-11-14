// Translation model comparison: the same sentences through several Claude models, with latency and cost.
// Runs once at server start when TRANSLATION_COMPARE=1 (so it uses the server's API key), and prints
// one JSON line per result, prefixed with "[compare]", to the log.
import { callModel } from "./translator.js";

// $ per million tokens (input, output). Output includes thinking tokens.
const MODELS = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};

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
];

export async function runCompare() {
  console.log(`[compare] start ${CASES.length} cases x ${Object.keys(MODELS).length} models`);
  const totals = Object.fromEntries(Object.keys(MODELS).map((m) => [m, { ms: 0, cost: 0, ok: 0, n: 0 }]));
  for (const [i, c] of CASES.entries()) {
    const to = c.from === "ko" ? "ja" : "ko";
    for (const [model, [pin, pout]] of Object.entries(MODELS)) {
      const r = await callModel(model, c.text, c.from, to, c.context ?? []);
      const cost = r.usage ? (r.usage.input * pin + r.usage.output * pout) / 1e6 : 0;
      Object.assign(totals[model], {
        ms: totals[model].ms + r.ms,
        cost: totals[model].cost + cost,
        ok: totals[model].ok + (r.ok ? 1 : 0),
        n: totals[model].n + 1,
      });
      console.log(
        "[compare] " +
          JSON.stringify({ i, model, from: c.from, src: c.text, out: r.text, ok: r.ok, error: r.error, ms: r.ms, in: r.usage?.input, outTok: r.usage?.output, cost: Number(cost.toFixed(6)) }),
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
