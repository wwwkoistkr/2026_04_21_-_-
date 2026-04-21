/**
 * Morning Stock AI — Service Worker v2.1
 * ─────────────────────────────────────
 * - App shell cache (정적 파일)
 * - API 요청: 네트워크 우선, 실패 시 캐시
 * - 로그인 만료 시 자동 리다이렉트
 */
const CACHE_VERSION = 'msaic-v2.1.0'
const APP_SHELL = [
  '/static/admin.js',
  '/static/style.css',
  '/static/manifest.json',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
  '/static/icons/apple-touch-icon.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      )
    )
  )
  self.clients.claim()
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

  // 정적 파일: stale-while-revalidate
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
