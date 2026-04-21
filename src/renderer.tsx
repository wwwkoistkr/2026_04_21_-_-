import { jsxRenderer } from 'hono/jsx-renderer'

interface Props {
  title?: string
}

export const renderer = jsxRenderer(({ children, title }: any) => {
  return (
    <html lang="ko">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no" />
        <meta name="format-detection" content="telephone=no" />
        <title>{title ?? 'Morning Stock AI Briefing Center'}</title>

        {/* PWA */}
        <link rel="manifest" href="/static/manifest.json" />
        <meta name="theme-color" content="#f59e0b" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="application-name" content="Morning Stock" />

        {/* iOS Home Screen */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="Morning Stock" />
        <link rel="apple-touch-icon" href="/static/icons/apple-touch-icon.png" />

        {/* Icons */}
        <link rel="icon" type="image/png" sizes="32x32" href="/static/icons/favicon-32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/static/icons/favicon-16.png" />
        <link rel="shortcut icon" href="/static/icons/favicon-32.png" />

        <script src="https://cdn.tailwindcss.com"></script>
        <link
          href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"
          rel="stylesheet"
        />
        <link href="/static/style.css" rel="stylesheet" />
      </head>
      <body class="bg-slate-50 min-h-screen text-gray-800">
        {children}

        {/* Service Worker 등록 */}
        <script dangerouslySetInnerHTML={{ __html: `
          if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
              navigator.serviceWorker.register('/static/sw.js').catch(() => {});
            });
          }
        `}} />
      </body>
    </html>
  )
})
