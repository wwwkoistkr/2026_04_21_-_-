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
  ADMIN_PASSWORD?: string           // 관리자 로그인 비밀번호
  BRIEFING_READ_TOKEN?: string      // Python 수집기 API 인증 토큰
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
}

const app = new Hono<{ Bindings: Bindings }>()

// ─────────────────────────────────────────────────────────────
// 공통 상수 / 유틸
// ─────────────────────────────────────────────────────────────
const KV_KEY_SOURCES = 'sources:v2'            // v2 스키마 (검색어 포함)
const KV_KEY_SOURCES_LEGACY = 'sources:v1'     // 기존 v1 (마이그레이션 참조용)
const KV_KEY_RECIPIENTS = 'recipients:v1'
const SESSION_COOKIE = 'msaic_session'
const SESSION_TTL_SEC = 60 * 60 * 12           // 12시간
const DEFAULT_RECIPIENT = 'wwwkoistkr@gmail.com'

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
  return c.render(
    <div class="max-w-md mx-auto mt-20 p-8 bg-white rounded-2xl shadow-lg">
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
          class="w-full py-2.5 bg-gradient-to-r from-blue-600 to-sky-500 text-white font-semibold rounded-lg hover:opacity-95 transition"
        >
          로그인
        </button>
      </form>
      <p class="text-xs text-gray-400 text-center mt-6">
        비밀번호는 <code>ADMIN_PASSWORD</code> 환경변수/Secret 으로 설정합니다.
      </p>
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
  return c.redirect('/login')
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
    <div class="max-w-6xl mx-auto p-6">
      {/* 헤더 */}
      <header class="bg-gradient-to-r from-blue-600 to-sky-500 text-white rounded-2xl shadow-lg p-6 mb-6">
        <div class="flex items-center justify-between">
          <div>
            <div class="text-xs uppercase tracking-widest opacity-80">
              Daily Briefing Admin v2
            </div>
            <h1 class="text-3xl font-bold mt-1">
              🌅 Morning Stock AI Briefing Center
            </h1>
            <p class="text-sm opacity-90 mt-1">
              매일 아침 <strong>07:00 (KST)</strong> 자동 발송되는 브리핑의
              <strong> 수신자·뉴스 소스·검색어</strong>를 여기서 모두 관리합니다.
            </p>
          </div>
          <form method="post" action="/logout">
            <button class="px-3 py-1.5 text-sm bg-white/20 rounded hover:bg-white/30">
              로그아웃
            </button>
          </form>
        </div>
      </header>

      {/* ① 이메일 수신자 관리 */}
      <section class="bg-white rounded-2xl shadow p-6 mb-6">
        <h2 class="text-lg font-bold text-gray-800 mb-4">
          <i class="fa-solid fa-envelope text-emerald-500 mr-2"></i>
          ① 매일 아침 브리핑을 받을 이메일 주소
        </h2>
        <p class="text-sm text-gray-500 mb-4">
          여기 등록된 모든 이메일로 <strong>매일 07:00 KST</strong> 브리핑이 발송됩니다.
        </p>
        <form id="addRecipientForm" class="grid grid-cols-1 md:grid-cols-[2fr_1fr_auto] gap-3">
          <input
            id="recipientEmail"
            type="email"
            required
            autocomplete="email"
            placeholder="이메일 주소 (예: wwwkoistkr@gmail.com)"
            class="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
          />
          <input
            id="recipientLabel"
            placeholder="별명 (선택, 예: 본인/업무용)"
            class="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
          />
          <button
            type="submit"
            class="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm hover:bg-emerald-700"
          >
            <i class="fa-solid fa-plus mr-1"></i> 수신자 추가
          </button>
        </form>
        <div class="flex items-center justify-between mt-5 mb-3">
          <h3 class="text-sm font-semibold text-gray-700">
            <i class="fa-solid fa-users mr-1 text-emerald-500"></i>
            현재 등록된 수신자
          </h3>
          <span id="recipientCount" class="text-xs text-gray-500">(불러오는 중…)</span>
        </div>
        <div id="recipientList" class="space-y-2">
          <div class="text-center text-gray-400 py-6 text-sm">불러오는 중…</div>
        </div>
      </section>

      {/* ② 뉴스 소스 관리 (새 UI) */}
      <section class="bg-white rounded-2xl shadow p-6 mb-6">
        <h2 class="text-lg font-bold text-gray-800 mb-2">
          <i class="fa-solid fa-newspaper text-blue-500 mr-2"></i>
          ② 뉴스 소스 & 검색어 관리
        </h2>
        <p class="text-sm text-gray-500 mb-4">
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
      <section class="bg-blue-50 border border-blue-200 rounded-2xl p-5 mb-6 text-sm">
        <h3 class="font-bold text-blue-900 mb-2">
          <i class="fa-solid fa-lightbulb mr-1"></i>
          추천 검색어 프리셋
        </h3>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3 text-gray-700">
          <div>
            <strong>🇰🇷 한국:</strong>
            <p class="text-xs mt-1">반도체, AI, 금리, HBM, 삼성전자, SK하이닉스, 코스피</p>
          </div>
          <div>
            <strong>🌎 미국(반도체):</strong>
            <p class="text-xs mt-1">semiconductor, AI chip, TSMC, Nvidia, AMD, Micron</p>
          </div>
          <div>
            <strong>🌎 미국(ETF/거시):</strong>
            <p class="text-xs mt-1">ETF, S&amp;P 500, dividend, Fed rate, FOMC, QQQ</p>
          </div>
        </div>
      </section>

      {/* 푸터 */}
      <footer class="text-center text-xs text-gray-400 mt-8">
        Morning Stock AI Briefing Center v2 · Python pipeline runs daily at 07:00 KST via GitHub Actions
      </footer>

      {/* 모달: 소스 편집 */}
      <div id="editModal" class="hidden fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
        <div class="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
          <div class="p-6 border-b border-gray-200 flex items-center justify-between">
            <h3 class="text-lg font-bold text-gray-800">
              <i class="fa-solid fa-pen-to-square text-blue-500 mr-2"></i>
              <span id="modalTitle">소스 편집</span>
            </h3>
            <button id="btnCloseModal" class="text-gray-400 hover:text-gray-600">
              <i class="fa-solid fa-xmark text-xl"></i>
            </button>
          </div>
          <div class="p-6" id="modalBody">
            {/* JS 가 채워넣음 */}
          </div>
          <div class="p-4 border-t border-gray-200 flex justify-end gap-2 bg-gray-50 rounded-b-2xl">
            <button id="btnCancelEdit" class="px-4 py-2 text-sm bg-white border border-gray-300 rounded hover:bg-gray-50">
              취소
            </button>
            <button id="btnSaveEdit" class="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700">
              <i class="fa-solid fa-check mr-1"></i>저장
            </button>
          </div>
        </div>
      </div>

      {/* 토스트 알림 */}
      <div id="toast" class="hidden fixed bottom-6 right-6 z-50 px-5 py-3 rounded-lg shadow-lg text-white text-sm"></div>

      <script src="/static/admin.js"></script>
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
app.get('/api/admin/recipients', async (c) => {
  const list = await loadRecipients(c.env)
  return c.json({ recipients: list })
})

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

  const newItem: EmailRecipient = {
    id: 'r_' + Date.now().toString(36),
    email,
    label: label || undefined,
    enabled: true,
    createdAt: new Date().toISOString(),
  }
  list.push(newItem)
  await saveRecipients(c.env, list)
  return c.json({ ok: true, recipient: newItem })
})

app.delete('/api/admin/recipients/:id', async (c) => {
  const id = c.req.param('id')
  const list = await loadRecipients(c.env)
  const next = list.filter((r) => r.id !== id)
  if (next.length === list.length) return c.json({ error: 'not found' }, 404)
  await saveRecipients(c.env, next)
  return c.json({ ok: true })
})

app.patch('/api/admin/recipients/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const list = await loadRecipients(c.env)
  const target = list.find((r) => r.id === id)
  if (!target) return c.json({ error: 'not found' }, 404)
  if (typeof body.enabled === 'boolean') target.enabled = body.enabled
  if (typeof body.label === 'string') target.label = body.label.trim() || undefined
  await saveRecipients(c.env, list)
  return c.json({ ok: true, recipient: target })
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
  c.json({ ok: true, service: 'Morning Stock AI Briefing Center', version: 'v2.0' })
)

export default app
