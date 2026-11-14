# KoJa Talk · 코자톡 · コジャトーク

한국인과 일본인이 **전화로 언어교환**하는 웹앱입니다. 내가 한국어로 말하면 상대에게는 **내 목소리가 그대로 들리고**, 화면에는 **일본어 번역 자막**이 뜹니다. (반대도 마찬가지)

韓国人と日本人が**電話でランゲージエクスチェンジ**するWebアプリです。日本語で話すと、相手には**自分の声がそのまま聞こえ**、画面には**韓国語の翻訳字幕**が表示されます。

## 기능

| 기능 | 설명 |
|---|---|
| 프로필 | 닉네임 + 모국어(한국어/日本語) 선택. UI가 내 언어로 표시됩니다. |
| 홈 화면 앱 | 아이폰 Safari → 공유 → **홈 화면에 추가**하면 앱처럼 열립니다 (Android/PC는 "설치" 버튼). 앱을 닫아 두어도 **새 메시지·전화 알림**이 옵니다 (iOS 16.4+). |
| 대화방 | 카톡처럼 대화방이 계속 유지됩니다. 대화 기록(채팅·통화 자막)이 저장되고, 안 읽은 메시지 수와 상대의 접속 상태("온라인", "3분 전 접속")가 보입니다. |
| 부재 중 전화 | 상대가 앱 밖에 있으면 알림으로 전화를 알리고, 상대가 앱을 열면 바로 울립니다 (45초). 받지 못하면 "부재중 전화" 알림. |
| 고정 방 링크 | 로비에서 "초대 링크 만들기" → 카톡/LINE으로 친구에게 전송. **같은 링크를 계속 사용**합니다. 먼저 들어온 사람이 기다리고, 나중에 들어온 사람과 바로 연결됩니다. 친구 화면에는 "○○さんが待っています"가 뜨고 일본어가 미리 선택됩니다. |
| 외부 브라우저 열기 | 카톡·LINE·인스타 앱 안에서 링크를 열면 Chrome/Safari로 자동으로 넘기고, 안 되면 방법을 안내합니다 (앱 내 브라우저는 마이크가 막히는 경우가 많음). |
| 재접속 유지 | 휴대폰 신호가 잠깐 끊기거나 서버가 재시작돼도 60초 동안 방과 통화를 유지하고, 다시 연결되면 그대로 이어집니다. 통화 중 와이파이↔LTE가 바뀌면 통화를 자동 복구합니다. |
| 로비 | 접속 중인 사용자 목록, 대화 신청/수락, **랜덤 매칭**(한↔일 자동 연결) |
| 번역 채팅 | 보낸 메시지가 즉시 상대 언어로 번역. 받은 메시지는 **번역문 + 원문**을 함께 보여 줘서 공부가 됩니다. 내 메시지에는 "상대에게 보이는 문장"이 표시됩니다. |
| 🔊 발음 듣기 | 원문/번역문 옆 버튼으로 원어 발음을 TTS로 들을 수 있습니다. |
| 음성 통화 | WebRTC P2P 음성 통화. 상대에게는 내 실제 목소리가 들립니다. 마이크 on/off |
| 실시간 통화 자막 | 말하면 음성 인식 → 서버에서 번역 → 상대 화면에 **번역 자막**. 상대가 말하는 중에는 원문이 실시간으로 보이고, 문장이 끝나면 번역이 뜹니다. 음성 인식은 `DEEPGRAM_API_KEY`가 있으면 서버(Deepgram)에서 하고 — **휴대폰에서도 동작** — 없으면 브라우저 음성 인식을 씁니다. |
| 내 말 확인 | 통화 화면 아래에 "나: 내가 한 말 → 상대에게 보인 번역"이 표시돼서, 내 말이 일본어로 어떻게 전달됐는지 배울 수 있습니다. |
| 통화 기록 | 통화 중 문장도 채팅창에 원문+번역으로 남아 나중에 복습할 수 있습니다. |

번역은 Claude API(`claude-opus-5-5`)를 사용합니다. 최근 대화 몇 줄을 문맥으로 함께 보내서 생략된 주어, 반말/존댓말·タメ口/敬語 같은 말투를 유지하도록 했습니다.

## 실행하기

Node.js 20 이상이 필요합니다.

```bash
npm install

# 실제 번역 (Claude API 키 필요)
export ANTHROPIC_API_KEY=sk-ant-...
npm start

# API 키 없이 UI만 테스트 (번역 대신 "[ko→ja] 원문", 통화 중엔 가짜 음성 인식 "테스트 음성 N번")
npm run dev:mock
```

브라우저에서 `http://localhost:3000` 을 연 뒤, 다른 브라우저 창(또는 시크릿 창)에서 하나 더 열어 한국어/일본어 사용자로 각각 접속해 보세요.

### 환경 변수

| 이름 | 기본값 | 설명 |
|---|---|---|
| `ANTHROPIC_API_KEY` | – | Claude API 키 (번역) |
| `DATABASE_URL` | – | Postgres 연결 문자열 (예: Neon 무료). **배포 시 필수** — 없으면 계정·대화방·기록이 메모리에만 있어 서버가 재시작/잠들면 사라짐 |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | 자동 생성 | 푸시 알림 서버 키. 비워 두면 처음 시작할 때 만들어 DB에 저장 |
| `DEEPGRAM_API_KEY` | – | Deepgram API 키 (통화 음성 인식). 있으면 서버 음성 인식을 사용해 휴대폰에서도 자막이 동작 |
| `STT` | 키가 있으면 `deepgram`, 없으면 `off` | `mock` 은 테스트용 가짜 음성 인식, `off` 는 브라우저 음성 인식만 사용 |
| `DEEPGRAM_MODEL` | `nova-3` | Deepgram 모델 |
| `DAILY_STT_MINUTES` | `600` | 하루 최대 음성 인식 분량(분). `0`이면 무제한 |
| `TRANSLATOR` | `claude` | `mock` 으로 두면 API 호출 없이 동작 |
| `CLAUDE_MODEL` | `claude-opus-5-5` | 번역에 쓸 모델 |
| `PORT` | `3000` | 서버 포트 |
| `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` | – | Cloudflare TURN 키. 있으면 통화마다 임시 TURN 자격증명을 발급합니다 (월 1,000GB 무료). **모바일 데이터·다른 나라 간 통화에 권장** |
| `ICE_SERVERS` | Google STUN | 다른 TURN 서비스를 쓸 때 ICE 서버 JSON. 예: `[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]` |
| `DAILY_TRANSLATION_LIMIT` | `2000` | 하루(한국/일본 날짜 기준) 최대 번역 API 호출 수. `0`이면 무제한 |
| `RECONNECT_GRACE_MS` | `60000` | 연결이 끊긴 사용자의 방을 유지하는 시간 |

## Render에 배포하기

1. Render에서 이 저장소로 **Web Service**를 만듭니다. (Runtime: Node, Build: `npm ci`, Start: `npm start`, 지역은 Singapore 권장)
2. 서비스의 **Environment** 메뉴에서 `ANTHROPIC_API_KEY` 에 Claude API 키를 넣고 저장합니다. (키는 https://console.anthropic.com 에서 발급)
3. 배포가 끝나면 `https://<서비스이름>.onrender.com` 으로 접속해 초대 링크를 만들어 친구에게 보내세요.

무료 플랜은 15분 동안 접속이 없으면 잠들고, 다음 접속 때 깨어나는 데 1분 정도 걸립니다. 서버가 재시작되면 만들어 둔 초대 링크도 사라지니 새로 만들어 주세요.

## 구조

```
src/server.js       Express + Socket.IO: 로비, 매칭, 채팅, 통화 시그널링, 번역 호출
src/translator.js   Claude API 번역 (문맥 포함, 짧은 문구 캐시, 하루 한도, mock 모드)
src/ice.js          WebRTC ICE/TURN 서버 설정 (Cloudflare TURN 임시 자격증명)
src/stt.js          서버 음성 인식 (Deepgram 실시간 스트리밍, mock)
src/store.js        저장소: 사용자·대화방·메시지·푸시 구독 (Postgres 또는 메모리)
src/push.js         Web Push 알림 (VAPID)
public/index.html   단일 페이지 (설정 → 로비 → 대화방)
public/js/app.js    화면/채팅/통화 UI 로직
public/js/rtc.js    WebRTC 1:1 음성 통화 (offer/answer/ICE)
public/js/speech.js 음성 인식(Web Speech API) + 🔊 발음 듣기용 TTS
public/js/i18n.js   한국어/일본어 UI 문자열
public/js/inapp.js  카톡/LINE 등 앱 내 브라우저 감지 → 외부 브라우저로 열기
public/js/stt.js    통화 마이크 소리를 서버 음성 인식으로 전송
public/js/pwa.js    홈 화면 앱: 서비스 워커 등록, 푸시 구독, 설치 안내, 배지
public/sw.js        서비스 워커: 푸시 알림 표시, 알림 누르면 앱 열기
public/js/pcm-worklet.js  마이크 소리 → 16kHz PCM 변환 (AudioWorklet)
docs/PLAN.md        완성 계획과 체크리스트
```

통화 번역 흐름:

```
[내 마이크] → 16kHz PCM → socket "stt:audio" → 서버 → Deepgram 음성인식
            (키가 없으면: 브라우저 음성인식 → socket "speech:final")
   → 서버: Claude 번역 → socket "caption:translation" → [상대 화면 자막]
[목소리 자체]는 WebRTC로 상대와 직접(P2P) 연결 — 번역 음성(TTS)은 쓰지 않음
```

## 알아둘 점

- `DEEPGRAM_API_KEY`가 없으면 브라우저 음성 인식을 쓰므로 **PC의 Chrome / Edge 권장**입니다. 휴대폰에서 통화 자막을 쓰려면 Deepgram 키를 넣으세요.
- 마이크는 **HTTPS 또는 localhost**에서만 동작합니다. 배포 시 HTTPS가 필요합니다.
- **이어폰 사용을 권장**합니다. 스피커로 나온 상대 목소리를 내 마이크가 다시 듣게 되면, 그 소리가 내 자막으로 잘못 인식될 수 있습니다.
- 서로 다른 네트워크(특히 모바일 데이터, 회사망) 간 통화는 STUN만으로 연결이 안 될 수 있어 **TURN 서버**(`CF_TURN_KEY_ID`/`CF_TURN_API_TOKEN` 또는 `ICE_SERVERS`)가 필요합니다.
- 로그인은 기기에 저장된 비밀 키로 합니다(회원가입 없음). 아이폰 홈 화면 앱은 Safari와 저장 공간이 따로라서, 처음 열 때 Safari에 표시된 6자리 코드로 계정을 이어받습니다.
- 아이폰 푸시 알림은 **홈 화면에 추가한 앱**에서만 동작합니다 (Safari 탭에서는 불가).
- WebSocket을 쓰므로 Vercel 같은 서버리스보다는 Render, Fly.io, Railway 같은 상시 실행 서버에 배포하세요.
