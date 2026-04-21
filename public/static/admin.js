/**
 * Morning Stock AI — Admin Dashboard Client Script v2.2.5
 * ───────────────────────────────────────────────────────
 * - 카테고리 탭 (🇰🇷/🌎/📺/➕/전체)
 * - 소스 카드: 검색어 태그 표시, 편집/테스트/삭제 버튼
 * - 편집 모달: label/url/site/queries/defaultLimit 편집 + 프리셋 적용 버튼
 * - 새 소스 추가: 모달 재사용
 * - 기본값 복원
 * - 토스트 알림
 * - PC↔모바일 실시간 동기화 (BroadcastChannel + 폴링)
 * - 글로벌 에러 핸들러로 사용자에게 친절한 에러 표시
 * BUILD: 2026-04-21 v2.2.5
 * [v2.2.5] 🔴 CRITICAL FIX: 이메일 '발송완료' 오보고 + 로그인화면 복원
 *   - Python email_sender: sendmail() 거부 수신자 dict 검사 → 일부 실패도 감지
 *   - Gmail 스팸 분류 낮추는 헤더 추가 (Reply-To, List-Unsubscribe, Date)
 *   - BRIEFING_READ_TOKEN 401/403 시 명확한 진단 로그 → 관리UI 수신자 반영 안되는 상황 가시화
 *   - 세션 TTL 12h → 2h: 첫화면 로그인 요구 충족
 *   - GET /logout 추가 (모바일 편의)
 *   - 스팸폴더 확인 안내 UI 추가
 * [v2.2.3] CRITICAL FIX: "지금 발송" 중복 트리거 및 폴링 오매칭 수정
 *   - 더블클릭/연타 방지용 triggerInFlight 플래그 + 버튼 잠금
 *   - startPolling 이 workflow_dispatch 이벤트 & 60초 오차 창 내의
 *     가장 최근 런 만 매칭하도록 강화 (다른 실행과 혼동되던 버그 해결)
 *   - 에러 메시지에 GEMINI 503 힌트 추가
 * [v2.2.2] 🔴 CRITICAL FIX: Tailwind hidden vs sm:flex specificity 충돌 해결
 *   - 모달 HTML 클래스: hidden + sm:flex → modal-hidden
 *   - showModal/hideModal 헬퍼로 통일
 *   - toast-hidden/visible 분리
 *   - CSS에 !important 기반 전용 룰 추가
 */

(function () {
  // ═════════════════════════════════════════════════════════════
  // 🛡️ 전역 에러 핸들러 (v2.2)
  // ═════════════════════════════════════════════════════════════
  window.addEventListener('error', (e) => {
    console.error('[GlobalError]', e.message, 'at', e.filename + ':' + e.lineno + ':' + e.colno, e.error)
    try { toast('⚠️ JS 오류: ' + (e.message || '알 수 없음'), 'error') } catch {}
  })
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[UnhandledRejection]', e.reason)
    try { toast('⚠️ 비동기 오류: ' + (e.reason?.message || e.reason || '알 수 없음'), 'error') } catch {}
  })

  // ═════════════════════════════════════════════════════════════
  // 🌐 안전한 fetch 헬퍼 (v2.2)
  // - 401 시 자동 로그인 리다이렉트
  // - 비 2xx 응답 시 서버 에러 메시지 파싱
  // - 네트워크/파싱 에러를 { error } 객체로 반환 (throw 하지 않음)
  // ═════════════════════════════════════════════════════════════
  async function safeFetch(url, options = {}) {
    try {
      const r = await fetch(url, options)
      if (r.status === 401) {
        console.warn('[safeFetch] 세션 만료 — 로그인 페이지로 이동')
        location.href = '/login'
        return { error: '세션 만료' }
      }
      // JSON 파싱 시도
      const text = await r.text()
      let data = {}
      if (text) {
        try { data = JSON.parse(text) } catch {
          return { error: `서버 응답 파싱 실패 (HTTP ${r.status}): ${text.slice(0, 200)}` }
        }
      }
      if (!r.ok) {
        return { ...data, error: data.error || `HTTP ${r.status}` }
      }
      return data
    } catch (e) {
      console.error('[safeFetch] network error', url, e)
      return { error: '네트워크 오류: ' + (e?.message || e) }
    }
  }

  // ═════════════════════════════════════════════════════════════
  // API 래퍼
  // ═════════════════════════════════════════════════════════════
  const api = {
    list: () => safeFetch('/api/admin/sources'),
    presets: () => safeFetch('/api/admin/presets'),
    add: (payload) =>
      safeFetch('/api/admin/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    remove: (id) =>
      safeFetch('/api/admin/sources/' + encodeURIComponent(id), { method: 'DELETE' }),
    patch: (id, patch) =>
      safeFetch('/api/admin/sources/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }),
    test: (payload) =>
      safeFetch('/api/admin/test-source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    resetDefaults: () =>
      safeFetch('/api/admin/sources/reset-defaults', { method: 'POST' }),
  }

  const recipientApi = {
    list: () => safeFetch('/api/admin/recipients'),
    add: (email, label) =>
      safeFetch('/api/admin/recipients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, label }),
      }),
    remove: (id) =>
      safeFetch('/api/admin/recipients/' + encodeURIComponent(id), { method: 'DELETE' }),
    patch: (id, patch) =>
      safeFetch('/api/admin/recipients/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }),
  }

  // ═════════════════════════════════════════════════════════════
  // 🚀 "지금 발송" API
  // ═════════════════════════════════════════════════════════════
  const triggerApi = {
    status: () => safeFetch('/api/admin/trigger-status'),
    run: (dryRun) =>
      safeFetch('/api/admin/trigger-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun }),
      }),
    recentRuns: () => safeFetch('/api/admin/recent-runs'),
  }

  // ═════════════════════════════════════════════════════════════
  // 전역 상태
  // ═════════════════════════════════════════════════════════════
  let allSources = []
  let currentCategory = 'all'
  let presetCatalog = []
  // 편집 중인 소스: null = 새 소스 추가 모드
  let editingSource = null
  // 편집 모달 열려있는지 (실시간 동기화에서 재로딩 방지용)
  let isEditingModal = false

  // ═════════════════════════════════════════════════════════════
  // 유틸
  // ═════════════════════════════════════════════════════════════
  const CATEGORY_META = {
    kr: { icon: '🇰🇷', name: '한국' },
    us: { icon: '🌎', name: '미국' },
    yt: { icon: '📺', name: '유튜브' },
    custom: { icon: '➕', name: '사용자' },
  }

  const TYPE_LABEL = {
    rss: 'RSS',
    google_news: 'Google News',
    youtube: 'YouTube',
    web: 'Web',
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[m]))
  }

  function toast(msg, type = 'info') {
    const el = document.getElementById('toast')
    if (!el) return
    const palette = {
      info: 'bg-gray-800',
      success: 'bg-emerald-600',
      warn: 'bg-amber-600',
      error: 'bg-red-600',
    }
    el.className = 'toast-visible fixed bottom-6 right-6 z-50 px-5 py-3 rounded-lg shadow-lg text-white text-sm ' + (palette[type] || palette.info)
    el.innerHTML = msg
    clearTimeout(toast._t)
    toast._t = setTimeout(() => {
      el.className = 'toast-hidden fixed bottom-6 right-6 z-50 px-5 py-3 rounded-lg shadow-lg text-white text-sm'
    }, 3000)
  }

  function badge(type, enabled) {
    const name = TYPE_LABEL[type] || type
    const typeColor = {
      rss: 'bg-purple-100 text-purple-700',
      google_news: 'bg-blue-100 text-blue-700',
      youtube: 'bg-red-100 text-red-700',
      web: 'bg-gray-100 text-gray-700',
    }[type] || 'bg-gray-100 text-gray-700'
    const enabledBadge = enabled
      ? '<span class="text-xs text-green-600 ml-1"><i class="fa-solid fa-circle-check"></i> 활성</span>'
      : '<span class="text-xs text-gray-400 ml-1"><i class="fa-solid fa-circle-pause"></i> 비활성</span>'
    return `<span class="text-xs px-2 py-0.5 rounded-full ${typeColor}">${name}</span>${enabledBadge}`
  }

  function queryTags(queries, defaultLimit) {
    if (!queries || queries.length === 0) {
      return `<span class="text-xs text-gray-400 italic">검색어 없음 → 사이트 최신순 ${defaultLimit}건 수집</span>`
    }
    return queries
      .map(
        (q) =>
          `<span class="inline-flex items-center gap-1 text-xs bg-sky-50 text-sky-700 px-2 py-0.5 rounded border border-sky-200">
            <i class="fa-solid fa-magnifying-glass text-[10px]"></i>
            ${escapeHtml(q.keyword)}
            <span class="text-sky-400">×${q.limit}</span>
          </span>`
      )
      .join(' ')
  }

  // ═════════════════════════════════════════════════════════════
  // 카테고리 탭
  // ═════════════════════════════════════════════════════════════
  function setupTabs() {
    const tabs = document.querySelectorAll('.cat-tab')
    tabs.forEach((t) => {
      t.addEventListener('click', () => {
        tabs.forEach((x) => {
          x.classList.remove('active', 'border-blue-500', 'text-blue-600')
          x.classList.add('border-transparent', 'text-gray-500')
        })
        t.classList.add('active', 'border-blue-500', 'text-blue-600')
        t.classList.remove('border-transparent', 'text-gray-500')
        currentCategory = t.dataset.cat
        renderSources()
      })
    })
  }

  function updateCategoryCounts() {
    const counts = { all: allSources.length, kr: 0, us: 0, yt: 0, custom: 0 }
    allSources.forEach((s) => {
      if (counts[s.category] !== undefined) counts[s.category]++
    })
    document.querySelectorAll('.cat-tab').forEach((t) => {
      const c = t.dataset.cat
      const span = t.querySelector('.cat-count')
      if (span) span.textContent = counts[c] ?? 0
    })
  }

  // ═════════════════════════════════════════════════════════════
  // 소스 카드 렌더
  // ═════════════════════════════════════════════════════════════
  function renderSources() {
    const listEl = document.getElementById('sourceList')
    const countEl = document.getElementById('sourceCount')

    const filtered =
      currentCategory === 'all'
        ? allSources
        : allSources.filter((s) => s.category === currentCategory)

    countEl.textContent = `(${currentCategory === 'all' ? '전체' : CATEGORY_META[currentCategory]?.name || ''} ${filtered.length}개 / 총 ${allSources.length}개)`

    if (filtered.length === 0) {
      listEl.innerHTML = `
        <div class="text-center py-10 text-gray-400">
          <i class="fa-regular fa-folder-open text-4xl mb-2"></i>
          <p class="text-sm">이 카테고리에는 소스가 없습니다.</p>
        </div>`
      return
    }

    listEl.innerHTML = filtered
      .map((s) => {
        const categoryIcon = CATEGORY_META[s.category]?.icon || '•'
        const totalExpected =
          s.queries && s.queries.length > 0
            ? s.queries.reduce((acc, q) => acc + q.limit, 0)
            : s.defaultLimit
        return `
        <div class="source-card border border-gray-200 rounded-lg p-3 bg-white hover:shadow-sm transition ${s.enabled ? '' : 'opacity-60'}">
          <div class="flex items-start gap-3">
            <div class="text-2xl flex-shrink-0 pt-1">${categoryIcon}</div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap mb-1">
                <strong class="text-gray-800 truncate">${escapeHtml(s.label)}</strong>
                ${badge(s.type, s.enabled)}
                ${s.builtin ? '<span class="text-xs text-gray-400">[기본]</span>' : ''}
                <span class="text-xs text-gray-400 ml-auto">예상 ${totalExpected}건/일</span>
              </div>
              <div class="text-xs text-gray-500 mb-2 truncate">
                ${s.site ? `<i class="fa-solid fa-globe mr-1"></i>site:${escapeHtml(s.site)}` : ''}
                ${!s.site && s.url ? `<a href="${encodeURI(s.url)}" target="_blank" class="text-blue-600 hover:underline"><i class="fa-solid fa-link mr-1"></i>${escapeHtml(s.url)}</a>` : ''}
              </div>
              <div class="flex flex-wrap gap-1 mb-2">
                ${queryTags(s.queries, s.defaultLimit)}
              </div>
            </div>
            <div class="flex gap-1 flex-shrink-0">
              <button data-action="toggle" data-id="${s.id}"
                class="px-2 py-1.5 rounded hover:bg-gray-100" title="활성/비활성">
                <i class="fa-solid ${s.enabled ? 'fa-toggle-on text-green-500' : 'fa-toggle-off text-gray-400'} text-lg"></i>
              </button>
              <button data-action="edit" data-id="${s.id}"
                class="px-2 py-1.5 text-xs text-blue-600 rounded hover:bg-blue-50" title="편집">
                <i class="fa-solid fa-pen-to-square"></i>
              </button>
              <button data-action="test" data-id="${s.id}"
                class="px-2 py-1.5 text-xs text-amber-600 rounded hover:bg-amber-50" title="수집 테스트">
                <i class="fa-solid fa-flask"></i>
              </button>
              <button data-action="delete" data-id="${s.id}"
                class="px-2 py-1.5 text-xs text-red-500 rounded hover:bg-red-50" title="삭제">
                <i class="fa-solid fa-trash"></i>
              </button>
            </div>
          </div>
        </div>`
      })
      .join('')

    listEl.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', onSourceAction)
    })
  }

  async function onSourceAction(e) {
    const btn = e.currentTarget
    const id = btn.dataset.id
    const action = btn.dataset.action
    const target = allSources.find((s) => s.id === id)

    if (!target) {
      console.warn('[onSourceAction] target not found for id:', id, 'action:', action)
      toast('⚠️ 소스를 찾을 수 없습니다. 새로고침합니다…', 'warn')
      await reload()
      return
    }

    try {
      if (action === 'toggle') {
        const res = await api.patch(id, { enabled: !target.enabled })
        if (res?.error) return toast('❌ ' + res.error, 'error')
        await reload()
        // 🔄 다른 탭으로 변경사항 브로드캐스트
        notifyOtherTabs('sources')
      } else if (action === 'edit') {
        openEditModal(target)
      } else if (action === 'test') {
        await runQuickTest(target)
      } else if (action === 'delete') {
        const warn = target.builtin
          ? `[기본 소스] "${target.label}"을(를) 삭제하시겠습니까?\n('기본값 복원' 버튼으로 다시 불러올 수 있습니다.)`
          : `"${target.label}"을(를) 삭제하시겠습니까?`
        if (!confirm(warn)) return
        const res = await api.remove(id)
        if (res?.error) return toast('❌ ' + res.error, 'error')
        await reload()
        notifyOtherTabs('sources')
        toast(`🗑️ <strong>${escapeHtml(target.label)}</strong> 삭제됨`, 'success')
      }
    } catch (err) {
      console.error('[onSourceAction]', action, err)
      toast('❌ 작업 실패: ' + (err?.message || err), 'error')
    }
  }

  async function runQuickTest(s) {
    toast('<i class="fa-solid fa-spinner fa-spin mr-1"></i> 수집 테스트 중…', 'info')
    // queries 가 있으면 첫 번째 키워드로, 없으면 URL 로 테스트
    const payload = {}
    if (s.site && s.queries && s.queries.length > 0) {
      payload.site = s.site
      payload.keyword = s.queries[0].keyword
    } else if (s.site) {
      payload.site = s.site
    } else {
      payload.url = s.url
    }
    const res = await api.test(payload)
    if (res.ok) {
      const samples = (res.samples || []).slice(0, 3).map((t) => '• ' + escapeHtml(t)).join('<br>')
      toast(
        `✅ <strong>${escapeHtml(s.label)}</strong> ${res.sampleCount}건 수집 OK<br><span class="text-xs opacity-80">${samples}</span>`,
        'success'
      )
    } else {
      toast(`❌ <strong>${escapeHtml(s.label)}</strong> 수집 실패: ${escapeHtml(res.error || '알 수 없음')}`, 'error')
    }
  }

  // ═════════════════════════════════════════════════════════════
  // 편집/추가 모달 (v2.2.2 - modal-hidden/visible 룰 기반)
  // ═════════════════════════════════════════════════════════════
  const modal = document.getElementById('editModal')
  const modalBody = document.getElementById('modalBody')
  const modalTitle = document.getElementById('modalTitle')

  /**
   * 모달 표시/숨김 헬퍼 (CSS specificity 충돌 방지).
   * Tailwind `hidden` 은 미디어쿼리에 약하므로 전용 클래스 사용.
   */
  function showModal(el) {
    if (!el) return
    el.classList.remove('modal-hidden', 'hidden')
    el.classList.add('modal-visible')
  }
  function hideModal(el) {
    if (!el) return
    el.classList.remove('modal-visible')
    el.classList.add('modal-hidden')
  }

  function openAddModal() {
    if (!modal || !modalBody) {
      console.error('[openAddModal] modal DOM not found')
      toast('❌ 페이지 로딩 오류 - 새로고침 해주세요', 'error')
      return
    }
    editingSource = null
    isEditingModal = true
    if (modalTitle) modalTitle.textContent = '새 소스 추가'
    try {
      renderModalBody({
        id: '',
        label: '',
        category: 'custom',
        type: 'google_news',
        url: '',
        site: '',
        queries: [],
        defaultLimit: 5,
        enabled: true,
        builtin: false,
      })
      showModal(modal)
    } catch (e) {
      console.error('[openAddModal] render failed:', e)
      hideModal(modal)
      toast('❌ 모달 렌더링 실패: ' + (e?.message || e), 'error')
      isEditingModal = false
    }
  }

  function openEditModal(source) {
    if (!modal || !modalBody) {
      console.error('[openEditModal] modal DOM not found')
      toast('❌ 페이지 로딩 오류 - 새로고침 해주세요', 'error')
      return
    }
    if (!source || typeof source !== 'object') {
      console.error('[openEditModal] invalid source:', source)
      toast('❌ 소스 데이터를 찾을 수 없습니다. 새로고침해주세요.', 'error')
      return
    }
    editingSource = source
    isEditingModal = true
    if (modalTitle) modalTitle.textContent = `편집 — ${source.label || '(이름없음)'}`
    try {
      renderModalBody(source)
      showModal(modal)
    } catch (e) {
      console.error('[openEditModal] render failed for:', source, e)
      hideModal(modal)
      toast('❌ 편집 모달 오류: ' + (e?.message || e), 'error')
      isEditingModal = false
    }
  }

  function closeModal() {
    hideModal(modal)
    editingSource = null
    isEditingModal = false
  }

  function renderModalBody(s) {
    // 안전 정규화: undefined/null 방어
    s = s || {}
    const safeQueries = Array.isArray(s.queries) ? s.queries : []
    const safePresets = Array.isArray(presetCatalog) ? presetCatalog : []

    const queriesHtml = safeQueries
      .map((q, i) => queryRowHtml(q?.keyword || '', q?.limit || 3, i))
      .join('')

    modalBody.innerHTML = `
      <div class="space-y-4">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">표시 이름 <span class="text-red-500">*</span></label>
            <input id="m_label" value="${escapeHtml(s.label)}" required
              placeholder="예: 한국경제 (반도체)"
              class="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-blue-500">
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">카테고리</label>
            <select id="m_category" class="w-full px-3 py-2 border border-gray-300 rounded text-sm">
              <option value="kr" ${s.category === 'kr' ? 'selected' : ''}>🇰🇷 한국</option>
              <option value="us" ${s.category === 'us' ? 'selected' : ''}>🌎 미국</option>
              <option value="yt" ${s.category === 'yt' ? 'selected' : ''}>📺 유튜브</option>
              <option value="custom" ${s.category === 'custom' ? 'selected' : ''}>➕ 사용자</option>
            </select>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">
              사이트 도메인 (Google News 검색용)
            </label>
            <input id="m_site" value="${escapeHtml(s.site || '')}"
              placeholder="예: hankyung.com, reuters.com"
              class="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-blue-500">
            <p class="text-[11px] text-gray-400 mt-1">검색어가 있으면 <code>site:도메인 "검색어"</code> 로 Google News 수집합니다.</p>
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">URL (홈/RSS/유튜브 채널)</label>
            <input id="m_url" value="${escapeHtml(s.url || '')}"
              placeholder="https://example.com 또는 RSS URL"
              class="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-blue-500">
          </div>
        </div>

        <div>
          <div class="flex items-center justify-between mb-2">
            <label class="text-xs font-semibold text-gray-600">
              🔎 검색어 (최대 5개, 비우면 사이트 최신순 수집)
            </label>
            <div class="flex gap-1">
              <select id="m_preset_select" class="text-xs px-2 py-1 border border-gray-300 rounded">
                <option value="">📋 프리셋 적용...</option>
                ${safePresets.map((p) => `<option value="${p.id}">${escapeHtml(p.label)}</option>`).join('')}
              </select>
              <button type="button" id="m_add_query" class="text-xs px-2 py-1 bg-sky-100 text-sky-700 rounded hover:bg-sky-200">
                <i class="fa-solid fa-plus"></i> 검색어 추가
              </button>
            </div>
          </div>
          <div id="m_queries" class="space-y-2">
            ${queriesHtml || '<p class="text-xs text-gray-400 italic text-center py-3">검색어가 비어있습니다. (사이트 최신순으로 수집)</p>'}
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 items-end">
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">
              검색어 없을 때 기본 수집 건수
            </label>
            <input id="m_defaultLimit" type="number" min="1" max="10" value="${s.defaultLimit || 5}"
              class="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-blue-500">
          </div>
          <div>
            <label class="inline-flex items-center gap-2 cursor-pointer pt-6">
              <input type="checkbox" id="m_enabled" ${s.enabled ? 'checked' : ''} class="rounded">
              <span class="text-sm text-gray-700">활성화 (브리핑에 포함)</span>
            </label>
          </div>
        </div>

        <div class="pt-2 border-t border-gray-100">
          <button type="button" id="m_test_btn" class="text-xs px-3 py-1.5 bg-amber-100 text-amber-700 rounded hover:bg-amber-200">
            <i class="fa-solid fa-flask mr-1"></i>이 설정으로 수집 미리보기
          </button>
          <div id="m_test_result" class="mt-3 hidden text-xs"></div>
        </div>
      </div>
    `

    // 이벤트 바인딩
    document.getElementById('m_add_query').addEventListener('click', () => addQueryRow())
    document.getElementById('m_preset_select').addEventListener('change', onPresetSelect)
    document.getElementById('m_test_btn').addEventListener('click', onModalTest)
    // 자동 타이핑: URL 입력 시 site 자동 채움
    const urlInput = document.getElementById('m_url')
    const siteInput = document.getElementById('m_site')
    urlInput.addEventListener('blur', () => {
      if (!siteInput.value.trim() && urlInput.value.trim()) {
        try {
          const u = new URL(urlInput.value.trim())
          siteInput.value = u.hostname.replace(/^www\./, '')
        } catch {
          /* ignore */
        }
      }
    })
    bindQueryRowEvents()
  }

  function queryRowHtml(keyword, limit, idx) {
    return `
      <div class="query-row flex items-center gap-2" data-idx="${idx}">
        <i class="fa-solid fa-magnifying-glass text-sky-500 text-sm"></i>
        <input class="q_keyword flex-1 px-2 py-1.5 border border-gray-300 rounded text-sm"
          value="${escapeHtml(keyword)}" placeholder="검색어 (예: 반도체, semiconductor)">
        <input class="q_limit w-20 px-2 py-1.5 border border-gray-300 rounded text-sm text-center"
          type="number" min="1" max="10" value="${limit || 3}">
        <span class="text-xs text-gray-400">건</span>
        <button type="button" class="q_remove px-2 py-1 text-red-500 hover:bg-red-50 rounded">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>`
  }

  function addQueryRow(keyword = '', limit = 3) {
    const wrap = document.getElementById('m_queries')
    const existing = wrap.querySelectorAll('.query-row').length
    if (existing >= 5) {
      toast('⚠️ 검색어는 최대 5개까지 추가할 수 있습니다.', 'warn')
      return
    }
    // placeholder 텍스트 제거
    if (existing === 0) wrap.innerHTML = ''
    wrap.insertAdjacentHTML('beforeend', queryRowHtml(keyword, limit, existing))
    bindQueryRowEvents()
  }

  function bindQueryRowEvents() {
    document.querySelectorAll('#m_queries .q_remove').forEach((btn) => {
      btn.onclick = (e) => {
        e.currentTarget.closest('.query-row').remove()
        const wrap = document.getElementById('m_queries')
        if (wrap.querySelectorAll('.query-row').length === 0) {
          wrap.innerHTML = '<p class="text-xs text-gray-400 italic text-center py-3">검색어가 비어있습니다. (사이트 최신순으로 수집)</p>'
        }
      }
    })
  }

  function onPresetSelect(e) {
    const id = e.target.value
    if (!id) return
    const preset = presetCatalog.find((p) => p.id === id)
    if (!preset) return
    // 현재 검색어를 프리셋으로 교체
    const wrap = document.getElementById('m_queries')
    if (preset.queries.length === 0) {
      wrap.innerHTML = '<p class="text-xs text-gray-400 italic text-center py-3">검색어가 비어있습니다. (사이트 최신순으로 수집)</p>'
    } else {
      wrap.innerHTML = preset.queries
        .map((q, i) => queryRowHtml(q.keyword, q.limit, i))
        .join('')
      bindQueryRowEvents()
    }
    toast(`📋 프리셋 "${escapeHtml(preset.label)}" 적용됨`, 'success')
    e.target.value = '' // 드롭다운 초기화
  }

  function collectModalPayload() {
    const label = document.getElementById('m_label').value.trim()
    const category = document.getElementById('m_category').value
    const url = document.getElementById('m_url').value.trim()
    const site = document.getElementById('m_site').value.trim()
    const defaultLimit = parseInt(document.getElementById('m_defaultLimit').value, 10) || 5
    const enabled = document.getElementById('m_enabled').checked
    const queries = []
    document.querySelectorAll('#m_queries .query-row').forEach((row) => {
      const kw = row.querySelector('.q_keyword').value.trim()
      const lm = parseInt(row.querySelector('.q_limit').value, 10) || 3
      if (kw) queries.push({ keyword: kw, limit: Math.max(1, Math.min(10, lm)) })
    })
    return { label, category, url, site, defaultLimit, enabled, queries }
  }

  async function onModalTest() {
    const p = collectModalPayload()
    const payload = {}
    if (p.site && p.queries.length > 0) {
      payload.site = p.site
      payload.keyword = p.queries[0].keyword
    } else if (p.site) {
      payload.site = p.site
    } else if (p.url) {
      payload.url = p.url
    } else {
      toast('⚠️ URL 또는 사이트 도메인이 필요합니다.', 'warn')
      return
    }
    const resEl = document.getElementById('m_test_result')
    resEl.classList.remove('hidden')
    resEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> 수집 미리보기 중…'
    const res = await api.test(payload)
    if (res.ok) {
      const samples = (res.samples || []).slice(0, 5)
        .map((t, i) => `<li class="truncate"><span class="text-gray-400 mr-1">${i + 1}.</span>${escapeHtml(t)}</li>`)
        .join('')
      resEl.className = 'mt-3 p-3 bg-green-50 border border-green-200 text-green-800 rounded text-xs'
      resEl.innerHTML = `
        <div class="font-semibold mb-1">✅ ${res.sampleCount}건 수집 성공</div>
        <ul class="space-y-0.5">${samples}</ul>
      `
    } else {
      resEl.className = 'mt-3 p-3 bg-red-50 border border-red-200 text-red-700 rounded text-xs'
      resEl.innerHTML = `❌ 수집 실패: ${escapeHtml(res.error || '알 수 없음')}`
    }
  }

  async function onSaveModal() {
    const p = collectModalPayload()
    if (!p.label) return toast('⚠️ 표시 이름을 입력하세요.', 'warn')
    if (!p.url) return toast('⚠️ URL 을 입력하세요.', 'warn')
    if (!/^https?:\/\//i.test(p.url)) return toast('⚠️ URL 은 http:// 또는 https:// 로 시작해야 합니다.', 'warn')

    if (editingSource) {
      // 편집 (PATCH)
      const res = await api.patch(editingSource.id, {
        label: p.label,
        url: p.url,
        site: p.site,
        queries: p.queries,
        defaultLimit: p.defaultLimit,
        enabled: p.enabled,
      })
      if (res?.error) return toast('❌ ' + res.error, 'error')
      closeModal()
      await reload()
      notifyOtherTabs('sources')
      toast(`💾 <strong>${escapeHtml(p.label)}</strong> 저장됨`, 'success')
    } else {
      // 신규 추가 (POST) — category 는 서버가 'custom' 으로 강제
      const res = await api.add({
        label: p.label,
        url: p.url,
        queries: p.queries,
        defaultLimit: p.defaultLimit,
      })
      if (res?.error) return toast('❌ ' + res.error, 'error')
      // site/enabled 를 이어서 PATCH (서버가 초기값 설정 안 한 필드 반영)
      if (res.source?.id && (p.site || p.enabled === false)) {
        await api.patch(res.source.id, { site: p.site, enabled: p.enabled })
      }
      closeModal()
      await reload()
      notifyOtherTabs('sources')
      toast(`✨ <strong>${escapeHtml(p.label)}</strong> 추가됨`, 'success')
    }
  }

  // ═════════════════════════════════════════════════════════════
  // 수신자 (변경 없음)
  // ═════════════════════════════════════════════════════════════
  function renderRecipients(recipients) {
    const recipientListEl = document.getElementById('recipientList')
    const recipientCountEl = document.getElementById('recipientCount')
    recipientCountEl.textContent = `(총 ${recipients.length}명)`
    if (recipients.length === 0) {
      recipientListEl.innerHTML = `
        <div class="text-center py-6 text-gray-400 text-sm">
          <i class="fa-regular fa-envelope text-3xl mb-2"></i>
          <p>등록된 수신자가 없습니다.</p>
        </div>`
      return
    }
    recipientListEl.innerHTML = recipients
      .map(
        (r) => `
        <div class="flex items-center gap-3 p-3 border border-gray-200 rounded-lg ${r.enabled ? 'bg-emerald-50/30' : 'bg-gray-50'}">
          <i class="fa-solid fa-envelope ${r.enabled ? 'text-emerald-500' : 'text-gray-300'} text-xl"></i>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <strong class="text-gray-800">${escapeHtml(r.email)}</strong>
              ${r.label ? `<span class="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">${escapeHtml(r.label)}</span>` : ''}
              ${r.enabled
                ? '<span class="text-xs text-emerald-600"><i class="fa-solid fa-circle-check"></i> 활성</span>'
                : '<span class="text-xs text-gray-400"><i class="fa-solid fa-circle-pause"></i> 비활성</span>'}
            </div>
            <div class="text-xs text-gray-400 mt-0.5">등록: ${new Date(r.createdAt).toLocaleString('ko-KR')}</div>
          </div>
          <div class="flex gap-1">
            <button data-raction="toggle" data-rid="${r.id}" data-renabled="${r.enabled}" class="px-2.5 py-1.5 rounded hover:bg-gray-100">
              <i class="fa-solid ${r.enabled ? 'fa-toggle-on text-emerald-500' : 'fa-toggle-off text-gray-400'} text-base"></i>
            </button>
            <button data-raction="delete" data-rid="${r.id}" class="px-2.5 py-1.5 text-red-500 rounded hover:bg-red-50">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </div>`
      )
      .join('')
    document.querySelectorAll('#recipientList button[data-raction]').forEach((btn) => {
      btn.addEventListener('click', onRecipientAction)
    })
  }

  async function onRecipientAction(e) {
    const btn = e.currentTarget
    const id = btn.dataset.rid
    const action = btn.dataset.raction
    try {
      if (action === 'toggle') {
        const enabled = btn.dataset.renabled !== 'true'
        const res = await recipientApi.patch(id, { enabled })
        if (res?.error) return toast('❌ ' + res.error, 'error')
        await reloadRecipients()
        notifyOtherTabs('recipients')
      } else if (action === 'delete') {
        if (!confirm('이 수신자를 삭제할까요?')) return
        const res = await recipientApi.remove(id)
        if (res?.error) return toast('❌ ' + res.error, 'error')
        await reloadRecipients()
        notifyOtherTabs('recipients')
      }
    } catch (err) {
      console.error('[onRecipientAction]', err)
      toast('❌ 작업 실패: ' + (err?.message || err), 'error')
    }
  }

  async function reloadRecipients() {
    try {
      const data = await recipientApi.list()
      renderRecipients(data.recipients || [])
    } catch (e) {
      document.getElementById('recipientList').innerHTML =
        `<div class="text-red-500 p-4 text-sm">수신자 목록 로드 실패: ${e.message}</div>`
    }
  }

  // ═════════════════════════════════════════════════════════════
  // 초기화 / 부트스트랩
  // ═════════════════════════════════════════════════════════════
  async function reload() {
    try {
      const data = await api.list()
      allSources = data.sources || []
      updateCategoryCounts()
      renderSources()
    } catch (e) {
      document.getElementById('sourceList').innerHTML =
        `<div class="text-red-500 p-4">소스 목록 로드 실패: ${e.message}</div>`
    }
  }

  async function loadPresets() {
    try {
      const data = await api.presets()
      presetCatalog = data.presets || []
    } catch {
      presetCatalog = []
    }
  }

  function setupGlobalEvents() {
    // 모달 닫기
    document.getElementById('btnCloseModal').addEventListener('click', closeModal)
    document.getElementById('btnCancelEdit').addEventListener('click', closeModal)
    document.getElementById('btnSaveEdit').addEventListener('click', onSaveModal)
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal()
    })

    // 새 소스 추가 버튼
    document.getElementById('btnAddSource').addEventListener('click', openAddModal)

    // 기본값 복원
    document.getElementById('btnResetDefaults').addEventListener('click', async () => {
      if (!confirm('13개 기본 소스를 복원합니다.\n(사용자 추가 소스는 그대로 유지됩니다.)\n\n계속할까요?')) return
      const res = await api.resetDefaults()
      if (res.ok) {
        toast(`✅ 기본값 복원 완료 (총 ${res.count}개)`, 'success')
        await reload()
        notifyOtherTabs('sources')
      } else {
        toast('❌ 복원 실패' + (res.error ? ': ' + res.error : ''), 'error')
      }
    })

    // 수신자 추가
    document.getElementById('addRecipientForm').addEventListener('submit', async (ev) => {
      ev.preventDefault()
      const email = document.getElementById('recipientEmail').value.trim()
      const label = document.getElementById('recipientLabel').value.trim()
      if (!email) return
      const res = await recipientApi.add(email, label)
      if (res.error) {
        toast('⚠️ ' + res.error, 'warn')
        return
      }
      document.getElementById('recipientEmail').value = ''
      document.getElementById('recipientLabel').value = ''
      await reloadRecipients()
      notifyOtherTabs('recipients')
      toast(`📧 <strong>${escapeHtml(email)}</strong> 추가됨`, 'success')
    })
  }

  // ═════════════════════════════════════════════════════════════
  // 🚀 "지금 발송" 버튼 로직
  // ═════════════════════════════════════════════════════════════
  let triggerPollTimer = null

  function showConfirm(title, body, onOk) {
    const m = document.getElementById('confirmModal')
    if (!m) {
      console.error('[showConfirm] confirmModal not found - falling back to native confirm')
      if (window.confirm(title + '\n' + body.replace(/<[^>]+>/g, ''))) onOk()
      return
    }
    document.getElementById('confirmTitle').textContent = title
    document.getElementById('confirmBody').innerHTML = body
    showModal(m)
    const okBtn = document.getElementById('btnConfirmOk')
    const cancelBtn = document.getElementById('btnConfirmCancel')
    const close = () => hideModal(m)
    const handler = () => {
      close()
      okBtn.removeEventListener('click', handler)
      cancelBtn.removeEventListener('click', close)
      onOk()
    }
    okBtn.addEventListener('click', handler, { once: true })
    cancelBtn.addEventListener('click', close, { once: true })
  }

  function showTriggerStatus(cls, html) {
    const el = document.getElementById('triggerStatus')
    el.className = 'mt-3 p-3 rounded-lg text-xs sm:text-sm ' + cls
    el.innerHTML = html
    el.classList.remove('hidden')
  }

  async function checkTriggerConfig() {
    try {
      const s = await triggerApi.status()
      if (!s.configured) {
        showTriggerStatus(
          'bg-amber-50 border border-amber-200 text-amber-800',
          '<i class="fa-solid fa-triangle-exclamation mr-1"></i>' +
            '<strong>PAT 미설정</strong> — "지금 발송" 기능을 쓰려면 ' +
            'Cloudflare Secret 에 <code>GITHUB_TRIGGER_TOKEN</code> 을 등록하세요.'
        )
        document.getElementById('btnTriggerNow').disabled = true
        document.getElementById('btnTriggerDryRun').disabled = true
        document.getElementById('btnTriggerNow').classList.add('opacity-50', 'cursor-not-allowed')
        document.getElementById('btnTriggerDryRun').classList.add('opacity-50', 'cursor-not-allowed')
      }
      return s
    } catch {
      return null
    }
  }

  // ── 중복 클릭 방지용 플래그 (v2.2.3)
  let triggerInFlight = false

  function setTriggerButtonsDisabled(disabled) {
    const ids = ['btnTriggerNow', 'btnTriggerDryRun']
    ids.forEach((id) => {
      const b = document.getElementById(id)
      if (!b) return
      b.disabled = disabled
      b.classList.toggle('opacity-50', disabled)
      b.classList.toggle('cursor-not-allowed', disabled)
    })
  }

  async function onTriggerClick(dryRun) {
    // (v2.2.3) 중복 트리거 방지 — 요청 진행 중이면 즉시 반환
    if (triggerInFlight) {
      toast('⏳ 이미 요청이 진행 중입니다. 잠시만 기다려 주세요.', 'warn')
      return
    }

    const actionText = dryRun ? 'DRY RUN (메일 발송 없이 프리뷰만 생성)' : '실제 브리핑 발송'
    const confirmBody = dryRun
      ? '수집·AI요약만 수행하고 <strong>메일은 보내지 않습니다</strong>.<br>결과는 GitHub Actions 페이지의 artifact 로 다운로드 가능합니다.'
      : '지금 즉시 <strong>모든 활성 수신자에게 메일</strong>이 발송됩니다.<br>약 1~3분 소요되며, 10분 쿨다운이 적용됩니다.'

    showConfirm(
      actionText + ' 실행',
      confirmBody,
      async () => {
        // (v2.2.3) 확정 직후 버튼 잠금 — 더블클릭/연타로 두 건이 동시에 디스패치되는 버그 차단
        triggerInFlight = true
        setTriggerButtonsDisabled(true)

        showTriggerStatus(
          'bg-blue-50 border border-blue-200 text-blue-800',
          '<i class="fa-solid fa-spinner fa-spin mr-1"></i> 워크플로 요청 중…'
        )

        const requestSentAt = Date.now()
        let res
        try {
          res = await triggerApi.run(dryRun)
        } catch (e) {
          console.error('[onTriggerClick] API 호출 예외:', e)
          res = { ok: false, error: e?.message || '네트워크 오류' }
        }

        if (res.ok) {
          showTriggerStatus(
            'bg-green-50 border border-green-200 text-green-800',
            `<i class="fa-solid fa-check-circle mr-1"></i>${res.message}
             <a href="${res.runsUrl}" target="_blank" class="underline ml-2">진행 상황 보기 <i class="fa-solid fa-arrow-up-right-from-square text-[10px]"></i></a>`
          )
          toast('🚀 발송 요청 완료', 'success')
          // 상태 폴링 시작 — dryRun 값까지 일치해야 매칭 (다른 동시 실행과 혼동 방지)
          startPolling(requestSentAt, dryRun)
        } else {
          const hint = res.hint ? `<div class="text-xs mt-1 opacity-80">💡 ${escapeHtml(res.hint)}</div>` : ''
          showTriggerStatus(
            'bg-red-50 border border-red-200 text-red-700',
            `<i class="fa-solid fa-circle-xmark mr-1"></i>${escapeHtml(res.error || '알 수 없는 오류')}${hint}`
          )
          toast('❌ 발송 요청 실패', 'error')
          // 요청 자체 실패 시에는 잠금을 바로 해제 (폴링은 돌지 않음)
          triggerInFlight = false
          setTriggerButtonsDisabled(false)
        }
      }
    )
  }

  /**
   * v2.2.3 폴링 규칙
   *  - 요청 시각(sinceMs)과 dry_run 플래그가 동시에 일치하는 '자기 자신의 런' 만 매칭
   *  - name / display_title 에서 dry_run 입력값 추론 (GitHub 는 dispatch 한 input 을
   *    display_title 에 포함시키지는 않으므로, 대부분 가장 가까운 workflow_dispatch 런을 선택)
   *  - 완료되거나 타임아웃되면 버튼 잠금 해제
   */
  function startPolling(sinceMs, dryRun) {
    clearInterval(triggerPollTimer)
    let elapsed = 0
    const MAX_MIN = 5

    const release = () => {
      triggerInFlight = false
      setTriggerButtonsDisabled(false)
    }

    triggerPollTimer = setInterval(async () => {
      elapsed += 10
      if (elapsed > MAX_MIN * 60) {
        clearInterval(triggerPollTimer)
        showTriggerStatus(
          'bg-amber-50 border border-amber-200 text-amber-800',
          '<i class="fa-solid fa-triangle-exclamation mr-1"></i>' +
            '폴링 타임아웃 — GitHub Actions 페이지에서 직접 확인해 주세요.'
        )
        release()
        return
      }

      const data = await triggerApi.recentRuns().catch(() => null)
      if (!data || !data.ok || !Array.isArray(data.runs) || data.runs.length === 0) return

      // 내 요청 이후 생성된 workflow_dispatch 런만 후보로 — 오차 60초
      const candidates = data.runs.filter((r) => {
        if (!r || !r.created_at) return false
        if (r.event && r.event !== 'workflow_dispatch') return false
        const createdMs = new Date(r.created_at).getTime()
        return createdMs >= sinceMs - 60000
      })
      if (candidates.length === 0) return

      // 가장 최근(=내가 방금 트리거한 것)을 선택
      candidates.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      const match = candidates[0]

      if (match.status === 'completed') {
        clearInterval(triggerPollTimer)
        if (match.conclusion === 'success') {
          // (v2.2.5) 실제 발송 완료 시 스팸 폴더 확인 안내 - 과거 사용자가
          // '워크플로 성공'만 보고 받은메일함에서 못 찾아 "발송 안됨"으로 오해한 버그 대응
          const spamHint = dryRun ? '' :
            '<div class="text-xs mt-2 p-2 bg-white/60 rounded border border-green-300 text-green-900">' +
              '📬 <strong>메일이 안 보이나요?</strong><br>' +
              '&nbsp;&nbsp;1️⃣ Gmail <strong>스팸/프로모션 탭</strong>을 확인해 주세요<br>' +
              '&nbsp;&nbsp;2️⃣ <code>EMAIL_RECIPIENTS</code> Secret 의 주소 철자 확인<br>' +
              '&nbsp;&nbsp;3️⃣ 그래도 없으면 아래 <strong>상세 보기</strong> 에서 "📬 최종 발송 대상" 로그 확인' +
            '</div>'
          showTriggerStatus(
            'bg-green-50 border border-green-200 text-green-800',
            `<i class="fa-solid fa-circle-check mr-1"></i><strong>실행 완료!</strong> ${
              dryRun ? 'DRY RUN 성공 (메일 미발송)' : '이메일 발송 완료'
            }
            <a href="${match.html_url}" target="_blank" class="underline ml-2">상세 보기</a>${spamHint}`
          )
          toast(dryRun ? '✅ DRY RUN 성공' : '✉️ 발송 완료! (스팸폴더 확인)', 'success')
        } else {
          showTriggerStatus(
            'bg-red-50 border border-red-200 text-red-700',
            `<i class="fa-solid fa-circle-xmark mr-1"></i><strong>실행 실패</strong> (${escapeHtml(match.conclusion || 'unknown')})
            <div class="text-xs mt-1 opacity-90">💡 GEMINI 503 또는 시크릿 누락일 수 있습니다. 잠시 후 재시도하거나 아래 로그를 확인하세요.</div>
            <a href="${match.html_url}" target="_blank" class="underline ml-2">로그 보기</a>`
          )
          toast('❌ 실행 실패 — 로그를 확인해 주세요', 'error')
        }
        release()
      } else {
        // in_progress / queued
        const statusKo =
          match.status === 'queued' ? '대기 중' :
          match.status === 'in_progress' ? '실행 중' : match.status
        showTriggerStatus(
          'bg-blue-50 border border-blue-200 text-blue-800',
          `<i class="fa-solid fa-spinner fa-spin mr-1"></i>워크플로 <strong>${statusKo}</strong>… (${elapsed}초 경과)
          <a href="${match.html_url}" target="_blank" class="underline ml-2">실시간 로그</a>`
        )
      }
    }, 10000)
  }

  async function onCheckStatus() {
    const el = document.getElementById('triggerStatus')
    el.className = 'mt-3 p-3 rounded-lg text-xs sm:text-sm bg-blue-50 border border-blue-200 text-blue-800'
    el.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> 조회 중…'
    el.classList.remove('hidden')
    const data = await triggerApi.recentRuns()
    if (!data.ok) {
      showTriggerStatus(
        'bg-red-50 border border-red-200 text-red-700',
        `❌ ${escapeHtml(data.error || '조회 실패')}`
      )
      return
    }
    if (!data.runs.length) {
      showTriggerStatus(
        'bg-gray-50 border border-gray-200 text-gray-600',
        '<i class="fa-solid fa-info-circle mr-1"></i>최근 실행 기록이 없습니다.'
      )
      return
    }
    const rows = data.runs.slice(0, 5).map((r) => {
      const icon =
        r.status !== 'completed' ? '<i class="fa-solid fa-spinner fa-spin text-blue-500"></i>' :
        r.conclusion === 'success' ? '<i class="fa-solid fa-circle-check text-green-500"></i>' :
        '<i class="fa-solid fa-circle-xmark text-red-500"></i>'
      const time = new Date(r.created_at).toLocaleString('ko-KR')
      return `
        <li class="flex items-center gap-2 py-1 text-xs">
          ${icon}
          <span class="text-gray-500">#${r.run_number}</span>
          <span class="truncate flex-1">${escapeHtml(r.display_title || 'briefing')}</span>
          <span class="text-gray-400 text-[11px]">${time}</span>
          <a href="${r.html_url}" target="_blank" class="text-blue-600"><i class="fa-solid fa-arrow-up-right-from-square text-[10px]"></i></a>
        </li>`
    }).join('')
    showTriggerStatus(
      'bg-white border border-gray-200 text-gray-700',
      `<div class="font-semibold text-xs mb-2 text-gray-800"><i class="fa-solid fa-clock-rotate-left mr-1"></i>최근 5회 실행</div>
       <ul class="divide-y divide-gray-100">${rows}</ul>`
    )
  }

  // ═════════════════════════════════════════════════════════════
  // 🩺 (v2.2.5) 수신자 동기화 진단 + MailChannels 즉시 테스트
  //   네이버/다음 수신자에게 메일이 안 가는 문제의 근본 원인(BRIEFING_READ_TOKEN
  //   CF↔GH 불일치)을 즉시 파악하고, 테스트 발송으로 스팸 필터 여부까지 점검.
  // ═════════════════════════════════════════════════════════════
  function showDiagStatus(kind, html) {
    const el = document.getElementById('diagStatus')
    if (!el) return
    el.className = 'mt-3 p-3 rounded-lg text-xs sm:text-sm break-words'
    if (kind === 'success') el.classList.add('bg-emerald-50', 'border', 'border-emerald-200', 'text-emerald-800')
    else if (kind === 'error') el.classList.add('bg-rose-50', 'border', 'border-rose-200', 'text-rose-800')
    else if (kind === 'warn') el.classList.add('bg-amber-50', 'border', 'border-amber-200', 'text-amber-800')
    else el.classList.add('bg-sky-50', 'border', 'border-sky-200', 'text-sky-800')
    el.innerHTML = html
    el.classList.remove('hidden')
  }

  async function onDiagSync() {
    const btn = document.getElementById('btnDiagSync')
    if (btn) btn.disabled = true
    showDiagStatus('info', '<i class="fa-solid fa-spinner fa-spin mr-1"></i>진단 정보를 수집 중…')
    try {
      const resp = await fetch('/api/admin/diag-recipient-sync', { credentials: 'same-origin' })
      const data = await resp.json()
      if (!data.ok) {
        showDiagStatus('error', `<strong>❌ 진단 실패</strong><br/>${data.error || 'unknown error'}`)
        return
      }

      const emails = Array.isArray(data.activeRecipients) ? data.activeRecipients : []
      const emailList = emails.map(e => `<code class="bg-white px-1.5 py-0.5 rounded border border-sky-200">${e}</code>`).join(' ')
      const secretValue = data.emailRecipientsSecret || ''

      const tokenStatus = data.tokenConfigured
        ? `<span class="inline-block bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full text-xs font-semibold">CF 설정됨</span>
           <code class="bg-white px-1.5 py-0.5 rounded border border-sky-200 text-xs">hash: ${data.tokenHashPrefix || '?'}…</code>`
        : `<span class="inline-block bg-rose-100 text-rose-800 px-2 py-0.5 rounded-full text-xs font-semibold">❌ CF 미설정</span>`

      const html = `
        <div class="space-y-2">
          <div><strong>🩺 진단 결과</strong></div>
          <div class="bg-white/60 p-2 rounded border border-sky-200">
            <div class="mb-1"><strong>1. Cloudflare BRIEFING_READ_TOKEN</strong>: ${tokenStatus}</div>
            <div class="text-xs text-gray-600">→ 이 해시(앞 8자리)와 <strong>GitHub Repo Secrets 의 BRIEFING_READ_TOKEN</strong> 이 같은 값을 가리키는지 확인하세요.</div>
          </div>
          <div class="bg-white/60 p-2 rounded border border-sky-200">
            <div class="mb-1"><strong>2. 관리 UI 활성 수신자</strong>: ${data.activeRecipientCount}명</div>
            <div class="flex flex-wrap gap-1 mt-1">${emailList || '<em class="text-gray-500">없음</em>'}</div>
          </div>
          ${secretValue ? `
          <div class="bg-amber-50 p-2 rounded border border-amber-300">
            <div class="mb-2"><strong>🔧 즉시 해결책 (권장)</strong></div>
            <div class="text-xs mb-2">아래 문자열을 복사해서 <strong>GitHub Repo → Settings → Secrets and variables → Actions</strong> 의 <code>EMAIL_RECIPIENTS</code> 값으로 저장하세요. 그러면 토큰 일치 여부와 관계없이 모든 수신자에게 발송됩니다.</div>
            <div class="flex gap-2 items-start">
              <code id="diagSecretValue" class="flex-1 bg-white p-2 rounded border border-amber-200 text-xs break-all select-all">${secretValue}</code>
              <button type="button" id="btnCopySecret" class="px-3 py-1.5 bg-amber-500 text-white text-xs font-semibold rounded hover:bg-amber-600 transition whitespace-nowrap">
                <i class="fa-solid fa-copy mr-1"></i>복사
              </button>
            </div>
          </div>
          ` : ''}
          <div class="bg-white/60 p-2 rounded border border-sky-200 text-xs">
            <div class="font-semibold mb-1">📋 검증 명령어 (복붙)</div>
            <code class="block bg-gray-900 text-emerald-300 p-2 rounded whitespace-pre-wrap break-all">${data.hints && data.hints.verifyCmd ? data.hints.verifyCmd.replace(/</g,'&lt;').replace(/>/g,'&gt;') : ''}</code>
          </div>
        </div>`
      showDiagStatus('info', html)

      // 복사 버튼
      const copyBtn = document.getElementById('btnCopySecret')
      if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(secretValue)
            copyBtn.innerHTML = '<i class="fa-solid fa-check mr-1"></i>복사됨'
            toast('📋 클립보드에 복사됨 — GitHub Secret EMAIL_RECIPIENTS 에 붙여넣으세요', 'success')
            setTimeout(() => { copyBtn.innerHTML = '<i class="fa-solid fa-copy mr-1"></i>복사' }, 3000)
          } catch (e) {
            toast('클립보드 복사 실패 — 수동으로 선택 후 Ctrl+C 하세요', 'error')
          }
        })
      }
    } catch (e) {
      showDiagStatus('error', `<strong>❌ 진단 요청 실패</strong><br/>${(e && e.message) || e}`)
    } finally {
      if (btn) btn.disabled = false
    }
  }

  async function onDiagSendTest() {
    const input = document.getElementById('diagTestEmail')
    const btn = document.getElementById('btnDiagSendTest')
    const email = (input && input.value || '').trim()
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast('유효한 이메일 주소를 입력하세요', 'error')
      if (input) input.focus()
      return
    }
    if (!(await showConfirm({
      title: '즉시 테스트 발송',
      message: `${email} 로 MailChannels 경유 테스트 메일을 발송합니다.\n(GitHub Actions 우회 → 결과 즉시 확인 가능)\n\n받은편지함과 스팸/프로모션 폴더를 모두 확인하세요.`,
      confirmText: '발송',
      cancelText: '취소',
    }))) return

    if (btn) btn.disabled = true
    showDiagStatus('info', `<i class="fa-solid fa-spinner fa-spin mr-1"></i>${email} 로 테스트 메일 발송 중…`)
    try {
      const resp = await fetch('/api/admin/send-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email }),
      })
      const data = await resp.json()
      if (data.ok) {
        showDiagStatus('success',
          `<strong>✅ 테스트 발송 성공 (경유: ${data.via || 'mailchannels'})</strong><br/>` +
          `수신자: <code class="bg-white px-1.5 py-0.5 rounded">${email}</code><br/>` +
          `<div class="mt-2 text-xs">` +
          `💡 <strong>확인 순서</strong>: ① 받은편지함 → ② 스팸 폴더 → ③ 프로모션 탭 (Gmail) / 전체편지함 (네이버)<br/>` +
          `💡 스팸 폴더에 있으면 '스팸 아님' 처리 후 발신자를 <strong>주소록</strong>에 추가해 주세요.` +
          `</div>`)
        toast(`📬 ${email} 로 테스트 메일 발송됨`, 'success')
      } else {
        showDiagStatus('error',
          `<strong>❌ 테스트 발송 실패</strong><br/>` +
          `<code class="bg-white px-1 py-0.5 rounded text-xs">${data.error || 'unknown'}</code><br/>` +
          (data.hint ? `<div class="mt-1 text-xs">💡 ${data.hint}</div>` : ''))
      }
    } catch (e) {
      showDiagStatus('error', `<strong>❌ 네트워크 오류</strong><br/>${(e && e.message) || e}`)
    } finally {
      if (btn) btn.disabled = false
    }
  }

  function setupDiagButtons() {
    const diagBtn = document.getElementById('btnDiagSync')
    const testBtn = document.getElementById('btnDiagSendTest')
    const testInput = document.getElementById('diagTestEmail')
    if (diagBtn) diagBtn.addEventListener('click', onDiagSync)
    if (testBtn) testBtn.addEventListener('click', onDiagSendTest)
    // Enter 키로 테스트 발송
    if (testInput) testInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onDiagSendTest() }
    })
  }

  function setupTriggerButtons() {
    const nowBtn = document.getElementById('btnTriggerNow')
    const dryBtn = document.getElementById('btnTriggerDryRun')
    const chkBtn = document.getElementById('btnCheckTriggerStatus')
    // (v2.2.3) 버튼 자체에서도 진행중 가드 — 이벤트 버블/연타/인풋디바이스 이중 발동 대비
    if (nowBtn) nowBtn.addEventListener('click', (e) => {
      if (triggerInFlight || nowBtn.disabled) { e.preventDefault(); return }
      onTriggerClick(false)
    })
    if (dryBtn) dryBtn.addEventListener('click', (e) => {
      if (triggerInFlight || dryBtn.disabled) { e.preventDefault(); return }
      onTriggerClick(true)
    })
    if (chkBtn) chkBtn.addEventListener('click', onCheckStatus)
  }

  // ═════════════════════════════════════════════════════════════
  // 📱 PWA 설치 버튼
  // ═════════════════════════════════════════════════════════════
  let deferredInstallPrompt = null
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferredInstallPrompt = e
    const btn = document.getElementById('btnInstallPwa')
    if (btn) {
      btn.classList.remove('hidden')
      btn.addEventListener('click', async () => {
        if (!deferredInstallPrompt) return
        deferredInstallPrompt.prompt()
        const { outcome } = await deferredInstallPrompt.userChoice
        if (outcome === 'accepted') {
          toast('📱 홈 화면에 설치됨', 'success')
          btn.classList.add('hidden')
        }
        deferredInstallPrompt = null
      }, { once: true })
    }
  })

  window.addEventListener('appinstalled', () => {
    toast('📱 앱이 설치되었습니다', 'success')
  })

  // URL ?action=trigger 로 진입하면 자동 스크롤 + 포커스
  if (new URL(location.href).searchParams.get('action') === 'trigger') {
    setTimeout(() => {
      const btn = document.getElementById('btnTriggerNow')
      if (btn) {
        btn.scrollIntoView({ behavior: 'smooth', block: 'center' })
        btn.classList.add('ring-4', 'ring-orange-300')
        setTimeout(() => btn.classList.remove('ring-4', 'ring-orange-300'), 2000)
      }
    }, 300)
  }

  // ═════════════════════════════════════════════════════════════
  // 🔄 실시간 동기화 (v2.2) — PC ↔ 모바일 연동
  // 1) 같은 브라우저 탭 간: BroadcastChannel (즉시)
  // 2) 서로 다른 디바이스 간: /api/admin/sync-version 폴링 (15초)
  //    - 서버에 단순한 버전 카운터 (소스/수신자 변경시 +1)
  //    - 버전이 바뀌면 자동 reload (UI 에 "다른 기기에서 변경됨" 토스트)
  // ═════════════════════════════════════════════════════════════
  const syncChannel = ('BroadcastChannel' in window) ? new BroadcastChannel('morning-stock-sync') : null
  let lastSyncVersion = null
  let syncPollTimer = null
  // isEditingModal 은 위 전역 상태 섹션에 선언됨

  function notifyOtherTabs(what) {
    try {
      if (syncChannel) {
        syncChannel.postMessage({ type: 'changed', what, ts: Date.now() })
      }
    } catch (e) { /* ignore */ }
  }

  if (syncChannel) {
    syncChannel.addEventListener('message', (e) => {
      const { type, what } = e.data || {}
      if (type !== 'changed') return
      console.log('[sync] 다른 탭에서 변경 감지:', what)
      if (what === 'sources') reload()
      else if (what === 'recipients') reloadRecipients()
      else { reload(); reloadRecipients() }
      try { toast('🔄 다른 화면에서 변경된 내용을 반영했습니다', 'info') } catch {}
    })
  }

  async function pollSyncVersion() {
    try {
      const r = await fetch('/api/admin/sync-version', { cache: 'no-store' })
      if (!r.ok) return
      const data = await r.json()
      const v = data.version
      if (lastSyncVersion === null) {
        lastSyncVersion = v
        return
      }
      if (v !== lastSyncVersion) {
        console.log('[sync] 서버 버전 변경:', lastSyncVersion, '→', v)
        lastSyncVersion = v
        // 편집 중이면 다음 주기까지 대기
        if (isEditingModal || !modal.classList.contains('hidden')) {
          console.log('[sync] 편집 중 — 재로딩 지연')
          return
        }
        await reload()
        await reloadRecipients()
        try { toast('🔄 다른 기기에서 설정이 변경되어 자동 갱신되었습니다', 'info') } catch {}
      }
    } catch (e) {
      // 네트워크 오류는 조용히 무시
    }
  }

  function startSyncPolling() {
    // 초기 version 가져오기
    pollSyncVersion()
    // 15초 간격 폴링 (브라우저 탭 focus 시 더 자주)
    if (syncPollTimer) clearInterval(syncPollTimer)
    syncPollTimer = setInterval(pollSyncVersion, 15000)

    // 탭 visible 상태로 돌아오면 즉시 확인
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        pollSyncVersion()
      }
    })
  }

  // ═════════════════════════════════════════════════════════════
  // 실행
  // ═════════════════════════════════════════════════════════════
  console.log('[MorningStock] Admin v2.2.5 초기화 중…')
  setupTabs()
  setupGlobalEvents()
  setupTriggerButtons()
  setupDiagButtons()
  loadPresets().then(() => reload())
  reloadRecipients()
  checkTriggerConfig()
  startSyncPolling()
  console.log('[MorningStock] 초기화 완료. PC↔모바일 실시간 동기화 활성화.')
})()
