// PM2 configuration for local sandbox development
// Runs `wrangler pages dev` which serves the built Hono app.

module.exports = {
  apps: [
    {
      name: 'morning-stock-briefing',
      script: 'npx',
      args: 'wrangler pages dev dist --ip 0.0.0.0 --port 3000 --kv SOURCES_KV',
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        // 개발용 기본 비밀번호 — 프로덕션에서는 wrangler secret 로 교체됨
        ADMIN_PASSWORD: 'admin1234',
        // Python 수집기가 공개 API 호출 시 쓰는 토큰 (개발용)
        BRIEFING_READ_TOKEN: 'dev-briefing-token',
        // GitHub Actions workflow_dispatch 용 PAT
        // 프로덕션에서는 wrangler pages secret 로 교체됨
        GITHUB_TRIGGER_TOKEN: process.env.GITHUB_TRIGGER_TOKEN || '',
        GITHUB_REPO: 'wwwkoistkr/2026_04_21_-_-',
        GITHUB_WORKFLOW_FILE: 'daily_briefing.yml',
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork',
    },
  ],
}
