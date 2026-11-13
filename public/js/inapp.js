// Messenger in-app browsers (KakaoTalk, LINE, Instagram, …) often block the microphone or WebRTC.
// Move the page to the phone's real browser (Chrome / Safari) before anything else happens,
// and if that is not possible, explain how to do it by hand.
const ua = navigator.userAgent;
const isAndroid = /Android/i.test(ua);
const isIOS = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function detect() {
  if (/KAKAOTALK/i.test(ua)) return "kakao";
  if (/\bLine\//i.test(ua)) return "line";
  if (/Instagram|FBAN|FBAV|FB_IAB|NAVER\(inapp|DaumApps|everytimeApp|Snapchat|; wv\)/i.test(ua)) return "other";
  return null;
}

export const inApp = detect();
const DISMISS_KEY = "koja:inappDismissed";

function withParam(url, key, value) {
  const u = new URL(url);
  u.searchParams.set(key, value);
  return u.toString();
}

function tryOpenExternal() {
  const here = location.href;
  if (inApp === "kakao") {
    location.href = `kakaotalk://web/openExternal?url=${encodeURIComponent(here)}`;
  } else if (inApp === "line") {
    if (!new URL(here).searchParams.has("openExternalBrowser")) location.replace(withParam(here, "openExternalBrowser", "1"));
  } else if (isAndroid) {
    location.href = `intent://${here.replace(/^https?:\/\//, "")}#Intent;scheme=https;package=com.android.chrome;end`;
  }
  // iOS apps other than KakaoTalk/LINE offer no way to switch automatically — the guide below explains it.
}

function showGuide() {
  const how = isIOS
    ? "화면의 ⋯ 또는 공유(⬆︎) 버튼 → <b>Safari로 열기</b><br>画面の ⋯ または共有(⬆︎)ボタン → <b>Safariで開く</b>"
    : "화면의 ⋮ 버튼 → <b>다른 브라우저로 열기</b><br>画面の ⋮ ボタン → <b>他のブラウザで開く</b>";
  const el = document.createElement("div");
  el.className = "inapp-guide";
  el.innerHTML = `
    <div class="inapp-card">
      <div class="inapp-icon">🌐</div>
      <h2>Chrome / Safari에서 열어 주세요<br><small>Chrome / Safari で開いてください</small></h2>
      <p>메신저 안의 브라우저에서는 마이크(통화)가 막힐 수 있어요.<br>アプリ内ブラウザではマイク（通話）が使えないことがあります。</p>
      <p class="inapp-how">${how}</p>
      <div class="inapp-actions">
        <button class="btn primary" data-act="retry">다시 시도 · もう一度</button>
        <button class="btn" data-act="copy">링크 복사 · リンクをコピー</button>
        <button class="btn ghost" data-act="stay">그냥 계속 (채팅만) · このまま続ける</button>
      </div>
    </div>`;
  el.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    const act = btn?.dataset.act;
    if (act === "retry") tryOpenExternal();
    if (act === "copy") {
      const url = withParam(location.href, "openExternalBrowser", "1");
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        prompt("", url);
        return;
      }
      btn.textContent = "✓ 복사했어요 · コピーしました";
    }
    if (act === "stay") {
      try {
        sessionStorage.setItem(DISMISS_KEY, "1");
      } catch {}
      el.remove();
    }
  });
  document.body.append(el);
}

let dismissed = false;
try {
  dismissed = sessionStorage.getItem(DISMISS_KEY) === "1";
} catch {}

if (inApp && !dismissed) {
  tryOpenExternal();
  // If we are still here a moment later, the automatic switch did not happen.
  setTimeout(showGuide, 1200);
}
