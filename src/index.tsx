/**
 * 🌅 Morning Stock AI Briefing Center
 * ────────────────────────────────────
 * 매일 아침 06:30 (KST) 주식/반도체 브리핑을 자동 발송하는 파이프라인의
 * '소스·수신자 관리 웹 콘솔' 입니다.
 *
 * [v2.0] 검색어 기반 확장 수집 기능 추가:
 *   - 각 소스마다 '검색어(queries)' 배열을 가질 수 있음
 *   - 검색어가 비어있으면 → 해당 사이트의 최신 뉴스 수집 (기존 동작)
 *   - 검색어가 있으면    → Google News RSS 로 site:xxx "검색어" 조합 검색
 *   - 한 소스에 최대 5개 검색어, 각 검색어별 수집 건수 개별 설정
 *   - 카테고리(kr/us/custom) 분리로 UI 탭 구성 (v2.5.3: yt 제거)
 *   - 최초 접속 시 18개 "기본 시드 소스" 를 KV 에 자동 주입
 */
import { Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { renderer } from './renderer'

// ── 타입 정의 ──────────────────────────────────────────────────────────
type Bindings = {
  SOURCES_KV: KVNamespace
  ADMIN_PASSWORD?: string              // 관리자 로그인 비밀번호
  BRIEFING_READ_TOKEN?: string         // Python 수집기 API 인증 토큰 (소스 목록 조회용)
  BRIEFING_REPORT_TOKEN?: string       // v2.4.0: Python 수집기 → 결과 전송용 인증 토큰
  GITHUB_TRIGGER_TOKEN?: string        // GitHub PAT (repo + workflow 권한) — 지금 발송용
  GITHUB_REPO?: string                 // 예: "wwwkoistkr/2026_04_21_-_-" (기본값 하드코딩)
  GITHUB_WORKFLOW_FILE?: string        // 예: "daily_briefing.yml"
  // (v2.2.7) MailChannels 기반 테스트 발송용 — Cloudflare 에서 바로 보낼 때 사용
  EMAIL_SENDER?: string                // 발신자 Gmail 주소 (GitHub Secret 과 동일)
  EMAIL_APP_PASSWORD?: string          // 참조용 (Cloudflare Worker 에서는 SMTP 불가)
}

// v2.5.3: youtube 타입 제거 (서비스 정책상 유튜브 소스 미지원)
type SourceType = 'rss' | 'google_news' | 'web'
type SourceCategory = 'kr' | 'us' | 'custom'

/** 개별 검색어 질의 */
interface SearchQuery {
  keyword: string   // 예: "반도체", "HBM", "Fed"
  limit: number     // 이 키워드로 수집할 개수 (1~10)
}

/** 뉴스 소스 (확장된 스키마 v2) */
interface NewsSource {
  id: string                 // 고유 ID
  label: string              // 사용자에게 보일 이름
  category: SourceCategory   // kr / us / custom  (v2.5.3: yt 제거)
  type: SourceType           // rss / google_news / web  (v2.5.3: youtube 제거)
  url: string                // (type=rss/web 일 때) 직접 URL
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
const KV_KEY_DRYRUN_HISTORY = 'trigger:dryrun:hist'  // v2.3.2: DRY RUN 시간당 10회 제한용 실행 타임스탬프 배열
const KV_KEY_SYNC_VERSION = 'sync:version'     // PC ↔ 모바일 실시간 동기화용 카운터
// v2.4.0: 수집 진행/결과 추적용 키
const KV_KEY_RUN_PROGRESS = 'runs:in_progress'  // 진행 중 스냅샷 (DRY RUN 폴링용)
const KV_KEY_LATEST_RUN = 'runs:latest'         // 가장 최근 완료 실행 결과
const KV_KEY_RUN_HISTORY = 'runs:history'       // 최근 N건 이력 (최대 10건)
const RUN_HISTORY_MAX = 10

// v2.6.0: 3단계 분리 파이프라인(Phase 2)용 중간 상태 저장 키
// 실행일자(KST 기준) 별로 collect/summarize 결과를 분리 저장.
//   - pipeline:state:YYYYMMDD = { stage, collectedAt, summarizedAt, sentAt, stats }
//   - pipeline:collected:YYYYMMDD = [ {source,title,link,summary}, ... ]    (raw news)
//   - pipeline:summary:YYYYMMDD  = markdown 요약 전체 (UTF-8 문자열)
// TTL 72시간 — 주말/휴일에 재실행해도 복구 가능하도록.
const KV_KEY_PIPELINE_STATE_PREFIX   = 'pipeline:state:'
const KV_KEY_PIPELINE_COLLECTED_PFX  = 'pipeline:collected:'
const KV_KEY_PIPELINE_SUMMARY_PFX    = 'pipeline:summary:'
const PIPELINE_STATE_TTL_SEC = 72 * 3600  // 72h
const SESSION_COOKIE = 'msaic_session'
// (v2.2.7) 12시간 → 2시간으로 단축. 사용자 요구 "첫 화면에 비밀번호"
// 를 만족시키기 위함. 자주 사용하는 사용자는 모바일 PWA에 저장된 비밀번호로
// 바로 로그인되므로 UX 저하는 미미함.
const SESSION_TTL_SEC = 60 * 60 * 2            // 2시간
const DEFAULT_RECIPIENT = 'wwwkoistkr@gmail.com'

// 지금 발송 기본 설정 (Secret 없으면 기본값 사용)
const DEFAULT_GITHUB_REPO = 'wwwkoistkr/2026_04_21_-_-'
const DEFAULT_WORKFLOW_FILE = 'daily_briefing.yml'
// v2.3.2: 이중 쿨다운 시스템 — DRY RUN(테스트용)은 짧게, 실제 발송은 안전하게
// DRY RUN은 메일 발송을 하지 않으므로 빈번한 테스트 허용. 실제 워크플로 실행은 ~2분 소요되어
// 연속 호출해도 실제 동시 실행은 발생하지 않음.
const DRY_RUN_COOLDOWN_SEC = 30                 // 테스트용 DRY RUN: 30초 (실행 ~2분이라 사실상 연타 불가)
const REAL_SEND_COOLDOWN_SEC = 300              // 실제 발송: 5분 (수신자 스팸 처리 방지)
// 하위 호환: trigger-status 응답에 기본값으로 REAL 쿨다운 노출
const TRIGGER_COOLDOWN_SEC = REAL_SEND_COOLDOWN_SEC
// v2.3.2: DRY RUN 시간당 10회 제한 — GitHub Actions 월 2,000분 무료 쿼터 보호
// 1회당 ~1.5분 소요 → 시간당 10회면 월 최대 450분 (25%) 사용
const DRY_RUN_HOURLY_LIMIT = 10
const DRY_RUN_WINDOW_MS = 60 * 60 * 1000  // 1시간 슬라이딩 윈도우

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

    // ── v2.5.3: 유튜브 소스 제거됨 ──
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

/** URL 을 자동 판별해서 type 을 결정한다. (v2.5.3: youtube 제거) */
function detectSourceType(url: string): SourceType {
  const u = url.toLowerCase().trim()
  // 유튜브 URL은 사용자 편의를 위해 RSS로 폴백 (실제 수집은 Python 수집기에서 처리 안 함)
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
// (v2.4.0) favicon — 콘솔 404 제거 (PWA 아이콘 재사용)
// ═════════════════════════════════════════════════════════════
app.get('/favicon.ico', (c) => c.redirect('/static/icons/favicon-32.png', 302))

// ═════════════════════════════════════════════════════════════
// (v2.4.0) 편의용 별칭 경로 — 404 방지
//   /admin, /dashboard, /home 등 흔히 시도하는 경로를 루트로 리다이렉트
// ═════════════════════════════════════════════════════════════
app.get('/admin', (c) => c.redirect('/', 302))
app.get('/admin/', (c) => c.redirect('/', 302))
app.get('/dashboard', (c) => c.redirect('/', 302))
app.get('/home', (c) => c.redirect('/', 302))
app.get('/index', (c) => c.redirect('/', 302))
app.get('/index.html', (c) => c.redirect('/', 302))

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
                Daily Briefing Admin v2.6.0
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
              매일 <strong>06:30 KST</strong> 자동 발송 · 모바일 설치 가능 (홈 화면 추가)
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
              매일 06:30 KST 스케줄과 별도로, <strong>지금 바로</strong> 최신 뉴스를 수집·요약·이메일 발송합니다.
            </p>
            <p class="text-[11px] text-gray-500 mt-1 flex items-center gap-1.5 flex-wrap">
              <span class="inline-flex items-center px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded font-medium"><i class="fa-regular fa-clock mr-0.5"></i>예상 5~9분</span>
              <span>뉴스 수집 ~2분 → <strong>AI 요약 ~5분</strong> (병목, 15건) → 발송 ~30초 · v2.9.10 솔직 시간</span>
            </p>
            <div id="triggerStatus" class="hidden mt-3 p-3 rounded-lg text-xs sm:text-sm"></div>
          </div>
        </div>
        {/* v2.3.2: 버튼 + 하단 슬라이드바 하이브리드 (옵션 A+C)
              - 옵션 A: 버튼 내부 하단의 얇은 프로그레스 바 (버튼과 일체형)
              - 옵션 C: 버튼 아래 독립적인 두꺼운 슬라이드 바 + 카운트다운 텍스트
              - 모바일 우선 반응형: 세로 스택 → 데스크톱에서 가로 */}
        <div class="flex flex-col sm:flex-row gap-2 mt-4 sm:mt-3 sm:ml-16">
          {/* 🚀 실제 발송 버튼 (주황색) */}
          <div class="flex-1 sm:flex-initial">
            <button id="btnTriggerNow"
              class="cooldown-btn touch-target relative overflow-hidden w-full px-4 py-3 sm:py-2.5 bg-gradient-to-r from-orange-500 to-amber-500 text-white font-semibold rounded-lg hover:from-orange-600 hover:to-amber-600 transition shadow-sm"
              data-mode="realSend">
              <span class="btn-label relative z-10"><i class="fa-solid fa-paper-plane mr-1"></i>🚀 지금 발송</span>
              <span class="btn-countdown hidden ml-1 text-xs opacity-90 relative z-10"></span>
              {/* 옵션 A: 버튼 내부 하단 프로그레스 바 (실제 발송 = 주황색) */}
              <span class="cooldown-inner-bar absolute bottom-0 left-0 h-[3px] bg-white/80 transition-[width] duration-1000 ease-linear" style="width: 0%"></span>
            </button>
          </div>
          {/* 🧪 DRY RUN 버튼 (파란색 계열) */}
          <div class="flex-1 sm:flex-initial">
            <button id="btnTriggerDryRun"
              class="cooldown-btn touch-target relative overflow-hidden w-full px-4 py-3 sm:py-2.5 bg-white border border-blue-300 text-blue-700 font-medium rounded-lg hover:bg-blue-50 transition"
              data-mode="dryRun">
              <span class="btn-label relative z-10"><i class="fa-solid fa-flask mr-1"></i>DRY RUN (미리보기)</span>
              <span class="btn-countdown hidden ml-1 text-xs opacity-90 relative z-10"></span>
              {/* 옵션 A: 버튼 내부 하단 프로그레스 바 (DRY RUN = 파란색) */}
              <span class="cooldown-inner-bar absolute bottom-0 left-0 h-[3px] bg-blue-500 transition-[width] duration-1000 ease-linear" style="width: 0%"></span>
            </button>
          </div>
          {/* 🔄 최근 실행 상태 확인 */}
          <button id="btnCheckTriggerStatus"
            class="touch-target px-4 py-3 sm:py-2.5 bg-white border border-gray-300 text-gray-600 text-sm rounded-lg hover:bg-gray-50 transition" title="최근 워크플로 실행 상태 확인">
            <i class="fa-solid fa-rotate"></i>
          </button>
          {/* 🚨 v2.3.2: 관리자 강제 쿨다운 해제 (긴급용) */}
          <button id="btnResetCooldown"
            class="touch-target px-4 py-3 sm:py-2.5 bg-white border border-rose-300 text-rose-600 text-sm rounded-lg hover:bg-rose-50 transition"
            title="긴급 상황용: 쿨다운을 즉시 해제합니다">
            <i class="fa-solid fa-unlock"></i>
            <span class="hidden sm:inline ml-1">강제 해제</span>
          </button>
        </div>

        {/* 옵션 C: 버튼 아래 독립 슬라이드바 (DRY RUN 전용, 카운트다운 중에만 표시) */}
        <div id="dryRunCooldownBar" class="cooldown-slide-container hidden mt-3 sm:ml-16">
          <div class="flex items-center gap-2 text-xs sm:text-sm text-blue-700 mb-1">
            <i class="fa-solid fa-flask text-blue-500"></i>
            <span class="font-medium">🧪 DRY RUN 쿨다운</span>
            <span class="ml-auto font-mono font-bold" id="dryRunCooldownText">0:30</span>
          </div>
          <div class="relative h-2 sm:h-[10px] bg-blue-100 rounded-full overflow-hidden shadow-inner">
            <div id="dryRunCooldownFill"
              class="cooldown-slide-fill absolute top-0 left-0 h-full rounded-full transition-[width] duration-1000 ease-linear"
              style="width: 0%; background: linear-gradient(90deg, #3b82f6 0%, #60a5fa 100%); box-shadow: 0 0 8px rgba(59, 130, 246, 0.5);"></div>
          </div>
        </div>

        {/* 옵션 C: 실제 발송 전용 독립 슬라이드바 */}
        <div id="realSendCooldownBar" class="cooldown-slide-container hidden mt-3 sm:ml-16">
          <div class="flex items-center gap-2 text-xs sm:text-sm text-orange-700 mb-1">
            <i class="fa-solid fa-paper-plane text-orange-500"></i>
            <span class="font-medium">📧 실제 발송 쿨다운 (수신자 보호)</span>
            <span class="ml-auto font-mono font-bold" id="realSendCooldownText">5:00</span>
          </div>
          <div class="relative h-2 sm:h-[10px] bg-orange-100 rounded-full overflow-hidden shadow-inner">
            <div id="realSendCooldownFill"
              class="cooldown-slide-fill absolute top-0 left-0 h-full rounded-full transition-[width] duration-1000 ease-linear"
              style="width: 0%; background: linear-gradient(90deg, #f97316 0%, #fb923c 100%); box-shadow: 0 0 8px rgba(249, 115, 22, 0.5);"></div>
          </div>
        </div>

        {/* v2.3.2: 이중 쿨다운 안내 + v2.3.2: 시간당 제한 정보 */}
        <div class="mt-3 sm:ml-16 text-[11px] sm:text-xs text-gray-500 leading-relaxed">
          <div>
            <i class="fa-solid fa-circle-info mr-1 text-gray-400"></i>
            <strong>쿨다운 정책 (v2.3.2):</strong>
            🧪 DRY RUN = <strong class="text-blue-600">30초</strong> (테스트 반복)  ·
            📧 실제 발송 = <strong class="text-orange-600">5분</strong> (수신자 보호)
          </div>
          <div class="mt-1" id="dryRunHourlyInfo">
            <i class="fa-solid fa-clock mr-1 text-gray-400"></i>
            <strong>DRY RUN 시간당 한도:</strong>
            <span id="dryRunHourlyCountText" class="font-mono">0/10</span> 회 사용
            <span class="text-gray-400">(GitHub Actions 쿼터 보호)</span>
          </div>
        </div>
      </section>

      {/* 🔄 v2.6.0: 3단계 파이프라인 상태 카드 */}
      <section class="bg-gradient-to-br from-slate-50 to-indigo-50 border-2 border-indigo-200 rounded-2xl shadow p-4 sm:p-6 mb-6">
        <div class="flex items-start justify-between gap-3 mb-3 flex-wrap">
          <div class="flex items-start gap-3">
            <div class="flex-shrink-0 text-2xl sm:text-3xl">🔄</div>
            <div>
              <h2 class="text-base sm:text-lg font-bold text-gray-800">
                오늘의 파이프라인 상태 (v2.6.0)
              </h2>
              <p class="text-xs sm:text-sm text-gray-600 mt-0.5">
                <strong>Collect → Summarize → Send</strong> 3단계 중 어디까지 진행됐는지 실시간으로 확인합니다.
                실패한 단계만 선택해 재실행할 수 있습니다.
              </p>
            </div>
          </div>
          <button id="btnPipelineRefresh"
            class="touch-target px-3 py-2 text-xs bg-white border border-indigo-300 text-indigo-700 rounded-lg hover:bg-indigo-50 transition">
            <i class="fa-solid fa-rotate mr-1"></i>새로고침
          </button>
        </div>

        {/* 3단계 스테이지 타일 */}
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3" id="pipelineStages">
          {/* 초기 상태 — JS 가 덮어쓰기 */}
          <div class="stage-tile bg-white border border-gray-200 rounded-lg p-3" data-stage="collect">
            <div class="flex items-center justify-between mb-1">
              <span class="text-xs font-semibold text-gray-500">① Collect</span>
              <span class="stage-badge text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">pending</span>
            </div>
            <div class="text-xs text-gray-700 stage-info">수집 대기 중…</div>
            <button class="stage-rerun mt-2 hidden w-full text-[11px] px-2 py-1 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded hover:bg-indigo-100">
              <i class="fa-solid fa-play mr-1"></i>이 단계 재실행
            </button>
          </div>
          <div class="stage-tile bg-white border border-gray-200 rounded-lg p-3" data-stage="summarize">
            <div class="flex items-center justify-between mb-1">
              <span class="text-xs font-semibold text-gray-500">② Summarize</span>
              <span class="stage-badge text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">pending</span>
            </div>
            <div class="text-xs text-gray-700 stage-info">요약 대기 중…</div>
            <button class="stage-rerun mt-2 hidden w-full text-[11px] px-2 py-1 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded hover:bg-indigo-100">
              <i class="fa-solid fa-play mr-1"></i>이 단계 재실행
            </button>
          </div>
          <div class="stage-tile bg-white border border-gray-200 rounded-lg p-3" data-stage="send">
            <div class="flex items-center justify-between mb-1">
              <span class="text-xs font-semibold text-gray-500">③ Send</span>
              <span class="stage-badge text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">pending</span>
            </div>
            <div class="text-xs text-gray-700 stage-info">발송 대기 중…</div>
            <button class="stage-rerun mt-2 hidden w-full text-[11px] px-2 py-1 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded hover:bg-indigo-100">
              <i class="fa-solid fa-play mr-1"></i>이 단계 재실행
            </button>
          </div>
        </div>

        <div class="mt-3 text-[11px] sm:text-xs text-gray-500 leading-relaxed">
          <i class="fa-solid fa-circle-info mr-1 text-indigo-400"></i>
          <strong>단계별 실행 팁:</strong>
          <span class="text-gray-700">수집(AI 호출 0회)</span> 실패 시 재실행해도 할당량 소모 없음.
          <span class="text-gray-700">요약</span>이 실패하면 <strong>다음날 09:00 KST</strong>(Gemini 쿼터 리셋) 이후 재실행 권장.
        </div>
      </section>

      {/* 📊 v2.4.0: 수집 대시보드 — 마지막 실행 결과 + 소스별 건강도 */}
      <section class="bg-white border border-gray-200 rounded-2xl shadow p-4 sm:p-6 mb-6">
        <div class="flex items-start justify-between gap-3 mb-4 flex-wrap">
          <div class="flex items-start gap-3">
            <div class="flex-shrink-0 text-2xl sm:text-3xl">📊</div>
            <div>
              <h2 class="text-base sm:text-lg font-bold text-gray-800">
                수집 대시보드 — 에이전트 진행 상황
              </h2>
              <p class="text-xs sm:text-sm text-gray-600 mt-1">
                각 사이트별 수집 결과를 표로 확인합니다. 마지막 실행 기준으로 <strong>소스별 건수·상태·소요 시간</strong>을 보여줍니다.
              </p>
            </div>
          </div>
          <div class="flex items-center gap-2">
            {/* Phase 4: DRY-RUN 근실시간 폴링 토글 */}
            <label class="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none" title="DRY-RUN 실행 중이면 10초마다 부분 결과를 자동 갱신">
              <input id="dashLiveToggle" type="checkbox" class="w-4 h-4 accent-sky-500" />
              <i class="fa-solid fa-satellite-dish text-sky-500"></i>
              <span>실시간</span>
            </label>
            <button id="btnDashRefresh"
              class="touch-target px-3 py-2 bg-white border border-gray-300 text-gray-700 text-xs rounded-lg hover:bg-gray-50 transition"
              title="지금 새로고침">
              <i class="fa-solid fa-rotate"></i>
              <span class="hidden sm:inline ml-1">새로고침</span>
            </button>
          </div>
        </div>

        {/* 상단 요약 카드 (4개) */}
        <div id="dashSummary" class="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3 mb-4">
          <div class="bg-gradient-to-br from-sky-50 to-blue-50 border border-sky-200 rounded-lg p-3">
            <div class="text-[10px] sm:text-xs text-sky-700 font-medium uppercase tracking-wide">마지막 실행</div>
            <div id="dashLastRun" class="text-sm sm:text-base font-bold text-gray-800 mt-1">—</div>
            <div id="dashLastRunAgo" class="text-[10px] sm:text-xs text-gray-500 mt-0.5">데이터 없음</div>
          </div>
          <div class="bg-gradient-to-br from-emerald-50 to-green-50 border border-emerald-200 rounded-lg p-3">
            <div class="text-[10px] sm:text-xs text-emerald-700 font-medium uppercase tracking-wide">수집 건수</div>
            <div id="dashTotalItems" class="text-lg sm:text-2xl font-bold text-emerald-700 mt-1">—</div>
            <div id="dashTotalItemsSub" class="text-[10px] sm:text-xs text-gray-500 mt-0.5">목표 대비</div>
          </div>
          <div class="bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-200 rounded-lg p-3">
            <div class="text-[10px] sm:text-xs text-amber-700 font-medium uppercase tracking-wide">성공 소스</div>
            <div id="dashSuccessSources" class="text-lg sm:text-2xl font-bold text-amber-700 mt-1">—</div>
            <div id="dashSuccessSourcesSub" class="text-[10px] sm:text-xs text-gray-500 mt-0.5">전체 중</div>
          </div>
          <div class="bg-gradient-to-br from-purple-50 to-indigo-50 border border-purple-200 rounded-lg p-3">
            <div class="text-[10px] sm:text-xs text-purple-700 font-medium uppercase tracking-wide">소요 시간</div>
            <div id="dashDuration" class="text-lg sm:text-2xl font-bold text-purple-700 mt-1">—</div>
            <div id="dashDurationSub" class="text-[10px] sm:text-xs text-gray-500 mt-0.5">수집 단계</div>
          </div>
        </div>

        {/* DRY-RUN 진행 중 배지 */}
        <div id="dashLiveBadge" class="hidden mb-3 p-2.5 rounded-lg bg-sky-50 border border-sky-200 text-xs sm:text-sm text-sky-800">
          <i class="fa-solid fa-satellite-dish mr-1 text-sky-600 animate-pulse"></i>
          <strong>DRY-RUN 실행 중</strong> — <span id="dashLiveProgressText">소스 수집 대기 중…</span>
        </div>

        {/* 소스별 테이블 */}
        <div class="overflow-x-auto -mx-4 sm:mx-0">
          <table class="min-w-full text-xs sm:text-sm border-collapse">
            <thead>
              <tr class="bg-gray-50 border-b border-gray-200 text-gray-600">
                <th class="py-2 px-2 sm:px-3 text-left font-medium whitespace-nowrap">상태</th>
                <th class="py-2 px-2 sm:px-3 text-left font-medium">소스</th>
                <th class="py-2 px-2 sm:px-3 text-left font-medium whitespace-nowrap hidden sm:table-cell">타입</th>
                <th class="py-2 px-2 sm:px-3 text-right font-medium whitespace-nowrap">수집/목표</th>
                <th class="py-2 px-2 sm:px-3 text-right font-medium whitespace-nowrap hidden md:table-cell">소요</th>
                <th class="py-2 px-2 sm:px-3 text-left font-medium hidden lg:table-cell">메모</th>
              </tr>
            </thead>
            <tbody id="dashSourceTableBody">
              <tr>
                <td colspan={6} class="py-6 text-center text-gray-400 text-sm">
                  <i class="fa-solid fa-spinner fa-spin mr-2"></i>
                  데이터를 불러오는 중…
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* 최근 실행 히스토리 (접기) */}
        <details class="mt-4 group">
          <summary class="cursor-pointer text-xs sm:text-sm text-gray-600 hover:text-gray-800 select-none">
            <i class="fa-solid fa-clock-rotate-left mr-1"></i>
            최근 실행 이력 (최대 10건)
            <i class="fa-solid fa-chevron-down ml-1 text-[10px] group-open:rotate-180 transition-transform"></i>
          </summary>
          <div id="dashHistoryList" class="mt-3 space-y-2 text-xs sm:text-sm">
            <div class="text-gray-400 text-center py-3">이력 없음</div>
          </div>
        </details>
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

      {/* v2.9.4: 사용자 직접 점수 입력 + AI 자가점수 비교 + 7일 추이 + 금지어 통계 */}
      <section class="bg-gradient-to-br from-amber-50 to-yellow-50 border-2 border-amber-200 rounded-2xl shadow p-4 sm:p-6 mb-6">
        <div class="flex items-start gap-3 sm:gap-4 mb-4">
          <div class="flex-shrink-0 text-3xl sm:text-4xl pt-1">📊</div>
          <div class="flex-1 min-w-0">
            <h2 class="text-base sm:text-lg font-bold text-gray-800">
              오늘 받은 메일 품질 평가 <span class="text-xs font-normal text-gray-500">(v2.9.6)</span>
            </h2>
            <p class="text-xs sm:text-sm text-gray-600 mt-1">
              0~100 점으로 직접 평가해 주세요. AI 자가점수와 비교해 1주일 후 시스템 개선 방향을 결정합니다.
            </p>
          </div>
        </div>

        {/* 입력 영역 */}
        <div class="bg-white rounded-xl p-4 mb-4 border border-amber-200">
          <div class="flex flex-col gap-3">
            {/* 날짜 + 점수 슬라이더 */}
            <div class="flex flex-col sm:flex-row gap-3 sm:items-center">
              <label class="text-sm font-medium text-gray-700 sm:w-20">평가 날짜</label>
              <input id="userScoreDate" type="date"
                class="touch-target px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400" />
            </div>
            <div class="flex flex-col gap-2">
              <div class="flex items-center justify-between">
                <label class="text-sm font-medium text-gray-700">메일 품질 점수</label>
                <div class="flex items-center gap-2">
                  <input id="userScoreNumber" type="number" min="0" max="100" step="1" value="80"
                    class="w-20 px-2 py-1 border border-gray-300 rounded text-center font-bold text-lg" />
                  <span class="text-sm text-gray-500">/ 100</span>
                </div>
              </div>
              <input id="userScoreSlider" type="range" min="0" max="100" step="1" value="80"
                class="w-full h-2 bg-gradient-to-r from-red-300 via-yellow-300 to-green-400 rounded-lg appearance-none cursor-pointer" />
              <div class="flex justify-between text-xs text-gray-500">
                <span>0 (매우 나쁨)</span>
                <span>50 (보통)</span>
                <span>100 (완벽)</span>
              </div>
            </div>

            {/* 약점 축 체크박스 (선택) */}
            <div class="flex flex-col gap-1">
              <span class="text-sm font-medium text-gray-700">약점 (선택, 복수 가능)</span>
              <div class="flex flex-wrap gap-2">
                <label class="flex items-center gap-1 px-2 py-1 bg-gray-100 rounded-full text-xs cursor-pointer hover:bg-gray-200">
                  <input type="checkbox" class="user-score-axis" value="정확성" /> 정확성
                </label>
                <label class="flex items-center gap-1 px-2 py-1 bg-gray-100 rounded-full text-xs cursor-pointer hover:bg-gray-200">
                  <input type="checkbox" class="user-score-axis" value="시의성" /> 시의성
                </label>
                <label class="flex items-center gap-1 px-2 py-1 bg-gray-100 rounded-full text-xs cursor-pointer hover:bg-gray-200">
                  <input type="checkbox" class="user-score-axis" value="심층성" /> 심층성
                </label>
                <label class="flex items-center gap-1 px-2 py-1 bg-gray-100 rounded-full text-xs cursor-pointer hover:bg-gray-200">
                  <input type="checkbox" class="user-score-axis" value="명료성" /> 명료성
                </label>
                <label class="flex items-center gap-1 px-2 py-1 bg-gray-100 rounded-full text-xs cursor-pointer hover:bg-gray-200">
                  <input type="checkbox" class="user-score-axis" value="실행가능성" /> 실행가능성
                </label>
              </div>
            </div>

            {/* 코멘트 */}
            <div class="flex flex-col gap-1">
              <label class="text-sm font-medium text-gray-700">코멘트 <span class="text-xs text-gray-400">(선택, 500자 이내)</span></label>
              <textarea id="userScoreComment" rows="2" maxLength="500"
                placeholder="예: 미국 뉴스 7건 중 1건이 광고성, 한국 부분은 양호"
                class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400 text-sm"></textarea>
            </div>

            {/* v2.9.6: 상태 배지 (신규 입력 / 저장됨) */}
            <div id="userScoreBadge" class="hidden text-xs font-semibold px-2 py-1 rounded-full self-start"></div>

            <div class="flex flex-wrap gap-2 mt-2">
              {/* v2.9.6.1: 🆕 신규 입력 — 폼 전체 초기화 + 오늘 날짜로 세팅 */}
              <button id="btnUserScoreNew" title="폼을 비우고 오늘 날짜로 새로 입력 시작"
                class="touch-target px-4 py-2.5 bg-gradient-to-r from-blue-500 to-indigo-500 text-white font-semibold rounded-lg hover:from-blue-600 hover:to-indigo-600 transition shadow-sm">
                <i class="fa-solid fa-plus mr-1"></i> 🆕 신규 입력
              </button>
              <button id="btnUserScoreSave"
                class="touch-target flex-1 min-w-[140px] px-4 py-2.5 bg-gradient-to-r from-amber-500 to-yellow-500 text-white font-semibold rounded-lg hover:from-amber-600 hover:to-yellow-600 transition shadow-sm">
                <i class="fa-solid fa-floppy-disk mr-1"></i> 점수 저장
              </button>
              <button id="btnUserScoreReload" title="현재 날짜 점수 다시 불러오기"
                class="touch-target px-3 py-2.5 bg-white border border-amber-300 text-amber-700 font-medium rounded-lg hover:bg-amber-50 transition">
                <i class="fa-solid fa-rotate"></i>
              </button>
              {/* v2.9.6: 삭제 버튼 (저장된 기록만 활성화됨) */}
              <button id="btnUserScoreDelete" title="이 날짜 점수 삭제" disabled
                class="touch-target px-3 py-2.5 bg-white border border-red-300 text-red-600 font-medium rounded-lg hover:bg-red-50 transition disabled:opacity-40 disabled:cursor-not-allowed">
                <i class="fa-solid fa-trash"></i>
              </button>
            </div>
            <div id="userScoreStatus" class="hidden text-sm p-2 rounded-lg"></div>
          </div>
        </div>

        {/* AI 자가점수 vs 사용자 점수 비교 카드 + 7일 그래프 */}
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
          <div class="bg-white rounded-xl p-3 border border-gray-200">
            <div class="text-xs text-gray-500">오늘 사용자 점수</div>
            <div id="todayUserScore" class="text-3xl font-bold text-amber-600">—</div>
          </div>
          <div class="bg-white rounded-xl p-3 border border-gray-200">
            <div class="text-xs text-gray-500">오늘 AI 자가점수 (자가/전문가)</div>
            <div id="todayAiScore" class="text-3xl font-bold text-blue-600">—</div>
          </div>
          <div class="bg-white rounded-xl p-3 border border-gray-200">
            <div class="text-xs text-gray-500">7일 평균 차이 (AI − 사용자)</div>
            <div id="scoreGap" class="text-3xl font-bold text-purple-600">—</div>
            <div class="text-xs text-gray-400">+ 면 AI 가 후함, − 면 박함</div>
          </div>
        </div>

        {/* v2.9.5: 현재 적용 중인 강화 지침 패널 */}
        <div id="reinforcePanel" class="hidden bg-gradient-to-r from-rose-50 to-pink-50 rounded-xl p-3 border border-rose-200 mb-4">
          <div class="flex items-start gap-2">
            <i class="fa-solid fa-gears text-rose-500 mt-0.5"></i>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-semibold text-rose-700">
                🔁 내일 Stage 2 에 적용될 강화 지침 <span class="text-xs font-normal text-rose-500">(v2.9.5)</span>
              </div>
              <div id="reinforceDetail" class="text-xs text-rose-600 mt-1 leading-relaxed">
                {/* JS 가 채움 */}
              </div>
            </div>
          </div>
        </div>

        {/* 7일 추이 그래프 */}
        <div class="bg-white rounded-xl p-3 border border-gray-200 mb-4">
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-sm font-semibold text-gray-700">📈 최근 7일 점수 추이</h3>
            <span id="userScoreSummary" class="text-xs text-gray-500"></span>
          </div>
          <div style="position:relative;height:240px">
            <canvas id="userScoreChart"></canvas>
          </div>
        </div>

        {/* 금지어 통계 (중립 톤) */}
        <details class="bg-white rounded-xl p-3 border border-gray-200">
          <summary class="cursor-pointer text-sm font-semibold text-gray-700">
            📊 분석 표현 사용 통계 <span class="text-xs font-normal text-gray-500">(7일 누적, 참고용)</span>
          </summary>
          <div id="forbiddenStatsBody" class="mt-3 text-xs text-gray-700">
            <div class="text-gray-400">로딩 중…</div>
          </div>
        </details>
      </section>

      {/* ① 이메일 수신자 관리 */}
      <section class="bg-white rounded-2xl shadow p-4 sm:p-6 mb-6">
        <h2 class="text-base sm:text-lg font-bold text-gray-800 mb-4">
          <i class="fa-solid fa-envelope text-emerald-500 mr-2"></i>
          ① 매일 아침 브리핑을 받을 이메일 주소
        </h2>
        <p class="text-xs sm:text-sm text-gray-500 mb-4">
          여기 등록된 모든 이메일로 <strong>매일 06:30 KST</strong> 브리핑이 발송됩니다.
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
          {/* v2.5.3: 유튜브 탭 제거됨 */}
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
        <p>Morning Stock AI Briefing Center <span class="font-semibold">v2.6.0</span></p>
        <p class="mt-1">매일 06:30 KST · GitHub Actions · 모바일 홈 화면 추가 지원</p>
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

      <script src="/static/admin.js?v=2.9.6.4"></script>
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

// ─────────────────────────────────────────────────────────────
// v2.3.2: DRY RUN 시간당 제한 — 최근 1시간 실행 타임스탬프 배열 관리
// ─────────────────────────────────────────────────────────────
async function getDryRunHistory(env: Bindings): Promise<number[]> {
  const raw = await env.SOURCES_KV.get(KV_KEY_DRYRUN_HISTORY, 'json')
  if (!Array.isArray(raw)) return []
  // 1시간 이전 기록은 제거 (슬라이딩 윈도우)
  const cutoff = Date.now() - DRY_RUN_WINDOW_MS
  return (raw as number[]).filter((ts) => typeof ts === 'number' && ts > cutoff)
}

async function recordDryRun(env: Bindings): Promise<void> {
  const history = await getDryRunHistory(env)
  history.push(Date.now())
  // 최근 20건만 유지 (10회 제한이므로 여유 10건)
  const trimmed = history.slice(-20)
  await env.SOURCES_KV.put(KV_KEY_DRYRUN_HISTORY, JSON.stringify(trimmed))
}

/** 시간당 제한 검사 결과 */
interface DryRunLimitInfo {
  count: number           // 최근 1시간 실행 횟수
  limit: number           // 허용 한도 (10)
  remaining: number       // 남은 횟수
  resetInMs: number       // 가장 오래된 기록이 만료되기까지 남은 시간 (1번 슬롯 회복 시점)
  blocked: boolean        // true 이면 한도 초과로 차단
}

async function checkDryRunLimit(env: Bindings): Promise<DryRunLimitInfo> {
  const history = await getDryRunHistory(env)
  const now = Date.now()
  const count = history.length
  const remaining = Math.max(0, DRY_RUN_HOURLY_LIMIT - count)
  // 가장 오래된 기록 만료 시점까지 남은 시간 (이후 1번 슬롯 회복)
  const oldest = history.length > 0 ? Math.min(...history) : now
  const resetInMs = Math.max(0, oldest + DRY_RUN_WINDOW_MS - now)
  return {
    count,
    limit: DRY_RUN_HOURLY_LIMIT,
    remaining,
    resetInMs,
    blocked: count >= DRY_RUN_HOURLY_LIMIT,
  }
}

/** 현재 지금-발송 기능 설정 상태 조회 (v2.3.2: 이중 쿨다운 + 시간당 제한 반영) */
app.get('/api/admin/trigger-status', async (c) => {
  const hasToken = !!c.env.GITHUB_TRIGGER_TOKEN
  const repo = c.env.GITHUB_REPO || DEFAULT_GITHUB_REPO
  const workflow = c.env.GITHUB_WORKFLOW_FILE || DEFAULT_WORKFLOW_FILE
  const last = await getLastTrigger(c.env)
  const now = Date.now()

  // v2.3.2: DRY RUN 과 실제 발송 각각 남은 쿨다운 계산
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

  // v2.3.2: DRY RUN 시간당 제한 정보
  const dryRunLimit = await checkDryRunLimit(c.env)

  return c.json({
    configured: hasToken,
    repo,
    workflow,
    // v2.3.2 이중 쿨다운 정보
    dryRunCooldownSec: DRY_RUN_COOLDOWN_SEC,
    realSendCooldownSec: REAL_SEND_COOLDOWN_SEC,
    dryRunRemainMs,
    realSendRemainMs,
    // v2.3.2 시간당 제한 정보
    dryRunHourlyLimit: DRY_RUN_HOURLY_LIMIT,
    dryRunHourlyCount: dryRunLimit.count,
    dryRunHourlyRemaining: dryRunLimit.remaining,
    dryRunHourlyResetInMs: dryRunLimit.resetInMs,
    dryRunHourlyBlocked: dryRunLimit.blocked,
    // 하위 호환: 실제 발송 기준 값
    cooldownSec: TRIGGER_COOLDOWN_SEC,
    cooldownRemainMs: realSendRemainMs,
    last,
  })
})

/**
 * v2.3.2: 관리자 강제 쿨다운 해제 API
 * - 긴급 상황(잘못된 트리거, 테스트 중 실수 등)에 사용
 * - 쿨다운과 DRY RUN 시간당 카운터를 모두 초기화
 * - 관리자 세션 (adminSessionMiddleware) 으로 보호됨 — 이 라우터는 이미 /api/admin/* 전체에 적용
 */
app.post('/api/admin/reset-cooldown', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const resetCooldown = body.resetCooldown !== false  // 기본 true
    const resetHourlyLimit = body.resetHourlyLimit === true  // 기본 false (명시적 요청 시만)

    const actions: string[] = []

    if (resetCooldown) {
      await c.env.SOURCES_KV.delete(KV_KEY_LAST_TRIGGER)
      actions.push('쿨다운 초기화 (DRY RUN 30초 / 실제 발송 5분 모두 해제)')
    }

    if (resetHourlyLimit) {
      await c.env.SOURCES_KV.delete(KV_KEY_DRYRUN_HISTORY)
      actions.push('DRY RUN 시간당 카운터 초기화 (10/10 으로 복구)')
    }

    return c.json({
      ok: true,
      message: '✅ 강제 해제 완료',
      actions,
      timestamp: Date.now(),
    })
  } catch (e: any) {
    return c.json({
      ok: false,
      error: `강제 해제 실패: ${e?.message ?? String(e)}`,
    }, 500)
  }
})

// ═════════════════════════════════════════════════════════════
// 📊 v2.4.0: 수집 진행/결과 대시보드 API
// ═════════════════════════════════════════════════════════════

/** Python → Cloudflare 리포터용 Bearer 인증 검사 */
function checkReportToken(c: any): { ok: boolean; reason?: string } {
  const expected = c.env.BRIEFING_REPORT_TOKEN
  if (!expected) {
    return { ok: false, reason: 'BRIEFING_REPORT_TOKEN 미설정 (Cloudflare Secret 에 등록 필요)' }
  }
  const auth = c.req.header('authorization') || ''
  const m = auth.match(/^Bearer\s+(.+)$/i)
  if (!m) return { ok: false, reason: 'Authorization 헤더에 Bearer 토큰 필요' }
  if (m[1] !== expected) return { ok: false, reason: '토큰 불일치' }
  return { ok: true }
}

/** 수집 실행 결과 공통 타입 (KV 저장 스키마) */
interface RunKeywordResult {
  keyword: string
  target: number
  actual: number
  elapsed: number  // seconds
  status: 'ok' | 'partial' | 'failed' | 'skipped'
  error?: string
}
interface RunSourceResult {
  id: string
  label: string
  category: string
  type: string
  site: string
  keywords: RunKeywordResult[]
  totalTarget: number
  totalActual: number
  elapsedSec: number
  status: 'ok' | 'partial' | 'failed' | 'skipped'
  finishedAt: number
}
interface RunProgressRecord {
  runId: string
  startedAt: number
  finishedAt?: number
  updatedAt?: number
  durationSec?: number
  status: 'in_progress' | 'ok' | 'partial' | 'failed' | 'skipped'
  dryRun: boolean
  totalSources?: number
  sources: RunSourceResult[]
  totalTarget: number
  totalActual: number
  finalCountAfterDedup?: number | null
  error?: string | null
}

/**
 * v2.4.0: Python 수집기가 소스 처리 직후 부분 결과를 보고 (준실시간).
 * 인증: Bearer BRIEFING_REPORT_TOKEN
 * 저장: KV_KEY_RUN_PROGRESS (5분 TTL)
 */
app.post('/api/public/record-run-progress', async (c) => {
  const auth = checkReportToken(c)
  if (!auth.ok) {
    return c.json({ ok: false, error: `인증 실패: ${auth.reason}` }, 401)
  }
  try {
    const body = (await c.req.json()) as RunProgressRecord
    if (!body || !body.runId) {
      return c.json({ ok: false, error: 'runId 필수' }, 400)
    }
    // 5분 TTL 로 진행 중 스냅샷 저장 (DRY RUN 최대 실행 시간의 2~3배)
    await c.env.SOURCES_KV.put(
      KV_KEY_RUN_PROGRESS,
      JSON.stringify(body),
      { expirationTtl: 300 },
    )
    return c.json({ ok: true, runId: body.runId })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? String(e) }, 500)
  }
})

/**
 * v2.4.0: Python 수집기가 수집 완료 후 최종 결과를 보고.
 * 인증: Bearer BRIEFING_REPORT_TOKEN
 * 저장: KV_KEY_LATEST_RUN (영구) + KV_KEY_RUN_HISTORY (최근 10건)
 */
app.post('/api/public/record-run-result', async (c) => {
  const auth = checkReportToken(c)
  if (!auth.ok) {
    return c.json({ ok: false, error: `인증 실패: ${auth.reason}` }, 401)
  }
  try {
    const body = (await c.req.json()) as RunProgressRecord
    if (!body || !body.runId) {
      return c.json({ ok: false, error: 'runId 필수' }, 400)
    }

    // 최종 결과 저장
    await c.env.SOURCES_KV.put(KV_KEY_LATEST_RUN, JSON.stringify(body))

    // 이력 갱신 (최대 10건)
    const histRaw = await c.env.SOURCES_KV.get(KV_KEY_RUN_HISTORY, 'json')
    const history: RunProgressRecord[] = Array.isArray(histRaw) ? (histRaw as any) : []
    history.unshift(body)  // 최신이 앞
    const trimmed = history.slice(0, RUN_HISTORY_MAX)
    await c.env.SOURCES_KV.put(KV_KEY_RUN_HISTORY, JSON.stringify(trimmed))

    // 진행 중 스냅샷 삭제 (완료됐으므로)
    await c.env.SOURCES_KV.delete(KV_KEY_RUN_PROGRESS)

    return c.json({ ok: true, runId: body.runId, historyCount: trimmed.length })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? String(e) }, 500)
  }
})

/**
 * v2.4.0: 관리 UI 전용 — 최근 완료 실행 결과 조회.
 *  inProgress 가 있으면 함께 반환 (DRY RUN 중 표시용)
 */
app.get('/api/admin/latest-run', async (c) => {
  const latest = await c.env.SOURCES_KV.get(KV_KEY_LATEST_RUN, 'json')
  const inProgress = await c.env.SOURCES_KV.get(KV_KEY_RUN_PROGRESS, 'json')
  const reportTokenConfigured = !!c.env.BRIEFING_REPORT_TOKEN
  return c.json({
    ok: true,
    latest: latest ?? null,
    inProgress: inProgress ?? null,
    reportTokenConfigured,
    serverTime: Date.now(),
  })
})

/** v2.4.0: 최근 N건 이력 */
app.get('/api/admin/run-history', async (c) => {
  const n = Math.max(1, Math.min(RUN_HISTORY_MAX, parseInt(c.req.query('n') ?? '10', 10) || 10))
  const raw = await c.env.SOURCES_KV.get(KV_KEY_RUN_HISTORY, 'json')
  const history: RunProgressRecord[] = Array.isArray(raw) ? (raw as any).slice(0, n) : []
  return c.json({ ok: true, count: history.length, history })
})

// ═════════════════════════════════════════════════════════════
// 🔄 v2.6.0: 3단계 파이프라인(Phase 2) — collect → summarize → send
// ═════════════════════════════════════════════════════════════
/**
 * 설계 배경
 * --------
 * 기존 main.py 는 "수집→AI요약→발송"을 한 번에 돌려서 15분 제한에 걸리거나,
 * AI 요약에서 실패하면 이전 수집 결과도 함께 날아갔다.
 * v2.6.0 부터는 GitHub Actions 를 3 단계로 분리하고, 각 단계 결과를
 * KV 에 저장해 "다음 단계만 재시도" 가능하게 한다.
 *
 *  단계       | KV 키 prefix              | 쓰는 쪽        | 읽는 쪽
 *  ----------|---------------------------|---------------|------------------
 *  collect   | pipeline:collected:YYMMDD | 01_collect.yml | 02_summarize.yml
 *  summarize | pipeline:summary:YYMMDD   | 02_summarize   | 03_send.yml
 *  status    | pipeline:state:YYMMDD     | 모든 단계       | 관리 UI
 *
 * 모든 저장 API 는 BRIEFING_REPORT_TOKEN 으로 인증.
 * 관리 UI 용 조회 API 는 /api/admin/* 로 노출.
 */

/** 오늘 날짜(KST) 를 YYYYMMDD 문자열로 반환 (파이프라인 키에 사용). */
function kstDateKey(d: Date = new Date()): string {
  const kst = new Date(d.getTime() + 9 * 3600 * 1000)
  const y = kst.getUTCFullYear()
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0')
  const day = String(kst.getUTCDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

type PipelineStage = 'collect' | 'summarize' | 'send'
type PipelineStageStatus = 'pending' | 'in_progress' | 'ok' | 'failed' | 'skipped'

interface PipelineState {
  date: string                        // YYYYMMDD (KST)
  stages: {
    collect:   { status: PipelineStageStatus; at?: number; count?: number; error?: string }
    summarize: { status: PipelineStageStatus; at?: number; chars?: number;  error?: string }
    send:      { status: PipelineStageStatus; at?: number; recipients?: number; error?: string }
  }
  updatedAt: number
}

/** 초기/기본 상태 */
function emptyPipelineState(date: string): PipelineState {
  return {
    date,
    stages: {
      collect:   { status: 'pending' },
      summarize: { status: 'pending' },
      send:      { status: 'pending' },
    },
    updatedAt: Date.now(),
  }
}

/**
 * v2.6.0: 수집 단계가 완료되면 수집 결과(뉴스 리스트)를 KV 에 저장.
 * 인증: Bearer BRIEFING_REPORT_TOKEN
 * Body: { date?: "YYYYMMDD", news: [{source,title,link,summary}, ...] }
 *        date 생략 시 KST 오늘.
 */
app.post('/api/public/pipeline/collected', async (c) => {
  const auth = checkReportToken(c)
  if (!auth.ok) return c.json({ ok: false, error: `인증 실패: ${auth.reason}` }, 401)

  try {
    const body = await c.req.json() as { date?: string; news?: any[] }
    const date = (body.date && /^\d{8}$/.test(body.date)) ? body.date : kstDateKey()
    const news = Array.isArray(body.news) ? body.news : []

    if (news.length === 0) {
      return c.json({ ok: false, error: 'news 배열이 비었습니다' }, 400)
    }

    // 수집 결과 저장 (72h TTL)
    await c.env.SOURCES_KV.put(
      KV_KEY_PIPELINE_COLLECTED_PFX + date,
      JSON.stringify(news),
      { expirationTtl: PIPELINE_STATE_TTL_SEC },
    )

    // 상태 업데이트
    const stateKey = KV_KEY_PIPELINE_STATE_PREFIX + date
    const prev = await c.env.SOURCES_KV.get(stateKey, 'json') as PipelineState | null
    const state = prev ?? emptyPipelineState(date)
    state.stages.collect = { status: 'ok', at: Date.now(), count: news.length }
    state.updatedAt = Date.now()
    await c.env.SOURCES_KV.put(stateKey, JSON.stringify(state),
      { expirationTtl: PIPELINE_STATE_TTL_SEC })

    return c.json({ ok: true, date, count: news.length })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? String(e) }, 500)
  }
})

/**
 * v2.6.0: 요약 단계에서 수집 결과 읽어가기.
 * 인증: Bearer BRIEFING_READ_TOKEN (수집기가 소스 목록 가져올 때 쓰는 토큰 재사용)
 * 쿼리: ?date=YYYYMMDD (생략 시 KST 오늘)
 */
app.get('/api/public/pipeline/collected', async (c) => {
  const expected = c.env.BRIEFING_READ_TOKEN
  const auth = c.req.header('authorization') || ''
  const m = auth.match(/^Bearer\s+(.+)$/i)
  if (!expected || !m || m[1] !== expected) {
    return c.json({ ok: false, error: '인증 실패 (Bearer BRIEFING_READ_TOKEN 필요)' }, 401)
  }

  const date = (c.req.query('date') || '').match(/^\d{8}$/) ? c.req.query('date')! : kstDateKey()
  const news = await c.env.SOURCES_KV.get(KV_KEY_PIPELINE_COLLECTED_PFX + date, 'json')
  if (!news) {
    return c.json({ ok: false, error: `수집 데이터 없음 (date=${date})` }, 404)
  }
  return c.json({ ok: true, date, count: (news as any[]).length, news })
})

/**
 * v2.6.0: 요약 단계 완료 시 마크다운 결과를 저장.
 * 인증: Bearer BRIEFING_REPORT_TOKEN
 * Body: { date?: "YYYYMMDD", markdown: "...", meta?: {...} }
 */
app.post('/api/public/pipeline/summary', async (c) => {
  const auth = checkReportToken(c)
  if (!auth.ok) return c.json({ ok: false, error: `인증 실패: ${auth.reason}` }, 401)

  try {
    const body = await c.req.json() as { date?: string; markdown?: string; error?: string }
    const date = (body.date && /^\d{8}$/.test(body.date)) ? body.date : kstDateKey()

    const stateKey = KV_KEY_PIPELINE_STATE_PREFIX + date
    const prev = await c.env.SOURCES_KV.get(stateKey, 'json') as PipelineState | null
    const state = prev ?? emptyPipelineState(date)

    if (body.error) {
      state.stages.summarize = { status: 'failed', at: Date.now(), error: String(body.error).slice(0, 500) }
    } else if (body.markdown && body.markdown.length > 0) {
      await c.env.SOURCES_KV.put(
        KV_KEY_PIPELINE_SUMMARY_PFX + date,
        body.markdown,
        { expirationTtl: PIPELINE_STATE_TTL_SEC },
      )
      state.stages.summarize = { status: 'ok', at: Date.now(), chars: body.markdown.length }
    } else {
      return c.json({ ok: false, error: 'markdown 또는 error 필드 필요' }, 400)
    }

    state.updatedAt = Date.now()
    await c.env.SOURCES_KV.put(stateKey, JSON.stringify(state),
      { expirationTtl: PIPELINE_STATE_TTL_SEC })

    return c.json({ ok: true, date, chars: body.markdown?.length ?? 0 })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? String(e) }, 500)
  }
})

/**
 * v2.6.0: 발송 단계에서 요약 결과 읽어가기.
 * 인증: Bearer BRIEFING_READ_TOKEN
 */
app.get('/api/public/pipeline/summary', async (c) => {
  const expected = c.env.BRIEFING_READ_TOKEN
  const auth = c.req.header('authorization') || ''
  const m = auth.match(/^Bearer\s+(.+)$/i)
  if (!expected || !m || m[1] !== expected) {
    return c.json({ ok: false, error: '인증 실패 (Bearer BRIEFING_READ_TOKEN 필요)' }, 401)
  }

  const date = (c.req.query('date') || '').match(/^\d{8}$/) ? c.req.query('date')! : kstDateKey()
  const markdown = await c.env.SOURCES_KV.get(KV_KEY_PIPELINE_SUMMARY_PFX + date)
  if (!markdown) {
    return c.json({ ok: false, error: `요약 데이터 없음 (date=${date})` }, 404)
  }
  return c.json({ ok: true, date, chars: markdown.length, markdown })
})

/**
 * v2.6.0: 발송 완료/실패 기록.
 * 인증: Bearer BRIEFING_REPORT_TOKEN
 */
app.post('/api/public/pipeline/send', async (c) => {
  const auth = checkReportToken(c)
  if (!auth.ok) return c.json({ ok: false, error: `인증 실패: ${auth.reason}` }, 401)

  try {
    const body = await c.req.json() as { date?: string; recipients?: number; error?: string }
    const date = (body.date && /^\d{8}$/.test(body.date)) ? body.date : kstDateKey()

    const stateKey = KV_KEY_PIPELINE_STATE_PREFIX + date
    const prev = await c.env.SOURCES_KV.get(stateKey, 'json') as PipelineState | null
    const state = prev ?? emptyPipelineState(date)

    if (body.error) {
      state.stages.send = { status: 'failed', at: Date.now(), error: String(body.error).slice(0, 500) }
    } else {
      state.stages.send = {
        status: 'ok', at: Date.now(),
        recipients: typeof body.recipients === 'number' ? body.recipients : 0,
      }
    }
    state.updatedAt = Date.now()
    await c.env.SOURCES_KV.put(stateKey, JSON.stringify(state),
      { expirationTtl: PIPELINE_STATE_TTL_SEC })

    return c.json({ ok: true, date, state: state.stages.send })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? String(e) }, 500)
  }
})

// ───────────────────────────────────────────────────────────────────────
// v2.9.2 (2026-04-25): 발송 락(Lock) + 재시도 통계 엔드포인트
// 목적: Stage 3 가 Stage 2 완료를 기다리며 4회 재시도 + 동시 발송 방지.
// ───────────────────────────────────────────────────────────────────────
const KV_KEY_PIPELINE_LOCK_PFX = 'pipeline:lock:'        // pipeline:lock:YYYYMMDD
const KV_KEY_PIPELINE_RETRY_PFX = 'pipeline:retry:'      // pipeline:retry:YYYYMMDD
const PIPELINE_LOCK_TTL_DEFAULT = 300  // 5분 (락 자동 만료)

// ───────────────────────────────────────────────────────────────────────
// v2.9.4 (2026-04-25): 사용자 점수 입력 + 금지어 통계 KV prefix
// 목적:
//   1) 사용자가 매일 메일 품질을 0~100점으로 직접 평가 → AI 자가점수와 비교
//   2) AI 가 사용한 금지어 표현 빈도를 통계로만 기록 (드랍하지 않음)
// 보관 기간: 90일 (분석 + 추이 그래프용)
// ───────────────────────────────────────────────────────────────────────
const KV_KEY_USER_SCORE_PFX     = 'user_score:'          // user_score:YYYYMMDD
const KV_KEY_FORBIDDEN_STATS_PFX = 'forbidden_stats:'    // forbidden_stats:YYYYMMDD
const USER_SCORE_TTL_SEC        = 86400 * 90  // 90일 보관

/**
 * v2.9.5: Stage 2 가 호출할 사용자 피드백 신호 조회 (public, BRIEFING_READ_TOKEN).
 * GET /api/public/feedback/signal?days=7
 * 응답:
 *   {
 *     ok, days, samples,             // 점수가 입력된 일수
 *     avgScore,                       // 최근 N일 평균 점수 (samples 가 0 이면 null)
 *     weakAxesTop: ["정확성", ...],   // 가장 빈번한 약점 (최대 3개, 빈도 내림차순)
 *     weakAxesCounts: { "정확성": 5, "심층성": 3 },
 *     reinforce: boolean              // avgScore < 80 이고 samples >= 2 일 때 true
 *                                     // → Stage 2 가 프롬프트에 강화 지침 주입할지 결정
 *   }
 * 인증 실패 시 401, 데이터 없음(샘플 0개)도 200 으로 정상 응답 (reinforce=false).
 */
app.get('/api/public/feedback/signal', async (c) => {
  const expected = c.env.BRIEFING_READ_TOKEN
  const auth = c.req.header('authorization') || ''
  const m = auth.match(/^Bearer\s+(.+)$/i)
  if (!expected || !m || m[1] !== expected) {
    return c.json({ ok: false, error: '인증 실패 (Bearer BRIEFING_READ_TOKEN 필요)' }, 401)
  }

  const days = Math.max(1, Math.min(30, Number(c.req.query('days') || 7)))
  const today = kstDateKey()
  const y = Number(today.slice(0, 4))
  const mo = Number(today.slice(4, 6)) - 1
  const d = Number(today.slice(6, 8))
  const todayDate = new Date(Date.UTC(y, mo, d))

  // 어제부터 거꾸로 N일 (오늘은 아직 입력 전이므로 제외)
  const dates: string[] = []
  for (let i = 1; i <= days; i++) {
    const dt = new Date(todayDate.getTime() - i * 86400_000)
    const ymd = dt.getUTCFullYear().toString().padStart(4, '0')
      + (dt.getUTCMonth() + 1).toString().padStart(2, '0')
      + dt.getUTCDate().toString().padStart(2, '0')
    dates.push(ymd)
  }

  const records: Array<{ score: number; weakAxes?: string[] }> = []
  await Promise.all(dates.map(async (date) => {
    const raw = await c.env.SOURCES_KV.get(KV_KEY_USER_SCORE_PFX + date)
    if (!raw) return
    try {
      const r = JSON.parse(raw) as UserScore
      if (typeof r.score === 'number') {
        records.push({ score: r.score, weakAxes: r.weakAxes })
      }
    } catch {}
  }))

  const samples = records.length
  let avgScore: number | null = null
  const weakAxesCounts: Record<string, number> = {}
  if (samples > 0) {
    avgScore = Math.round(records.reduce((s, r) => s + r.score, 0) / samples)
    for (const r of records) {
      for (const ax of r.weakAxes || []) {
        weakAxesCounts[ax] = (weakAxesCounts[ax] || 0) + 1
      }
    }
  }
  const weakAxesTop = Object.entries(weakAxesCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => k)

  // 강화 지침 주입 조건: 평균 점수 80 미만 + 샘플 2개 이상 (1개는 통계적 의미 부족)
  const reinforce = !!(avgScore !== null && avgScore < 80 && samples >= 2)

  return c.json({
    ok: true,
    days,
    samples,
    avgScore,
    weakAxesTop,
    weakAxesCounts,
    reinforce,
  })
})

/**
 * v2.9.2: 발송 락 상태 조회 (점유 중인지 확인).
 * GET /api/public/pipeline/lock?date=YYYYMMDD
 */
app.get('/api/public/pipeline/lock', async (c) => {
  const auth = checkReportToken(c)
  if (!auth.ok) return c.json({ ok: false, error: `인증 실패: ${auth.reason}` }, 401)

  try {
    const date = (c.req.query('date') || '').match(/^\d{8}$/)
      ? c.req.query('date')!
      : kstDateKey()
    const lockKey = KV_KEY_PIPELINE_LOCK_PFX + date
    const value = await c.env.SOURCES_KV.get(lockKey, 'json') as
      | { owner: string; acquiredAt: number; ttl: number }
      | null

    if (!value) {
      return c.json({ ok: true, locked: false, date }, 404)
    }
    return c.json({
      ok: true,
      locked: true,
      date,
      owner: value.owner,
      acquiredAt: value.acquiredAt,
      ttl: value.ttl,
    })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? String(e) }, 500)
  }
})

/**
 * v2.9.2: 발송 락 획득.
 * POST /api/public/pipeline/lock  body: { date, owner, ttl? }
 */
app.post('/api/public/pipeline/lock', async (c) => {
  const auth = checkReportToken(c)
  if (!auth.ok) return c.json({ ok: false, error: `인증 실패: ${auth.reason}` }, 401)

  try {
    const body = await c.req.json() as { date?: string; owner?: string; ttl?: number }
    const date = (body.date && /^\d{8}$/.test(body.date)) ? body.date : kstDateKey()
    const owner = String(body.owner || 'unknown').slice(0, 100)
    const ttl = Math.max(60, Math.min(900, body.ttl ?? PIPELINE_LOCK_TTL_DEFAULT))

    const lockKey = KV_KEY_PIPELINE_LOCK_PFX + date
    await c.env.SOURCES_KV.put(
      lockKey,
      JSON.stringify({ owner, acquiredAt: Date.now(), ttl }),
      { expirationTtl: ttl },
    )
    return c.json({ ok: true, date, owner, ttl })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? String(e) }, 500)
  }
})

/**
 * v2.9.2: 발송 락 해제 (정상 발송 완료 후).
 * POST /api/public/pipeline/lock/release  body: { date }
 */
app.post('/api/public/pipeline/lock/release', async (c) => {
  const auth = checkReportToken(c)
  if (!auth.ok) return c.json({ ok: false, error: `인증 실패: ${auth.reason}` }, 401)

  try {
    const body = await c.req.json() as { date?: string }
    const date = (body.date && /^\d{8}$/.test(body.date)) ? body.date : kstDateKey()
    const lockKey = KV_KEY_PIPELINE_LOCK_PFX + date
    await c.env.SOURCES_KV.delete(lockKey)
    return c.json({ ok: true, date, released: true })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? String(e) }, 500)
  }
})

/**
 * v2.9.2: 재시도 통계 기록.
 * POST /api/public/pipeline/retry_stats  body: { date, attempts, success, stage }
 * 목적: 재시도 패턴을 추적해 v3.0 cron 시간 결정에 활용.
 */
app.post('/api/public/pipeline/retry_stats', async (c) => {
  const auth = checkReportToken(c)
  if (!auth.ok) return c.json({ ok: false, error: `인증 실패: ${auth.reason}` }, 401)

  try {
    const body = await c.req.json() as {
      date?: string; attempts?: number; success?: boolean; stage?: string
    }
    const date = (body.date && /^\d{8}$/.test(body.date)) ? body.date : kstDateKey()
    const attempts = Math.max(0, Math.min(10, body.attempts ?? 0))
    const success = !!body.success
    const stage = String(body.stage || 'send').slice(0, 50)

    const statsKey = KV_KEY_PIPELINE_RETRY_PFX + date
    const stat = { date, stage, attempts, success, recordedAt: Date.now() }
    await c.env.SOURCES_KV.put(statsKey, JSON.stringify(stat),
      { expirationTtl: 86400 * 30 })  // 30일 보관 (분석용)
    return c.json({ ok: true, ...stat })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? String(e) }, 500)
  }
})

// ═══════════════════════════════════════════════════════════════════════
// v2.9.4 (2026-04-25): 사용자 점수 입력 시스템
// ─────────────────────────────────────────────────────────────────────
// 목적: AI 자가평가의 편향(self-preference bias)을 보완하기 위해
//       사용자가 매일 받은 메일을 직접 0~100점으로 평가하고
//       1주일 추이 + AI 자가점수와의 비교를 대시보드에서 확인.
// ═══════════════════════════════════════════════════════════════════════

interface UserScore {
  date: string                  // YYYYMMDD
  score: number                 // 0~100
  comment?: string              // 자유 코멘트 (선택)
  weakAxes?: string[]           // 약점 축 체크박스 (정확성/시의성/심층성/명료성/실행가능성)
  aiScoreSelf?: number          // AI 자가점수 (있으면 비교용)
  aiScoreExpert?: number        // AI 전문가 점수 (있으면 비교용)
  recordedAt: number
  updatedAt?: number
}

/**
 * v2.9.4: 사용자 점수 등록/수정 (관리자 보호).
 * POST /api/admin/user-score
 *   body: { date?: YYYYMMDD, score: 0~100, comment?, weakAxes?: string[] }
 * 같은 날짜 재호출 시 덮어쓰기 (수정).
 */
app.post('/api/admin/user-score', async (c) => {
  try {
    const body = await c.req.json() as {
      date?: string
      score?: number
      comment?: string
      weakAxes?: string[]
    }
    const date = (body.date && /^\d{8}$/.test(body.date)) ? body.date : kstDateKey()
    // 점수: 0~100 hard clamp (사용자 요청)
    const rawScore = Number(body.score)
    if (!Number.isFinite(rawScore)) {
      return c.json({ ok: false, error: '점수가 유효한 숫자여야 합니다.' }, 400)
    }
    const score = Math.max(0, Math.min(100, Math.round(rawScore)))
    const comment = String(body.comment || '').slice(0, 500)
    const weakAxes = Array.isArray(body.weakAxes)
      ? body.weakAxes.filter(x => typeof x === 'string').slice(0, 5)
      : []

    // 같은 날짜 기존 점수 조회 (수정인지 신규인지 판단)
    const key = KV_KEY_USER_SCORE_PFX + date
    const existingRaw = await c.env.SOURCES_KV.get(key)
    let existing: UserScore | null = null
    try { existing = existingRaw ? JSON.parse(existingRaw) as UserScore : null } catch {}

    // 같은 날 AI 자가점수가 있으면 함께 저장 (비교용)
    // pipeline:summary:YYYYMMDD 에 BRIEFING_SCORE 주석이 들어있을 수 있음
    let aiScoreSelf: number | undefined
    let aiScoreExpert: number | undefined
    try {
      const summary = await c.env.SOURCES_KV.get(KV_KEY_PIPELINE_SUMMARY_PFX + date)
      if (summary) {
        const m = /<!--\s*BRIEFING_SCORE:\s*self=(\d+)\s+expert=(\d+)/.exec(summary)
        if (m) {
          aiScoreSelf = Number(m[1])
          aiScoreExpert = Number(m[2])
        }
      }
    } catch {}

    const now = Date.now()
    const record: UserScore = {
      date,
      score,
      comment: comment || undefined,
      weakAxes: weakAxes.length ? weakAxes : undefined,
      aiScoreSelf: aiScoreSelf ?? existing?.aiScoreSelf,
      aiScoreExpert: aiScoreExpert ?? existing?.aiScoreExpert,
      recordedAt: existing?.recordedAt ?? now,
      updatedAt: existing ? now : undefined,
    }

    await c.env.SOURCES_KV.put(key, JSON.stringify(record),
      { expirationTtl: USER_SCORE_TTL_SEC })

    return c.json({ ok: true, record, isUpdate: !!existing })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? String(e) }, 500)
  }
})

/**
 * v2.9.4: 단일 날짜 점수 조회 (관리자).
 * GET /api/admin/user-score?date=YYYYMMDD
 */
app.get('/api/admin/user-score', async (c) => {
  const date = (c.req.query('date') || '').match(/^\d{8}$/)
    ? c.req.query('date')! : kstDateKey()
  const raw = await c.env.SOURCES_KV.get(KV_KEY_USER_SCORE_PFX + date)
  if (!raw) return c.json({ ok: true, exists: false, date })
  try {
    const record = JSON.parse(raw) as UserScore
    return c.json({ ok: true, exists: true, record })
  } catch {
    return c.json({ ok: false, error: 'KV 파싱 실패' }, 500)
  }
})

/**
 * v2.9.6: 사용자 점수 삭제.
 * DELETE /api/admin/user-score?date=YYYYMMDD
 *   date 파라미터 누락 시 오늘(KST) 기준.
 *   존재하지 않으면 ok=true, deleted=false 로 응답 (idempotent).
 */
app.delete('/api/admin/user-score', async (c) => {
  const date = (c.req.query('date') || '').match(/^\d{8}$/)
    ? c.req.query('date')! : kstDateKey()
  const key = KV_KEY_USER_SCORE_PFX + date
  const existing = await c.env.SOURCES_KV.get(key)
  if (!existing) {
    return c.json({ ok: true, deleted: false, date })
  }
  await c.env.SOURCES_KV.delete(key)
  return c.json({ ok: true, deleted: true, date })
})

/**
 * v2.9.4: 최근 N일 점수 추이 조회 (대시보드 그래프용).
 * GET /api/admin/user-scores/recent?days=7  (기본 7, 최대 30)
 * 응답:
 *   { ok, days, items: [{ date, score, aiScoreSelf, aiScoreExpert, comment, weakAxes }] }
 *   날짜는 오래된 → 최신 순 (그래프 X축에 그대로 그릴 수 있음).
 */
app.get('/api/admin/user-scores/recent', async (c) => {
  const days = Math.max(1, Math.min(30, Number(c.req.query('days') || 7)))
  const today = kstDateKey()  // YYYYMMDD

  // 오늘부터 거꾸로 N일치 KV 키 조회
  const dates: string[] = []
  // YYYYMMDD → Date 변환
  const y = Number(today.slice(0, 4))
  const m = Number(today.slice(4, 6)) - 1
  const d = Number(today.slice(6, 8))
  const todayDate = new Date(Date.UTC(y, m, d))
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(todayDate.getTime() - i * 86400_000)
    const ymd = dt.getUTCFullYear().toString().padStart(4, '0')
      + (dt.getUTCMonth() + 1).toString().padStart(2, '0')
      + dt.getUTCDate().toString().padStart(2, '0')
    dates.push(ymd)
  }

  const items = await Promise.all(dates.map(async (date) => {
    const raw = await c.env.SOURCES_KV.get(KV_KEY_USER_SCORE_PFX + date)
    if (!raw) {
      // 점수 미입력 → AI 자가점수만이라도 같이 노출
      try {
        const summary = await c.env.SOURCES_KV.get(KV_KEY_PIPELINE_SUMMARY_PFX + date)
        if (summary) {
          const mm = /<!--\s*BRIEFING_SCORE:\s*self=(\d+)\s+expert=(\d+)/.exec(summary)
          if (mm) {
            return {
              date, score: null,
              aiScoreSelf: Number(mm[1]),
              aiScoreExpert: Number(mm[2]),
            }
          }
        }
      } catch {}
      return { date, score: null }
    }
    try {
      const r = JSON.parse(raw) as UserScore
      return {
        date,
        score: r.score,
        aiScoreSelf: r.aiScoreSelf,
        aiScoreExpert: r.aiScoreExpert,
        comment: r.comment,
        weakAxes: r.weakAxes,
      }
    } catch {
      return { date, score: null }
    }
  }))

  // 통계 요약 (입력된 점수만)
  const scored = items.filter(x => x.score !== null && typeof x.score === 'number') as Array<{ score: number; aiScoreSelf?: number }>
  const avg = scored.length ? Math.round(scored.reduce((a, b) => a + b.score, 0) / scored.length) : null
  const aiAvg = (() => {
    const ai = scored.filter(x => typeof x.aiScoreSelf === 'number') as Array<{ aiScoreSelf: number }>
    return ai.length ? Math.round(ai.reduce((a, b) => a + b.aiScoreSelf, 0) / ai.length) : null
  })()
  const min = scored.length ? Math.min(...scored.map(x => x.score)) : null
  const max = scored.length ? Math.max(...scored.map(x => x.score)) : null

  return c.json({
    ok: true,
    days,
    items,
    summary: {
      count: scored.length,
      userAvg: avg,
      aiAvg,
      gap: (avg !== null && aiAvg !== null) ? aiAvg - avg : null,  // AI 가 얼마나 후한지
      min, max,
    },
  })
})

// ═══════════════════════════════════════════════════════════════════════
// v2.9.4 (2026-04-25): 금지어 통계 (드랍 안 함, 통계만 기록)
// ─────────────────────────────────────────────────────────────────────
// Python 측 _is_item_output_valid 가 검출 후 카드는 살리고 통계만 POST.
// ═══════════════════════════════════════════════════════════════════════

interface ForbiddenStat {
  date: string
  totalCards: number          // 그날 생성된 카드 수
  cardsWithForbidden: number  // 금지어 1회 이상 포함 카드 수
  totalHits: number           // 총 금지어 등장 횟수 (모든 카드 합산)
  topPhrases: Array<{ phrase: string; count: number }>  // 빈도 상위 10
  recordedAt: number
}

/**
 * v2.9.4: 금지어 통계 기록 (Python 에서 호출).
 * POST /api/public/pipeline/forbidden_stats
 *   body: { date?, totalCards, cardsWithForbidden, totalHits,
 *           topPhrases?: [{phrase, count}] }
 */
app.post('/api/public/pipeline/forbidden_stats', async (c) => {
  const auth = checkReportToken(c)
  if (!auth.ok) return c.json({ ok: false, error: `인증 실패: ${auth.reason}` }, 401)

  try {
    const body = await c.req.json() as {
      date?: string
      totalCards?: number
      cardsWithForbidden?: number
      totalHits?: number
      topPhrases?: Array<{ phrase: string; count: number }>
    }
    const date = (body.date && /^\d{8}$/.test(body.date)) ? body.date : kstDateKey()
    const stat: ForbiddenStat = {
      date,
      totalCards: Math.max(0, Math.min(50, body.totalCards ?? 0)),
      cardsWithForbidden: Math.max(0, Math.min(50, body.cardsWithForbidden ?? 0)),
      totalHits: Math.max(0, Math.min(500, body.totalHits ?? 0)),
      topPhrases: Array.isArray(body.topPhrases)
        ? body.topPhrases
            .filter(x => x && typeof x.phrase === 'string')
            .slice(0, 10)
            .map(x => ({ phrase: String(x.phrase).slice(0, 50), count: Number(x.count) || 0 }))
        : [],
      recordedAt: Date.now(),
    }
    await c.env.SOURCES_KV.put(
      KV_KEY_FORBIDDEN_STATS_PFX + date,
      JSON.stringify(stat),
      { expirationTtl: USER_SCORE_TTL_SEC }
    )
    return c.json({ ok: true, ...stat })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? String(e) }, 500)
  }
})

/**
 * v2.9.4: 금지어 통계 조회 (관리자 대시보드).
 * GET /api/admin/forbidden-stats/recent?days=7
 */
app.get('/api/admin/forbidden-stats/recent', async (c) => {
  const days = Math.max(1, Math.min(30, Number(c.req.query('days') || 7)))
  const today = kstDateKey()
  const y = Number(today.slice(0, 4))
  const m = Number(today.slice(4, 6)) - 1
  const d = Number(today.slice(6, 8))
  const todayDate = new Date(Date.UTC(y, m, d))

  const dates: string[] = []
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(todayDate.getTime() - i * 86400_000)
    const ymd = dt.getUTCFullYear().toString().padStart(4, '0')
      + (dt.getUTCMonth() + 1).toString().padStart(2, '0')
      + dt.getUTCDate().toString().padStart(2, '0')
    dates.push(ymd)
  }

  const items = await Promise.all(dates.map(async (date) => {
    const raw = await c.env.SOURCES_KV.get(KV_KEY_FORBIDDEN_STATS_PFX + date)
    if (!raw) return { date, totalCards: 0, cardsWithForbidden: 0, totalHits: 0, topPhrases: [] as Array<{phrase:string;count:number}> }
    try { return JSON.parse(raw) as ForbiddenStat }
    catch { return { date, totalCards: 0, cardsWithForbidden: 0, totalHits: 0, topPhrases: [] as Array<{phrase:string;count:number}> } }
  }))

  // 전체 빈도 상위 합산
  const phraseTotals = new Map<string, number>()
  for (const it of items) {
    for (const p of (it.topPhrases || [])) {
      phraseTotals.set(p.phrase, (phraseTotals.get(p.phrase) || 0) + p.count)
    }
  }
  const topOverall = Array.from(phraseTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([phrase, count]) => ({ phrase, count }))

  return c.json({ ok: true, days, items, topOverall })
})

/**
 * v2.6.0: 관리 UI 용 파이프라인 상태 조회.
 * GET /api/admin/pipeline-state?date=YYYYMMDD   (date 생략 시 KST 오늘)
 * 상태, 수집 건수, 요약 글자수, 발송 수신자 수 반환.
 */
app.get('/api/admin/pipeline-state', async (c) => {
  const date = (c.req.query('date') || '').match(/^\d{8}$/) ? c.req.query('date')! : kstDateKey()
  const stateKey = KV_KEY_PIPELINE_STATE_PREFIX + date
  const state = await c.env.SOURCES_KV.get(stateKey, 'json') as PipelineState | null

  // 실제 데이터 존재 여부도 체크 (상태는 있지만 데이터 TTL 만료됐을 수 있음)
  const [collectedRaw, summary] = await Promise.all([
    c.env.SOURCES_KV.get(KV_KEY_PIPELINE_COLLECTED_PFX + date, 'json'),
    c.env.SOURCES_KV.get(KV_KEY_PIPELINE_SUMMARY_PFX + date),
  ])

  return c.json({
    ok: true,
    date,
    state: state ?? emptyPipelineState(date),
    dataAvailable: {
      collected: !!collectedRaw,
      collectedCount: Array.isArray(collectedRaw) ? (collectedRaw as any[]).length : 0,
      summary:   !!summary,
      summaryChars: summary ? (summary as string).length : 0,
    },
    serverTime: Date.now(),
  })
})

/**
 * v2.2.7 수신자 동기화 진단 — "왜 이메일이 특정 사람에게만 가는가" 해결용
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
  // v2.6.0: stage 파라미터 — 'collect' | 'summarize' | 'send' | 'all' (기본 all)
  // 'all' 이면 기존 레거시 워크플로우(daily_briefing.yml) 실행,
  // 그 외는 각각 daily_0{1,2,3}_*.yml 워크플로우를 독립적으로 디스패치.
  const stageRaw = typeof body.stage === 'string' ? body.stage.toLowerCase() : 'all'
  const STAGE_TO_WORKFLOW: Record<string, string> = {
    collect:   'daily_01_collect.yml',
    summarize: 'daily_02_summarize.yml',
    send:      'daily_03_send.yml',
    all:       c.env.GITHUB_WORKFLOW_FILE || DEFAULT_WORKFLOW_FILE,
  }
  const stage = STAGE_TO_WORKFLOW[stageRaw] ? stageRaw : 'all'
  const isStageMode = stage !== 'all'

  // v2.3.2: 이중 쿨다운 체크
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

  // v2.3.2: DRY RUN 시간당 10회 제한 체크 (GitHub Actions 쿼터 보호)
  if (dryRun) {
    const limitInfo = await checkDryRunLimit(c.env)
    if (limitInfo.blocked) {
      const resetMin = Math.ceil(limitInfo.resetInMs / 60_000)
      return c.json({
        ok: false,
        error: `⚠️ DRY RUN 시간당 ${DRY_RUN_HOURLY_LIMIT}회 한도 초과 (${limitInfo.count}/${DRY_RUN_HOURLY_LIMIT}).
${resetMin}분 뒤에 1슬롯 회복됩니다. GitHub Actions 월 무료 쿼터(2,000분) 보호를 위한 제한입니다.`,
        dryRunLimit: limitInfo,
        hint: '긴급 상황이라면 관리 UI의 "쿨다운 강제 해제" 버튼으로 카운터를 초기화할 수 있습니다.',
      }, 429)
    }
  }

  const repo = c.env.GITHUB_REPO || DEFAULT_GITHUB_REPO
  const workflow = STAGE_TO_WORKFLOW[stage]
  const dispatchUrl = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`

  // v2.6.0: stage 모드의 daily_0X_*.yml 워크플로우는 dry_run 입력을 받지 않으므로
  //         스테이지 모드에서는 inputs 를 생략 (send 단계만 예외적으로 dry_run 지원).
  const dispatchInputs: Record<string, string> = {}
  if (stage === 'all' || stage === 'send') {
    dispatchInputs.dry_run = dryRun ? 'true' : 'false'
  }

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
        inputs: dispatchInputs,
      }),
    })

    if (resp.status === 204) {
      // 스테이지 모드일 때는 dryRun/lastTrigger 기록 자체를 가볍게 처리
      await saveTrigger(c.env, { timestamp: now, dryRun, ok: true })
      if (dryRun && !isStageMode) {
        await recordDryRun(c.env)
      }
      const stageLabelKo = ({
        collect: '수집', summarize: '요약', send: '발송', all: '전체',
      } as Record<string, string>)[stage]
      return c.json({
        ok: true,
        dryRun,
        stage,
        message: isStageMode
          ? `✅ ${stageLabelKo} 단계 워크플로우 요청됨 — GitHub Actions 에서 실행 중`
          : (dryRun
              ? '✅ DRY RUN 요청됨 — 메일 발송 없이 프리뷰만 생성'
              : '✅ 브리핑 발송 요청됨 — 약 5~9분 뒤 이메일 도착 (AI 요약 단계가 병목 · v2.9.10)'),
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

    // ── v2.9.7: 422 disabled workflow 자동 복구 ──────────────────────
    // GitHub 는 60일 미커밋 등으로 워크플로우를 자동 비활성화할 수 있다.
    // 422 + "disabled" 키워드 감지 시 → PUT .../enable → 재 dispatch 시도.
    if (resp.status === 422 && detail.toLowerCase().includes('disabled')) {
      const enableUrl = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/enable`
      try {
        const enableResp = await fetch(enableUrl, {
          method: 'PUT',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'MorningStockAI-BriefingCenter/2.1',
          },
        })
        if (enableResp.status === 204) {
          // 활성화 성공 → 1초 대기 후 dispatch 재시도
          await new Promise(r => setTimeout(r, 1000))
          const retryResp = await fetch(dispatchUrl, {
            method: 'POST',
            headers: {
              Accept: 'application/vnd.github+json',
              Authorization: `Bearer ${token}`,
              'X-GitHub-Api-Version': '2022-11-28',
              'User-Agent': 'MorningStockAI-BriefingCenter/2.1',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ ref: 'main', inputs: dispatchInputs }),
          })
          if (retryResp.status === 204) {
            await saveTrigger(c.env, { timestamp: now, dryRun, ok: true })
            if (dryRun && !isStageMode) await recordDryRun(c.env)
            const stageLabelKo = ({
              collect: '수집', summarize: '요약', send: '발송', all: '전체',
            } as Record<string, string>)[stage]
            return c.json({
              ok: true,
              dryRun,
              stage,
              autoEnabled: true,
              message: isStageMode
                ? `✅ 워크플로우 자동 활성화 후 ${stageLabelKo} 단계 요청됨`
                : (dryRun
                    ? '✅ 워크플로우 자동 활성화 후 DRY RUN 요청됨'
                    : '✅ 워크플로우 자동 활성화 후 브리핑 발송 요청됨 — 약 5~9분 뒤 이메일 도착 (v2.9.10)'),
              runsUrl: `https://github.com/${repo}/actions/workflows/${workflow}`,
            })
          }
        }
      } catch (_enableErr) {
        // enable 시도 자체가 실패해도 아래 일반 에러 분기로 폴스루
      }
    }
    // ── /v2.9.7 ──────────────────────────────────────────────────────

    await saveTrigger(c.env, { timestamp: now, dryRun, ok: false })
    return c.json({
      ok: false,
      error: `GitHub API ${resp.status}: ${detail}`,
      hint: resp.status === 401
        ? 'PAT 토큰이 잘못되었거나 만료됨. repo + workflow 권한 확인.'
        : resp.status === 404
        ? `워크플로 파일(${workflow}) 또는 저장소(${repo}) 를 찾을 수 없음.`
        : resp.status === 422
        ? `워크플로(${workflow})가 비활성화 상태입니다. 자동 활성화를 시도했지만 실패했습니다. GitHub → Actions 탭에서 "Enable workflow" 버튼을 눌러 수동으로 활성화하세요. → https://github.com/${repo}/actions`
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

/**
 * 새 소스 추가
 * v2.5.3: category 파라미터 허용 (kr/us/custom). 기본값 'custom'.
 *   이전 버그: 클라이언트가 카테고리를 보내도 서버가 무시하고 무조건 'custom' 저장 →
 *   사용자가 "미국"으로 선택해도 "사용자" 탭에 저장되는 문제.
 */
app.post('/api/admin/sources', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const label = String(body.label ?? '').trim()
  const url = String(body.url ?? '').trim()
  const rawQueries = Array.isArray(body.queries) ? body.queries : []
  const defaultLimit = Math.max(1, Math.min(10, Number(body.defaultLimit) || 5))

  // v2.5.3: 카테고리 화이트리스트 검증 (유튜브 'yt' 제거됨)
  const ALLOWED_CATEGORIES: SourceCategory[] = ['kr', 'us', 'custom']
  const requestedCategory = String(body.category ?? '').trim() as SourceCategory
  const category: SourceCategory = ALLOWED_CATEGORIES.includes(requestedCategory)
    ? requestedCategory
    : 'custom'

  if (!label || !url) {
    return c.json({ error: 'label 과 url 은 필수입니다.' }, 400)
  }
  if (!/^https?:\/\//i.test(url)) {
    return c.json({ error: 'URL 은 http:// 또는 https:// 로 시작해야 합니다.' }, 400)
  }
  // v2.5.3: 유튜브 URL 차단 (서비스 정책)
  if (url.toLowerCase().includes('youtube.com') || url.toLowerCase().includes('youtu.be')) {
    return c.json({ error: '유튜브 소스는 더 이상 지원되지 않습니다.' }, 400)
  }

  // v2.5.3: 클라이언트가 type 을 명시하면 존중, 없으면 자동 판정 폴백
  const ALLOWED_TYPES: SourceType[] = ['rss', 'google_news', 'web']
  const requestedType = String(body.type ?? '').trim() as SourceType
  const type: SourceType = ALLOWED_TYPES.includes(requestedType)
    ? requestedType
    : detectSourceType(url)
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
    category,                  // v2.5.3: 클라이언트 지정값 반영
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
  if (typeof body.url === 'string' && body.url.trim()) {
    const newUrl = body.url.trim()
    // v2.5.3: 유튜브 URL 차단
    if (newUrl.toLowerCase().includes('youtube.com') || newUrl.toLowerCase().includes('youtu.be')) {
      return c.json({ error: '유튜브 소스는 더 이상 지원되지 않습니다.' }, 400)
    }
    target.url = newUrl
  }
  if (typeof body.defaultLimit === 'number') {
    target.defaultLimit = Math.max(1, Math.min(10, body.defaultLimit))
  }
  // v2.5.3: 타입 변경 허용 (rss/google_news/web 만) — 기존 'web' 스킵 소스 복구용
  if (typeof body.type === 'string') {
    const ALLOWED_TYPES: SourceType[] = ['rss', 'google_news', 'web']
    const t = body.type.trim() as SourceType
    if (ALLOWED_TYPES.includes(t)) {
      target.type = t
    }
  }
  // v2.5.3: 카테고리 변경 허용 (kr/us/custom 만)
  if (typeof body.category === 'string') {
    const ALLOWED: SourceCategory[] = ['kr', 'us', 'custom']
    const cat = body.category.trim() as SourceCategory
    if (ALLOWED.includes(cat)) {
      target.category = cat
    }
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
  }
  // v2.5.3: 유튜브 분기 제거됨 (서비스 정책상 유튜브 소스 미지원)

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

// v2.5.3: extractYouTubeChannelId 제거됨 (유튜브 소스 미지원)

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
  c.json({ ok: true, service: 'Morning Stock AI Briefing Center', version: 'v2.6.0' })
)

// ═════════════════════════════════════════════════════════════
// (v2.9.6.4) 친절한 404 / 500 핸들러
//   - 존재하지 않는 경로 접속 시 검은 화면 + "404 Not Found" 만 보이던 문제 개선
//   - API 경로(/api/*)는 JSON 응답, 일반 페이지는 안내 화면 + 자동 리다이렉트
// ═════════════════════════════════════════════════════════════
app.notFound((c) => {
  const path = c.req.path
  // API 경로는 JSON 으로 응답
  if (path.startsWith('/api/')) {
    return c.json(
      { ok: false, error: 'not_found', path, hint: '경로를 다시 확인해 주세요.' },
      404,
    )
  }
  // 일반 페이지는 친절한 안내 화면 + 5초 후 루트로 자동 이동
  return c.html(
    `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="5; url=/">
  <title>페이지를 찾을 수 없습니다 · Morning Stock AI</title>
  <link rel="icon" href="/static/icons/favicon-32.png">
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
</head>
<body class="bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900 min-h-screen flex items-center justify-center p-4 text-white">
  <div class="max-w-lg w-full bg-white/10 backdrop-blur-md rounded-2xl shadow-2xl p-6 sm:p-8 text-center border border-white/20">
    <div class="text-6xl sm:text-7xl mb-3">🔍</div>
    <h1 class="text-2xl sm:text-3xl font-bold mb-2">404 — 페이지를 찾을 수 없습니다</h1>
    <p class="text-sm sm:text-base text-blue-100 mb-4">
      요청하신 경로 <code class="bg-black/30 px-2 py-0.5 rounded text-yellow-200 break-all">${path.replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[ch] || ch))}</code> 은(는) 존재하지 않습니다.
    </p>
    <div class="bg-blue-500/20 border border-blue-400/40 rounded-lg p-3 text-xs sm:text-sm text-blue-50 mb-5 text-left">
      <div class="font-semibold mb-1"><i class="fa-solid fa-circle-info mr-1"></i>가능한 원인</div>
      <ul class="list-disc list-inside space-y-0.5">
        <li>오타가 있거나 더 이상 사용되지 않는 경로</li>
        <li>오래된 프리뷰 URL (예: <code class="text-yellow-200">xxxx.morning-stock-briefing.pages.dev</code>)</li>
        <li>로그인 세션 만료 → 자동으로 로그인 화면으로 이동합니다</li>
      </ul>
    </div>
    <div class="flex flex-col sm:flex-row gap-2 justify-center">
      <a href="/" class="inline-flex items-center justify-center gap-2 px-4 py-2 bg-blue-500 hover:bg-blue-400 rounded-lg font-semibold transition">
        <i class="fa-solid fa-house"></i> 홈으로 (5초 후 자동 이동)
      </a>
      <a href="/login" class="inline-flex items-center justify-center gap-2 px-4 py-2 bg-white/15 hover:bg-white/25 rounded-lg font-semibold transition">
        <i class="fa-solid fa-right-to-bracket"></i> 로그인
      </a>
    </div>
    <div class="mt-6 text-[11px] text-blue-200/70">
      Morning Stock AI Briefing Center · v2.9.6.4
    </div>
  </div>
</body>
</html>`,
    404,
  )
})

app.onError((err, c) => {
  console.error('[v2.9.6.4] Unhandled error:', err)
  const path = c.req.path
  if (path.startsWith('/api/')) {
    return c.json(
      { ok: false, error: 'internal_error', message: err.message || 'unknown error' },
      500,
    )
  }
  return c.html(
    `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>일시적인 오류 · Morning Stock AI</title>
  <link rel="icon" href="/static/icons/favicon-32.png">
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
</head>
<body class="bg-gradient-to-br from-rose-900 via-slate-900 to-rose-900 min-h-screen flex items-center justify-center p-4 text-white">
  <div class="max-w-lg w-full bg-white/10 backdrop-blur-md rounded-2xl shadow-2xl p-6 sm:p-8 text-center border border-white/20">
    <div class="text-6xl mb-3">⚠️</div>
    <h1 class="text-2xl sm:text-3xl font-bold mb-2">일시적인 오류가 발생했습니다</h1>
    <p class="text-sm sm:text-base text-rose-100 mb-4">
      잠시 후 다시 시도해 주세요. 문제가 지속되면 관리자에게 문의해 주세요.
    </p>
    <a href="/" class="inline-flex items-center justify-center gap-2 px-4 py-2 bg-rose-500 hover:bg-rose-400 rounded-lg font-semibold transition">
      <i class="fa-solid fa-rotate-right"></i> 홈으로 돌아가기
    </a>
    <div class="mt-6 text-[11px] text-rose-200/70">v2.9.6.4</div>
  </div>
</body>
</html>`,
    500,
  )
})

export default app
