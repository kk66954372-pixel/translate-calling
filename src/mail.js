// Sending sign-in codes by email, over HTTPS APIs (Render's free plan blocks SMTP ports).
//
// BREVO_API_KEY  -> Brevo (free: 300 emails/day; the sender address must be verified in Brevo)
// RESEND_API_KEY -> Resend (needs a domain you own, verified in Resend)
// MAIL=log       -> no email; the code is printed to the server log (development and tests only)
// EMAIL_FROM     -> sender, e.g. "KoJa Talk <you@example.com>"

const FROM = process.env.EMAIL_FROM || "";
const provider = process.env.BREVO_API_KEY ? "brevo" : process.env.RESEND_API_KEY ? "resend" : process.env.MAIL === "log" ? "log" : null;

export const mailInfo = { provider, enabled: Boolean(provider) };

function parseFrom(from) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  return m ? { name: m[1] || "KoJa Talk", email: m[2] } : { name: "KoJa Talk", email: from.trim() };
}

function content(code) {
  const subject = `KoJa Talk 인증 코드 · 認証コード: ${code}`;
  const text =
    `KoJa Talk 인증 코드: ${code}\n10분 안에 앱에 입력해 주세요.\n\n` +
    `KoJa Talk 認証コード: ${code}\n10分以内にアプリに入力してください。\n\n` +
    `요청하지 않았다면 이 메일은 무시하세요. · 心当たりがない場合は、このメールを無視してください。`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Hiragino Sans',sans-serif;max-width:420px;margin:auto;padding:24px;text-align:center">
  <div style="font-size:15px;color:#555">KoJa Talk 인증 코드 · 認証コード</div>
  <div style="font-size:36px;font-weight:700;letter-spacing:8px;margin:16px 0;color:#2f5bea">${code}</div>
  <div style="font-size:14px;color:#555;line-height:1.6">10분 안에 앱에 입력해 주세요.<br>10分以内にアプリに入力してください。</div>
  <div style="font-size:12px;color:#999;margin-top:24px">요청하지 않았다면 이 메일은 무시하세요.<br>心当たりがない場合は、このメールを無視してください。</div>
</div>`;
  return { subject, text, html };
}

/** @returns {Promise<boolean>} whether the email was accepted for delivery */
export async function sendCode(to, code) {
  const { subject, text, html } = content(code);
  try {
    if (provider === "log") {
      console.log(`[mail] code for ${to}: ${code}`);
      return true;
    }
    if (provider === "brevo") {
      const res = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ sender: parseFrom(FROM), to: [{ email: to }], subject, textContent: text, htmlContent: html }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) console.error(`[mail] Brevo refused: ${res.status} ${await res.text().catch(() => "")}`);
      return res.ok;
    }
    if (provider === "resend") {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM, to: [to], subject, text, html }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) console.error(`[mail] Resend refused: ${res.status} ${await res.text().catch(() => "")}`);
      return res.ok;
    }
  } catch (e) {
    console.error("[mail] send failed:", e.message);
  }
  return false;
}
