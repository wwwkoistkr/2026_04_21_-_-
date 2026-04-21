/**
 * Morning Stock AI — Service Worker v2.2.7
 * ─────────────────────────────────────
 * - App shell cache (정적 파일)
 * - admin.js: 네트워크 우선 (최신 코드 강제 적용)
 * - API 요청: 네트워크 우선, 실패 시 캐시
 * - 로그인 만료 시 자동 리다이렉트
 * - 버전 업데이트 시 기존 캐시 자동 삭제 + 클라이언트 즉시 새로고침
 */
const CACHE_VERSION = 'msaic-v2.2.7'
const APP_SHELL = [
  '/static/style.css',
  '/static/manifest.json',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
  '/static/icons/apple-touch-icon.png',
]

// ★ 네트워크 우선으로 가져올 파일 (자주 변경되는 JS) — 캐시 stale 문제 방지
const NETWORK_FIRST_PATHS = [
  '/static/admin.js',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  )
  // 즉시 활성화 → 기존 탭도 빨리 새 SW 사용
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 기존 캐시 모두 삭제
      const keys = await caches.keys()
      await Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      )
      // 모든 클라이언트 즉시 장악
      await self.clients.claim()
      // 활성 클라이언트에 리로드 신호 전송 (선택적)
      const clients = await self.clients.matchAll({ type: 'window' })
      for (const client of clients) {
        client.postMessage({ type: 'SW_UPDATED', version: CACHE_VERSION })
      }
    })()
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // 다른 도메인은 건드리지 않음
  if (url.origin !== self.location.origin) return

  // API / 인증 / 로그인 관련은 항상 네트워크 (캐시하지 않음)
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname === '/login' ||
    url.pathname === '/logout'
  ) {
    return // 기본 네트워크 동작
  }

  // ★ 네트워크 우선 파일 (admin.js 등) - 네트워크 실패 시에만 캐시
  if (NETWORK_FIRST_PATHS.some((p) => url.pathname === p)) {
    event.respondWith(
      fetch(request)
        .then((resp) => {
          if (resp && resp.ok) {
            const respClone = resp.clone()
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, respClone))
          }
          return resp
        })
        .catch(() => caches.match(request).then((c) => c || new Response('offline', { status: 503 })))
    )
    return
  }

  // 정적 파일: stale-while-revalidate (이미지, CSS, manifest 등)
  if (url.pathname.startsWith('/static/')) {
    event.respondWith(
      caches.open(CACHE_VERSION).then((cache) =>
        cache.match(request).then((cached) => {
          const fetchPromise = fetch(request)
            .then((resp) => {
              if (resp.ok) cache.put(request, resp.clone())
              return resp
            })
            .catch(() => cached || new Response('offline', { status: 503 }))
          return cached || fetchPromise
        })
      )
    )
    return
  }

  // HTML(대시보드) 은 네트워크 우선, 오프라인 시 캐시된 정적 리소스로 복원
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match('/static/manifest.json').then(() =>
          new Response(
            '<h1>오프라인 상태</h1><p>네트워크가 복구되면 다시 시도하세요.</p>',
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          )
        )
      )
    )
  }
})
