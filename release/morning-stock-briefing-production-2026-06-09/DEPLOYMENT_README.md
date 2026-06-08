# Morning Stock Briefing Production Release

Release date: 2026-06-09
Source code commit: aa89197

This release contains the production web build, Python stock briefing pipeline,
GitHub Actions workflow files, and helper scripts for setup/deploy/run.

## Folder Layout

- `cloudflare-pages/dist/`
  - Production Cloudflare Pages/Worker build.
- `cloudflare-pages/deploy-cloudflare.ps1`
  - Builds nothing; deploys the included production `dist` folder.
- `python-pipeline/`
  - Python collect/summarize/send pipeline.
- `python-pipeline/setup-python.ps1`
  - Creates `.venv` and installs `requirements.txt`.
- `python-pipeline/run-collect.ps1`
  - Runs `python main.py collect`.
- `python-pipeline/run-summarize.ps1`
  - Runs `python main.py summarize`.
- `python-pipeline/run-send.ps1`
  - Runs `python main.py send`.
- `python-pipeline/run-all.ps1`
  - Runs `python main.py all`.
- `source-config/`
  - Source/config files for future rebuilds.
- `github-actions/.github/`
  - Workflow files for scheduled automation.

## 1. Deploy Web Console To Cloudflare

Open PowerShell in `cloudflare-pages` and run:

```powershell
.\deploy-cloudflare.ps1
```

Required Cloudflare settings:

- KV binding: `SOURCES_KV`
- Secrets:
  - `ADMIN_PASSWORD`
  - `BRIEFING_READ_TOKEN`
  - `BRIEFING_REPORT_TOKEN`
  - `GITHUB_TRIGGER_TOKEN`
  - `EMAIL_SENDER`
  - `EMAIL_APP_PASSWORD`

## 2. Run Python Pipeline

Open PowerShell in `python-pipeline` and run setup once:

```powershell
.\setup-python.ps1
```

Then set environment variables or copy `.env.example` into your own environment
manager. Required values:

- `GEMINI_API_KEY`
- `EMAIL_SENDER`
- `EMAIL_APP_PASSWORD`
- `EMAIL_RECIPIENTS`
- `BRIEFING_ADMIN_API`
- `BRIEFING_READ_TOKEN`
- `BRIEFING_REPORT_TOKEN`

Freshness defaults included in the code:

- `ARTICLE_MAX_AGE_HOURS=72`
- `ARTICLE_ALLOW_UNDATED=true`
- `GOOGLE_NEWS_RECENT_WINDOW=2d`

Run stages:

```powershell
.\run-collect.ps1
.\run-summarize.ps1
.\run-send.ps1
```

Or run all in one pass:

```powershell
.\run-all.ps1
```

## Verification

Before packaging, `npm run build` completed successfully and produced:

- `cloudflare-pages/dist/_worker.js`
- `cloudflare-pages/dist/_routes.json`
- static admin/PWA assets under `cloudflare-pages/dist/static/`

