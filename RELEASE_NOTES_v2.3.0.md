# v2.3.0 — YouTube 수집 제거

## 🎯 배경
- 지난 3개월간 디일렉(THEELEC) 유튜브 수집이 **실제 0건** (채널 ID 오류 + RSS 차단)
- YouTube Data API v3 키 관리 부담(활성화/제한/노출 관리) 대비 효용 낮음
- 텍스트 뉴스 58건/일으로 브리핑 품질 충분히 확보됨

## 📝 변경사항

### 코드 정리
- `briefing/collectors/youtube_news.py` **파일 제거**
- `briefing/collectors/aggregator.py`: `get_youtube_news` import 제거, 폴백 경로에서 YouTube 블록 제거
- `briefing/collectors/custom_sources.py` 정리:
  - `_fetch_youtube_rss()`, `_fetch_youtube_via_api()` 함수 제거
  - `_YT_CHANNEL_FIXUPS`, `_apply_channel_id_fixup()`, `_youtube_url_to_rss()` 제거
  - `type=youtube` 소스는 조용히 스킵 (레거시 KV 데이터 호환)
  - 카테고리 루프에서 `'yt'` 제외

### KV 데이터
- `sources:v2`에서 디일렉(THEELEC) 소스 영구 삭제 (12개 → 11개)

### 워크플로 & 시크릿
- `.github/workflows/daily_briefing.yml`:
  - `YOUTUBE_API_KEY`, `THELEC_YOUTUBE_CHANNEL_ID` env 블록 제거
- Cloudflare Pages Secret `YOUTUBE_API_KEY` 삭제
  - GitHub Secret `YOUTUBE_API_KEY`는 사용자 수동 삭제 권장 (무해하나 정리 권장)

### 버전 라벨링
- `src/index.tsx`: `v2.2.8` → `v2.3.0` (3곳)
- `public/static/admin.js`: 빌드 표기 및 콘솔 로그
- `public/static/sw.js`: 서비스 워커 캐시 버전

## 🔁 복원 방법
필요 시 git 히스토리에서 복원:
```bash
git show v2.2.9:briefing/collectors/youtube_news.py > briefing/collectors/youtube_news.py
```

## 📊 수집 소스 현황 (v2.3.0 기준)
| 카테고리 | 소스 수 | 예시 |
|---------|--------|------|
| 🇰🇷 한국 | 3 | 한국경제, 매일경제, 머니투데이 (각각 google_news) |
| 🌎 미국 | 4 | Seeking Alpha, ETF.com, Morningstar |
| ➕ 사용자 | 4 | 대신증권, StockInvest, 한국 반도체 ETF, AlphaSquare |
| **합계** | **11** | (디일렉 YouTube 제거됨) |
