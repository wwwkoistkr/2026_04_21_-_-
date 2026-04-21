import { jsxRenderer } from 'hono/jsx-renderer'

interface Props {
  title?: string
}

/**
 * Morning Stock AI — HTML Renderer v2.2
 * ─────────────────────────────────────
 * - PWA 풀 지원 (Android/iOS/Windows)
 * - 고해상도 아이콘 (Retina/4K/8K 디스플레이 대응)
 * - SEO·접근성 메타 태그
 * - 색상 테마 (밝은/어두운 테마 자동 전환)
 */
export const renderer = jsxRenderer(({ children, title }: any) => {
  return (
    <html lang="ko">
      <head>
        <meta charset="UTF-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=yes, maximum-scale=5.0"
        />
        <meta name="format-detection" content="telephone=no" />
        <meta name="description" content="매일 아침 7시 주식·반도체 AI 브리핑을 자동으로 받아보세요. PC와 모바일 실시간 동기화 지원." />
        <title>{title ?? 'Morning Stock AI Briefing Center'}</title>

        {/* PWA Core */}
        <link rel="manifest" href="/static/manifest.json" />
        <meta name="theme-color" content="#f59e0b" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#b45309" media="(prefers-color-scheme: dark)" />
        {/* (v2.2.6) OS 다크모드 환경에서도 라이트 UI 고정 — input 배경 검정 버그 방지 */}
        <meta name="color-scheme" content="light only" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="application-name" content="Morning Stock" />

        {/* iOS / Safari */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Morning Stock" />
        <link rel="apple-touch-icon" sizes="180x180" href="/static/icons/apple-touch-icon.png" />
        <link rel="apple-touch-icon" sizes="167x167" href="/static/icons/icon-167.png" />
        <link rel="apple-touch-icon" sizes="152x152" href="/static/icons/icon-152.png" />

        {/* Windows / Edge */}
        <meta name="msapplication-TileColor" content="#f59e0b" />
        <meta name="msapplication-TileImage" content="/static/icons/icon-144.png" />

        {/* Standard Favicons (고해상도 대응) */}
        <link rel="icon" type="image/png" sizes="16x16" href="/static/icons/favicon-16.png" />
        <link rel="icon" type="image/png" sizes="32x32" href="/static/icons/favicon-32.png" />
        <link rel="icon" type="image/png" sizes="48x48" href="/static/icons/favicon-48.png" />
        <link rel="icon" type="image/png" sizes="64x64" href="/static/icons/favicon-64.png" />
        <link rel="icon" type="image/png" sizes="192x192" href="/static/icons/icon-192.png" />
        <link rel="icon" type="image/png" sizes="512x512" href="/static/icons/icon-512.png" />
        <link rel="shortcut icon" href="/static/icons/favicon-32.png" />

        {/* OG / Twitter (SNS 공유) */}
        <meta property="og:type" content="website" />
        <meta property="og:title" content="Morning Stock AI — Briefing Center" />
        <meta property="og:description" content="매일 아침 7시 주식·반도체 AI 브리핑. PC와 모바일 실시간 동기화." />
        <meta property="og:image" content="/static/icons/icon-1024.png" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:image" content="/static/icons/icon-1024.png" />

        {/* Preconnect (성능) */}
        <link rel="preconnect" href="https://cdn.tailwindcss.com" />
        <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin="anonymous" />
        <link rel="dns-prefetch" href="https://api.github.com" />

        <script src="https://cdn.tailwindcss.com"></script>
        <link
          href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"
          rel="stylesheet"
        />
        <link href="/static/style.css?v=2.2.6" rel="stylesheet" />

        {/* Tailwind 설정: 고해상도 디스플레이 대응 breakpoints */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              tailwind.config = {
                theme: {
                  extend: {
                    screens: {
                      'xs': '480px',
                      '3xl': '1920px',
                      '4xl': '2560px',
                      '5xl': '3840px',
                    }
                  }
                }
              }
            `,
          }}
        />
      </head>
      <body class="bg-slate-50 min-h-screen text-gray-800 antialiased">
        {children}

        {/* Service Worker 등록 + 자동 업데이트 + SW 갱신 시 즉시 새로고침 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', () => {
                  navigator.serviceWorker.register('/static/sw.js').then((reg) => {
                    // 페이지 로드 시 강제 업데이트 확인
                    reg.update().catch(() => {});

                    // 새 버전 감지 시 자동 활성화
                    reg.addEventListener('updatefound', () => {
                      const nw = reg.installing;
                      if (nw) {
                        nw.addEventListener('statechange', () => {
                          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
                            console.log('[SW] 새 버전 준비 완료 - 자동 새로고침');
                            // 사용자 작업 방해 최소화: 3초 후 새로고침
                            setTimeout(() => window.location.reload(), 3000);
                          }
                        });
                      }
                    });
                  }).catch((e) => console.warn('[SW] 등록 실패:', e));

                  // SW가 업데이트 메시지 보내면 즉시 새로고침
                  navigator.serviceWorker.addEventListener('message', (e) => {
                    if (e.data && e.data.type === 'SW_UPDATED') {
                      console.log('[SW] 업데이트 감지:', e.data.version);
                    }
                  });

                  // Controller 바뀌면 (새 SW 활성화) 한 번만 새로고침
                  let reloaded = false;
                  navigator.serviceWorker.addEventListener('controllerchange', () => {
                    if (reloaded) return;
                    reloaded = true;
                    console.log('[SW] Controller 교체 - 새로고침');
                    window.location.reload();
                  });
                });
              }

              // 전역 에러 핸들러: 런타임 오류를 사용자에게 알림
              window.addEventListener('error', (e) => {
                console.error('[Global Error]', e.message, e.filename, e.lineno);
              });
              window.addEventListener('unhandledrejection', (e) => {
                console.error('[Unhandled Promise]', e.reason);
              });
            `,
          }}
        />
      </body>
    </html>
  )
})
