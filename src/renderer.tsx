import { jsxRenderer } from 'hono/jsx-renderer'

interface Props {
  title?: string
}

export const renderer = jsxRenderer(({ children, title }: any) => {
  return (
    <html lang="ko">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{title ?? 'Morning Stock AI Briefing Center'}</title>
        <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ctext y='14' font-size='14'%3E🌅%3C/text%3E%3C/svg%3E" />
        <script src="https://cdn.tailwindcss.com"></script>
        <link
          href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"
          rel="stylesheet"
        />
        <link href="/static/style.css" rel="stylesheet" />
      </head>
      <body class="bg-slate-50 min-h-screen text-gray-800">{children}</body>
    </html>
  )
})
