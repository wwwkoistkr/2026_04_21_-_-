/**
 * 🌅 Morning Stock AI Briefing Center
 * ────────────────────────────────────
 * - 매일 아침 8시(KST) 주식/반도체 브리핑을 이메일로 발송하는 Python 파이프라인의
 *   '소스 관리 웹 UI' 입니다.
 * - 사용자는 여기서 새로운 뉴스지/애널리스트 RSS/유튜브 URL 을 자유롭게 추가·삭제 가능.
 * - 등록된 소스는 Cloudflare KV 에 저장되고, Python 수집기가 매일 아침 이 목록을
 *   API 로 읽어와 동적으로 뉴스를 수집합니다.
 */
import { Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { renderer } from './renderer'

// ── 타입 정의 ──────────────────────────────────────────────────────────
type Bindings = {
  SOURCES_KV: KVNamespace
  ADMIN_PASSWORD?: string           // 관리자 로그인 비밀번호
  BRIEFING_READ_TOKEN?: string      // Python 수집기가 GET /api/sources 호출 시 Bearer 토큰
}

type SourceType = 'rss' | 'google_news' | 'youtube' | 'web'

interface NewsSource {
  id: string          // 고유 ID (timestamp 기반)
  label: string       // 사용자에게 보일 이름 (예: "디일렉 유튜브")
  type: SourceType
  url: string         // RSS URL, 유튜브 channel URL, 웹사이트 URL, …
  enabled: boolean
  createdAt: string   // ISO
}

interface EmailRecipient {
  id: string          // 고유 ID
  email: string       // 이메일 주소
  label?: string      // 사용자 별명 (예: "본인", "업무용")
  enabled: boolean
  createdAt: string   // ISO
}

const app = new Hono<{ Bindings: Bindings }>()

// ─────────────────────────────────────────────────────────────
// 공통 상수 / 유틸
// ─────────────────────────────────────────────────────────────
const KV_KEY_SOURCES = 'sources:v1'        // 사용자 추가 소스 리스트
const KV_KEY_RECIPIENTS = 'recipients:v1'  // 이메일 수신자 리스트
const SESSION_COOKIE = 'msaic_session'     // 관리자 세션 쿠키
const SESSION_TTL_SEC = 60 * 60 * 12       // 12시간
const DEFAULT_RECIPIENT = 'wwwkoistkr@gmail.com'  // 초기 기본 수신자

function getSession(c: any): string | undefined {
  return getCookie(c, SESSION_COOKIE)
}

function isAuthed(c: any): boolean {
  const sess = getSession(c)
  if (!sess) return false
  // 세션 값은 단순히 비밀번호 해시의 접두사 — 로그인 시 기록.
  // Workers 는 서버-상태가 없으므로 expiry 는 쿠키 TTL 로만 관리.
  return sess.length >= 8
}

async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function loadSources(env: Bindings): Promise<NewsSource[]> {
  const raw = await env.SOURCES_KV.get(KV_KEY_SOURCES, 'json')
  if (!raw) return []
  return raw as NewsSource[]
}

async function saveSources(env: Bindings, list: NewsSource[]): Promise<void> {
  await env.SOURCES_KV.put(KV_KEY_SOURCES, JSON.stringify(list))
}

async function loadRecipients(env: Bindings): Promise<EmailRecipient[]> {
  const raw = await env.SOURCES_KV.get(KV_KEY_RECIPIENTS, 'json')
  if (!raw) {
    // 최초 1회 기본 수신자 (wwwkoistkr@gmail.com) 자동 등록
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
  const expected = c.env.ADMIN_PASSWORD ?? 'admin1234' // 기본값(개발용)

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
    <div class="max-w-5xl mx-auto p-6">
      {/* 헤더 */}
      <header class="bg-gradient-to-r from-blue-600 to-sky-500 text-white rounded-2xl shadow-lg p-6 mb-6">
        <div class="flex items-center justify-between">
          <div>
            <div class="text-xs uppercase tracking-widest opacity-80">
              Daily Briefing Admin
            </div>
            <h1 class="text-3xl font-bold mt-1">
              🌅 Morning Stock AI Briefing Center
            </h1>
            <p class="text-sm opacity-90 mt-1">
              매일 아침 8시(KST) 자동 발송되는 브리핑의 <strong>뉴스 소스를 관리</strong>하는 콘솔입니다.
            </p>
          </div>
          <form method="post" action="/logout">
            <button class="px-3 py-1.5 text-sm bg-white/20 rounded hover:bg-white/30">
              로그아웃
            </button>
          </form>
        </div>
      </header>

      {/* 이메일 수신자 관리 */}
      <section class="bg-white rounded-2xl shadow p-6 mb-6">
        <h2 class="text-lg font-bold text-gray-800 mb-4">
          <i class="fa-solid fa-envelope text-emerald-500 mr-2"></i>
          매일 아침 브리핑을 받을 이메일 주소
        </h2>
        <p class="text-sm text-gray-500 mb-4">
          여기에 등록된 모든 이메일로 <strong>매일 아침 08:00 KST</strong> 브리핑이 발송됩니다.
          여러 명을 등록할 수 있습니다.
        </p>
        <form id="addRecipientForm" class="grid grid-cols-1 md:grid-cols-[2fr_1fr_auto] gap-3">
          <input
            id="recipientEmail"
            type="email"
            required
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

      {/* 새 소스 추가 폼 */}
      <section class="bg-white rounded-2xl shadow p-6 mb-6">
        <h2 class="text-lg font-bold text-gray-800 mb-4">
          <i class="fa-solid fa-plus-circle text-blue-500 mr-2"></i>
          새로운 소스 추가
        </h2>
        <p class="text-sm text-gray-500 mb-4">
          뉴스지 RSS, 애널리스트 블로그, YouTube 채널 등 어떤 URL 이든 붙여넣으면 자동으로 종류를 판별합니다.
        </p>
        <form id="addForm" class="grid grid-cols-1 md:grid-cols-[1fr_2fr_auto] gap-3">
          <input
            id="label"
            required
            placeholder="소스 이름 (예: 박병창 애널리스트)"
            class="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <input
            id="url"
            required
            placeholder="URL (예: https://… 혹은 RSS)"
            class="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <div class="flex gap-2">
            <button
              type="button"
              id="testBtn"
              class="px-4 py-2 bg-gray-100 border border-gray-300 rounded-lg text-sm hover:bg-gray-200"
              title="실제로 수집되는지 먼저 시험해 봅니다"
            >
              <i class="fa-solid fa-flask mr-1"></i> 테스트
            </button>
            <button
              type="submit"
              class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"
            >
              <i class="fa-solid fa-plus mr-1"></i> 추가
            </button>
          </div>
        </form>
        <div id="testResult" class="hidden mt-4 p-4 rounded-lg text-sm"></div>
      </section>

      {/* 현재 등록된 소스 리스트 */}
      <section class="bg-white rounded-2xl shadow p-6">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-lg font-bold text-gray-800">
            <i class="fa-solid fa-list text-blue-500 mr-2"></i>
            사용자 등록 소스
          </h2>
          <span id="sourceCount" class="text-sm text-gray-500">(불러오는 중…)</span>
        </div>
        <div id="sourceList" class="space-y-2">
          <div class="text-center text-gray-400 py-8">불러오는 중…</div>
        </div>

        <hr class="my-6" />
        <details class="text-sm text-gray-600">
          <summary class="cursor-pointer font-medium">
            <i class="fa-solid fa-info-circle mr-1"></i>
            기본 내장 소스(수정 불가)
          </summary>
          <ul class="list-disc pl-6 mt-2 space-y-1">
            <li><strong>한국 3사</strong>: 한국경제·매일경제·머니투데이 (증권/IT) — RSS + Google News Fallback</li>
            <li><strong>미국 매체</strong>: Seeking Alpha · ETF.com · Morningstar · Reuters · Bloomberg (Google News 우회)</li>
            <li><strong>유튜브</strong>: 디일렉(THEELEC) 공식 채널</li>
          </ul>
          <p class="mt-2 text-xs text-gray-500">
            위 기본 소스는 Python 코드에 내장되어 있으며, 여기서 추가한 소스는 <em>그 위에 추가 수집</em>됩니다.
          </p>
        </details>
      </section>

      {/* 푸터 */}
      <footer class="text-center text-xs text-gray-400 mt-8">
        Morning Stock AI Briefing Center · Python pipeline runs daily at 08:00 KST via GitHub Actions
      </footer>

      <script src="/static/admin.js"></script>
    </div>,
    { title: 'Morning Stock AI Briefing Center' }
  )
})

// ═════════════════════════════════════════════════════════════
// 4) 관리 API (인증 필요)
// ═════════════════════════════════════════════════════════════

/** 현재 등록된 소스 목록 조회 */
app.get('/api/admin/sources', async (c) => {
  const list = await loadSources(c.env)
  return c.json({ sources: list })
})

/** 새 소스 추가 */
app.post('/api/admin/sources', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const label = String(body.label ?? '').trim()
  const url = String(body.url ?? '').trim()

  if (!label || !url) {
    return c.json({ error: 'label 과 url 은 필수입니다.' }, 400)
  }
  if (!/^https?:\/\//i.test(url)) {
    return c.json({ error: 'URL 은 http:// 또는 https:// 로 시작해야 합니다.' }, 400)
  }

  const list = await loadSources(c.env)
  const newItem: NewsSource = {
    id: 's_' + Date.now().toString(36),
    label,
    url,
    type: detectSourceType(url),
    enabled: true,
    createdAt: new Date().toISOString(),
  }
  list.push(newItem)
  await saveSources(c.env, list)
  return c.json({ ok: true, source: newItem })
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

/** 소스 활성/비활성 토글 */
app.patch('/api/admin/sources/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const list = await loadSources(c.env)
  const target = list.find((s) => s.id === id)
  if (!target) return c.json({ error: 'not found' }, 404)
  if (typeof body.enabled === 'boolean') target.enabled = body.enabled
  if (typeof body.label === 'string' && body.label.trim()) target.label = body.label.trim()
  await saveSources(c.env, list)
  return c.json({ ok: true, source: target })
})

// ─── 이메일 수신자 관리 ───────────────────────────────────────

/** 수신자 목록 조회 */
app.get('/api/admin/recipients', async (c) => {
  const list = await loadRecipients(c.env)
  return c.json({ recipients: list })
})

/** 수신자 추가 */
app.post('/api/admin/recipients', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const email = String(body.email ?? '').trim().toLowerCase()
  const label = String(body.label ?? '').trim()

  if (!email) {
    return c.json({ error: '이메일 주소는 필수입니다.' }, 400)
  }
  if (!isValidEmail(email)) {
    return c.json({ error: '올바른 이메일 주소 형식이 아닙니다.' }, 400)
  }

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

/** 수신자 삭제 */
app.delete('/api/admin/recipients/:id', async (c) => {
  const id = c.req.param('id')
  const list = await loadRecipients(c.env)
  const next = list.filter((r) => r.id !== id)
  if (next.length === list.length) {
    return c.json({ error: 'not found' }, 404)
  }
  await saveRecipients(c.env, next)
  return c.json({ ok: true })
})

/** 수신자 활성/비활성·라벨 수정 */
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

/** 소스 URL 즉석 테스트 — RSS 파싱해서 최근 제목 몇 개 반환 */
app.post('/api/admin/test-source', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const url = String(body.url ?? '').trim()
  if (!url) return c.json({ error: 'url 필요' }, 400)

  const type = detectSourceType(url)

  try {
    // YouTube 채널 URL → RSS URL 자동 변환 시도
    let fetchUrl = url
    if (type === 'youtube') {
      const channelId = extractYouTubeChannelId(url)
      if (channelId) {
        fetchUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
      }
    }

    // YouTube RSS 는 feedparser UA 를 선호하므로 헤더 분기
    const ua = fetchUrl.includes('youtube.com/feeds')
      ? 'feedparser/6.0 +https://github.com/kurtmckee/feedparser'
      : 'Mozilla/5.0 (compatible; MorningStockAI/1.0)'
    const resp = await fetch(fetchUrl, {
      headers: { 'User-Agent': ua, Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9' },
    })
    if (!resp.ok) {
      return c.json({
        ok: false,
        type,
        fetchUrl,
        error: `HTTP ${resp.status}`,
      })
    }
    const xml = await resp.text()

    // 아주 간단한 RSS/Atom 제목 추출 (정규식)
    const titles = extractTitles(xml).slice(0, 5)
    return c.json({
      ok: titles.length > 0,
      type,
      fetchUrl,
      sampleCount: titles.length,
      samples: titles,
      message:
        titles.length > 0
          ? '✅ 정상 수집됩니다. 추가 버튼을 눌러 등록하세요.'
          : '⚠️ 응답은 받았지만 제목을 찾지 못했습니다. RSS/Atom 피드가 아닐 수 있습니다.',
    })
  } catch (e: any) {
    return c.json({
      ok: false,
      type,
      error: e?.message ?? String(e),
    })
  }
})

function extractYouTubeChannelId(url: string): string | null {
  // https://www.youtube.com/channel/UC... → UC...
  const m1 = url.match(/youtube\.com\/channel\/([A-Za-z0-9_-]+)/)
  if (m1) return m1[1]
  return null
}

function extractTitles(xml: string): string[] {
  const out: string[] = []
  // <title>...</title> 을 모두 추출 (첫 번째는 채널/피드 제목일 수 있으므로 제외)
  const re = /<title(?:[^>]*)>([\s\S]*?)<\/title>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    let t = m[1]
    // CDATA 제거
    t = t.replace(/<!\[CDATA\[|\]\]>/g, '').trim()
    if (t) out.push(t)
  }
  // 맨 앞 1개는 보통 피드 전체 제목이므로 드롭
  return out.slice(1)
}

// ═════════════════════════════════════════════════════════════
// 5) 공개 API (Python 수집기가 호출) — Bearer 토큰 보호
// ═════════════════════════════════════════════════════════════
function checkBearer(c: any): boolean {
  const expected = c.env.BRIEFING_READ_TOKEN
  if (!expected) return true  // 토큰이 설정 안 되어 있으면 허용(개발)
  const auth = c.req.header('Authorization') ?? ''
  const token = auth.replace(/^Bearer\s+/i, '')
  return token === expected
}

app.get('/api/public/sources', async (c) => {
  if (!checkBearer(c)) return c.json({ error: 'unauthorized' }, 401)
  const list = await loadSources(c.env)
  return c.json({
    sources: list.filter((s) => s.enabled),
    generatedAt: new Date().toISOString(),
  })
})

/** Python 이메일 발송 모듈이 호출 — 활성화된 수신자 이메일만 반환 */
app.get('/api/public/recipients', async (c) => {
  if (!checkBearer(c)) return c.json({ error: 'unauthorized' }, 401)
  const list = await loadRecipients(c.env)
  const emails = list.filter((r) => r.enabled).map((r) => r.email)
  return c.json({
    recipients: emails,
    generatedAt: new Date().toISOString(),
  })
})

// 헬스체크
app.get('/api/health', (c) =>
  c.json({ ok: true, service: 'Morning Stock AI Briefing Center' })
)

export default app
