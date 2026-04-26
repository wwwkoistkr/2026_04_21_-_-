/**
 * Morning Stock AI — Admin Dashboard Client Script v2.3.0
 * ───────────────────────────────────────────────────────
 * - 카테고리 탭 (🇰🇷/🌎/📺/➕/전체)
 * - 소스 카드: 검색어 태그 표시, 편집/테스트/삭제 버튼
 * - 편집 모달: label/url/site/queries/defaultLimit 편집 + 프리셋 적용 버튼
 * - 새 소스 추가: 모달 재사용
 * - 기본값 복원
 * - 토스트 알림
 * - PC↔모바일 실시간 동기화 (BroadcastChannel + 폴링)
 * - 글로벌 에러 핸들러로 사용자에게 친절한 에러 표시
 * BUILD: 2026-04-22 v2.3.0 (YouTube 수집 제거)
 * [v2.2.7] 🔴 CRITICAL FIX: 이메일 '발송완료' 오보고 + 로그인화면 복원
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
    // (v2.2.7) 일괄 작업 / Export / Import / Backup
    bulk: (ids, action) =>
      safeFetch('/api/admin/recipients/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action }),
      }),
    importData: (recipients, mode) =>
      safeFetch('/api/admin/recipients/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients, mode }),
      }),
    listBackups: () => safeFetch('/api/admin/recipients/backups'),
    restoreBackup: (date) =>
      safeFetch('/api/admin/recipients/backups/' + encodeURIComponent(date) + '/restore', {
        method: 'POST',
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
  // 📊 v2.4.0: 수집 대시보드 API
  // ═════════════════════════════════════════════════════════════
  const dashboardApi = {
    latest: () => safeFetch('/api/admin/latest-run'),
    history: () => safeFetch('/api/admin/run-history'),
    // v2.6.0: 3단계 파이프라인 상태
    pipelineState: (date) =>
      safeFetch('/api/admin/pipeline-state' + (date ? `?date=${date}` : '')),
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
  // v2.5.2: 유튜브 카테고리 제거
  const CATEGORY_META = {
    kr: { icon: '🇰🇷', name: '한국' },
    us: { icon: '🌎', name: '미국' },
    custom: { icon: '➕', name: '사용자' },
  }

  const TYPE_LABEL = {
    rss: 'RSS',
    google_news: 'Google News',
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
        updateAddButtonState()  // v2.5.2
      })
    })
  }

  // v2.5.2: "새 소스 추가" 는 '사용자' 또는 '전체' 탭에서만 활성화
  //   → 이후 편집 화면에서 카테고리를 kr/us/custom 중 선택해서 재분류
  function updateAddButtonState() {
    const btn = document.getElementById('btnAddSource')
    if (!btn) return
    const allowed = (currentCategory === 'custom' || currentCategory === 'all')
    if (allowed) {
      btn.disabled = false
      btn.classList.remove('opacity-50', 'cursor-not-allowed')
      btn.title = '새 소스를 추가합니다 (카테고리는 편집 창에서 선택)'
    } else {
      btn.disabled = true
      btn.classList.add('opacity-50', 'cursor-not-allowed')
      btn.title = '새 소스 추가는 "사용자" 탭에서만 가능합니다. 추가 후 편집에서 카테고리(한국/미국)로 변경하세요.'
    }
  }

  function updateCategoryCounts() {
    // v2.5.2: 유튜브 카운트 제거
    const counts = { all: allSources.length, kr: 0, us: 0, custom: 0 }
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

    // v2.5.3: 수집 방식 기본값 — 기존 소스는 저장값, 신규는 google_news (권장)
    const currentType = s.type || 'google_news'
    modalBody.innerHTML = `
      <div class="space-y-4">
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
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
              <option value="custom" ${s.category === 'custom' ? 'selected' : ''}>➕ 사용자</option>
            </select>
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">
              수집 방식 <span class="text-[10px] text-gray-400 font-normal">(v2.5.3)</span>
            </label>
            <select id="m_type" class="w-full px-3 py-2 border border-gray-300 rounded text-sm">
              <option value="google_news" ${currentType === 'google_news' ? 'selected' : ''}>🔎 Google News 검색 (권장)</option>
              <option value="rss" ${currentType === 'rss' ? 'selected' : ''}>📡 RSS 직접 수집</option>
              <option value="web" ${currentType === 'web' ? 'selected' : ''}>🌐 Web (수집 불가·스킵)</option>
            </select>
            <p class="text-[11px] text-gray-400 mt-1">
              일반 사이트(reuters.com 등)는 <b>Google News 검색</b> 선택.
            </p>
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
            <label class="block text-xs font-semibold text-gray-600 mb-1">URL (홈 또는 RSS)</label>
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
    // v2.5.3: 수집 방식 필드 추가
    const typeEl = document.getElementById('m_type')
    const type = typeEl ? typeEl.value : 'google_news'
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
    return { label, category, type, url, site, defaultLimit, enabled, queries }
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
      // 편집 (PATCH) — v2.5.3: category + type 전송
      const res = await api.patch(editingSource.id, {
        label: p.label,
        category: p.category,       // ← v2.5.2: 카테고리 변경 허용
        type: p.type,               // ← v2.5.3: 수집 방식 변경 허용
        url: p.url,
        site: p.site,
        queries: p.queries,
        defaultLimit: p.defaultLimit,
        enabled: p.enabled,
      })
      if (res?.error) return toast('❌ ' + res.error, 'error')
      closeModal()
      // v2.5.2: 카테고리를 바꿨으면 해당 탭으로 자동 이동
      if (p.category && p.category !== editingSource.category && p.category !== currentCategory) {
        const tab = document.querySelector(`.cat-tab[data-cat="${p.category}"]`)
        if (tab) tab.click()
      }
      await reload()
      notifyOtherTabs('sources')
      toast(`💾 <strong>${escapeHtml(p.label)}</strong> 저장됨`, 'success')
    } else {
      // 신규 추가 (POST)
      // v2.5.3: category + type 둘 다 명시적으로 전송
      //   - v2.5.2 fix: category 를 프론트에서 전송 (이전엔 무시돼서 무조건 'custom' 저장됨)
      //   - v2.5.3 fix: type 도 전송 (이전엔 서버에서 detectSourceType 로 재판정 → 'web' 로 고정됨)
      const res = await api.add({
        label: p.label,
        category: p.category,     // ← v2.5.2
        type: p.type,             // ← v2.5.3: 수집 방식 전송
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
      // v2.5.2: 저장한 카테고리 탭으로 자동 이동하여 결과가 바로 보이게
      const targetCat = p.category || 'custom'
      if (targetCat !== currentCategory && targetCat !== 'all') {
        const tab = document.querySelector(`.cat-tab[data-cat="${targetCat}"]`)
        if (tab) tab.click()
      }
      await reload()
      notifyOtherTabs('sources')
      toast(`✨ <strong>${escapeHtml(p.label)}</strong> 추가됨 (${CATEGORY_META[targetCat]?.name || '사용자'})`, 'success')
    }
  }

  // ═════════════════════════════════════════════════════════════
  // 📬 수신자 관리 (v2.2.7 대폭 업그레이드)
  //   - 편집 버튼: 이메일/별명 수정 모달
  //   - 체크박스 + 일괄 작업 (활성/비활성/삭제)
  //   - Export / Import (JSON)
  //   - 발송 이력 표시 (lastSentAt, sentCount, lastFailedReason)
  //   - 커스텀 confirm 모달 (PWA/모바일에서도 확실히 동작)
  //   - 자동 백업 (7일 보관, 복원 가능)
  // ═════════════════════════════════════════════════════════════
  let currentRecipients = []           // 마지막 로드된 수신자 목록 (편집/일괄작업용 캐시)
  const selectedRecipientIds = new Set()

  function fmtDate(iso) {
    if (!iso) return ''
    try { return new Date(iso).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) }
    catch { return iso }
  }

  function fmtRelative(iso) {
    if (!iso) return '없음'
    try {
      const diff = Date.now() - new Date(iso).getTime()
      if (diff < 60_000) return '방금 전'
      if (diff < 3600_000) return `${Math.floor(diff/60_000)}분 전`
      if (diff < 86400_000) return `${Math.floor(diff/3600_000)}시간 전`
      if (diff < 7 * 86400_000) return `${Math.floor(diff/86400_000)}일 전`
      return new Date(iso).toLocaleDateString('ko-KR')
    } catch { return '' }
  }

  function renderRecipients(recipients) {
    currentRecipients = Array.isArray(recipients) ? recipients : []
    const recipientListEl = document.getElementById('recipientList')
    const recipientCountEl = document.getElementById('recipientCount')
    const activeCount = currentRecipients.filter(r => r.enabled).length
    const inactiveCount = currentRecipients.length - activeCount
    recipientCountEl.innerHTML = `(총 <strong>${currentRecipients.length}</strong>명 · 활성 ${activeCount}${inactiveCount > 0 ? ` · 비활성 ${inactiveCount}` : ''})`

    // 선택 상태 정리 — 삭제된 ID 는 Set 에서 제거
    const validIds = new Set(currentRecipients.map(r => r.id))
    for (const id of Array.from(selectedRecipientIds)) {
      if (!validIds.has(id)) selectedRecipientIds.delete(id)
    }

    if (currentRecipients.length === 0) {
      recipientListEl.innerHTML = `
        <div class="text-center py-6 text-gray-400 text-sm">
          <i class="fa-regular fa-envelope text-3xl mb-2"></i>
          <p>등록된 수신자가 없습니다.</p>
        </div>`
      updateBulkBar()
      return
    }

    recipientListEl.innerHTML = currentRecipients
      .map((r) => {
        const isChecked = selectedRecipientIds.has(r.id)
        const sentInfo = r.sentCount || r.lastSentAt
          ? `<span class="text-xs text-emerald-600" title="총 ${r.sentCount || 0}회 발송 성공">
               <i class="fa-solid fa-paper-plane"></i> ${r.sentCount || 0}회
               ${r.lastSentAt ? ` · <span class="text-gray-500">마지막 ${fmtRelative(r.lastSentAt)}</span>` : ''}
             </span>`
          : '<span class="text-xs text-gray-400" title="발송 이력 없음"><i class="fa-regular fa-circle"></i> 이력 없음</span>'
        const failedInfo = r.lastFailedReason
          ? `<div class="text-xs text-rose-500 mt-1 truncate" title="${escapeHtml(r.lastFailedReason)}">
               <i class="fa-solid fa-triangle-exclamation"></i> 최근 실패: ${escapeHtml(r.lastFailedReason.slice(0, 60))}
             </div>`
          : ''
        return `
        <div class="recipient-row flex items-center gap-2 sm:gap-3 p-2.5 sm:p-3 border rounded-lg transition ${r.enabled ? 'bg-emerald-50/30 border-emerald-100 hover:border-emerald-300' : 'bg-gray-50 border-gray-200'} ${isChecked ? 'ring-2 ring-sky-300' : ''}"
             data-rid="${r.id}">
          <label class="flex-shrink-0 cursor-pointer p-1 -m-1">
            <input type="checkbox" class="recipient-checkbox w-4 h-4 sm:w-5 sm:h-5 accent-sky-500" data-rid="${r.id}" ${isChecked ? 'checked' : ''}>
          </label>
          <i class="fa-solid fa-envelope ${r.enabled ? 'text-emerald-500' : 'text-gray-300'} text-lg sm:text-xl hidden sm:block"></i>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <strong class="text-gray-800 text-sm sm:text-base break-all">${escapeHtml(r.email)}</strong>
              ${r.label ? `<span class="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">${escapeHtml(r.label)}</span>` : ''}
              ${r.enabled
                ? '<span class="text-xs text-emerald-600"><i class="fa-solid fa-circle-check"></i> 활성</span>'
                : '<span class="text-xs text-gray-400"><i class="fa-solid fa-circle-pause"></i> 비활성</span>'}
            </div>
            <div class="flex items-center gap-3 flex-wrap mt-1 text-xs text-gray-500">
              <span title="등록: ${fmtDate(r.createdAt)}"><i class="fa-regular fa-calendar-plus"></i> ${fmtRelative(r.createdAt)}</span>
              ${r.updatedAt ? `<span title="마지막 수정: ${fmtDate(r.updatedAt)}"><i class="fa-solid fa-pen"></i> ${fmtRelative(r.updatedAt)}</span>` : ''}
              ${sentInfo}
            </div>
            ${failedInfo}
          </div>
          <div class="flex gap-0.5 sm:gap-1 flex-shrink-0">
            <button data-raction="toggle" data-rid="${r.id}" data-renabled="${r.enabled}" class="touch-target w-10 h-10 sm:w-11 sm:h-11 flex items-center justify-center rounded-lg hover:bg-gray-100" title="${r.enabled ? '비활성화' : '활성화'}">
              <i class="fa-solid ${r.enabled ? 'fa-toggle-on text-emerald-500' : 'fa-toggle-off text-gray-400'} text-lg"></i>
            </button>
            <button data-raction="edit" data-rid="${r.id}" class="touch-target w-10 h-10 sm:w-11 sm:h-11 flex items-center justify-center text-sky-600 rounded-lg hover:bg-sky-50" title="편집">
              <i class="fa-solid fa-pen-to-square"></i>
            </button>
            <button data-raction="delete" data-rid="${r.id}" class="touch-target w-10 h-10 sm:w-11 sm:h-11 flex items-center justify-center text-rose-500 rounded-lg hover:bg-rose-50" title="삭제">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </div>`
      })
      .join('')

    // 이벤트 바인딩
    document.querySelectorAll('#recipientList button[data-raction]').forEach((btn) => {
      btn.addEventListener('click', onRecipientAction)
    })
    document.querySelectorAll('#recipientList .recipient-checkbox').forEach((cb) => {
      cb.addEventListener('change', onRecipientCheckbox)
    })
    updateBulkBar()
  }

  function onRecipientCheckbox(e) {
    const id = e.currentTarget.dataset.rid
    if (e.currentTarget.checked) selectedRecipientIds.add(id)
    else selectedRecipientIds.delete(id)
    // 행 하이라이트 즉시 갱신
    const row = document.querySelector(`.recipient-row[data-rid="${id}"]`)
    if (row) row.classList.toggle('ring-2', e.currentTarget.checked)
    if (row) row.classList.toggle('ring-sky-300', e.currentTarget.checked)
    updateBulkBar()
  }

  function updateBulkBar() {
    const bar = document.getElementById('recipientBulkBar')
    if (!bar) return
    const count = selectedRecipientIds.size
    if (count === 0) {
      bar.classList.add('hidden')
    } else {
      bar.classList.remove('hidden')
      const countEl = document.getElementById('recipientBulkCount')
      if (countEl) countEl.textContent = count
    }
    // 전체선택 체크박스 상태
    const all = document.getElementById('recipientCheckAll')
    if (all) {
      all.checked = currentRecipients.length > 0 && count === currentRecipients.length
      all.indeterminate = count > 0 && count < currentRecipients.length
    }
  }

  async function onRecipientAction(e) {
    const btn = e.currentTarget
    const id = btn.dataset.rid
    const action = btn.dataset.raction
    const target = currentRecipients.find(r => r.id === id)
    if (!target) return
    try {
      if (action === 'toggle') {
        const enabled = btn.dataset.renabled !== 'true'
        const res = await recipientApi.patch(id, { enabled })
        if (res?.error) return toast('❌ ' + res.error, 'error')
        toast(`${enabled ? '✅ 활성화' : '⏸ 비활성화'} · ${target.email}`, 'success')
        await reloadRecipients()
        notifyOtherTabs('recipients')
      } else if (action === 'edit') {
        openRecipientEditModal(target)
      } else if (action === 'delete') {
        const ok = await showConfirm({
          title: '수신자 삭제',
          message: `<div>다음 수신자를 삭제합니다:</div>
                    <div class="mt-2 p-3 bg-rose-50 border border-rose-200 rounded-lg font-semibold text-rose-800 break-all">
                      ${escapeHtml(target.email)}${target.label ? ' (' + escapeHtml(target.label) + ')' : ''}
                    </div>
                    <div class="mt-2 text-xs text-gray-500">🛡️ 실수로 삭제해도 7일 이내라면 자동 백업에서 복원 가능합니다.</div>`,
          confirmText: '삭제',
          cancelText: '취소',
          danger: true,
        })
        if (!ok) return
        const res = await recipientApi.remove(id)
        if (res?.error) return toast('❌ ' + res.error, 'error')
        toast(`🗑️ 삭제됨 · ${target.email}`, 'success')
        selectedRecipientIds.delete(id)
        await reloadRecipients()
        notifyOtherTabs('recipients')
      }
    } catch (err) {
      console.error('[onRecipientAction]', err)
      toast('❌ 작업 실패: ' + (err?.message || err), 'error')
    }
  }

  /** 수신자 편집 모달 열기 — 이메일/별명/활성 상태 수정 */
  function openRecipientEditModal(recipient) {
    let modal = document.getElementById('recipientEditModal')
    if (!modal) {
      // 모달이 아직 DOM 에 없으면 동적으로 생성 (HTML 렌더링 확장 없이 추가)
      modal = document.createElement('div')
      modal.id = 'recipientEditModal'
      modal.className = 'modal-hidden fixed inset-0 bg-black/50 z-50 p-4 overflow-y-auto'
      modal.innerHTML = `
        <div class="bg-white rounded-xl shadow-2xl w-full max-w-md mx-auto my-auto p-5 sm:p-6">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-lg font-bold text-gray-800"><i class="fa-solid fa-pen-to-square text-sky-500 mr-2"></i>수신자 편집</h3>
            <button id="btnRecipientEditClose" class="touch-target w-10 h-10 flex items-center justify-center text-gray-400 hover:text-gray-600 rounded-lg">
              <i class="fa-solid fa-xmark text-xl"></i>
            </button>
          </div>
          <div class="space-y-3">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">이메일 주소</label>
              <input id="recipientEditEmail" type="email" autocomplete="email" inputmode="email"
                     class="touch-target w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500">
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">별명 <span class="text-gray-400 text-xs">(선택)</span></label>
              <input id="recipientEditLabel" type="text"
                     class="touch-target w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500"
                     placeholder="예: 홍길동, 팀장님">
            </div>
            <label class="flex items-center gap-2 p-2 rounded-lg bg-gray-50 cursor-pointer">
              <input id="recipientEditEnabled" type="checkbox" class="w-5 h-5 accent-emerald-500">
              <span class="text-sm text-gray-700">활성 상태 (매일 브리핑 수신)</span>
            </label>
            <div id="recipientEditError" class="hidden text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg p-2"></div>
            <div id="recipientEditStats" class="text-xs text-gray-500 border-t pt-3"></div>
          </div>
          <div class="flex gap-2 mt-5">
            <button id="btnRecipientEditCancel" class="touch-target flex-1 px-4 py-2.5 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition">취소</button>
            <button id="btnRecipientEditSave" class="touch-target flex-1 px-4 py-2.5 bg-sky-600 text-white font-semibold rounded-lg hover:bg-sky-700 transition">
              <i class="fa-solid fa-check mr-1"></i>저장
            </button>
          </div>
        </div>`
      document.body.appendChild(modal)
    }

    // 값 채우기
    document.getElementById('recipientEditEmail').value = recipient.email || ''
    document.getElementById('recipientEditLabel').value = recipient.label || ''
    document.getElementById('recipientEditEnabled').checked = !!recipient.enabled
    const errEl = document.getElementById('recipientEditError')
    errEl.classList.add('hidden'); errEl.textContent = ''

    // 통계 표시
    const statsEl = document.getElementById('recipientEditStats')
    statsEl.innerHTML = `
      등록: ${fmtDate(recipient.createdAt)}
      ${recipient.updatedAt ? `<br>마지막 수정: ${fmtDate(recipient.updatedAt)}` : ''}
      ${recipient.lastSentAt ? `<br>마지막 발송: ${fmtDate(recipient.lastSentAt)} (총 ${recipient.sentCount || 0}회)` : ''}
      ${recipient.lastFailedReason ? `<br><span class="text-rose-500">최근 실패: ${escapeHtml(recipient.lastFailedReason)}</span>` : ''}`

    showModal(modal)

    // 이벤트 (매번 새로 바인딩 — 이전 핸들러 제거용으로 .cloneNode 사용)
    const saveBtn = document.getElementById('btnRecipientEditSave')
    const cancelBtn = document.getElementById('btnRecipientEditCancel')
    const closeBtn = document.getElementById('btnRecipientEditClose')
    // 기존 핸들러 제거 — clone 으로 replace
    const newSave = saveBtn.cloneNode(true); saveBtn.parentNode.replaceChild(newSave, saveBtn)
    const newCancel = cancelBtn.cloneNode(true); cancelBtn.parentNode.replaceChild(newCancel, cancelBtn)
    const newClose = closeBtn.cloneNode(true); closeBtn.parentNode.replaceChild(newClose, closeBtn)

    const closeHandler = () => hideModal(modal)
    newCancel.addEventListener('click', closeHandler)
    newClose.addEventListener('click', closeHandler)

    newSave.addEventListener('click', async () => {
      const email = document.getElementById('recipientEditEmail').value.trim().toLowerCase()
      const label = document.getElementById('recipientEditLabel').value.trim()
      const enabled = document.getElementById('recipientEditEnabled').checked
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errEl.textContent = '올바른 이메일 주소를 입력해 주세요.'
        errEl.classList.remove('hidden'); return
      }
      newSave.disabled = true
      newSave.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i>저장 중…'
      try {
        const res = await recipientApi.patch(recipient.id, { email, label, enabled })
        if (res?.error) {
          errEl.textContent = '❌ ' + res.error
          errEl.classList.remove('hidden')
          newSave.disabled = false
          newSave.innerHTML = '<i class="fa-solid fa-check mr-1"></i>저장'
          return
        }
        hideModal(modal)
        toast(res.changed ? `✅ 수정됨 · ${email}` : 'ℹ️ 변경사항 없음', 'success')
        await reloadRecipients()
        notifyOtherTabs('recipients')
      } catch (e) {
        errEl.textContent = '❌ ' + (e?.message || e)
        errEl.classList.remove('hidden')
        newSave.disabled = false
        newSave.innerHTML = '<i class="fa-solid fa-check mr-1"></i>저장'
      }
    })
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

  // ─── 일괄 작업 핸들러 ──────────────────────────────────────
  async function onBulkAction(action) {
    const ids = Array.from(selectedRecipientIds)
    if (ids.length === 0) return toast('선택된 수신자가 없습니다', 'error')
    const targets = currentRecipients.filter(r => ids.includes(r.id))
    const emailPreview = targets.slice(0, 5).map(r => r.email).join(', ') + (targets.length > 5 ? ` 외 ${targets.length - 5}명` : '')

    const actionLabel = { enable: '활성화', disable: '비활성화', delete: '삭제' }[action]
    const danger = action === 'delete'
    const ok = await showConfirm({
      title: `일괄 ${actionLabel}`,
      message: `<div><strong>${ids.length}명</strong>의 수신자를 일괄 ${actionLabel}합니다:</div>
                <div class="mt-2 p-3 bg-gray-50 border rounded-lg text-xs break-all">${escapeHtml(emailPreview)}</div>
                ${danger ? '<div class="mt-2 text-xs text-gray-500">🛡️ 7일간 자동 백업에 보관되어 복원 가능합니다.</div>' : ''}`,
      confirmText: actionLabel,
      cancelText: '취소',
      danger,
    })
    if (!ok) return
    try {
      const res = await recipientApi.bulk(ids, action)
      if (res?.error) return toast('❌ ' + res.error, 'error')
      toast(`✅ ${res.affected}명 ${actionLabel} 완료`, 'success')
      selectedRecipientIds.clear()
      await reloadRecipients()
      notifyOtherTabs('recipients')
    } catch (e) {
      toast('❌ ' + (e?.message || e), 'error')
    }
  }

  // ─── Export / Import ─────────────────────────────────────
  function onExportRecipients() {
    // 브라우저에서 직접 파일 다운로드 — window.location 사용하면 세션 쿠키 자동 포함
    const link = document.createElement('a')
    link.href = '/api/admin/recipients/export'
    link.download = `recipients_${new Date().toISOString().slice(0,10)}.json`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    toast('📦 수신자 목록 다운로드 시작', 'success')
  }

  async function onImportRecipientsFile(file) {
    if (!file) return
    if (file.size > 1024 * 1024) {
      return toast('❌ 파일이 너무 큽니다 (1MB 이하)', 'error')
    }
    let recipients
    try {
      const text = await file.text()
      // JSON 먼저 시도
      if (file.name.endsWith('.json')) {
        const parsed = JSON.parse(text)
        recipients = Array.isArray(parsed) ? parsed : (parsed.recipients || [])
      } else {
        // CSV/줄바꿈 이메일 목록
        recipients = text.split(/[\n,;]/).map(s => s.trim()).filter(s => s && s.includes('@'))
      }
    } catch (e) {
      return toast('❌ 파일 형식 오류: ' + (e?.message || e), 'error')
    }
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return toast('❌ 가져올 수신자가 없습니다', 'error')
    }

    const mode = await new Promise((resolve) => {
      showConfirm({
        title: '가져오기 방식 선택',
        message: `<div><strong>${recipients.length}개</strong> 수신자 항목을 가져옵니다.</div>
                  <div class="mt-3 space-y-2">
                    <div class="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs">
                      <strong>합치기 (권장)</strong>: 기존 수신자는 유지하고 새 이메일만 추가
                    </div>
                    <div class="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs">
                      <strong>대체</strong>: 기존 목록을 모두 지우고 새로 덮어쓰기 (위험)
                    </div>
                  </div>`,
        confirmText: '합치기',
        cancelText: '취소',
      }).then((merged) => resolve(merged ? 'merge' : null))
    })
    if (!mode) return

    try {
      const res = await recipientApi.importData(recipients, mode)
      if (res?.error) return toast('❌ ' + res.error, 'error')
      const errMsg = res.errors && res.errors.length ? ` · 무효 ${res.errors.length}건` : ''
      toast(`📥 가져오기 완료: 추가 ${res.added}, 건너뜀 ${res.skipped}${errMsg}`, 'success')
      await reloadRecipients()
      notifyOtherTabs('recipients')
    } catch (e) {
      toast('❌ ' + (e?.message || e), 'error')
    }
  }

  function setupRecipientBulkHandlers() {
    const checkAll = document.getElementById('recipientCheckAll')
    if (checkAll) {
      checkAll.addEventListener('change', (e) => {
        if (e.target.checked) {
          currentRecipients.forEach(r => selectedRecipientIds.add(r.id))
        } else {
          selectedRecipientIds.clear()
        }
        renderRecipients(currentRecipients)
      })
    }
    const btnMap = {
      btnBulkEnable: () => onBulkAction('enable'),
      btnBulkDisable: () => onBulkAction('disable'),
      btnBulkDelete: () => onBulkAction('delete'),
      btnBulkClear: () => { selectedRecipientIds.clear(); renderRecipients(currentRecipients) },
      btnExportRecipients: onExportRecipients,
    }
    for (const [id, handler] of Object.entries(btnMap)) {
      const btn = document.getElementById(id)
      if (btn) btn.addEventListener('click', handler)
    }
    const importInput = document.getElementById('recipientImportInput')
    const importBtn = document.getElementById('btnImportRecipients')
    if (importBtn && importInput) {
      importBtn.addEventListener('click', () => importInput.click())
      importInput.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0]
        if (file) await onImportRecipientsFile(file)
        e.target.value = ''  // 같은 파일 재선택 가능하도록
      })
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

    // 새 소스 추가 버튼 (v2.5.2: 사용자/전체 탭에서만 활성)
    document.getElementById('btnAddSource').addEventListener('click', () => {
      if (currentCategory !== 'custom' && currentCategory !== 'all') {
        toast('⚠️ 새 소스 추가는 "사용자" 탭에서 하세요. 추가 후 편집 화면에서 카테고리를 한국/미국으로 바꿀 수 있습니다.', 'warn')
        return
      }
      openAddModal()
    })

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

  /**
   * (v2.2.7) 범용 확인 다이얼로그 — 두 가지 호출 방식 모두 지원:
   *   1) showConfirm(title, bodyHtml, onOk) — 콜백 스타일 (레거시)
   *   2) showConfirm({title, message, confirmText, cancelText, danger}) — Promise<boolean> 반환
   *
   *   danger: true 이면 OK 버튼이 빨간색으로 표시됨 (삭제 등 위험 작업)
   */
  function showConfirm(arg1, arg2, arg3) {
    // 호출 방식 감지
    const isObjectStyle = arg1 && typeof arg1 === 'object' && arg2 === undefined
    const opts = isObjectStyle ? arg1 : { title: arg1, body: arg2, _cb: arg3 }

    const title = opts.title || '확인'
    const body = opts.message || opts.body || ''
    const confirmText = opts.confirmText || '확인'
    const cancelText = opts.cancelText || '취소'
    const danger = opts.danger === true

    const m = document.getElementById('confirmModal')
    if (!m) {
      console.error('[showConfirm] confirmModal not found - falling back to native confirm')
      const plainText = (typeof body === 'string' ? body.replace(/<[^>]+>/g, '') : '')
      const result = window.confirm(title + '\n' + plainText)
      if (isObjectStyle) return Promise.resolve(result)
      if (result && typeof opts._cb === 'function') opts._cb()
      return
    }

    document.getElementById('confirmTitle').textContent = title
    // body 가 줄바꿈 있는 plain text 이면 <br> 로 변환, HTML 태그 있으면 그대로
    const bodyEl = document.getElementById('confirmBody')
    if (/<[a-z][\s\S]*>/i.test(body)) {
      bodyEl.innerHTML = body
    } else {
      bodyEl.innerHTML = escapeHtml(body).replace(/\n/g, '<br/>')
    }

    const okBtn = document.getElementById('btnConfirmOk')
    const cancelBtn = document.getElementById('btnConfirmCancel')
    if (okBtn) {
      okBtn.textContent = confirmText
      okBtn.className = danger
        ? 'px-5 py-2.5 bg-rose-600 text-white font-semibold rounded-lg hover:bg-rose-700 transition shadow-sm'
        : 'px-5 py-2.5 bg-orange-500 text-white font-semibold rounded-lg hover:bg-orange-600 transition shadow-sm'
    }
    if (cancelBtn) cancelBtn.textContent = cancelText

    showModal(m)

    return new Promise((resolve) => {
      const cleanup = () => {
        hideModal(m)
        okBtn.removeEventListener('click', onOk)
        cancelBtn.removeEventListener('click', onCancel)
      }
      const onOk = () => {
        cleanup()
        if (!isObjectStyle && typeof opts._cb === 'function') opts._cb()
        resolve(true)
      }
      const onCancel = () => { cleanup(); resolve(false) }
      okBtn.addEventListener('click', onOk, { once: true })
      cancelBtn.addEventListener('click', onCancel, { once: true })
    })
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
      cooldownState.configured = !!s.configured
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
      } else {
        // v2.3.1: 실시간 카운트다운 티커 시작
        cooldownState.dryRunRemainMs = Number(s.dryRunRemainMs || 0)
        cooldownState.realSendRemainMs = Number(s.realSendRemainMs || 0)
        cooldownState.lastSyncAt = Date.now()
        startCooldownTicker()
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

  // ═════════════════════════════════════════════════════════════
  // ⏱️ v2.3.2: 실시간 쿨다운 카운트다운 + 슬라이드바 + 펄스
  //   - DRY RUN 버튼: 30초 쿨다운 (파란색 바)
  //   - 실제 발송 버튼: 5분 쿨다운 (주황색 바)
  //   - 옵션 A: 버튼 내부 하단 얇은 바 (.cooldown-inner-bar)
  //   - 옵션 C: 버튼 아래 독립 두꺼운 바 (#dryRunCooldownBar, #realSendCooldownBar)
  //   - 마지막 3초: 초록빛 펄스 애니메이션
  //   - 초 단위 로컬 감산 + 10초마다 서버 동기화
  //   - v2.3.2: DRY RUN 시간당 10회 제한 카운터 표시
  // ═════════════════════════════════════════════════════════════
  const PULSE_THRESHOLD_MS = 3000  // 마지막 3초 펄스

  let cooldownState = {
    dryRunRemainMs: 0,
    realSendRemainMs: 0,
    dryRunTotalMs: 30 * 1000,      // 바 진행률 계산용 (총 쿨다운 시간)
    realSendTotalMs: 300 * 1000,
    hourlyCount: 0,                 // 최근 1시간 DRY RUN 사용 횟수
    hourlyLimit: 10,
    hourlyRemaining: 10,
    hourlyBlocked: false,
    lastSyncAt: 0,
    configured: true,
  }

  function formatCountdown(remainMs) {
    if (remainMs <= 0) return ''
    const s = Math.ceil(remainMs / 1000)
    if (s >= 60) {
      const m = Math.floor(s / 60)
      const sec = s % 60
      return `${m}:${String(sec).padStart(2, '0')}`
    }
    return `0:${String(s).padStart(2, '0')}`
  }

  /** 버튼 + 내부 바 + 독립 바 일괄 렌더링 */
  function renderCooldownUI(mode, remainMs, totalMs) {
    // mode: 'dryRun' | 'realSend'
    const isDry = mode === 'dryRun'
    const btnId = isDry ? 'btnTriggerDryRun' : 'btnTriggerNow'
    const barId = isDry ? 'dryRunCooldownBar' : 'realSendCooldownBar'
    const fillId = isDry ? 'dryRunCooldownFill' : 'realSendCooldownFill'
    const textId = isDry ? 'dryRunCooldownText' : 'realSendCooldownText'
    const pulseClass = isDry ? 'cooldown-pulsing-dry' : 'cooldown-pulsing-real'

    const btn = document.getElementById(btnId)
    const bar = document.getElementById(barId)
    const fill = document.getElementById(fillId)
    const text = document.getElementById(textId)
    if (!btn) return

    const innerBar = btn.querySelector('.cooldown-inner-bar')
    const cd = btn.querySelector('.btn-countdown')

    // PAT 미설정 / 요청 진행 중이면 건드리지 않음
    if (!cooldownState.configured || triggerInFlight) return

    // v2.3.2: DRY RUN 시간당 한도 초과 시 버튼 항상 비활성 (카운트다운과 무관)
    const hourlyBlockDry = isDry && cooldownState.hourlyBlocked

    if (remainMs > 0 || hourlyBlockDry) {
      // 쿨다운 중 또는 시간당 한도 초과 → 비활성
      btn.disabled = true
      btn.classList.add('opacity-60', 'cursor-not-allowed')

      // 카운트다운 텍스트 (버튼 내부, 옵션 A)
      if (cd) {
        cd.classList.remove('hidden')
        if (hourlyBlockDry && remainMs <= 0) {
          cd.textContent = `(한도 ${cooldownState.hourlyCount}/${cooldownState.hourlyLimit})`
        } else {
          cd.textContent = '(' + formatCountdown(remainMs) + ')'
        }
      }

      // 독립 슬라이드바 표시 (옵션 C) — 쿨다운이 실제로 진행 중일 때만
      if (remainMs > 0 && bar && fill && text) {
        bar.classList.remove('hidden')
        // 진행률: 100% 에서 시작해 0% 로 감소 (남은 시간 기준)
        const ratio = Math.max(0, Math.min(1, remainMs / Math.max(1, totalMs)))
        const percent = (ratio * 100).toFixed(2)
        fill.style.width = percent + '%'
        text.textContent = formatCountdown(remainMs)

        // 마지막 3초 펄스 애니메이션
        if (remainMs <= PULSE_THRESHOLD_MS) {
          fill.classList.add(pulseClass)
          if (innerBar) innerBar.classList.add('cooldown-pulsing-inner')
        } else {
          fill.classList.remove(pulseClass)
          if (innerBar) innerBar.classList.remove('cooldown-pulsing-inner')
        }
      } else if (bar) {
        // 시간당 한도 초과 상태 (쿨다운은 0) → 독립 바 숨김
        bar.classList.add('hidden')
      }

      // 버튼 내부 바 (옵션 A) — 쿨다운 진행 중에만 표시
      if (innerBar) {
        if (remainMs > 0) {
          const ratio = Math.max(0, Math.min(1, remainMs / Math.max(1, totalMs)))
          innerBar.style.width = (ratio * 100).toFixed(2) + '%'
        } else {
          innerBar.style.width = '0%'
          innerBar.classList.remove('cooldown-pulsing-inner')
        }
      }

      // 툴팁
      if (hourlyBlockDry && remainMs <= 0) {
        btn.setAttribute('title', `⚠️ DRY RUN 시간당 한도 초과 (${cooldownState.hourlyCount}/${cooldownState.hourlyLimit}). 강제 해제로 초기화 가능.`)
      } else {
        btn.setAttribute('title', '⏳ 쿨다운: ' + formatCountdown(remainMs) + ' 남음')
      }
    } else {
      // 쿨다운 해제 → 활성화
      btn.disabled = false
      btn.classList.remove('opacity-60', 'cursor-not-allowed')

      if (cd) {
        cd.classList.add('hidden')
        cd.textContent = ''
      }
      if (bar) bar.classList.add('hidden')
      if (fill) {
        fill.style.width = '0%'
        fill.classList.remove('cooldown-pulsing-dry', 'cooldown-pulsing-real')
      }
      if (innerBar) {
        innerBar.style.width = '0%'
        innerBar.classList.remove('cooldown-pulsing-inner')
      }
      btn.removeAttribute('title')
    }
  }

  /** 시간당 제한 표시 업데이트 */
  function renderHourlyInfo() {
    const el = document.getElementById('dryRunHourlyCountText')
    if (!el) return
    el.textContent = `${cooldownState.hourlyCount}/${cooldownState.hourlyLimit}`
    // 경고 색상
    const container = document.getElementById('dryRunHourlyInfo')
    if (container) {
      container.classList.remove('text-rose-600', 'text-amber-600', 'text-gray-500', 'font-semibold')
      if (cooldownState.hourlyBlocked) {
        container.classList.add('text-rose-600', 'font-semibold')
      } else if (cooldownState.hourlyRemaining <= 3) {
        container.classList.add('text-amber-600', 'font-semibold')
      } else {
        container.classList.add('text-gray-500')
      }
    }
  }

  /** 서버에서 최신 쿨다운 상태 가져와 동기화 */
  async function refreshCooldownState() {
    try {
      const s = await triggerApi.status()
      if (!s) return
      cooldownState.dryRunRemainMs = Number(s.dryRunRemainMs || 0)
      cooldownState.realSendRemainMs = Number(s.realSendRemainMs || 0)
      // 서버가 반환하는 쿨다운 총 시간 (초 → ms)
      cooldownState.dryRunTotalMs = Number(s.dryRunCooldownSec || 30) * 1000
      cooldownState.realSendTotalMs = Number(s.realSendCooldownSec || 300) * 1000
      // v2.3.2: 시간당 제한 정보
      cooldownState.hourlyCount = Number(s.dryRunHourlyCount || 0)
      cooldownState.hourlyLimit = Number(s.dryRunHourlyLimit || 10)
      cooldownState.hourlyRemaining = Number(s.dryRunHourlyRemaining || 0)
      cooldownState.hourlyBlocked = !!s.dryRunHourlyBlocked
      cooldownState.configured = !!s.configured
      cooldownState.lastSyncAt = Date.now()
      // 즉시 렌더
      renderHourlyInfo()
    } catch (e) {
      // 조용히 실패 — 다음 tick 에 다시 시도
    }
  }

  /** 매초 tick — 로컬 감산 + 10초마다 서버 동기화 */
  let cooldownTimer = null
  function startCooldownTicker() {
    if (cooldownTimer) return
    // 첫 동기화
    refreshCooldownState()
    cooldownTimer = setInterval(() => {
      // 로컬 1초 감산
      if (cooldownState.dryRunRemainMs > 0) cooldownState.dryRunRemainMs = Math.max(0, cooldownState.dryRunRemainMs - 1000)
      if (cooldownState.realSendRemainMs > 0) cooldownState.realSendRemainMs = Math.max(0, cooldownState.realSendRemainMs - 1000)

      // 렌더 (요청 진행 중이 아닐 때만)
      if (!triggerInFlight && cooldownState.configured) {
        // 실제 쿨다운이 가장 길게 적용되는 규칙 반영:
        // - 직전이 REAL 이면 DRY RUN 도 5분 쿨다운 (서버에서 이미 이렇게 계산해서 보내줌)
        // - 따라서 두 버튼 각각 서버가 내려준 값 기준으로 렌더
        renderCooldownUI('dryRun', cooldownState.dryRunRemainMs, cooldownState.dryRunTotalMs)
        renderCooldownUI('realSend', cooldownState.realSendRemainMs, cooldownState.realSendTotalMs)
      }

      // 10초마다 서버 재동기화 (다른 기기/탭 반영)
      if (Date.now() - cooldownState.lastSyncAt > 10_000) {
        refreshCooldownState()
      }
    }, 1000)
  }

  /** 관리자 강제 쿨다운 해제 */
  async function onResetCooldownClick() {
    const confirmed = await new Promise((resolve) => {
      showConfirm({
        title: '🚨 쿨다운 강제 해제',
        message: `
          <p class="mb-2">다음 항목을 <strong>즉시 초기화</strong>합니다:</p>
          <ul class="list-disc ml-5 space-y-1 text-xs">
            <li>🧪 DRY RUN 쿨다운 (30초)</li>
            <li>📧 실제 발송 쿨다운 (5분)</li>
            <li>⏰ DRY RUN 시간당 카운터 (${cooldownState.hourlyCount}/${cooldownState.hourlyLimit} → 0/10)</li>
          </ul>
          <p class="mt-2 text-xs text-rose-600">
            ⚠️ 긴급 상황에만 사용하세요. 실제 발송 쿨다운 해제는 수신자에게 중복 메일 위험이 있습니다.
          </p>`,
        confirmText: '강제 해제',
        cancelText: '취소',
        danger: true,
      }).then(resolve)
    })

    if (!confirmed) return

    try {
      const res = await safeFetch('/api/admin/reset-cooldown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resetCooldown: true, resetHourlyLimit: true }),
      })
      if (res.ok) {
        toast('✅ 쿨다운 강제 해제 완료', 'success')
        showTriggerStatus(
          'bg-emerald-50 border border-emerald-200 text-emerald-800',
          `<i class="fa-solid fa-unlock mr-1"></i><strong>강제 해제됨:</strong> ${(res.actions || []).join(' · ')}`
        )
        // 즉시 서버 상태 재동기화
        await refreshCooldownState()
        // 버튼 즉시 활성화 렌더
        renderCooldownUI('dryRun', 0, cooldownState.dryRunTotalMs)
        renderCooldownUI('realSend', 0, cooldownState.realSendTotalMs)
      } else {
        toast('❌ 강제 해제 실패: ' + (res.error || '알 수 없는 오류'), 'error')
      }
    } catch (e) {
      toast('❌ 네트워크 오류', 'error')
    }
  }

  async function onTriggerClick(dryRun) {
    // (v2.2.3) 중복 트리거 방지 — 요청 진행 중이면 즉시 반환
    if (triggerInFlight) {
      toast('⏳ 이미 요청이 진행 중입니다. 잠시만 기다려 주세요.', 'warn')
      return
    }

    const actionText = dryRun ? 'DRY RUN (메일 발송 없이 프리뷰만 생성)' : '실제 브리핑 발송'
    const confirmBody = dryRun
      ? '수집·AI요약만 수행하고 <strong>메일은 보내지 않습니다</strong>.<br>결과는 GitHub Actions 페이지의 artifact 로 다운로드 가능합니다.<br><span class="text-xs text-gray-500">⏱️ 쿨다운: 30초 (테스트 빠른 반복용)</span>'
      : '지금 즉시 <strong>모든 활성 수신자에게 메일</strong>이 발송됩니다.<br>약 1~3분 소요되며, <strong>5분 쿨다운</strong>이 적용됩니다.<br><span class="text-xs text-amber-600">⚠️ 수신자 스팸 처리 방지를 위해 과도한 반복 발송은 피하세요.</span>'

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
          // v2.3.1: 서버 쿨다운 상태 즉시 재동기화 (버튼 카운트다운 시작)
          refreshCooldownState()
          // 상태 폴링 시작 — dryRun 값까지 일치해야 매칭 (다른 동시 실행과 혼동 방지)
          startPolling(requestSentAt, dryRun)
          // v2.4.0: 대시보드 라이브 폴링 자동 활성화 (DRY-RUN 진행 상황 실시간 관찰)
          try {
            const live = document.getElementById('dashLiveToggle')
            if (live && !live.checked) { live.checked = true }
            // 20초 후부터 폴링 시작 (Python 집계기 시작 시간 확보)
            setTimeout(() => { refreshDashboard() }, 20000)
          } catch (_) {}
        } else {
          const hint = res.hint ? `<div class="text-xs mt-1 opacity-80">💡 ${escapeHtml(res.hint)}</div>` : ''
          showTriggerStatus(
            'bg-red-50 border border-red-200 text-red-700',
            `<i class="fa-solid fa-circle-xmark mr-1"></i>${escapeHtml(res.error || '알 수 없는 오류')}${hint}`
          )
          toast('❌ 발송 요청 실패', 'error')
          // v2.3.1: 429 쿨다운 실패면 서버 상태 동기화
          if (res.cooldownRemainSec || /연속 호출/.test(res.error || '')) {
            refreshCooldownState()
          }
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
      // v2.3.1: 릴리즈 직후 카운트다운 즉시 동기화 (버튼에 남은 시간 반영)
      refreshCooldownState()
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
          // (v2.2.7) 실제 발송 완료 시 스팸 폴더 확인 안내 - 과거 사용자가
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
  // 🩺 (v2.2.7) 수신자 동기화 진단 + MailChannels 즉시 테스트
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

  // ═════════════════════════════════════════════════════════════
  // 📊 v2.4.0: 수집 대시보드 — 렌더링 & 폴링
  // ═════════════════════════════════════════════════════════════
  let dashLivePollTimer = null
  let dashLastRenderKey = null  // 불필요한 재렌더 방지

  function fmtAgo(ts) {
    if (!ts) return '데이터 없음'
    const diff = Math.max(0, Date.now() - new Date(ts).getTime())
    const s = Math.floor(diff / 1000)
    if (s < 60) return `${s}초 전`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}분 전`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}시간 전`
    const d = Math.floor(h / 24)
    return `${d}일 전`
  }

  function fmtDuration(sec) {
    if (!sec && sec !== 0) return '—'
    const s = Math.floor(sec)
    if (s < 60) return `${s}초`
    const m = Math.floor(s / 60)
    const rs = s % 60
    return `${m}분 ${rs}초`
  }

  function fmtTime(ts) {
    if (!ts) return '—'
    try {
      const d = new Date(ts)
      const hh = String(d.getHours()).padStart(2, '0')
      const mm = String(d.getMinutes()).padStart(2, '0')
      const MM = String(d.getMonth() + 1).padStart(2, '0')
      const DD = String(d.getDate()).padStart(2, '0')
      return `${MM}/${DD} ${hh}:${mm}`
    } catch { return '—' }
  }

  // 소스 상태 → 색상 배지
  function statusBadge(source) {
    const st = (source && source.status) || 'unknown'
    const collected = Number(source && source.collected) || 0
    const target = Number(source && source.target) || 0
    // 상태 기준: success | partial | failed | in_progress | skipped | unknown
    let st2 = st
    if (st2 === 'unknown' || st2 === 'success') {
      if (target > 0) {
        const ratio = collected / target
        if (ratio >= 1) st2 = 'success'
        else if (ratio >= 0.5) st2 = 'partial'
        else if (collected === 0) st2 = 'failed'
        else st2 = 'partial'
      } else if (collected > 0) st2 = 'success'
      else st2 = 'unknown'
    }
    const MAP = {
      success:     { cls: 'bg-emerald-100 text-emerald-700 border-emerald-200', icon: 'fa-circle-check', text: '🟢 정상' },
      partial:     { cls: 'bg-amber-100 text-amber-700 border-amber-200',       icon: 'fa-triangle-exclamation', text: '🟡 부분' },
      failed:      { cls: 'bg-rose-100 text-rose-700 border-rose-200',           icon: 'fa-circle-xmark', text: '🔴 실패' },
      in_progress: { cls: 'bg-sky-100 text-sky-700 border-sky-200',              icon: 'fa-spinner fa-spin', text: '⏳ 수집중' },
      skipped:     { cls: 'bg-gray-100 text-gray-500 border-gray-200',           icon: 'fa-forward', text: '⚪ 건너뜀' },
      unknown:     { cls: 'bg-gray-100 text-gray-500 border-gray-200',           icon: 'fa-question', text: '❔ 미상' },
    }
    const m = MAP[st2] || MAP.unknown
    return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] sm:text-xs font-medium ${m.cls}">
      <i class="fa-solid ${m.icon}"></i>${m.text}
    </span>`
  }

  function typeBadge(tp) {
    const t = String(tp || '').toLowerCase()
    const MAP = {
      rss:         { cls: 'bg-purple-50 text-purple-700 border-purple-200', text: 'RSS' },
      google_news: { cls: 'bg-blue-50 text-blue-700 border-blue-200',       text: 'Google News' },
      youtube:     { cls: 'bg-rose-50 text-rose-700 border-rose-200',       text: 'YouTube' },
      web:         { cls: 'bg-gray-50 text-gray-700 border-gray-200',       text: 'Web' },
      kr:          { cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', text: '🇰🇷 KR' },
      us:          { cls: 'bg-indigo-50 text-indigo-700 border-indigo-200',    text: '🇺🇸 US' },
      custom:      { cls: 'bg-amber-50 text-amber-700 border-amber-200',    text: '커스텀' },
    }
    const m = MAP[t] || { cls: 'bg-gray-50 text-gray-600 border-gray-200', text: t || '—' }
    return `<span class="inline-block px-1.5 py-0.5 rounded border text-[10px] font-medium ${m.cls}">${m.text}</span>`
  }

  function renderDashSummary(run) {
    const lastRun = document.getElementById('dashLastRun')
    const lastRunAgo = document.getElementById('dashLastRunAgo')
    const totalItems = document.getElementById('dashTotalItems')
    const totalItemsSub = document.getElementById('dashTotalItemsSub')
    const successSources = document.getElementById('dashSuccessSources')
    const successSourcesSub = document.getElementById('dashSuccessSourcesSub')
    const duration = document.getElementById('dashDuration')
    const durationSub = document.getElementById('dashDurationSub')

    if (!run) {
      if (lastRun) lastRun.textContent = '—'
      if (lastRunAgo) lastRunAgo.textContent = '데이터 없음'
      if (totalItems) totalItems.textContent = '—'
      if (totalItemsSub) totalItemsSub.textContent = '—'
      if (successSources) successSources.textContent = '—'
      if (successSourcesSub) successSourcesSub.textContent = '—'
      if (duration) duration.textContent = '—'
      if (durationSub) durationSub.textContent = '—'
      return
    }

    const tot = Number(run.totalCollected ?? 0)
    const tgt = Number(run.totalTarget ?? 0)
    const sources = Array.isArray(run.sources) ? run.sources : []
    const succ = sources.filter((s) => {
      const c = Number(s.collected) || 0
      const t = Number(s.target) || 0
      return s.status === 'success' || (t > 0 ? c >= t : c > 0)
    }).length
    const pctItems = tgt > 0 ? Math.round((tot / tgt) * 100) : null
    const pctSrcs = sources.length > 0 ? Math.round((succ / sources.length) * 100) : null

    if (lastRun) lastRun.textContent = fmtTime(run.finishedAt || run.startedAt)
    if (lastRunAgo) {
      const ago = fmtAgo(run.finishedAt || run.startedAt)
      const mode = run.dryRun ? '🧪 DRY-RUN' : '📧 실제 발송'
      lastRunAgo.textContent = `${mode} · ${ago}`
    }
    if (totalItems) totalItems.textContent = tgt > 0 ? `${tot}/${tgt}` : `${tot}`
    if (totalItemsSub) totalItemsSub.textContent = pctItems !== null ? `${pctItems}% 달성` : '목표 미설정'
    if (successSources) successSources.textContent = `${succ}/${sources.length}`
    if (successSourcesSub) successSourcesSub.textContent = pctSrcs !== null ? `${pctSrcs}% 성공` : '데이터 없음'
    if (duration) duration.textContent = fmtDuration(run.durationSec)
    if (durationSub) durationSub.textContent = run.status === 'in_progress' ? '실행 중…' : '수집 완료'
  }

  function renderDashTable(sources) {
    const tbody = document.getElementById('dashSourceTableBody')
    if (!tbody) return
    if (!sources || !sources.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="py-6 text-center text-gray-400 text-sm">
            <i class="fa-solid fa-inbox mr-2"></i>
            수집된 소스 데이터가 아직 없습니다. DRY-RUN으로 먼저 실행해 보세요.
          </td>
        </tr>`
      return
    }
    const rows = sources.map((s) => {
      const label = String(s.label || s.id || '—').replace(/</g, '&lt;')
      const site = s.site ? `<div class="text-[10px] text-gray-400 truncate max-w-[240px]">${String(s.site).replace(/</g, '&lt;')}</div>` : ''
      const collected = Number(s.collected) || 0
      const target = Number(s.target) || 0
      const ratio = target > 0 ? collected / target : (collected > 0 ? 1 : 0)
      const barColor = ratio >= 1 ? 'bg-emerald-500' : ratio >= 0.5 ? 'bg-amber-500' : (collected === 0 ? 'bg-rose-500' : 'bg-amber-500')
      const barPct = Math.min(100, Math.round(ratio * 100))
      const collectedText = target > 0 ? `${collected}/${target}` : `${collected}`
      const dur = (s.durationSec !== undefined && s.durationSec !== null) ? fmtDuration(s.durationSec) : '—'
      const note = s.note || s.error || ''
      const noteCls = s.error ? 'text-rose-600' : 'text-gray-500'
      return `
        <tr class="border-b border-gray-100 hover:bg-gray-50">
          <td class="py-2 px-2 sm:px-3">${statusBadge(s)}</td>
          <td class="py-2 px-2 sm:px-3">
            <div class="font-medium text-gray-800 truncate max-w-[220px]">${label}</div>
            ${site}
          </td>
          <td class="py-2 px-2 sm:px-3 hidden sm:table-cell">
            ${typeBadge(s.type)} ${s.category ? typeBadge(s.category) : ''}
          </td>
          <td class="py-2 px-2 sm:px-3 text-right">
            <div class="font-mono font-semibold text-gray-800">${collectedText}</div>
            <div class="mt-1 h-1 bg-gray-100 rounded-full overflow-hidden w-20 ml-auto">
              <div class="h-full ${barColor} transition-all duration-500" style="width:${barPct}%"></div>
            </div>
          </td>
          <td class="py-2 px-2 sm:px-3 text-right font-mono text-xs text-gray-600 hidden md:table-cell">${dur}</td>
          <td class="py-2 px-2 sm:px-3 text-xs ${noteCls} hidden lg:table-cell">
            <div class="truncate max-w-[300px]" title="${String(note).replace(/"/g, '&quot;')}">${String(note).replace(/</g, '&lt;') || '—'}</div>
          </td>
        </tr>`
    }).join('')
    tbody.innerHTML = rows
  }

  function renderDashHistory(history) {
    const box = document.getElementById('dashHistoryList')
    if (!box) return
    if (!history || !history.length) {
      box.innerHTML = `<div class="text-gray-400 text-center py-3">이력 없음</div>`
      return
    }
    box.innerHTML = history.slice(0, 10).map((h) => {
      const t = fmtTime(h.finishedAt || h.startedAt)
      const ago = fmtAgo(h.finishedAt || h.startedAt)
      const mode = h.dryRun ? '🧪' : '📧'
      const total = `${h.totalCollected ?? 0}${h.totalTarget ? '/' + h.totalTarget : ''}`
      const srcOk = Array.isArray(h.sources)
        ? h.sources.filter((s) => (s.status === 'success') || (Number(s.collected) > 0 && (!s.target || Number(s.collected) >= Number(s.target)))).length
        : 0
      const srcAll = Array.isArray(h.sources) ? h.sources.length : 0
      const dur = fmtDuration(h.durationSec)
      const okCls = (h.status === 'failed') ? 'text-rose-600' : (h.status === 'partial' ? 'text-amber-600' : 'text-emerald-600')
      const okIcon = (h.status === 'failed') ? 'fa-circle-xmark' : (h.status === 'partial' ? 'fa-triangle-exclamation' : 'fa-circle-check')
      return `
        <div class="flex items-center gap-2 p-2 rounded-lg border border-gray-100 hover:bg-gray-50 text-xs sm:text-sm">
          <i class="fa-solid ${okIcon} ${okCls}"></i>
          <span class="font-mono text-gray-700">${t}</span>
          <span class="text-gray-400">${ago}</span>
          <span>${mode}</span>
          <span class="ml-auto text-gray-600">수집 <strong class="text-gray-800 font-mono">${total}</strong></span>
          <span class="text-gray-600">소스 <strong class="text-gray-800 font-mono">${srcOk}/${srcAll}</strong></span>
          <span class="text-gray-500 hidden sm:inline">⏱ ${dur}</span>
        </div>`
    }).join('')
  }

  function updateLiveBadge(run) {
    const badge = document.getElementById('dashLiveBadge')
    const txt = document.getElementById('dashLiveProgressText')
    if (!badge) return
    if (run && run.status === 'in_progress') {
      badge.classList.remove('hidden')
      if (txt) {
        const sources = Array.isArray(run.sources) ? run.sources : []
        const done = sources.filter((s) => s.status === 'success' || s.status === 'failed' || s.status === 'partial' || s.status === 'skipped').length
        const cur = sources.find((s) => s.status === 'in_progress')
        const curLabel = cur ? `현재: ${cur.label || cur.id || '?'}` : ''
        txt.textContent = `소스 ${done}/${sources.length} 완료 · 수집 ${run.totalCollected ?? 0}건 ${curLabel ? '· ' + curLabel : ''}`
      }
    } else {
      badge.classList.add('hidden')
    }
  }

  async function refreshDashboard() {
    try {
      const [latest, history] = await Promise.all([
        dashboardApi.latest().catch(() => ({ ok: false })),
        dashboardApi.history().catch(() => ({ ok: false })),
      ])
      const run = (latest && latest.ok && latest.run) ? latest.run : null
      renderDashSummary(run)
      renderDashTable(run ? (run.sources || []) : [])
      updateLiveBadge(run)
      const hist = (history && history.ok && Array.isArray(history.history)) ? history.history : []
      renderDashHistory(hist)
      // 자동 폴링 필요 여부 (DRY-RUN 진행 중이면)
      const live = document.getElementById('dashLiveToggle')
      if (live && live.checked && run && run.status === 'in_progress') {
        scheduleDashLivePoll()
      } else if (run && run.status !== 'in_progress') {
        stopDashLivePoll()
      }
    } catch (e) {
      console.warn('[Dashboard] refresh failed:', e)
    }
  }

  function scheduleDashLivePoll() {
    stopDashLivePoll()
    dashLivePollTimer = setTimeout(() => { refreshDashboard() }, 10000)  // 10초
  }
  function stopDashLivePoll() {
    if (dashLivePollTimer) { clearTimeout(dashLivePollTimer); dashLivePollTimer = null }
  }

  function setupDashboard() {
    const refreshBtn = document.getElementById('btnDashRefresh')
    const liveToggle = document.getElementById('dashLiveToggle')
    if (refreshBtn) refreshBtn.addEventListener('click', () => refreshDashboard())
    if (liveToggle) liveToggle.addEventListener('change', () => {
      if (liveToggle.checked) {
        refreshDashboard()
      } else {
        stopDashLivePoll()
      }
    })
    // 초기 로드
    refreshDashboard()
  }

  // ═════════════════════════════════════════════════════════════
  // 🔄 v2.6.0: 3단계 파이프라인 상태 카드
  // ═════════════════════════════════════════════════════════════
  const PIPELINE_STAGES = ['collect', 'summarize', 'send']
  const PIPELINE_STAGE_LABEL_KO = {
    collect:   '수집',
    summarize: '요약',
    send:      '발송',
  }
  const PIPELINE_BADGE_CLASS = {
    pending:     'bg-gray-100 text-gray-500',
    in_progress: 'bg-amber-100 text-amber-700 animate-pulse',
    ok:          'bg-emerald-100 text-emerald-700',
    failed:      'bg-rose-100 text-rose-700',
    skipped:     'bg-slate-100 text-slate-600',
  }

  /** 상태에 맞게 각 stage 타일을 덮어쓴다. */
  function renderPipelineStages(state, dataAvailable) {
    if (!state || !state.stages) return
    PIPELINE_STAGES.forEach((stage) => {
      const tile = document.querySelector(`.stage-tile[data-stage="${stage}"]`)
      if (!tile) return
      const s = state.stages[stage] || { status: 'pending' }
      const badge = tile.querySelector('.stage-badge')
      const info = tile.querySelector('.stage-info')
      const rerun = tile.querySelector('.stage-rerun')

      if (badge) {
        badge.textContent = s.status
        badge.className =
          'stage-badge text-[10px] px-2 py-0.5 rounded-full ' +
          (PIPELINE_BADGE_CLASS[s.status] || PIPELINE_BADGE_CLASS.pending)
      }

      if (info) {
        const parts = []
        if (s.at) {
          const d = new Date(s.at)
          parts.push(`완료 ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`)
        }
        if (stage === 'collect' && typeof s.count === 'number') {
          parts.push(`${s.count}건 수집`)
        } else if (stage === 'summarize' && typeof s.chars === 'number') {
          parts.push(`${s.chars.toLocaleString()}자 요약`)
        } else if (stage === 'send' && typeof s.recipients === 'number') {
          parts.push(`${s.recipients}명 발송`)
        }
        if (s.error) {
          parts.push(`<span class="text-rose-600">❌ ${escapeHtml(s.error.slice(0, 80))}</span>`)
        }
        if (parts.length === 0) {
          parts.push(`${PIPELINE_STAGE_LABEL_KO[stage]} 대기 중…`)
        }
        info.innerHTML = parts.join(' · ')
      }

      // 재실행 버튼: 실패했거나, 이전 단계는 성공했는데 이 단계는 pending 일 때만 노출
      if (rerun) {
        const prevOk = isPrevStageOk(stage, state)
        const showRerun = (s.status === 'failed') || (s.status === 'pending' && prevOk)
        rerun.classList.toggle('hidden', !showRerun)
        rerun.onclick = () => onPipelineStageRerun(stage)
      }
    })
  }

  function isPrevStageOk(stage, state) {
    if (stage === 'collect') return true
    if (stage === 'summarize') return state.stages.collect?.status === 'ok'
    if (stage === 'send') return state.stages.summarize?.status === 'ok'
    return false
  }

  /** 재실행 버튼 클릭 → GitHub Actions 워크플로우 트리거 (기존 trigger-now 경로 재사용). */
  async function onPipelineStageRerun(stage) {
    const label = PIPELINE_STAGE_LABEL_KO[stage]
    const ok = await showConfirm({
      title: `${label} 단계 재실행`,
      message: `${label} 워크플로우를 지금 재실행할까요?\n` +
        (stage === 'summarize'
          ? '⚠️ AI 쿼터 제한이 있으니 당일에 여러 번 실행은 주의하세요.'
          : stage === 'collect'
            ? '수집은 AI 호출 없이 안전합니다.'
            : '발송은 수신자에게 메일이 도착합니다. DRY RUN 이 아닙니다.'),
      confirmText: '재실행',
      danger: stage === 'send',
    })
    if (!ok) return

    try {
      // 기존 "지금 발송" 기능과 동일한 dispatch API 재사용 + stage 인자 전달
      const res = await safeFetch('/api/admin/trigger-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage }),
      })
      if (res.ok) {
        toast(`🚀 ${label} 단계 재실행 요청 완료`, 'success')
        setTimeout(refreshPipelineCard, 3000)
      } else {
        toast(`❌ 재실행 실패: ${res.error || '알 수 없는 오류'}`, 'warn')
      }
    } catch (e) {
      toast(`❌ 네트워크 오류: ${e.message || e}`, 'warn')
    }
  }

  async function refreshPipelineCard() {
    try {
      const res = await dashboardApi.pipelineState()
      if (res && res.ok) {
        renderPipelineStages(res.state, res.dataAvailable)
      }
    } catch (e) {
      console.warn('[Pipeline] refresh failed:', e)
    }
  }

  function setupPipelineCard() {
    const refreshBtn = document.getElementById('btnPipelineRefresh')
    if (refreshBtn) refreshBtn.addEventListener('click', refreshPipelineCard)
    refreshPipelineCard()
    // 60초마다 자동 갱신
    setInterval(refreshPipelineCard, 60000)
  }

  function setupTriggerButtons() {
    const nowBtn = document.getElementById('btnTriggerNow')
    const dryBtn = document.getElementById('btnTriggerDryRun')
    const chkBtn = document.getElementById('btnCheckTriggerStatus')
    const resetBtn = document.getElementById('btnResetCooldown')  // v2.3.2
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
    // v2.3.2: 관리자 강제 쿨다운 해제 버튼
    if (resetBtn) resetBtn.addEventListener('click', onResetCooldownClick)
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
  // v2.9.6 (2026-04-26): 사용자 점수 입력 — 상태 배지 + 삭제 + 토스트
  // (v2.9.4: 사용자 점수 입력 + 7일 추이 + 금지어 통계)
  // ─────────────────────────────────────────────────────────────
  let userScoreChart = null

  // 오늘 KST 날짜 (YYYY-MM-DD)
  function todayKstISO() {
    const d = new Date(Date.now() + 9 * 3600 * 1000)
    return d.toISOString().slice(0, 10)
  }
  // YYYYMMDD ↔ YYYY-MM-DD 변환
  function ymdCompact(iso) { return iso.replaceAll('-', '') }
  function ymdDashed(compact) {
    return `${compact.slice(0,4)}-${compact.slice(4,6)}-${compact.slice(6,8)}`
  }

  function setUserScoreStatus(msg, type) {
    const el = document.getElementById('userScoreStatus')
    if (!el) return
    el.classList.remove('hidden', 'bg-green-50', 'text-green-800', 'bg-red-50', 'text-red-800', 'bg-blue-50', 'text-blue-800')
    if (type === 'ok')   el.classList.add('bg-green-50', 'text-green-800')
    else if (type === 'err')  el.classList.add('bg-red-50', 'text-red-800')
    else el.classList.add('bg-blue-50', 'text-blue-800')
    el.textContent = msg
  }

  /**
   * v2.9.6: 상태 배지 — "✏️ 신규 입력" / "✅ 저장됨 (편집 가능)"
   */
  function setUserScoreBadge(state) {
    const el = document.getElementById('userScoreBadge')
    if (!el) return
    el.classList.remove('hidden', 'bg-blue-100', 'text-blue-800', 'bg-emerald-100', 'text-emerald-800', 'bg-gray-100', 'text-gray-700')
    if (state === 'saved') {
      el.classList.add('bg-emerald-100', 'text-emerald-800')
      el.innerHTML = '✅ 저장됨 (편집 가능 · 다시 저장하면 수정됩니다)'
    } else if (state === 'new') {
      el.classList.add('bg-blue-100', 'text-blue-800')
      el.innerHTML = '✏️ 신규 입력 (이 날짜는 아직 미저장)'
    } else {
      el.classList.add('bg-gray-100', 'text-gray-700')
      el.textContent = state || '대기 중'
    }
  }

  /**
   * v2.9.6: 토스트 알림 — 화면 우상단에 잠깐 떴다 사라지는 메시지.
   * type: 'ok' (초록) | 'err' (빨강) | 'info' (파랑)
   */
  function showToast(msg, type = 'ok', duration = 2500) {
    let host = document.getElementById('toast-host')
    if (!host) {
      host = document.createElement('div')
      host.id = 'toast-host'
      host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none;'
      document.body.appendChild(host)
    }
    const t = document.createElement('div')
    const bg = type === 'err' ? '#dc2626' : (type === 'info' ? '#2563eb' : '#059669')
    t.style.cssText = `background:${bg};color:#fff;padding:10px 16px;border-radius:8px;font-size:14px;font-weight:600;box-shadow:0 4px 12px rgba(0,0,0,0.18);opacity:0;transform:translateY(-8px);transition:all 220ms ease;pointer-events:auto;max-width:320px;`
    t.textContent = msg
    host.appendChild(t)
    requestAnimationFrame(() => { t.style.opacity = '1'; t.style.transform = 'translateY(0)' })
    setTimeout(() => {
      t.style.opacity = '0'
      t.style.transform = 'translateY(-8px)'
      setTimeout(() => t.remove(), 240)
    }, duration)
  }

  // v2.9.6.2: 폼을 신규 입력 상태로 초기화 (오늘 날짜 + 점수/코멘트/약점 리셋)
  // - opts.dateOverride : 해당 날짜로 세팅, 아니면 오늘 KST
  // - opts.skipReload   : true 면 기존 점수 자동 로드를 건너뛰고 무조건 신규 폼 유지
  // - opts.scoreOverride: 슬라이더/숫자에 강제 세팅할 점수 (기본 80)
  // - opts.commentOverride : 코멘트 텍스트 (기본 빈 문자열)
  // - opts.weakAxesOverride: 체크할 약점 배열 (기본 [])
  // - opts.badgeMode   : 'new' | 'saved' (기본 'new')
  function resetUserScoreForm(opts) {
    // 하위호환: 예전 시그니처(dateOverride, skipReload) 지원
    if (typeof opts === 'string' || typeof opts === 'undefined') {
      opts = { dateOverride: opts, skipReload: arguments[1] === true }
    }
    const dateEl = document.getElementById('userScoreDate')
    const slider = document.getElementById('userScoreSlider')
    const numEl  = document.getElementById('userScoreNumber')
    const commEl = document.getElementById('userScoreComment')
    const btnDelete = document.getElementById('btnUserScoreDelete')
    if (!dateEl || !slider || !numEl) return

    const score = (typeof opts.scoreOverride === 'number') ? opts.scoreOverride : 80
    const comment = (typeof opts.commentOverride === 'string') ? opts.commentOverride : ''
    const axes = Array.isArray(opts.weakAxesOverride) ? opts.weakAxesOverride : []
    const badge = opts.badgeMode || 'new'

    // 1) 날짜 세팅 + change 이벤트 디스패치 (다른 리스너가 갱신되도록)
    dateEl.value = opts.dateOverride || todayKstISO()

    // 2) 점수: 슬라이더/숫자 양쪽에 동일하게 세팅 + input 이벤트 발사
    //    (브라우저 시각 갱신 + 양방향 바인딩 리스너 트리거)
    slider.value = score
    numEl.value = score
    try { slider.dispatchEvent(new Event('input', { bubbles: true })) } catch (_) {}
    try { numEl.dispatchEvent(new Event('input', { bubbles: true })) } catch (_) {}

    // 3) 코멘트 / 약점
    if (commEl) commEl.value = comment
    document.querySelectorAll('.user-score-axis').forEach(cb => {
      cb.checked = axes.indexOf(cb.value) !== -1
    })

    // 4) 배지 + 삭제 버튼 상태
    setUserScoreBadge(badge)
    if (btnDelete) btnDelete.disabled = (badge !== 'saved')

    // 5) 상태 메시지 숨김
    const statusEl = document.getElementById('userScoreStatus')
    if (statusEl) statusEl.classList.add('hidden')

    if (!opts.skipReload) {
      // 사용자가 일부러 신규 입력 버튼을 누른 게 아니라면(예: 페이지 첫 로드)
      // 해당 날짜에 저장된 점수가 있으면 자동 로드
      loadExistingScore()
    }
  }

  function setupUserScoreForm() {
    const dateEl = document.getElementById('userScoreDate')
    const slider = document.getElementById('userScoreSlider')
    const numEl  = document.getElementById('userScoreNumber')
    const btnSave = document.getElementById('btnUserScoreSave')
    const btnReload = document.getElementById('btnUserScoreReload')
    const btnDelete = document.getElementById('btnUserScoreDelete')
    const btnNew = document.getElementById('btnUserScoreNew')  // v2.9.6.1
    if (!dateEl || !slider || !numEl) return

    // 기본값: 오늘
    dateEl.value = todayKstISO()

    // 슬라이더 ↔ 숫자 입력 양방향 바인딩 + 0~100 클램프
    function clamp(v) {
      const n = Math.round(Number(v))
      if (!Number.isFinite(n)) return 0
      return Math.max(0, Math.min(100, n))
    }
    slider.addEventListener('input', () => { numEl.value = slider.value })
    numEl.addEventListener('input', () => {
      const v = clamp(numEl.value)
      slider.value = v
      // 사용자가 직접 입력 중에는 강제 클램프하지 않고 blur 시점에만
    })
    numEl.addEventListener('blur', () => {
      const v = clamp(numEl.value)
      numEl.value = v
      slider.value = v
    })

    // 날짜 변경 시 기존 점수 자동 로드
    dateEl.addEventListener('change', loadExistingScore)

    btnSave.addEventListener('click', async () => {
      const score = clamp(numEl.value)
      const comment = (document.getElementById('userScoreComment').value || '').slice(0, 500)
      const weakAxes = Array.from(document.querySelectorAll('.user-score-axis:checked'))
        .map(cb => cb.value)
      const date = ymdCompact(dateEl.value || todayKstISO())

      btnSave.disabled = true
      setUserScoreStatus('저장 중…', 'info')
      try {
        const res = await fetch('/api/admin/user-score', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ date, score, comment, weakAxes }),
        })
        const j = await res.json()
        if (!res.ok || !j.ok) throw new Error(j.error || '저장 실패')
        const verb = j.isUpdate ? '수정' : '신규 저장'
        setUserScoreStatus(
          `✅ 저장 완료 (${verb}) — ${score}점`, 'ok'
        )
        showToast(`방금 ${verb}됨 · ${ymdDashed(date)} · ${score}점`, 'ok')
        // v2.9.6: 저장 후 즉시 "저장됨" 배지로 전환 + 삭제 버튼 활성화
        setUserScoreBadge('saved')
        if (btnDelete) btnDelete.disabled = false
        await loadUserScoreTrend()
      } catch (e) {
        setUserScoreStatus('❌ ' + (e.message || e), 'err')
        showToast('저장 실패: ' + (e.message || e), 'err', 4000)
      } finally {
        btnSave.disabled = false
      }
    })

    btnReload.addEventListener('click', () => {
      loadExistingScore()
      loadUserScoreTrend()
    })

    // v2.9.6.2: 🆕 신규 입력 버튼 — 항상 오늘 날짜로 이동, 점수는 자동 입력
    //   - 오늘 점수 미저장 → 빈 폼(80점 기본값) + "신규 입력" 배지
    //   - 오늘 점수 이미 저장됨 →
    //       [확인] = 기존 점수를 폼에 자동 입력(수정 모드, "저장됨" 배지, 삭제 버튼 활성화)
    //       [취소] = 빈 폼(80점)으로 새로 입력 시작 → 저장 시 기존 점수 덮어쓰기
    if (btnNew) {
      btnNew.addEventListener('click', async () => {
        const today = todayKstISO()
        const todayCompact = ymdCompact(today)

        // 오늘 점수 조회
        let existing = null
        try {
          const res = await fetch(`/api/admin/user-score?date=${todayCompact}`, { credentials: 'same-origin' })
          const j = await res.json()
          if (j && j.ok && j.exists && j.record) existing = j.record
        } catch (_) { /* 네트워크 오류 시 빈 폼 진행 */ }

        if (existing) {
          // 오늘 이미 저장된 점수가 있을 때: 사용자에게 두 옵션 제공
          const score = (typeof existing.score === 'number') ? existing.score : 80
          const proceed = confirm(
            `오늘(${ymdDashed(todayCompact)})은 이미 저장된 점수가 있습니다 (${score}점).\n\n` +
            `[확인] = 기존 점수를 폼에 자동 입력 → 수정 모드\n` +
            `[취소] = 빈 폼(80점)으로 새로 입력 → 저장 시 덮어쓰기`
          )
          if (proceed) {
            // 수정 모드: 기존 점수 자동 입력
            resetUserScoreForm({
              dateOverride: today,
              skipReload: true,
              scoreOverride: score,
              commentOverride: existing.comment || '',
              weakAxesOverride: Array.isArray(existing.weakAxes) ? existing.weakAxes : [],
              badgeMode: 'saved',
            })
            showToast(`📝 오늘 점수 불러옴 — ${score}점 (수정 모드)`, 'info')
          } else {
            // 빈 폼: 80점으로 새로 입력
            resetUserScoreForm({
              dateOverride: today,
              skipReload: true,
              scoreOverride: 80,
              badgeMode: 'new',
            })
            showToast('🆕 신규 입력 모드 — 오늘 날짜, 80점으로 초기화', 'info')
          }
        } else {
          // 오늘 점수가 아직 없음 → 빈 폼
          resetUserScoreForm({
            dateOverride: today,
            skipReload: true,
            scoreOverride: 80,
            badgeMode: 'new',
          })
          showToast('🆕 신규 입력 모드 — 오늘 날짜, 80점으로 시작', 'info')
        }

        // 상단 '오늘 사용자 점수' 카드도 갱신
        try { loadUserScoreTrend() } catch (_) {}
        // 첫 입력 필드(슬라이더)에 포커스
        try { slider.focus() } catch (_) {}
      })
    }

    // v2.9.6: 삭제 버튼
    if (btnDelete) {
      btnDelete.addEventListener('click', async () => {
        const date = ymdCompact(dateEl.value || todayKstISO())
        const ok = confirm(`${ymdDashed(date)} 의 사용자 점수를 정말 삭제할까요?\n\n삭제 후에는 같은 날짜에 다시 신규 입력할 수 있습니다.`)
        if (!ok) return
        btnDelete.disabled = true
        setUserScoreStatus('삭제 중…', 'info')
        try {
          const res = await fetch(`/api/admin/user-score?date=${date}`, {
            method: 'DELETE',
            credentials: 'same-origin',
          })
          const j = await res.json()
          if (!res.ok || !j.ok) throw new Error(j.error || '삭제 실패')
          if (j.deleted) {
            showToast(`삭제됨 · ${ymdDashed(date)}`, 'ok')
            setUserScoreStatus(`🗑 ${ymdDashed(date)} 점수 삭제 완료`, 'ok')
          } else {
            showToast(`해당 날짜에 점수가 없습니다`, 'info')
            setUserScoreStatus(`해당 날짜에 저장된 점수가 없어 삭제할 게 없습니다`, 'info')
          }
          // 폼 리셋
          slider.value = 80
          numEl.value = 80
          // v2.9.6.2: 슬라이더 시각 위치 동기화
          try { slider.dispatchEvent(new Event('input', { bubbles: true })) } catch (_) {}
          document.getElementById('userScoreComment').value = ''
          document.querySelectorAll('.user-score-axis').forEach(cb => cb.checked = false)
          setUserScoreBadge('new')
          btnDelete.disabled = true
          await loadUserScoreTrend()
        } catch (e) {
          setUserScoreStatus('❌ ' + (e.message || e), 'err')
          showToast('삭제 실패: ' + (e.message || e), 'err', 4000)
          btnDelete.disabled = false
        }
      })
    }
  }

  async function loadExistingScore() {
    const dateEl = document.getElementById('userScoreDate')
    if (!dateEl) return
    const date = ymdCompact(dateEl.value || todayKstISO())
    const btnDelete = document.getElementById('btnUserScoreDelete')
    try {
      const res = await fetch(`/api/admin/user-score?date=${date}`, { credentials: 'same-origin' })
      const j = await res.json()
      if (!j.ok) return
      // 기본값으로 채워넣기
      const slider = document.getElementById('userScoreSlider')
      const numEl  = document.getElementById('userScoreNumber')
      const commEl = document.getElementById('userScoreComment')
      if (j.exists && j.record) {
        slider.value = j.record.score
        numEl.value = j.record.score
        // v2.9.6.2: 슬라이더 시각 위치 + 양방향 바인딩 동기화
        try { slider.dispatchEvent(new Event('input', { bubbles: true })) } catch (_) {}
        commEl.value = j.record.comment || ''
        document.querySelectorAll('.user-score-axis').forEach(cb => {
          cb.checked = (j.record.weakAxes || []).includes(cb.value)
        })
        setUserScoreStatus(`기존 점수 ${j.record.score}점 로드 — 수정 후 다시 저장하면 업데이트됩니다`, 'info')
        // v2.9.6: 저장됨 배지 + 삭제 버튼 활성화
        setUserScoreBadge('saved')
        if (btnDelete) btnDelete.disabled = false
      } else {
        slider.value = 80
        numEl.value = 80
        // v2.9.6.2: 슬라이더 시각 위치 동기화
        try { slider.dispatchEvent(new Event('input', { bubbles: true })) } catch (_) {}
        commEl.value = ''
        document.querySelectorAll('.user-score-axis').forEach(cb => cb.checked = false)
        const el = document.getElementById('userScoreStatus')
        if (el) el.classList.add('hidden')
        // v2.9.6: 신규 입력 배지 + 삭제 버튼 비활성화
        setUserScoreBadge('new')
        if (btnDelete) btnDelete.disabled = true
      }
    } catch (e) {
      console.warn('[user-score] 기존 점수 로드 실패:', e)
    }
  }

  async function loadUserScoreTrend() {
    const elToday = document.getElementById('todayUserScore')
    const elAi    = document.getElementById('todayAiScore')
    const elGap   = document.getElementById('scoreGap')
    const elSum   = document.getElementById('userScoreSummary')
    if (!elToday) return
    try {
      const res = await fetch('/api/admin/user-scores/recent?days=7', { credentials: 'same-origin' })
      const j = await res.json()
      if (!j.ok) throw new Error(j.error || 'failed')

      // 카드 갱신 — 마지막(=오늘) 항목
      const today = j.items[j.items.length - 1] || {}
      elToday.textContent = (today.score === null || today.score === undefined) ? '미입력' : (today.score + '점')
      if (today.aiScoreSelf !== undefined && today.aiScoreExpert !== undefined) {
        elAi.textContent = `${today.aiScoreSelf}/${today.aiScoreExpert}`
      } else {
        elAi.textContent = '—'
      }

      // 7일 평균 갭
      if (j.summary && j.summary.gap !== null && j.summary.gap !== undefined) {
        const g = j.summary.gap
        elGap.textContent = (g >= 0 ? '+' : '') + g + '점'
        elGap.classList.remove('text-purple-600', 'text-red-600', 'text-green-600')
        if (g > 5) elGap.classList.add('text-red-600')
        else if (g < -5) elGap.classList.add('text-green-600')
        else elGap.classList.add('text-purple-600')
      } else {
        elGap.textContent = '—'
      }

      // 통계 라인
      if (elSum && j.summary) {
        const s = j.summary
        if (s.count > 0) {
          elSum.textContent = `${s.count}일 평균 ${s.userAvg}점 (최저 ${s.min} · 최고 ${s.max})`
        } else {
          elSum.textContent = '아직 기록 없음'
        }
      }

      // v2.9.5: 강화 지침 패널 갱신
      updateReinforcePanel(j.items)

      // Chart.js 그래프
      renderUserScoreChart(j.items)
    } catch (e) {
      console.warn('[user-score] 추이 로드 실패:', e)
      elToday.textContent = '오류'
    }
  }

  /**
   * v2.9.5: 7일 점수 추이 데이터를 기반으로 내일 Stage 2 에 적용될
   * 강화 지침을 추정해서 어드민에 표시.
   *
   * 서버측 _get_user_feedback_signal() 과 동일한 로직을 클라이언트에서 미러링:
   *   - 어제부터 거꾸로 7일 (오늘 제외)
   *   - 입력된 점수만 집계
   *   - samples >= 2 && avgScore < 80 → reinforce=true
   *   - 약점 축 빈도 Top 3 노출
   */
  function updateReinforcePanel(items) {
    const panel = document.getElementById('reinforcePanel')
    const detail = document.getElementById('reinforceDetail')
    if (!panel || !detail) return

    // 오늘 날짜 (KST)
    const today = todayKstISO().replace(/-/g, '')
    // items 는 오래된→최신 순. 오늘은 제외하고 입력된 점수만 모음
    const past = (items || []).filter(it =>
      it.date !== today
      && typeof it.score === 'number'
      && it.score !== null
    )
    if (past.length < 2) {
      detail.textContent = `과거 7일 점수 샘플 ${past.length}개 — 2개 이상 누적되면 자동 분석 시작 (현재 강화 지침 미주입).`
      panel.classList.remove('hidden')
      panel.classList.remove('from-rose-50','to-pink-50','border-rose-200')
      panel.classList.add('from-gray-50','to-gray-100','border-gray-200')
      return
    }

    // 평균
    const avg = Math.round(past.reduce((s, x) => s + x.score, 0) / past.length)
    // 약점 축 빈도
    const counts = {}
    for (const it of past) {
      for (const ax of (it.weakAxes || [])) {
        counts[ax] = (counts[ax] || 0) + 1
      }
    }
    const top = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${k}(${v}회)`)

    const reinforce = avg < 80
    if (reinforce && top.length > 0) {
      panel.classList.remove('hidden','from-gray-50','to-gray-100','border-gray-200')
      panel.classList.add('from-rose-50','to-pink-50','border-rose-200')
      detail.innerHTML = `최근 7일 평균 <b>${avg}점</b> (목표 80점 미만) → 다음 약점 축이 강화 지침으로 주입됩니다: <b>${top.join(' · ')}</b>. 내일 Stage 2 부터 적용됩니다.`
    } else if (reinforce) {
      panel.classList.remove('hidden','from-gray-50','to-gray-100','border-gray-200')
      panel.classList.add('from-rose-50','to-pink-50','border-rose-200')
      detail.innerHTML = `최근 7일 평균 <b>${avg}점</b> (목표 80점 미만)이지만 약점 축이 미체크 상태 → 강화 지침 미주입. 점수 입력 시 약점 카테고리도 함께 체크해 주세요.`
    } else {
      panel.classList.remove('hidden','from-rose-50','to-pink-50','border-rose-200')
      panel.classList.add('from-emerald-50','to-green-50','border-emerald-200')
      detail.innerHTML = `최근 7일 평균 <b>${avg}점</b> — 80점 이상으로 안정. 강화 지침 미주입 (현재 프롬프트 그대로 사용).`
    }
  }

  function renderUserScoreChart(items) {
    const canvas = document.getElementById('userScoreChart')
    if (!canvas || typeof Chart === 'undefined') return
    const labels = items.map(x => `${x.date.slice(4,6)}/${x.date.slice(6,8)}`)
    const userData = items.map(x => (x.score === null || x.score === undefined) ? null : x.score)
    const aiData = items.map(x => (x.aiScoreSelf === undefined || x.aiScoreSelf === null) ? null : x.aiScoreSelf)

    const config = {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: '사용자 점수',
            data: userData,
            borderColor: '#f59e0b',
            backgroundColor: 'rgba(245,158,11,0.15)',
            borderWidth: 3,
            tension: 0.3,
            spanGaps: true,
            pointRadius: 5,
            pointBackgroundColor: '#f59e0b',
          },
          {
            label: 'AI 자가점수',
            data: aiData,
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59,130,246,0.1)',
            borderWidth: 2,
            borderDash: [5, 5],
            tension: 0.3,
            spanGaps: true,
            pointRadius: 4,
            pointBackgroundColor: '#3b82f6',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { min: 0, max: 100, ticks: { stepSize: 20 } },
        },
        plugins: {
          legend: { position: 'top', labels: { font: { size: 11 } } },
          tooltip: { mode: 'index', intersect: false },
        },
      },
    }
    if (userScoreChart) {
      userScoreChart.data = config.data
      userScoreChart.update('none')
    } else {
      userScoreChart = new Chart(canvas, config)
    }
  }

  async function loadForbiddenStats() {
    const body = document.getElementById('forbiddenStatsBody')
    if (!body) return
    try {
      const res = await fetch('/api/admin/forbidden-stats/recent?days=7', { credentials: 'same-origin' })
      const j = await res.json()
      if (!j.ok) throw new Error(j.error || 'failed')

      const totalCards = j.items.reduce((a, b) => a + (b.totalCards || 0), 0)
      const totalHits  = j.items.reduce((a, b) => a + (b.totalHits || 0), 0)
      const cardsWith  = j.items.reduce((a, b) => a + (b.cardsWithForbidden || 0), 0)

      let html = ''
      html += `<div class="grid grid-cols-3 gap-2 mb-3">`
      html += `<div class="bg-gray-50 rounded p-2"><div class="text-gray-500">총 카드 수</div><div class="font-bold text-base">${totalCards}</div></div>`
      html += `<div class="bg-gray-50 rounded p-2"><div class="text-gray-500">표현 검출 횟수</div><div class="font-bold text-base">${totalHits}</div></div>`
      html += `<div class="bg-gray-50 rounded p-2"><div class="text-gray-500">검출 카드 비율</div><div class="font-bold text-base">${totalCards ? Math.round(cardsWith*100/totalCards) : 0}%</div></div>`
      html += `</div>`

      if (j.topOverall && j.topOverall.length > 0) {
        html += `<div class="font-medium text-gray-700 mb-1">자주 등장한 표현 Top ${j.topOverall.length}</div>`
        html += `<ul class="space-y-1">`
        for (const p of j.topOverall) {
          html += `<li class="flex justify-between border-b border-gray-100 py-0.5"><span>${p.phrase}</span><span class="text-gray-500">${p.count}회</span></li>`
        }
        html += `</ul>`
      } else {
        html += `<div class="text-gray-400">아직 통계가 쌓이지 않았습니다.</div>`
      }
      html += `<div class="mt-2 text-gray-400">※ 이 통계는 카드 드랍 없이 기록만 합니다 (v2.9.4).</div>`
      body.innerHTML = html
    } catch (e) {
      body.innerHTML = `<div class="text-red-500">로드 실패: ${e.message || e}</div>`
    }
  }

  function setupUserScoreSection() {
    setupUserScoreForm()
    loadExistingScore()
    loadUserScoreTrend()
    loadForbiddenStats()
  }

  // ═════════════════════════════════════════════════════════════
  // 실행
  // ═════════════════════════════════════════════════════════════
  console.log('[MorningStock] Admin v2.9.6.2 초기화 중…')
  setupTabs()
  setupGlobalEvents()
  setupTriggerButtons()
  setupDiagButtons()
  setupRecipientBulkHandlers()
  setupDashboard()  // v2.4.0: 수집 대시보드
  setupPipelineCard()  // v2.6.0: 3단계 파이프라인 상태 카드
  setupUserScoreSection()  // v2.9.4: 사용자 점수 입력 + 추이 + 금지어 통계
  loadPresets().then(() => reload())
  reloadRecipients()
  checkTriggerConfig()
  startSyncPolling()
  updateAddButtonState()  // v2.5.2: 초기 탭(all)에 맞춰 버튼 상태 설정
  console.log('[MorningStock] v2.9.4 초기화 완료 (사용자 점수 입력 + 금지어 통계).')
})()
