/**
 * Morning Stock AI — Admin Dashboard Client Script
 * ────────────────────────────────────────────────
 * - 소스 리스트 로드/렌더
 * - 새 소스 추가 + 즉석 테스트
 * - 활성/비활성 토글, 삭제
 */

(function () {
  const api = {
    list: () => fetch('/api/admin/sources').then((r) => r.json()),
    add: (label, url) =>
      fetch('/api/admin/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, url }),
      }).then((r) => r.json()),
    remove: (id) =>
      fetch('/api/admin/sources/' + encodeURIComponent(id), { method: 'DELETE' }).then((r) =>
        r.json()
      ),
    patch: (id, patch) =>
      fetch('/api/admin/sources/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }).then((r) => r.json()),
    test: (url) =>
      fetch('/api/admin/test-source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      }).then((r) => r.json()),
  }

  // ───── 수신자 관리 API ─────
  const recipientApi = {
    list: () => fetch('/api/admin/recipients').then((r) => r.json()),
    add: (email, label) =>
      fetch('/api/admin/recipients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, label }),
      }).then((r) => r.json()),
    remove: (id) =>
      fetch('/api/admin/recipients/' + encodeURIComponent(id), { method: 'DELETE' }).then((r) =>
        r.json()
      ),
    patch: (id, patch) =>
      fetch('/api/admin/recipients/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }).then((r) => r.json()),
  }

  // ───── DOM ─────
  const listEl = document.getElementById('sourceList')
  const countEl = document.getElementById('sourceCount')
  const addForm = document.getElementById('addForm')
  const labelEl = document.getElementById('label')
  const urlEl = document.getElementById('url')
  const testBtn = document.getElementById('testBtn')
  const testResult = document.getElementById('testResult')

  // ───── 유틸 ─────
  const badgeFor = (type) => {
    const name = { rss: 'RSS', google_news: 'Google News', youtube: 'YouTube', web: 'Web' }[type] || type
    return `<span class="badge badge-${type}">${name}</span>`
  }

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[m]))

  function showTestResult(cls, html) {
    testResult.className = 'mt-4 p-4 rounded-lg text-sm fade-in ' + cls
    testResult.innerHTML = html
    testResult.classList.remove('hidden')
  }

  // ───── 렌더 ─────
  function renderList(sources) {
    countEl.textContent = `(총 ${sources.length}개)`
    if (sources.length === 0) {
      listEl.innerHTML = `
        <div class="text-center py-10 text-gray-400">
          <i class="fa-regular fa-folder-open text-4xl mb-2"></i>
          <p>아직 추가한 소스가 없습니다. 위에서 새 소스를 등록해 보세요.</p>
        </div>`
      return
    }

    listEl.innerHTML = sources
      .map(
        (s) => `
        <div class="source-item flex items-center gap-3 p-3 border border-gray-200 rounded-lg">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <strong class="text-gray-800">${escapeHtml(s.label)}</strong>
              ${badgeFor(s.type)}
              ${s.enabled
                ? '<span class="text-xs text-green-600"><i class="fa-solid fa-circle-check"></i> 활성</span>'
                : '<span class="text-xs text-gray-400"><i class="fa-solid fa-circle-pause"></i> 비활성</span>'}
            </div>
            <a href="${encodeURI(s.url)}" target="_blank" rel="noopener"
               class="text-xs text-blue-600 hover:underline break-all mt-1 block truncate">
              ${escapeHtml(s.url)}
            </a>
            <div class="text-xs text-gray-400 mt-0.5">
              등록: ${new Date(s.createdAt).toLocaleString('ko-KR')}
            </div>
          </div>
          <div class="flex gap-1 flex-shrink-0">
            <button data-action="toggle" data-id="${s.id}" data-enabled="${s.enabled}"
              class="px-2.5 py-1.5 text-xs rounded hover:bg-gray-100" title="활성/비활성">
              <i class="fa-solid ${s.enabled ? 'fa-toggle-on text-green-500' : 'fa-toggle-off text-gray-400'} text-base"></i>
            </button>
            <button data-action="delete" data-id="${s.id}"
              class="px-2.5 py-1.5 text-xs text-red-500 rounded hover:bg-red-50" title="삭제">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </div>`
      )
      .join('')

    // 이벤트 위임
    listEl.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', onListAction)
    })
  }

  async function onListAction(e) {
    const btn = e.currentTarget
    const id = btn.dataset.id
    const action = btn.dataset.action

    if (action === 'toggle') {
      const enabled = btn.dataset.enabled !== 'true'
      await api.patch(id, { enabled })
      await reload()
    } else if (action === 'delete') {
      if (!confirm('이 소스를 삭제할까요?')) return
      await api.remove(id)
      await reload()
    }
  }

  async function reload() {
    try {
      const data = await api.list()
      renderList(data.sources || [])
    } catch (e) {
      listEl.innerHTML = `<div class="text-red-500 p-4">목록 로드 실패: ${e.message}</div>`
    }
  }

  // ───── 추가 ─────
  addForm.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const label = labelEl.value.trim()
    const url = urlEl.value.trim()
    if (!label || !url) return
    const res = await api.add(label, url)
    if (res.error) {
      showTestResult('bg-red-50 border border-red-200 text-red-700', '⚠️ ' + res.error)
      return
    }
    labelEl.value = ''
    urlEl.value = ''
    testResult.classList.add('hidden')
    await reload()
    showTestResult(
      'bg-green-50 border border-green-200 text-green-800',
      `✅ <strong>${escapeHtml(res.source.label)}</strong> 추가 완료. (타입: ${res.source.type})`
    )
  })

  // ───── 테스트 ─────
  testBtn.addEventListener('click', async () => {
    const url = urlEl.value.trim()
    if (!url) {
      showTestResult('bg-yellow-50 border border-yellow-200 text-yellow-800', '⚠️ URL 을 입력해주세요.')
      return
    }
    showTestResult(
      'bg-blue-50 border border-blue-200 text-blue-700',
      '<i class="fa-solid fa-spinner fa-spin mr-1"></i> 수집 테스트 중… 잠시만요.'
    )
    const res = await api.test(url)
    if (res.ok) {
      const samples = (res.samples || [])
        .map((t, i) => `<li class="truncate"><span class="text-gray-400 mr-1">${i + 1}.</span>${escapeHtml(t)}</li>`)
        .join('')
      showTestResult(
        'bg-green-50 border border-green-200 text-green-800',
        `
          <div class="font-semibold mb-1">${res.message}</div>
          <div class="text-xs text-gray-600 mb-2">타입: <code>${res.type}</code> · 수집된 샘플 ${res.sampleCount}건</div>
          <ul class="text-xs space-y-0.5">${samples}</ul>
        `
      )
    } else {
      showTestResult(
        'bg-red-50 border border-red-200 text-red-700',
        `
          <div class="font-semibold mb-1">❌ 수집 실패</div>
          <div class="text-xs">사유: ${escapeHtml(res.error || '알 수 없음')}</div>
          <div class="text-xs text-gray-500 mt-1">타입 추정: <code>${res.type}</code></div>
        `
      )
    }
  })

  // ═══════════════════════════════════════════════════════════
  // 이메일 수신자 관리
  // ═══════════════════════════════════════════════════════════
  const recipientListEl = document.getElementById('recipientList')
  const recipientCountEl = document.getElementById('recipientCount')
  const addRecipientForm = document.getElementById('addRecipientForm')
  const recipientEmailEl = document.getElementById('recipientEmail')
  const recipientLabelEl = document.getElementById('recipientLabel')

  function renderRecipients(recipients) {
    recipientCountEl.textContent = `(총 ${recipients.length}명)`
    if (recipients.length === 0) {
      recipientListEl.innerHTML = `
        <div class="text-center py-6 text-gray-400 text-sm">
          <i class="fa-regular fa-envelope text-3xl mb-2"></i>
          <p>등록된 수신자가 없습니다. 위에서 이메일을 추가해 주세요.</p>
        </div>`
      return
    }

    recipientListEl.innerHTML = recipients
      .map(
        (r) => `
        <div class="flex items-center gap-3 p-3 border border-gray-200 rounded-lg ${
          r.enabled ? 'bg-emerald-50/30' : 'bg-gray-50'
        }">
          <div class="flex-shrink-0">
            <i class="fa-solid fa-envelope ${r.enabled ? 'text-emerald-500' : 'text-gray-300'} text-xl"></i>
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <strong class="text-gray-800">${escapeHtml(r.email)}</strong>
              ${r.label ? `<span class="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">${escapeHtml(r.label)}</span>` : ''}
              ${r.enabled
                ? '<span class="text-xs text-emerald-600"><i class="fa-solid fa-circle-check"></i> 활성</span>'
                : '<span class="text-xs text-gray-400"><i class="fa-solid fa-circle-pause"></i> 비활성</span>'}
            </div>
            <div class="text-xs text-gray-400 mt-0.5">
              등록: ${new Date(r.createdAt).toLocaleString('ko-KR')}
            </div>
          </div>
          <div class="flex gap-1 flex-shrink-0">
            <button data-raction="toggle" data-rid="${r.id}" data-renabled="${r.enabled}"
              class="px-2.5 py-1.5 text-xs rounded hover:bg-gray-100" title="활성/비활성">
              <i class="fa-solid ${r.enabled ? 'fa-toggle-on text-emerald-500' : 'fa-toggle-off text-gray-400'} text-base"></i>
            </button>
            <button data-raction="delete" data-rid="${r.id}"
              class="px-2.5 py-1.5 text-xs text-red-500 rounded hover:bg-red-50" title="삭제">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </div>`
      )
      .join('')

    recipientListEl.querySelectorAll('button[data-raction]').forEach((btn) => {
      btn.addEventListener('click', onRecipientAction)
    })
  }

  async function onRecipientAction(e) {
    const btn = e.currentTarget
    const id = btn.dataset.rid
    const action = btn.dataset.raction

    if (action === 'toggle') {
      const enabled = btn.dataset.renabled !== 'true'
      await recipientApi.patch(id, { enabled })
      await reloadRecipients()
    } else if (action === 'delete') {
      if (!confirm('이 수신자를 삭제할까요?\n삭제 후 더 이상 브리핑을 받지 못합니다.')) return
      await recipientApi.remove(id)
      await reloadRecipients()
    }
  }

  async function reloadRecipients() {
    try {
      const data = await recipientApi.list()
      renderRecipients(data.recipients || [])
    } catch (e) {
      recipientListEl.innerHTML = `<div class="text-red-500 p-4 text-sm">수신자 목록 로드 실패: ${e.message}</div>`
    }
  }

  addRecipientForm.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const email = recipientEmailEl.value.trim()
    const label = recipientLabelEl.value.trim()
    if (!email) return

    const res = await recipientApi.add(email, label)
    if (res.error) {
      alert('⚠️ ' + res.error)
      return
    }
    recipientEmailEl.value = ''
    recipientLabelEl.value = ''
    await reloadRecipients()
  })

  // ───── 초기 로드 ─────
  reload()
  reloadRecipients()
})()
