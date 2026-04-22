/**
 * 🌅 Morning Stock AI Briefing Center
 * ────────────────────────────────────
 * 매일 아침 07:00 (KST) 주식/반도체 브리핑을 자동 발송하는 파이프라인의
 * '소스·수신자 관리 웹 콘솔' 입니다.
 *
 * [v2.0] 검색어 기반 확장 수집 기능 추가:
 *   - 각 소스마다 '검색어(queries)' 배열을 가질 수 있음
 *   - 검색어가 비어있으면 → 해당 사이트의 최신 뉴스 수집 (기존 동작)
 *   - 검색어가 있으면    → Google News RSS 로 site:xxx "검색어" 조합 검색
 *   - 한 소스에 최대 5개 검색어, 각 검색어별 수집 건수 개별 설정
 *   - 카테고리(kr/us/yt/custom) 분리로 UI 탭 구성
 *   - 최초 접속 시 18개 "기본 시드 소스" 를 KV 에 자동 주입
 */
import { Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { renderer } from './renderer'

// ── 타입 정의 ──────────────────────────────────────────────────────────
type Bindings = {
  SOURCES_KV: KVNamespace
  ADMIN_PASSWORD?: string              // 관리자 로그인 비밀번호
  BRIEFING_READ_TOKEN?: string         // Python 수집기 API 인증 토큰
  GITHUB_TRIGGER_TOKEN?: string        // GitHub PAT (repo + workflow 권한) — 지금 발송용
  GITHUB_REPO?: string                 // 예: "wwwkoistkr/2026_04_21_-_-" (기본값 하드코딩)
  GITHUB_WORKFLOW_FILE?: string        // 예: "daily_briefing.yml"
  // (v2.2.7) MailChannels 기반 테스트 발송용 — Cloudflare 에서 바로 보낼 때 사용
  EMAIL_SENDER?: string                // 발신자 Gmail 주소 (GitHub Secret 과 동일)
  EMAIL_APP_PASSWORD?: string          // 참조용 (Cloudflare Worker 에서는 SMTP 불가)
}

type SourceType = 'rss' | 'google_news' | 'youtube' | 'web'
type SourceCategory = 'kr' | 'us' | 'yt' | 'custom'

/** 개별 검색어 질의 */
interface SearchQuery {
  keyword: string   // 예: "반도체", "HBM", "Fed"
  limit: number     // 이 키워드로 수집할 개수 (1~10)
}

/** 뉴스 소스 (확장된 스키마 v2) */
interface NewsSource {
  id: string                 // 고유 ID
  label: string              // 사용자에게 보일 이름
  category: SourceCategory   // kr / us / yt / custom
  type: SourceType           // rss / google_news / youtube / web
  url: string                // (type=rss/web/youtube 일 때) 직접 URL
  site?: string              // (type=google_news 일 때) site:xxxx 용 도메인
  queries: SearchQuery[]     // 검색어 배열 (비어있으면 최신순 수집)
  defaultLimit: number       // queries 가 비어있을 때 기본 수집 개수
  enabled: boolean
  builtin?: boolean          // 기본 내장 소스 여부 (true = 삭제는 가능하지만 복원 버튼으로 원복 가능)
  createdAt: string
}

interface EmailRecipient {
  id: string
  email: string
  label?: string
  enabled: boolean
  createdAt: string
  // (v2.2.7) 발송 이력 추적 — Python 메일 모듈이 성공/실패 후 POST /api/public/recipient-events 로 기록
  updatedAt?: string            // 마지막 편집 일시 (email/label 변경 시 갱신)
  lastSentAt?: string           // 마지막 발송 성공 일시
  lastAttemptAt?: string        // 마지막 발송 시도 일시 (성공/실패 무관)
  lastFailedAt?: string         // 마지막 발송 실패 일시
  lastFailedReason?: string     // 마지막 실패 사유 (SMTP code + message)
  sentCount?: number            // 누적 성공 건수
  failedCount?: number          // 누적 실패 건수
}

const app = new Hono<{ Bindings: Bindings }>()

// ─────────────────────────────────────────────────────────────
// 공통 상수 / 유틸
// ─────────────────────────────────────────────────────────────
const KV_KEY_SOURCES = 'sources:v2'            // v2 스키마 (검색어 포함)
const KV_KEY_SOURCES_LEGACY = 'sources:v1'     // 기존 v1 (마이그레이션 참조용)
const KV_KEY_RECIPIENTS = 'recipients:v1'
const KV_KEY_LAST_TRIGGER = 'trigger:last'     // "지금 발송" rate-limit 용
const KV_KEY_SYNC_VERSION = 'sync:version'     // PC ↔ 모바일 실시간 동기화용 카운터
const SESSION_COOKIE = 'msaic_session'
// (v2.2.7) 12시간 → 2시간으로 단축. 사용자 요구 "첫 화면에 비밀번호"
// 를 만족시키기 위함. 자주 사용하는 사용자는 모바일 PWA에 저장된 비밀번호로
// 바로 로그인되므로 UX 저하는 미미함.
const SESSION_TTL_SEC = 60 * 60 * 2            // 2시간
const DEFAULT_RECIPIENT = 'wwwkoistkr@gmail.com'

// 지금 발송 기본 설정 (Secret 없으면 기본값 사용)
const DEFAULT_GITHUB_REPO = 'wwwkoistkr/2026_04_21_-_-'
const DEFAULT_WORKFLOW_FILE = 'daily_briefing.yml'
// v2.3.1: 이중 쿨다운 시스템 — DRY RUN(테스트용)은 짧게, 실제 발송은 안전하게
// DRY RUN은 메일 발송을 하지 않으므로 빈번한 테스트 허용. 실제 워크플로 실행은 ~2분 소요되어
// 연속 호출해도 실제 동시 실행은 발생하지 않음.
const DRY_RUN_COOLDOWN_SEC = 30                 // 테스트용 DRY RUN: 30초 (실행 ~2분이라 사실상 연타 불가)
const REAL_SEND_COOLDOWN_SEC = 300              // 실제 발송: 5분 (수신자 스팸 처리 방지)
// 하위 호환: trigger-status 응답에 기본값으로 REAL 쿨다운 노출
const TRIGGER_COOLDOWN_SEC = REAL_SEND_COOLDOWN_SEC

// ─────────────────────────────────────────────────────────────
// 🌱 기본 시드 소스 정의 + 추천 프리셋 (옵션 3)
// ─────────────────────────────────────────────────────────────
// 프리셋 A: 한국 증권/경제 (반도체·HBM·코스피)
const KR_SECURITIES_PRESET: SearchQuery[] = [
  { keyword: '반도체', limit: 3 },
  { keyword: 'HBM', limit: 3 },
  { keyword: '코스피', limit: 3 },
]

// 프리셋 B: 한국 IT (AI·엔비디아·TSMC)
const KR_IT_PRESET: SearchQuery[] = [
  { keyword: 'AI', limit: 3 },
  { keyword: '엔비디아', limit: 3 },
  { keyword: 'TSMC', limit: 3 },
]

// 프리셋 C: US Semi (semiconductor·AI chip·HBM)
const US_SEMI_PRESET: SearchQuery[] = [
  { keyword: 'semiconductor', limit: 3 },
  { keyword: 'AI chip', limit: 3 },
  { keyword: 'HBM', limit: 3 },
]

// 프리셋 D: US ETF (SMH·SOXX·semiconductor ETF)
const US_ETF_PRESET: SearchQuery[] = [
  { keyword: 'SMH', limit: 3 },
  { keyword: 'SOXX', limit: 3 },
  { keyword: 'semiconductor ETF', limit: 3 },
]

// 사용자 UI 에서 보여줄 프리셋 카탈로그 (클라이언트가 /api/admin/presets 로 조회)
export const QUERY_PRESETS = [
  { id: 'kr_securities', label: '🇰🇷 한국 증권 (반도체·HBM·코스피)', queries: KR_SECURITIES_PRESET },
  { id: 'kr_it', label: '🇰🇷 한국 IT (AI·엔비디아·TSMC)', queries: KR_IT_PRESET },
  { id: 'us_semi', label: '🌎 US Semi (semiconductor·AI chip·HBM)', queries: US_SEMI_PRESET },
  { id: 'us_etf', label: '🌎 US ETF (SMH·SOXX·semiconductor ETF)', queries: US_ETF_PRESET },
  { id: 'clear', label: '🗑️ 검색어 비우기 (사이트 최신순 수집)', queries: [] },
]

function buildSeedSources(): NewsSource[] {
  const now = new Date().toISOString()
  const mk = (overrides: Partial<NewsSource>): NewsSource => ({
    id: 's_seed_' + Math.random().toString(36).slice(2, 9),
    label: '',
    category: 'kr',
    type: 'google_news',
    url: '',
    queries: [],
    defaultLimit: 5,
    enabled: true,
    builtin: true,
    createdAt: now,
    ...overrides,
  })

  return [
    // ── 🇰🇷 한국 6개 (증권 3 + IT 3) ──
    mk({ label: '한국경제 (증권)', category: 'kr', type: 'google_news', site: 'hankyung.com', queries: KR_SECURITIES_PRESET, url: 'https://hankyung.com' }),
    mk({ label: '매일경제 (증권)', category: 'kr', type: 'google_news', site: 'mk.co.kr', queries: KR_SECURITIES_PRESET, url: 'https://mk.co.kr' }),
    mk({ label: '머니투데이 (증권)', category: 'kr', type: 'google_news', site: 'mt.co.kr', queries: KR_SECURITIES_PRESET, url: 'https://mt.co.kr' }),
    mk({ label: '한국경제 (IT)', category: 'kr', type: 'google_news', site: 'hankyung.com', queries: KR_IT_PRESET, url: 'https://hankyung.com' }),
    mk({ label: '매일경제 (IT)', category: 'kr', type: 'google_news', site: 'mk.co.kr', queries: KR_IT_PRESET, url: 'https://mk.co.kr' }),
    mk({ label: '조선비즈', category: 'kr', type: 'google_news', site: 'biz.chosun.com', queries: KR_SECURITIES_PRESET, url: 'https://biz.chosun.com' }),

    // ── 🌎 미국 6개 (반도체 3 + ETF/거시 3) ──
    mk({ label: 'Reuters', category: 'us', type: 'google_news', site: 'reuters.com', queries: US_SEMI_PRESET, url: 'https://reuters.com' }),
    mk({ label: 'Bloomberg', category: 'us', type: 'google_news', site: 'bloomberg.com', queries: US_SEMI_PRESET, url: 'https://bloomberg.com' }),
    mk({ label: 'Seeking Alpha', category: 'us', type: 'google_news', site: 'seekingalpha.com', queries: US_SEMI_PRESET, url: 'https://seekingalpha.com' }),
    mk({ label: 'Seeking Alpha (ETF)', category: 'us', type: 'google_news', site: 'seekingalpha.com', queries: US_ETF_PRESET, url: 'https://seekingalpha.com' }),
    mk({ label: 'ETF.com', category: 'us', type: 'google_news', site: 'etf.com', queries: US_ETF_PRESET, url: 'https://etf.com' }),
    mk({ label: 'Morningstar', category: 'us', type: 'google_news', site: 'morningstar.com', queries: US_ETF_PRESET, url: 'https://morningstar.com' }),

    // ── 📺 유튜브 (검색어 없이 최신 영상) ──
    mk({
      label: '디일렉 (THEELEC)',
      category: 'yt',
      type: 'youtube',
      url: 'https://www.youtube.com/channel/UC2GRwEADsEKEX5k-Xg9YphA',
      queries: [],
      defaultLimit: 5,
    }),
  ]
}

// ─────────────────────────────────────────────────────────────
// 세션 / 인증 유틸
// ─────────────────────────────────────────────────────────────
function getSession(c: any): string | undefined {
  return getCookie(c, SESSION_COOKIE)
}

function isAuthed(c: any): boolean {
  const sess = getSession(c)
  if (!sess) return false
  return sess.length >= 8
}

async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim())
}

/** URL 을 자동 판별해서 type 을 결정한다. */
function detectSourceType(url: string): SourceType {
  const u = url.toLowerCase().trim()
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube'
  if (u.includes('news.google.com/rss')) return 'google_news'
  if (u.endsWith('.xml') || u.includes('/rss') || u.includes('/feed')) return 'rss'
  return 'web'
}

/** 사이트 URL 에서 순수 도메인 추출 (google_news 용) */
function extractSite(url: string): string | undefined {
  try {
    const u = new URL(url)
    return u.hostname.replace(/^www\./, '')
  } catch {
    return undefined
  }
}

// ─────────────────────────────────────────────────────────────
// KV 접근 레이어 (자동 시드 + v1 → v2 마이그레이션 포함)
// ─────────────────────────────────────────────────────────────
async function loadSources(env: Bindings): Promise<NewsSource[]> {
  // 1) v2 스키마 우선
  const raw = await env.SOURCES_KV.get(KV_KEY_SOURCES, 'json')
  if (raw) return raw as NewsSource[]

  // 2) v2 가 비어있으면 → v1 데이터 확인 후 마이그레이션
  const rawV1 = await env.SOURCES_KV.get(KV_KEY_SOURCES_LEGACY, 'json')
  if (rawV1 && Array.isArray(rawV1) && rawV1.length > 0) {
    const migrated: NewsSource[] = (rawV1 as any[]).map((s) => ({
      id: s.id ?? ('s_' + Math.random().toString(36).slice(2, 9)),
      label: s.label ?? '(이름없음)',
      category: 'custom' as SourceCategory,
      type: (s.type ?? 'rss') as SourceType,
      url: s.url ?? '',
      site: extractSite(s.url ?? ''),
      queries: [],
      defaultLimit: 5,
      enabled: s.enabled !== false,
      builtin: false,
      createdAt: s.createdAt ?? new Date().toISOString(),
    }))
    // 기본 시드 소스 + 마이그레이션된 사용자 소스
    const seeded = [...buildSeedSources(), ...migrated]
    await saveSources(env, seeded)
    return seeded
  }

  // 3) 완전 새 설치 → 18개 기본 시드
  const seed = buildSeedSources()
  await saveSources(env, seed)
  return seed
}

async function saveSources(env: Bindings, list: NewsSource[]): Promise<void> {
  await env.SOURCES_KV.put(KV_KEY_SOURCES, JSON.stringify(list))
  await bumpSyncVersion(env)
}

/** PC↔모바일 동기화용 버전 카운터 증가 */
async function bumpSyncVersion(env: Bindings): Promise<number> {
  const raw = await env.SOURCES_KV.get(KV_KEY_SYNC_VERSION)
  const cur = raw ? parseInt(raw, 10) || 0 : 0
  const next = cur + 1
  await env.SOURCES_KV.put(KV_KEY_SYNC_VERSION, String(next))
  return next
}

async function getSyncVersion(env: Bindings): Promise<number> {
  const raw = await env.SOURCES_KV.get(KV_KEY_SYNC_VERSION)
  return raw ? parseInt(raw, 10) || 0 : 0
}

async function loadRecipients(env: Bindings): Promise<EmailRecipient[]> {
  const raw = await env.SOURCES_KV.get(KV_KEY_RECIPIENTS, 'json')
  if (!raw) {
    const seed: EmailRecipient[] = [
      {
        id: 'r_default',
        email: DEFAULT_RECIPIENT,
        label: '기본 수신자',
        enabled: true,
        createdAt: new Date().toISOString(),
      },
    ]
    await env.SOURCES_KV.put(KV_KEY_RECIPIENTS, JSON.stringify(seed))
    return seed
  }
  return raw as EmailRecipient[]
}

async function saveRecipients(env: Bindings, list: EmailRecipient[]): Promise<void> {
  await env.SOURCES_KV.put(KV_KEY_RECIPIENTS, JSON.stringify(list))
  await bumpSyncVersion(env)
}

// ─────────────────────────────────────────────────────────────
// 페이지 렌더러 장착
// ─────────────────────────────────────────────────────────────
app.use(renderer)

// ═════════════════════════════════════════════════════════════
// 1) 로그인 화면
// ═════════════════════════════════════════════════════════════
app.get('/login', (c) => {
  const error = c.req.query('error')
  const loggedOut = c.req.query('logout')
  return c.render(
    <div class="max-w-md mx-auto mt-12 sm:mt-20 p-6 sm:p-8 bg-white rounded-2xl shadow-lg">
      <div class="text-center mb-6">
        <div class="text-5xl mb-2">🌅</div>
        <h1 class="text-2xl font-bold text-gray-800">Morning Stock AI</h1>
        <p class="text-sm text-gray-500 mt-1">Briefing Center — Admin Login</p>
      </div>
      {error && (
        <div class="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
          ⚠️ 비밀번호가 올바르지 않습니다.
        </div>
      )}
      {loggedOut && !error && (
        <div class="mb-4 p-3 bg-green-50 border border-green-200 rounded text-green-700 text-sm">
          ✅ 안전하게 로그아웃되었습니다.
        </div>
      )}
      <form method="post" action="/login" class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">
            관리자 비밀번호
          </label>
          <input
            type="password"
            name="password"
            required
            autofocus
            autocomplete="current-password"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="••••••••"
          />
        </div>
        <button
          type="submit"
          class="touch-target w-full py-3 bg-gradient-to-r from-blue-600 to-sky-500 text-white font-semibold rounded-lg hover:opacity-95 transition"
        >
          <i class="fa-solid fa-right-to-bracket mr-1"></i> 로그인
        </button>
      </form>
      <div class="mt-6 text-xs text-gray-400 text-center space-y-1">
        <p>비밀번호는 <code>ADMIN_PASSWORD</code> Secret 으로 설정됩니다.</p>
        <p>세션 유지 시간: 2시간 (이후 재로그인 필요)</p>
      </div>
    </div>,
    { title: 'Login — Morning Stock AI Briefing Center' }
  )
})

app.post('/login', async (c) => {
  const form = await c.req.parseBody()
  const password = String(form['password'] ?? '')
  const expected = c.env.ADMIN_PASSWORD ?? 'admin1234'

  if (password !== expected) {
    return c.redirect('/login?error=1')
  }

  const token = await sha256Hex(password + ':' + Date.now())
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SEC,
  })
  return c.redirect('/')
})

app.post('/logout', (c) => {
  setCookie(c, SESSION_COOKIE, '', { path: '/', maxAge: 0 })
  return c.redirect('/login?logout=1')
})

// (v2.2.7) GET 요청으로도 로그아웃 가능 — 모바일 PWA 북마크/빠른 실행용
app.get('/logout', (c) => {
  setCookie(c, SESSION_COOKIE, '', { path: '/', maxAge: 0 })
  return c.redirect('/login?logout=1')
})

// ═════════════════════════════════════════════════════════════
// 2) 인증 가드 (대시보드 보호)
// ═════════════════════════════════════════════════════════════
app.use('/', async (c, next) => {
  if (!isAuthed(c)) return c.redirect('/login')
  await next()
})
app.use('/api/admin/*', async (c, next) => {
  if (!isAuthed(c)) return c.json({ error: 'unauthorized' }, 401)
  await next()
})

// ═════════════════════════════════════════════════════════════
// 3) 대시보드
// ═════════════════════════════════════════════════════════════
app.get('/', (c) => {
  return c.render(
    <div class="max-w-6xl mx-auto p-3 sm:p-6">
      {/* 헤더 */}
      <header class="bg-gradient-to-r from-blue-600 to-sky-500 text-white rounded-2xl shadow-lg p-4 sm:p-6 mb-4 sm:mb-6">
        <div class="flex items-start justify-between gap-3">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-[10px] sm:text-xs uppercase tracking-widest opacity-80">
                Daily Briefing Admin v2.3.1
              </span>
              <span id="syncIndicator" class="hidden sm:inline-flex items-center gap-1 text-[10px] bg-white/20 px-2 py-0.5 rounded-full" title="PC ↔ 모바일 실시간 동기화 중">
                <span class="inline-block w-1.5 h-1.5 rounded-full bg-green-300 animate-pulse"></span>
                <span>실시간 동기화</span>
              </span>
            </div>
            <h1 class="text-xl sm:text-3xl font-bold mt-1 leading-tight">
              🌅 Morning Stock AI
            </h1>
            <p class="text-xs sm:text-sm opacity-90 mt-1">
              매일 <strong>07:00 KST</strong> 자동 발송 · 모바일 설치 가능 (홈 화면 추가)
            </p>
          </div>
          <form method="post" action="/logout" class="flex-shrink-0">
            <button class="touch-target px-3 py-1.5 text-xs sm:text-sm bg-white/20 rounded hover:bg-white/30">
              <i class="fa-solid fa-right-from-bracket sm:hidden"></i>
              <span class="hidden sm:inline">로그아웃</span>
            </button>
          </form>
        </div>
      </header>

      {/* 🚀 지금 발송 섹션 (새 기능) */}
      <section class="bg-gradient-to-br from-orange-50 to-amber-50 border-2 border-orange-200 rounded-2xl shadow p-4 sm:p-6 mb-6">
        <div class="flex items-start gap-3 sm:gap-4">
          <div class="flex-shrink-0 text-3xl sm:text-4xl pt-1">🚀</div>
          <div class="flex-1 min-w-0">
            <h2 class="text-base sm:text-lg font-bold text-gray-800">
              지금 즉시 브리핑 발송
            </h2>
            <p class="text-xs sm:text-sm text-gray-600 mt-1">
              매일 07:00 KST 스케줄과 별도로, <strong>지금 바로</strong> 최신 뉴스를 수집·요약·이메일 발송합니다.
              (약 1~3분 소요)
            </p>
            <div id="triggerStatus" class="hidden mt-3 p-3 rounded-lg text-xs sm:text-sm"></div>
          </div>
        </div>
        <div class="flex flex-col sm:flex-row gap-2 mt-4 sm:mt-3 sm:ml-16">
          <button id="btnTriggerNow"
            class="touch-target flex-1 sm:flex-initial px-4 py-3 sm:py-2.5 bg-gradient-to-r from-orange-500 to-amber-500 text-white font-semibold rounded-lg hover:from-orange-600 hover:to-amber-600 transition shadow-sm">
            <span class="btn-label"><i class="fa-solid fa-paper-plane mr-1"></i>🚀 지금 발송</span>
            <span class="btn-countdown hidden ml-1 text-xs opacity-90"></span>
          </button>
          <button id="btnTriggerDryRun"
            class="touch-target flex-1 sm:flex-initial px-4 py-3 sm:py-2.5 bg-white border border-orange-300 text-orange-700 font-medium rounded-lg hover:bg-orange-50 transition">
            <span class="btn-label"><i class="fa-solid fa-flask mr-1"></i>DRY RUN (미리보기)</span>
            <span class="btn-countdown hidden ml-1 text-xs opacity-90"></span>
          </button>
          <button id="btnCheckTriggerStatus"
            class="touch-target px-4 py-3 sm:py-2.5 bg-white border border-gray-300 text-gray-600 text-sm rounded-lg hover:bg-gray-50 transition" title="최근 워크플로 실행 상태 확인">
            <i class="fa-solid fa-rotate"></i>
          </button>
        </div>
        {/* v2.3.1: 이중 쿨다운 안내 */}
        <div class="mt-3 sm:ml-16 text-[11px] sm:text-xs text-gray-500 leading-relaxed">
          <i class="fa-solid fa-circle-info mr-1 text-gray-400"></i>
          <strong>쿨다운 정책 (v2.3.1):</strong>
          🧪 DRY RUN = <strong>30초</strong> (테스트 빠른 반복)  ·  📧 실제 발송 = <strong>5분</strong> (수신자 보호)
        </div>
      </section>

      {/* 🩺 (v2.2.7) 수신자 동기화 진단 + MailChannels 직접 테스트 — 네이버 미수신 해결용 */}
      <section class="bg-gradient-to-br from-sky-50 to-indigo-50 border-2 border-sky-200 rounded-2xl shadow p-4 sm:p-6 mb-6">
        <div class="flex items-start gap-3 sm:gap-4">
          <div class="flex-shrink-0 text-3xl sm:text-4xl pt-1">🩺</div>
          <div class="flex-1 min-w-0">
            <h2 class="text-base sm:text-lg font-bold text-gray-800">
              수신자 동기화 진단 · 네이버/다음 미수신 해결
            </h2>
            <p class="text-xs sm:text-sm text-gray-600 mt-1">
              관리 UI에 등록한 수신자가 실제 GitHub Actions 파이프라인에 반영되지 않을 때 사용하세요.
              <strong>토큰 해시</strong> 를 대조하고, 특정 이메일로 <strong>즉시 테스트 발송</strong> 이 가능합니다.
            </p>
            <div id="diagStatus" class="hidden mt-3 p-3 rounded-lg text-xs sm:text-sm"></div>
          </div>
        </div>
        <div class="flex flex-col sm:flex-row gap-2 mt-4 sm:mt-3 sm:ml-16">
          <button id="btnDiagSync"
            class="touch-target flex-1 sm:flex-initial px-4 py-3 sm:py-2.5 bg-gradient-to-r from-sky-500 to-indigo-500 text-white font-semibold rounded-lg hover:from-sky-600 hover:to-indigo-600 transition shadow-sm">
            <i class="fa-solid fa-stethoscope mr-1"></i>🩺 토큰·수신자 진단
          </button>
          <div class="flex-1 flex gap-2">
            <input id="diagTestEmail" type="email" autocomplete="email" inputmode="email"
              placeholder="테스트 이메일 주소 (예: hjlee12000@naver.com)"
              class="touch-target flex-1 min-w-0 px-3 py-2.5 border border-sky-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500" />
            <button id="btnDiagSendTest"
              class="touch-target px-3 py-2.5 bg-white border border-sky-400 text-sky-700 font-medium rounded-lg hover:bg-sky-50 transition whitespace-nowrap">
              <i class="fa-solid fa-paper-plane mr-1"></i>즉시 테스트
            </button>
          </div>
        </div>
      </section>

      {/* ① 이메일 수신자 관리 */}
      <section class="bg-white rounded-2xl shadow p-4 sm:p-6 mb-6">
        <h2 class="text-base sm:text-lg font-bold text-gray-800 mb-4">
          <i class="fa-solid fa-envelope text-emerald-500 mr-2"></i>
          ① 매일 아침 브리핑을 받을 이메일 주소
        </h2>
        <p class="text-xs sm:text-sm text-gray-500 mb-4">
          여기 등록된 모든 이메일로 <strong>매일 07:00 KST</strong> 브리핑이 발송됩니다.
        </p>
        <form id="addRecipientForm" class="grid grid-cols-1 md:grid-cols-[2fr_1fr_auto] gap-2 sm:gap-3">
          <input
            id="recipientEmail"
            type="email"
            required
            autocomplete="email"
            inputmode="email"
            placeholder="이메일 주소"
            class="touch-target px-3 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
          />
          <input
            id="recipientLabel"
            placeholder="별명 (선택)"
            class="touch-target px-3 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
          />
          <button
            type="submit"
            class="touch-target px-4 py-2.5 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700"
          >
            <i class="fa-solid fa-plus mr-1"></i> 수신자 추가
          </button>
        </form>
        <div class="flex items-center justify-between mt-5 mb-3 gap-2 flex-wrap">
          <h3 class="text-sm font-semibold text-gray-700 flex items-center gap-2">
            <label class="flex items-center gap-1.5 cursor-pointer select-none" title="전체 선택/해제">
              <input id="recipientCheckAll" type="checkbox" class="w-4 h-4 accent-sky-500" />
            </label>
            <i class="fa-solid fa-users text-emerald-500"></i>
            현재 등록된 수신자
            <span id="recipientCount" class="text-xs text-gray-500 font-normal">(불러오는 중…)</span>
          </h3>
          {/* (v2.2.7) Export / Import 버튼 */}
          <div class="flex items-center gap-1">
            <button id="btnExportRecipients"
              class="touch-target px-2.5 py-1.5 text-xs text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition"
              title="JSON 파일로 내보내기 (백업)">
              <i class="fa-solid fa-download mr-1"></i>내보내기
            </button>
            <input id="recipientImportInput" type="file" accept=".json,.csv,.txt" class="hidden" />
            <button id="btnImportRecipients"
              class="touch-target px-2.5 py-1.5 text-xs text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition"
              title="JSON/CSV 파일에서 가져오기">
              <i class="fa-solid fa-upload mr-1"></i>가져오기
            </button>
          </div>
        </div>

        {/* (v2.2.7) 일괄 작업 툴바 — 체크박스 선택 시만 표시 */}
        <div id="recipientBulkBar" class="hidden mb-3 p-2.5 bg-sky-50 border border-sky-200 rounded-lg flex items-center gap-2 flex-wrap">
          <span class="text-sm font-semibold text-sky-800">
            <i class="fa-solid fa-check-double mr-1"></i>
            <span id="recipientBulkCount">0</span>명 선택됨
          </span>
          <div class="flex-1"></div>
          <button id="btnBulkEnable"
            class="touch-target px-3 py-1.5 text-xs font-medium bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 transition">
            <i class="fa-solid fa-toggle-on mr-1"></i>활성화
          </button>
          <button id="btnBulkDisable"
            class="touch-target px-3 py-1.5 text-xs font-medium bg-gray-500 text-white rounded-lg hover:bg-gray-600 transition">
            <i class="fa-solid fa-toggle-off mr-1"></i>비활성화
          </button>
          <button id="btnBulkDelete"
            class="touch-target px-3 py-1.5 text-xs font-medium bg-rose-500 text-white rounded-lg hover:bg-rose-600 transition">
            <i class="fa-solid fa-trash mr-1"></i>삭제
          </button>
          <button id="btnBulkClear"
            class="touch-target px-2.5 py-1.5 text-xs text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition">
            <i class="fa-solid fa-xmark mr-1"></i>선택해제
          </button>
        </div>

        <div id="recipientList" class="space-y-2">
          <div class="text-center text-gray-400 py-6 text-sm">불러오는 중…</div>
        </div>
      </section>

      {/* ② 뉴스 소스 관리 (새 UI) */}
      <section class="bg-white rounded-2xl shadow p-4 sm:p-6 mb-6">
        <h2 class="text-base sm:text-lg font-bold text-gray-800 mb-2">
          <i class="fa-solid fa-newspaper text-blue-500 mr-2"></i>
          ② 뉴스 소스 & 검색어 관리
        </h2>
        <p class="text-xs sm:text-sm text-gray-500 mb-4">
          각 언론사에 <strong>검색어</strong>(최대 5개)를 설정해 관심 주제의 기사만 수집합니다.
          검색어를 비우면 해당 사이트 최신 뉴스가 그대로 수집됩니다.
        </p>

        {/* 카테고리 탭 */}
        <div class="flex gap-2 border-b border-gray-200 mb-4 overflow-x-auto" id="categoryTabs">
          <button data-cat="all" class="cat-tab active px-4 py-2 text-sm font-medium border-b-2 border-blue-500 text-blue-600 whitespace-nowrap">
            <i class="fa-solid fa-globe mr-1"></i>전체 <span class="cat-count">0</span>
          </button>
          <button data-cat="kr" class="cat-tab px-4 py-2 text-sm font-medium border-b-2 border-transparent text-gray-500 hover:text-gray-700 whitespace-nowrap">
            🇰🇷 한국 <span class="cat-count">0</span>
          </button>
          <button data-cat="us" class="cat-tab px-4 py-2 text-sm font-medium border-b-2 border-transparent text-gray-500 hover:text-gray-700 whitespace-nowrap">
            🌎 미국 <span class="cat-count">0</span>
          </button>
          <button data-cat="yt" class="cat-tab px-4 py-2 text-sm font-medium border-b-2 border-transparent text-gray-500 hover:text-gray-700 whitespace-nowrap">
            📺 유튜브 <span class="cat-count">0</span>
          </button>
          <button data-cat="custom" class="cat-tab px-4 py-2 text-sm font-medium border-b-2 border-transparent text-gray-500 hover:text-gray-700 whitespace-nowrap">
            ➕ 사용자 <span class="cat-count">0</span>
          </button>
        </div>

        {/* 툴바 */}
        <div class="flex flex-wrap gap-2 mb-4">
          <button id="btnAddSource" class="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700">
            <i class="fa-solid fa-plus mr-1"></i>새 소스 추가
          </button>
          <button id="btnResetDefaults" class="px-3 py-1.5 bg-amber-100 text-amber-700 text-sm rounded hover:bg-amber-200 border border-amber-300" title="기본 18개 소스를 복원합니다 (사용자 추가분은 보존)">
            <i class="fa-solid fa-rotate-left mr-1"></i>기본값 복원
          </button>
          <div class="ml-auto">
            <span id="sourceCount" class="text-sm text-gray-500">(불러오는 중…)</span>
          </div>
        </div>

        {/* 소스 카드 리스트 */}
        <div id="sourceList" class="space-y-3">
          <div class="text-center text-gray-400 py-8">불러오는 중…</div>
        </div>
      </section>

      {/* 추천 검색어 프리셋 안내 */}
      <section class="bg-blue-50 border border-blue-200 rounded-2xl p-4 sm:p-5 mb-6 text-sm">
        <h3 class="font-bold text-blue-900 mb-2 text-sm sm:text-base">
          <i class="fa-solid fa-lightbulb mr-1"></i>
          추천 검색어 프리셋
        </h3>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3 text-gray-700">
          <div>
            <strong class="text-xs sm:text-sm">🇰🇷 한국 증권:</strong>
            <p class="text-xs mt-1">반도체, HBM, 코스피, 삼성전자, SK하이닉스</p>
          </div>
          <div>
            <strong class="text-xs sm:text-sm">🇰🇷 한국 IT:</strong>
            <p class="text-xs mt-1">AI, 엔비디아, TSMC, 파운드리, 데이터센터</p>
          </div>
          <div>
            <strong class="text-xs sm:text-sm">🌎 US Semi / ETF:</strong>
            <p class="text-xs mt-1">semiconductor, AI chip, HBM, SMH, SOXX</p>
          </div>
        </div>
      </section>

      {/* 푸터 */}
      <footer class="text-center text-xs text-gray-400 mt-6 sm:mt-8 pb-4">
        <p>Morning Stock AI Briefing Center <span class="font-semibold">v2.3.1</span></p>
        <p class="mt-1">매일 07:00 KST · GitHub Actions · 모바일 홈 화면 추가 지원</p>
        <p class="mt-2">
          <button id="btnInstallPwa" class="hidden text-blue-600 underline">
            <i class="fa-solid fa-download"></i> 홈 화면에 설치하기
          </button>
        </p>
      </footer>

      {/* 모달: 소스 편집 — 모바일 전체 화면 */}
      <div id="editModal" class="modal-hidden fixed inset-0 bg-black/50 z-50 p-4">
        <div class="bg-white sm:rounded-2xl shadow-2xl w-full h-full sm:h-auto sm:max-w-2xl sm:max-h-[90vh] overflow-y-auto flex flex-col">
          <div class="p-4 sm:p-6 border-b border-gray-200 flex items-center justify-between sticky top-0 bg-white z-10">
            <h3 class="text-base sm:text-lg font-bold text-gray-800 truncate pr-2">
              <i class="fa-solid fa-pen-to-square text-blue-500 mr-2"></i>
              <span id="modalTitle">소스 편집</span>
            </h3>
            <button id="btnCloseModal" class="touch-target text-gray-400 hover:text-gray-600 flex-shrink-0">
              <i class="fa-solid fa-xmark text-2xl"></i>
            </button>
          </div>
          <div class="p-4 sm:p-6 flex-1" id="modalBody">
            {/* JS 가 채워넣음 */}
          </div>
          <div class="p-4 border-t border-gray-200 flex justify-end gap-2 bg-gray-50 sm:rounded-b-2xl sticky bottom-0 z-10">
            <button id="btnCancelEdit" class="touch-target px-4 py-2.5 text-sm bg-white border border-gray-300 rounded hover:bg-gray-50">
              취소
            </button>
            <button id="btnSaveEdit" class="touch-target px-5 py-2.5 text-sm bg-blue-600 text-white font-semibold rounded hover:bg-blue-700">
              <i class="fa-solid fa-check mr-1"></i>저장
            </button>
          </div>
        </div>
      </div>

      {/* 확인 모달 (지금 발송 용) */}
      <div id="confirmModal" class="modal-hidden fixed inset-0 bg-black/50 z-50 p-4">
        <div class="bg-white rounded-2xl shadow-2xl max-w-sm w-full">
          <div class="p-5 sm:p-6">
            <h3 id="confirmTitle" class="text-base sm:text-lg font-bold text-gray-800 mb-2">확인</h3>
            <p id="confirmBody" class="text-sm text-gray-600 mb-4"></p>
            <div class="flex gap-2 justify-end">
              <button id="btnConfirmCancel" class="touch-target px-4 py-2 text-sm bg-white border border-gray-300 rounded hover:bg-gray-50">
                취소
              </button>
              <button id="btnConfirmOk" class="touch-target px-5 py-2 text-sm bg-red-600 text-white font-semibold rounded hover:bg-red-700">
                확인
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 토스트 알림 — 모바일은 하단 중앙 */}
      <div id="toast" class="toast-hidden fixed bottom-4 left-1/2 -translate-x-1/2 sm:left-auto sm:right-6 sm:translate-x-0 z-50 px-5 py-3 rounded-lg shadow-lg text-white text-sm max-w-[90vw] sm:max-w-md"></div>

      <script src="/static/admin.js?v=2.2.7"></script>
    </div>,
    { title: 'Morning Stock AI Briefing Center' }
  )
})

// ═════════════════════════════════════════════════════════════
// 4) 관리 API (인증 필요)
// ═════════════════════════════════════════════════════════════

/** 소스 목록 조회 */
app.get('/api/admin/sources', async (c) => {
  const list = await loadSources(c.env)
  return c.json({ sources: list })
})

/** 프리셋 카탈로그 조회 (UI 드롭다운용) */
app.get('/api/admin/presets', (c) => {
  return c.json({ presets: QUERY_PRESETS })
})

/** 🔄 동기화 버전 조회 (PC ↔ 모바일 실시간 연동용)
 *  소스/수신자 변경시마다 +1 되므로 클라이언트는 이 값만 폴링하면 된다. */
app.get('/api/admin/sync-version', async (c) => {
  const version = await getSyncVersion(c.env)
  return c.json({ version, ts: Date.now() })
})

// ─────────────────────────────────────────────────────────────
// 🚀 "지금 발송" — GitHub Actions workflow_dispatch 래퍼
// ─────────────────────────────────────────────────────────────

interface TriggerRecord {
  timestamp: number  // Unix ms
  dryRun: boolean
  ok: boolean
}

/** 쿨다운 체크 */
async function getLastTrigger(env: Bindings): Promise<TriggerRecord | null> {
  const raw = await env.SOURCES_KV.get(KV_KEY_LAST_TRIGGER, 'json')
  return (raw as TriggerRecord) ?? null
}

async function saveTrigger(env: Bindings, record: TriggerRecord): Promise<void> {
  await env.SOURCES_KV.put(KV_KEY_LAST_TRIGGER, JSON.stringify(record))
}

/** 현재 지금-발송 기능 설정 상태 조회 (v2.3.1: 이중 쿨다운 반영) */
app.get('/api/admin/trigger-status', async (c) => {
  const hasToken = !!c.env.GITHUB_TRIGGER_TOKEN
  const repo = c.env.GITHUB_REPO || DEFAULT_GITHUB_REPO
  const workflow = c.env.GITHUB_WORKFLOW_FILE || DEFAULT_WORKFLOW_FILE
  const last = await getLastTrigger(c.env)
  const now = Date.now()

  // v2.3.1: DRY RUN 과 실제 발송 각각 남은 쿨다운 계산
  // - 마지막 트리거가 DRY RUN 이면: 다음 DRY RUN 은 30초 후, 다음 실제 발송은 30초 후 (짧게)
  // - 마지막 트리거가 실제 발송이면: 다음 실제 발송은 5분 후, 다음 DRY RUN 도 5분 후 (안전하게)
  // → 즉, 실제 발송 후엔 모두 5분 대기, DRY RUN 후엔 30초만 대기
  let dryRunRemainMs = 0
  let realSendRemainMs = 0
  if (last) {
    const elapsed = now - last.timestamp
    if (last.dryRun) {
      // 직전이 DRY RUN 이면 양쪽 다 30초 쿨다운만 적용
      dryRunRemainMs = Math.max(0, DRY_RUN_COOLDOWN_SEC * 1000 - elapsed)
      realSendRemainMs = Math.max(0, DRY_RUN_COOLDOWN_SEC * 1000 - elapsed)
    } else {
      // 직전이 실제 발송이면 양쪽 다 5분 쿨다운 적용 (수신자 보호)
      dryRunRemainMs = Math.max(0, REAL_SEND_COOLDOWN_SEC * 1000 - elapsed)
      realSendRemainMs = Math.max(0, REAL_SEND_COOLDOWN_SEC * 1000 - elapsed)
    }
  }

  return c.json({
    configured: hasToken,
    repo,
    workflow,
    // v2.3.1 이중 쿨다운 정보
    dryRunCooldownSec: DRY_RUN_COOLDOWN_SEC,
    realSendCooldownSec: REAL_SEND_COOLDOWN_SEC,
    dryRunRemainMs,
    realSendRemainMs,
    // 하위 호환: 실제 발송 기준 값
    cooldownSec: TRIGGER_COOLDOWN_SEC,
    cooldownRemainMs: realSendRemainMs,
    last,
  })
})

/**
 * (v2.2.7) 수신자 동기화 진단 — "왜 이메일이 특정 사람에게만 가는가" 해결용
 *
 * 관리 UI 에 등록된 수신자들이 실제 GitHub Actions 파이프라인에 반영되려면
 * Cloudflare Pages 의 BRIEFING_READ_TOKEN 과 GitHub Secrets 의 BRIEFING_READ_TOKEN
 * 값이 정확히 일치해야 한다. 이 API 는 **토큰을 직접 노출하지 않고**
 * 다음을 제공한다:
 *   1) BRIEFING_READ_TOKEN 설정 여부 및 해시 앞 8자리
 *   2) 관리 UI 의 활성 수신자 전체 목록 (이메일)
 *   3) 사용자가 바로 실행할 수 있는 **curl 테스트 명령어** (토큰을 그대로 쓰지 않음)
 *   4) EMAIL_RECIPIENTS 환경변수로 그대로 붙여넣을 수 있는 **쉼표 구분 문자열**
 */
app.get('/api/admin/diag-recipient-sync', async (c) => {
  const token = c.env.BRIEFING_READ_TOKEN ?? ''
  const tokenConfigured = token.length > 0
  let tokenHashPrefix: string | null = null
  if (tokenConfigured) {
    const hash = await sha256Hex(token)
    tokenHashPrefix = hash.slice(0, 8)
  }

  const allRecipients = await loadRecipients(c.env)
  const activeEmails = allRecipients.filter((r) => r.enabled).map((r) => r.email)

  // 사용자가 "이 값을 그대로 GitHub Secret EMAIL_RECIPIENTS 에 붙여넣으세요"
  // 하고 쓸 수 있도록 comma-separated string 생성
  const emailRecipientsSecret = activeEmails.join(',')

  const origin = new URL(c.req.url).origin

  return c.json({
    ok: true,
    tokenConfigured,
    tokenHashPrefix,  // 예: "a1b2c3d4" — GitHub Secrets 값 해시와 비교용
    adminApi: origin,
    endpoint: `${origin}/api/public/recipients`,
    activeRecipientCount: activeEmails.length,
    activeRecipients: activeEmails,
    emailRecipientsSecret,  // 복붙용: "a@x.com,b@y.com,c@z.com"
    hints: {
      quickFix: [
        `위 emailRecipientsSecret 값 (${activeEmails.length}개 이메일) 을 GitHub Repo 의 Secrets → EMAIL_RECIPIENTS 에 저장하면 BRIEFING_READ_TOKEN 일치 여부와 상관없이 즉시 모든 수신자에게 발송됩니다.`,
        `또는 Cloudflare Pages Settings → Environment variables 의 BRIEFING_READ_TOKEN 값을 확인하고 (해시 앞자리: ${tokenHashPrefix ?? '미설정'}), 동일 값을 GitHub Secrets 의 BRIEFING_READ_TOKEN 에 저장하세요.`,
      ],
      verifyCmd: tokenConfigured
        ? `curl -H "Authorization: Bearer <YOUR_TOKEN>" ${origin}/api/public/recipients\n# 200 이면 토큰 일치, 401 이면 불일치`
        : `curl ${origin}/api/public/recipients   # 토큰 미설정 상태 → 검증 불가`,
    },
  })
})

/**
 * (v2.2.7) SMTP 직접 발송 테스트 — 관리 UI 에서 특정 수신자에게만 테스트 메일
 *  - GitHub Actions 우회 → Cloudflare Worker 에서 직접 발송 (즉시 결과 확인)
 *  - BRIEFING_READ_TOKEN 문제와 무관하게 동작
 *  - 네이버/구글/기타 수신자 도착 여부를 각각 빠르게 점검 가능
 *
 *  Body: { email: "hjlee12000@naver.com" }  // 단일 수신자
 */
app.post('/api/admin/send-test', async (c) => {
  const sender = c.env.EMAIL_SENDER
  const appPassword = c.env.EMAIL_APP_PASSWORD
  if (!sender || !appPassword) {
    return c.json({
      ok: false,
      error: 'EMAIL_SENDER / EMAIL_APP_PASSWORD Cloudflare Secret 이 설정되지 않았습니다.',
      hint: 'Cloudflare Pages → Settings → Environment variables 에서 등록하세요.',
    }, 503)
  }

  const body = await c.req.json().catch(() => ({}))
  const target = String(body.email ?? '').trim()
  if (!isValidEmail(target)) {
    return c.json({ ok: false, error: '유효한 email 주소가 필요합니다.' }, 400)
  }

  // Cloudflare Workers 는 SMTP 를 직접 열 수 없으므로,
  // MailChannels (무료 이메일 API) 를 통해 발송
  // - Cloudflare Workers 에 공식 통합되어 있으며, Cloudflare IP 로부터의 전송은 자동 인증됨
  // - Custom domain 이 없어도 fallback 송신자 'briefing@morning-stock-briefing.pages.dev' 사용 가능
  const subject = '[Morning Stock AI] 테스트 이메일 — 수신 확인용'
  const now = new Date()
  const textBody = [
    '안녕하세요,',
    '',
    '이 메일은 Morning Stock AI Briefing Center 의 수신 테스트 메일입니다.',
    `관리 UI 로부터 ${now.toLocaleString('ko-KR')} 에 발송되었습니다.`,
    '',
    '이 메일이 받은편지함 또는 스팸/프로모션 폴더에 보인다면,',
    '일일 브리핑 발송도 동일 경로로 도착합니다.',
    '',
    '— Morning Stock AI Briefing Center',
  ].join('\n')

  const htmlBody = `
    <!DOCTYPE html><html lang="ko"><body style="font-family:Apple SD Gothic Neo,Malgun Gothic,sans-serif;color:#222;max-width:560px;margin:0 auto;padding:24px;">
      <div style="background:linear-gradient(135deg,#1d4ed8,#0ea5e9);color:#fff;padding:20px 24px;border-radius:12px 12px 0 0;">
        <div style="font-size:12px;opacity:.85;letter-spacing:1px;">MORNING STOCK AI · TEST MAIL</div>
        <div style="font-size:20px;font-weight:700;margin-top:4px;">📬 수신 테스트 메일</div>
      </div>
      <div style="background:#fff;padding:24px;border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;line-height:1.7;">
        <p>안녕하세요,</p>
        <p>이 메일은 <strong>Morning Stock AI Briefing Center</strong> 의 수신 테스트 메일입니다.</p>
        <p>관리 UI 로부터 <strong>${now.toLocaleString('ko-KR')}</strong> 에 발송되었습니다.</p>
        <p style="color:#666;font-size:14px;">이 메일이 받은편지함 또는 스팸/프로모션 폴더에 보인다면,
        일일 브리핑 발송도 동일 경로로 도착합니다.</p>
        <div style="margin-top:20px;padding:12px;background:#f0f9ff;border-left:4px solid #0ea5e9;font-size:13px;color:#075985;">
          💡 <strong>네이버 메일 사용자 팁</strong>: 이 메일이 스팸으로 분류되면
          '이 메일을 스팸이 아님으로 설정' 을 클릭하고, <code>${sender}</code> 를
          <strong>주소록/안전 발신인</strong> 에 등록해 주세요.
        </div>
      </div>
    </body></html>`

  // MailChannels API 호출
  const payload = {
    personalizations: [{ to: [{ email: target }] }],
    from: { email: sender, name: 'Morning Stock AI' },
    reply_to: { email: sender, name: 'Morning Stock AI' },
    subject,
    content: [
      { type: 'text/plain', value: textBody },
      { type: 'text/html', value: htmlBody },
    ],
    headers: {
      'List-Unsubscribe': `<mailto:${sender}?subject=unsubscribe>`,
      'X-Mailer': 'MorningStockAI-BriefingCenter/2.2.5-CF',
    },
  }

  try {
    const resp = await fetch('https://api.mailchannels.net/tx/v1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    const respText = await resp.text()
    if (!resp.ok) {
      return c.json({
        ok: false,
        via: 'mailchannels',
        error: `MailChannels HTTP ${resp.status}: ${respText.slice(0, 500)}`,
        hint: resp.status === 401 || resp.status === 403
          ? 'MailChannels 는 custom domain 을 요구할 수 있습니다. 대안으로 GitHub Actions 경로(SMTP)만 사용하세요.'
          : 'MailChannels API 가 응답하지 않음. GitHub Actions 를 통해 재시도하세요.',
      }, 502)
    }

    return c.json({
      ok: true,
      via: 'mailchannels',
      target,
      message: `✅ MailChannels 경유 테스트 메일 발송됨 → ${target} (받은편지함/스팸 폴더 확인)`,
      sentAt: now.toISOString(),
    })
  } catch (e: any) {
    return c.json({
      ok: false,
      via: 'mailchannels',
      error: `네트워크 오류: ${e?.message ?? String(e)}`,
    }, 500)
  }
})

/** 실제 워크플로 트리거 */
app.post('/api/admin/trigger-now', async (c) => {
  const token = c.env.GITHUB_TRIGGER_TOKEN
  if (!token) {
    return c.json({
      ok: false,
      error: 'GITHUB_TRIGGER_TOKEN 이 설정되지 않았습니다. Cloudflare Secret 으로 PAT 를 등록하세요.',
    }, 503)
  }

  const body = await c.req.json().catch(() => ({}))
  const dryRun = !!body.dryRun

  // v2.3.1: 이중 쿨다운 체크
  // - 지금 요청이 DRY RUN → 직전이 DRY RUN 이면 30초, 직전이 실제 발송이면 5분 대기
  // - 지금 요청이 실제 발송 → 실제 발송은 항상 5분 쿨다운 (직전 종류 무관)
  const last = await getLastTrigger(c.env)
  const now = Date.now()
  let requiredCooldownSec: number
  if (dryRun) {
    // DRY RUN 요청: 직전이 DRY RUN 이면 짧게, 실제 발송이면 5분 (이메일 쿨링)
    requiredCooldownSec = last?.dryRun ? DRY_RUN_COOLDOWN_SEC : REAL_SEND_COOLDOWN_SEC
    // 단, last 가 아예 없으면 쿨다운 0
    if (!last) requiredCooldownSec = 0
  } else {
    // 실제 발송 요청: 항상 5분 쿨다운 (직전 종류와 무관하게 수신자 보호)
    requiredCooldownSec = REAL_SEND_COOLDOWN_SEC
    if (!last) requiredCooldownSec = 0
  }

  if (last && requiredCooldownSec > 0 && now - last.timestamp < requiredCooldownSec * 1000) {
    const remain = Math.ceil((requiredCooldownSec * 1000 - (now - last.timestamp)) / 1000)
    const modeLabel = dryRun ? '🧪 DRY RUN' : '📧 실제 발송'
    return c.json({
      ok: false,
      error: `⏳ 연속 호출 방지 (${modeLabel}): ${remain}초 뒤 다시 시도하세요.`,
      cooldownRemainSec: remain,
      mode: dryRun ? 'dryRun' : 'realSend',
    }, 429)
  }

  const repo = c.env.GITHUB_REPO || DEFAULT_GITHUB_REPO
  const workflow = c.env.GITHUB_WORKFLOW_FILE || DEFAULT_WORKFLOW_FILE
  const dispatchUrl = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`

  try {
    const resp = await fetch(dispatchUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'MorningStockAI-BriefingCenter/2.1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          dry_run: dryRun ? 'true' : 'false',
        },
      }),
    })

    if (resp.status === 204) {
      await saveTrigger(c.env, { timestamp: now, dryRun, ok: true })
      return c.json({
        ok: true,
        dryRun,
        message: dryRun
          ? '✅ DRY RUN 요청됨 — 메일 발송 없이 프리뷰만 생성'
          : '✅ 브리핑 발송 요청됨 — 약 1~3분 뒤 이메일 도착',
        runsUrl: `https://github.com/${repo}/actions/workflows/${workflow}`,
      })
    }

    // 오류 분기
    let detail = ''
    try {
      const errJson = await resp.json()
      detail = errJson.message || JSON.stringify(errJson)
    } catch {
      detail = await resp.text()
    }

    await saveTrigger(c.env, { timestamp: now, dryRun, ok: false })
    return c.json({
      ok: false,
      error: `GitHub API ${resp.status}: ${detail}`,
      hint: resp.status === 401
        ? 'PAT 토큰이 잘못되었거나 만료됨. repo + workflow 권한 확인.'
        : resp.status === 404
        ? `워크플로 파일(${workflow}) 또는 저장소(${repo}) 를 찾을 수 없음.`
        : undefined,
    }, 502)
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? String(e) }, 500)
  }
})

/** 최근 워크플로 실행 조회 (상태 폴링용) */
app.get('/api/admin/recent-runs', async (c) => {
  const token = c.env.GITHUB_TRIGGER_TOKEN
  if (!token) {
    return c.json({ ok: false, error: 'GITHUB_TRIGGER_TOKEN 미설정', runs: [] }, 503)
  }
  const repo = c.env.GITHUB_REPO || DEFAULT_GITHUB_REPO
  const workflow = c.env.GITHUB_WORKFLOW_FILE || DEFAULT_WORKFLOW_FILE

  try {
    const resp = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/runs?per_page=5`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'MorningStockAI-BriefingCenter/2.1',
        },
      }
    )
    if (!resp.ok) {
      return c.json({ ok: false, error: `HTTP ${resp.status}`, runs: [] }, 502)
    }
    const data: any = await resp.json()
    const runs = (data.workflow_runs || []).map((r: any) => ({
      id: r.id,
      status: r.status,          // queued / in_progress / completed
      conclusion: r.conclusion,  // success / failure / null
      event: r.event,
      created_at: r.created_at,
      run_number: r.run_number,
      html_url: r.html_url,
      display_title: r.display_title,
    }))
    return c.json({ ok: true, runs })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? String(e), runs: [] }, 500)
  }
})

/** 새 소스 추가 (사용자 추가는 category=custom 으로 저장) */
app.post('/api/admin/sources', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const label = String(body.label ?? '').trim()
  const url = String(body.url ?? '').trim()
  const rawQueries = Array.isArray(body.queries) ? body.queries : []
  const defaultLimit = Math.max(1, Math.min(10, Number(body.defaultLimit) || 5))

  if (!label || !url) {
    return c.json({ error: 'label 과 url 은 필수입니다.' }, 400)
  }
  if (!/^https?:\/\//i.test(url)) {
    return c.json({ error: 'URL 은 http:// 또는 https:// 로 시작해야 합니다.' }, 400)
  }

  const type = detectSourceType(url)
  const queries: SearchQuery[] = rawQueries
    .map((q: any) => ({
      keyword: String(q.keyword ?? '').trim(),
      limit: Math.max(1, Math.min(10, Number(q.limit) || 3)),
    }))
    .filter((q: SearchQuery) => q.keyword.length > 0)
    .slice(0, 5)

  const list = await loadSources(c.env)
  const newItem: NewsSource = {
    id: 's_' + Date.now().toString(36),
    label,
    category: 'custom',
    type,
    url,
    site: extractSite(url),
    queries,
    defaultLimit,
    enabled: true,
    builtin: false,
    createdAt: new Date().toISOString(),
  }
  list.push(newItem)
  await saveSources(c.env, list)
  return c.json({ ok: true, source: newItem })
})

/** 소스 편집 (label, queries, defaultLimit, site, url, enabled) */
app.patch('/api/admin/sources/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const list = await loadSources(c.env)
  const target = list.find((s) => s.id === id)
  if (!target) return c.json({ error: 'not found' }, 404)

  if (typeof body.enabled === 'boolean') target.enabled = body.enabled
  if (typeof body.label === 'string' && body.label.trim()) target.label = body.label.trim()
  if (typeof body.site === 'string') target.site = body.site.trim() || undefined
  if (typeof body.url === 'string' && body.url.trim()) target.url = body.url.trim()
  if (typeof body.defaultLimit === 'number') {
    target.defaultLimit = Math.max(1, Math.min(10, body.defaultLimit))
  }
  if (Array.isArray(body.queries)) {
    target.queries = body.queries
      .map((q: any) => ({
        keyword: String(q.keyword ?? '').trim(),
        limit: Math.max(1, Math.min(10, Number(q.limit) || 3)),
      }))
      .filter((q: SearchQuery) => q.keyword.length > 0)
      .slice(0, 5)
  }

  await saveSources(c.env, list)
  return c.json({ ok: true, source: target })
})

/** 소스 삭제 */
app.delete('/api/admin/sources/:id', async (c) => {
  const id = c.req.param('id')
  const list = await loadSources(c.env)
  const next = list.filter((s) => s.id !== id)
  if (next.length === list.length) {
    return c.json({ error: 'not found' }, 404)
  }
  await saveSources(c.env, next)
  return c.json({ ok: true })
})

/** 기본값 복원 — 기본 18개 시드 소스를 재주입 (사용자 custom 은 보존) */
app.post('/api/admin/sources/reset-defaults', async (c) => {
  const current = await loadSources(c.env)
  const customOnly = current.filter((s) => s.category === 'custom' && !s.builtin)
  const restored = [...buildSeedSources(), ...customOnly]
  await saveSources(c.env, restored)
  return c.json({ ok: true, count: restored.length })
})

/** 소스 URL/검색어 즉석 테스트 */
app.post('/api/admin/test-source', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const url = String(body.url ?? '').trim()
  const site = String(body.site ?? '').trim()
  const keyword = String(body.keyword ?? '').trim()
  if (!url && !site) return c.json({ error: 'url 또는 site 필요' }, 400)

  // 테스트 URL 결정
  let fetchUrl = url
  let type: SourceType = detectSourceType(url)

  // site + keyword 조합이면 Google News RSS 구성
  if (site) {
    type = 'google_news'
    const siteClean = site.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '')
    const q = keyword ? `site:${siteClean} ${keyword}` : `site:${siteClean}`
    const isKr = /\.(kr|co\.kr)$/i.test(siteClean)
    const lang = isKr ? 'hl=ko&gl=KR&ceid=KR:ko' : 'hl=en-US&gl=US&ceid=US:en'
    fetchUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&${lang}`
  } else if (type === 'youtube') {
    const channelId = extractYouTubeChannelId(url)
    if (channelId) fetchUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
  }

  try {
    const ua = fetchUrl.includes('youtube.com/feeds')
      ? 'feedparser/6.0 +https://github.com/kurtmckee/feedparser'
      : 'Mozilla/5.0 (compatible; MorningStockAI/1.0)'
    const resp = await fetch(fetchUrl, {
      headers: { 'User-Agent': ua, Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9' },
    })
    if (!resp.ok) {
      return c.json({ ok: false, type, fetchUrl, error: `HTTP ${resp.status}` })
    }
    const xml = await resp.text()
    const titles = extractTitles(xml).slice(0, 5)
    return c.json({
      ok: titles.length > 0,
      type,
      fetchUrl,
      sampleCount: titles.length,
      samples: titles,
      message: titles.length > 0
        ? `✅ ${titles.length}건 수집 미리보기 성공`
        : '⚠️ 응답은 받았지만 제목을 찾지 못했습니다.',
    })
  } catch (e: any) {
    return c.json({ ok: false, type, error: e?.message ?? String(e) })
  }
})

function extractYouTubeChannelId(url: string): string | null {
  const m1 = url.match(/youtube\.com\/channel\/([A-Za-z0-9_-]+)/)
  if (m1) return m1[1]
  return null
}

function extractTitles(xml: string): string[] {
  const out: string[] = []
  const re = /<title(?:[^>]*)>([\s\S]*?)<\/title>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    let t = m[1]
    t = t.replace(/<!\[CDATA\[|\]\]>/g, '').trim()
    if (t) out.push(t)
  }
  return out.slice(1)
}

// ─── 이메일 수신자 API ───────────────────────────────────────────────
// (v2.2.7) 자동 백업 헬퍼 — 변경 전 상태를 KV 에 YYYYMMDD 키로 보관 (7일 TTL)
async function backupRecipients(env: Bindings, before: EmailRecipient[]): Promise<void> {
  try {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')  // 20260421
    const key = `recipients:backup:${today}`
    // 같은 날짜에 여러 번 변경하더라도 "그날 첫 변경 직전 상태" 를 유지 (최초 1회만 쓰기)
    const existing = await env.SOURCES_KV.get(key)
    if (!existing) {
      // 7일 TTL — KV 는 최소 60초, 604800초 = 7일
      await env.SOURCES_KV.put(key, JSON.stringify({
        snapshot: before,
        backedUpAt: new Date().toISOString(),
      }), { expirationTtl: 60 * 60 * 24 * 7 })
    }
  } catch (e) {
    // 백업 실패해도 본 작업은 진행 — 로그만 남김
    console.warn('[backupRecipients] 백업 실패 (본 작업은 계속)', e)
  }
}

/** 전체 수신자 목록 조회 */
app.get('/api/admin/recipients', async (c) => {
  const list = await loadRecipients(c.env)
  return c.json({ recipients: list })
})

/** 수신자 신규 등록 */
app.post('/api/admin/recipients', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const email = String(body.email ?? '').trim().toLowerCase()
  const label = String(body.label ?? '').trim()

  if (!email) return c.json({ error: '이메일 주소는 필수입니다.' }, 400)
  if (!isValidEmail(email)) return c.json({ error: '올바른 이메일 주소 형식이 아닙니다.' }, 400)

  const list = await loadRecipients(c.env)
  if (list.some((r) => r.email.toLowerCase() === email)) {
    return c.json({ error: '이미 등록된 이메일입니다.' }, 409)
  }

  await backupRecipients(c.env, list)

  const newItem: EmailRecipient = {
    id: 'r_' + Date.now().toString(36),
    email,
    label: label || undefined,
    enabled: true,
    createdAt: new Date().toISOString(),
    sentCount: 0,
    failedCount: 0,
  }
  list.push(newItem)
  await saveRecipients(c.env, list)
  return c.json({ ok: true, recipient: newItem })
})

/** 수신자 삭제 */
app.delete('/api/admin/recipients/:id', async (c) => {
  const id = c.req.param('id')
  const list = await loadRecipients(c.env)
  const next = list.filter((r) => r.id !== id)
  if (next.length === list.length) return c.json({ error: 'not found' }, 404)
  await backupRecipients(c.env, list)
  await saveRecipients(c.env, next)
  return c.json({ ok: true })
})

/**
 * (v2.2.7) 수신자 편집 — email, label, enabled 모두 수정 가능
 * - email 변경 시 중복 체크 (자기 자신 제외)
 * - 이메일 형식 검증
 * - 변경 시 updatedAt 갱신
 */
app.patch('/api/admin/recipients/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const list = await loadRecipients(c.env)
  const target = list.find((r) => r.id === id)
  if (!target) return c.json({ error: 'not found' }, 404)

  let changed = false

  // 이메일 변경
  if (typeof body.email === 'string') {
    const newEmail = body.email.trim().toLowerCase()
    if (!newEmail) return c.json({ error: '이메일 주소는 비울 수 없습니다.' }, 400)
    if (!isValidEmail(newEmail)) return c.json({ error: '올바른 이메일 주소 형식이 아닙니다.' }, 400)
    if (newEmail !== target.email.toLowerCase()) {
      // 중복 체크 (자기 자신 제외)
      if (list.some((r) => r.id !== id && r.email.toLowerCase() === newEmail)) {
        return c.json({ error: '이미 등록된 이메일입니다.' }, 409)
      }
      target.email = newEmail
      changed = true
    }
  }

  // 별명 변경
  if (typeof body.label === 'string') {
    const newLabel = body.label.trim() || undefined
    if (newLabel !== target.label) {
      target.label = newLabel
      changed = true
    }
  }

  // 활성/비활성 토글
  if (typeof body.enabled === 'boolean' && body.enabled !== target.enabled) {
    target.enabled = body.enabled
    changed = true
  }

  if (changed) {
    target.updatedAt = new Date().toISOString()
    await backupRecipients(c.env, list)
    await saveRecipients(c.env, list)
  }
  return c.json({ ok: true, recipient: target, changed })
})

/**
 * (v2.2.7) 일괄 작업 — 여러 수신자에 대해 한 번에 enable/disable/delete
 * Body: { ids: string[], action: 'enable'|'disable'|'delete' }
 */
app.post('/api/admin/recipients/bulk', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const ids = Array.isArray(body.ids) ? body.ids.map((x: any) => String(x)) : []
  const action = String(body.action ?? '')

  if (ids.length === 0) return c.json({ error: 'ids 배열이 비어있습니다.' }, 400)
  if (!['enable', 'disable', 'delete'].includes(action)) {
    return c.json({ error: `지원하지 않는 action: ${action}` }, 400)
  }

  const list = await loadRecipients(c.env)
  await backupRecipients(c.env, list)

  let affected = 0
  if (action === 'delete') {
    const next = list.filter((r) => {
      if (ids.includes(r.id)) { affected++; return false }
      return true
    })
    await saveRecipients(c.env, next)
    return c.json({ ok: true, action, affected })
  }

  // enable / disable
  const targetEnabled = action === 'enable'
  for (const r of list) {
    if (ids.includes(r.id) && r.enabled !== targetEnabled) {
      r.enabled = targetEnabled
      r.updatedAt = new Date().toISOString()
      affected++
    }
  }
  await saveRecipients(c.env, list)
  return c.json({ ok: true, action, affected })
})

/**
 * (v2.2.7) 수신자 Export — JSON 다운로드
 *   Content-Disposition attachment 로 파일 다운로드 유도
 */
app.get('/api/admin/recipients/export', async (c) => {
  const list = await loadRecipients(c.env)
  const today = new Date().toISOString().slice(0, 10)
  const filename = `recipients_${today}.json`
  const payload = {
    schema: 'msaic-recipients-v1',
    exportedAt: new Date().toISOString(),
    count: list.length,
    recipients: list,
  }
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
})

/**
 * (v2.2.7) 수신자 Import — JSON 업로드로 병합/덮어쓰기
 * Body: { recipients: EmailRecipient[] | string[], mode: 'merge'|'replace' }
 *   - mode=merge (기본): 기존에 없는 이메일만 추가 (중복은 건너뜀)
 *   - mode=replace: 기존 목록 완전 대체 (!위험, 자동 백업 후 수행)
 *   - recipients 항목은 객체 또는 단순 이메일 문자열 허용
 */
app.post('/api/admin/recipients/import', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const mode = String(body.mode ?? 'merge')
  const raw = Array.isArray(body.recipients) ? body.recipients : []
  if (!['merge', 'replace'].includes(mode)) {
    return c.json({ error: `지원하지 않는 mode: ${mode}` }, 400)
  }
  if (raw.length === 0) {
    return c.json({ error: 'recipients 배열이 비어있습니다.' }, 400)
  }

  // 입력 정규화 — 이메일 문자열 또는 객체 모두 수용
  const normalized: EmailRecipient[] = []
  const errors: string[] = []
  for (const item of raw) {
    let email = ''
    let label: string | undefined = undefined
    let enabled = true
    let createdAt = new Date().toISOString()
    if (typeof item === 'string') {
      email = item.trim().toLowerCase()
    } else if (item && typeof item === 'object') {
      email = String(item.email ?? '').trim().toLowerCase()
      if (typeof item.label === 'string' && item.label.trim()) label = item.label.trim()
      if (typeof item.enabled === 'boolean') enabled = item.enabled
      if (typeof item.createdAt === 'string') createdAt = item.createdAt
    }
    if (!email || !isValidEmail(email)) {
      errors.push(`무효 이메일: ${JSON.stringify(item).slice(0, 80)}`)
      continue
    }
    normalized.push({
      id: 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      email, label, enabled, createdAt,
      sentCount: 0, failedCount: 0,
    })
  }

  const current = await loadRecipients(c.env)
  await backupRecipients(c.env, current)

  let added = 0
  let skipped = 0
  let result: EmailRecipient[] = []

  if (mode === 'replace') {
    // 기존 완전 대체 — 중복 이메일만 제거
    const seen = new Set<string>()
    for (const r of normalized) {
      const key = r.email.toLowerCase()
      if (seen.has(key)) { skipped++; continue }
      seen.add(key)
      result.push(r)
      added++
    }
  } else {
    // merge — 기존 이메일은 건드리지 않고 새 이메일만 추가
    result = [...current]
    const existing = new Set(current.map((r) => r.email.toLowerCase()))
    for (const r of normalized) {
      const key = r.email.toLowerCase()
      if (existing.has(key)) { skipped++; continue }
      existing.add(key)
      result.push(r)
      added++
    }
  }

  await saveRecipients(c.env, result)
  return c.json({ ok: true, mode, added, skipped, errors, total: result.length })
})

/**
 * (v2.2.7) 백업 목록 조회 — 최근 7일 날짜별 스냅샷 확인
 */
app.get('/api/admin/recipients/backups', async (c) => {
  const prefix = 'recipients:backup:'
  const listResp = await c.env.SOURCES_KV.list({ prefix })
  const backups = listResp.keys.map((k) => ({
    key: k.name,
    date: k.name.replace(prefix, ''),
    expiration: k.expiration,
  }))
  return c.json({ backups })
})

/** 특정 날짜 백업 내용 보기 */
app.get('/api/admin/recipients/backups/:date', async (c) => {
  const date = c.req.param('date')
  const key = `recipients:backup:${date}`
  const data = await c.env.SOURCES_KV.get(key, 'json')
  if (!data) return c.json({ error: 'not found' }, 404)
  return c.json({ date, ...(data as any) })
})

/** 특정 날짜 백업으로 복원 */
app.post('/api/admin/recipients/backups/:date/restore', async (c) => {
  const date = c.req.param('date')
  const key = `recipients:backup:${date}`
  const data = await c.env.SOURCES_KV.get(key, 'json')
  if (!data) return c.json({ error: 'not found' }, 404)
  const snapshot = (data as any).snapshot
  if (!Array.isArray(snapshot)) return c.json({ error: 'invalid backup' }, 500)

  // 현재 상태를 먼저 백업 (복원 취소용)
  const current = await loadRecipients(c.env)
  await backupRecipients(c.env, current)

  await saveRecipients(c.env, snapshot as EmailRecipient[])
  return c.json({ ok: true, restoredFrom: date, count: snapshot.length })
})

/**
 * (v2.2.7) 발송 이력 이벤트 기록 — Python 메일 모듈이 호출
 * Body: { events: Array<{email, success, reason?, sentAt}> }
 * 공개 API 이지만 BRIEFING_READ_TOKEN 으로 보호 (checkBearer)
 */
app.post('/api/public/recipient-events', async (c) => {
  if (!checkBearer(c)) return c.json({ error: 'unauthorized' }, 401)
  const body = await c.req.json().catch(() => ({}))
  const events = Array.isArray(body.events) ? body.events : []
  if (events.length === 0) return c.json({ ok: true, updated: 0 })

  const list = await loadRecipients(c.env)
  let updated = 0
  for (const ev of events) {
    const email = String(ev.email ?? '').trim().toLowerCase()
    if (!email) continue
    const target = list.find((r) => r.email.toLowerCase() === email)
    if (!target) continue
    const now = String(ev.sentAt ?? new Date().toISOString())
    target.lastAttemptAt = now
    if (ev.success) {
      target.lastSentAt = now
      target.sentCount = (target.sentCount ?? 0) + 1
    } else {
      target.lastFailedAt = now
      target.lastFailedReason = String(ev.reason ?? 'unknown').slice(0, 200)
      target.failedCount = (target.failedCount ?? 0) + 1
    }
    updated++
  }
  if (updated > 0) {
    // 발송 이벤트는 백업 불필요 — 통계 필드만 업데이트
    await c.env.SOURCES_KV.put(KV_KEY_RECIPIENTS, JSON.stringify(list))
  }
  return c.json({ ok: true, updated })
})

// ═════════════════════════════════════════════════════════════
// 5) 공개 API (Python 수집기용) — Bearer 토큰 보호
// ═════════════════════════════════════════════════════════════
function checkBearer(c: any): boolean {
  const expected = c.env.BRIEFING_READ_TOKEN
  if (!expected) return true
  const auth = c.req.header('Authorization') ?? ''
  const token = auth.replace(/^Bearer\s+/i, '')
  return token === expected
}

/** Python 수집기가 호출 — 활성 소스만 반환 (검색어 포함 v2 스키마) */
app.get('/api/public/sources', async (c) => {
  if (!checkBearer(c)) return c.json({ error: 'unauthorized' }, 401)
  const list = await loadSources(c.env)
  return c.json({
    schema: 'v2',
    sources: list.filter((s) => s.enabled),
    generatedAt: new Date().toISOString(),
  })
})

/** Python 이메일 모듈이 호출 — 활성 수신자 이메일만 반환 */
app.get('/api/public/recipients', async (c) => {
  if (!checkBearer(c)) return c.json({ error: 'unauthorized' }, 401)
  const list = await loadRecipients(c.env)
  const emails = list.filter((r) => r.enabled).map((r) => r.email)
  return c.json({
    recipients: emails,
    generatedAt: new Date().toISOString(),
  })
})

app.get('/api/health', (c) =>
  c.json({ ok: true, service: 'Morning Stock AI Briefing Center', version: 'v2.3.1' })
)

export default app
