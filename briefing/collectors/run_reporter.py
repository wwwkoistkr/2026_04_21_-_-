"""
[v2.4.0] 수집 결과 리포터 (Python → Cloudflare KV)

목적
-----
수집 파이프라인 실행 시, 각 소스/검색어별 진행 상황과 결과를
Cloudflare Pages (KV) 에 전송하여 관리 UI 에서 실시간 또는 사후
조회할 수 있게 한다.

동작 흐름
---------
1. 수집 시작 시   → start_run()      : runId 발급, KV 에 초기 스냅샷 저장
2. 소스 처리 직후 → record_source()  : 해당 소스의 키워드별 결과 누적 + KV 즉시 업데이트 (준실시간)
3. 수집 종료 시   → finish_run()     : 총 건수/소요시간 기록 + 이력에 저장

환경 변수 (GitHub Actions 에서 설정)
- BRIEFING_ADMIN_API      : https://morning-stock-briefing.pages.dev
- BRIEFING_REPORT_TOKEN   : 서버 Cloudflare Secret 과 동일한 토큰 (미설정 시 조용히 비활성)

설계 원칙
---------
- **실패 허용**: 리포터가 어떤 오류를 내도 원래 수집 작업은 절대 방해하지 않음
- **부분 결과 전송**: 소스 하나 끝날 때마다 즉시 PUT 하여 DRY RUN 중에도 UI 가 따라갈 수 있게 함
- **타임아웃 짧게**: 각 요청 3초 — 네트워크 문제 시 워크플로우 지연 방지
"""
from __future__ import annotations

import logging
import os
import time
import uuid
from typing import Any, Dict, List, Optional

import requests

logger = logging.getLogger(__name__)

# 환경 변수 기반 설정 (지연 로딩)
_DEFAULT_TIMEOUT = 3  # seconds — 원래 수집 지연을 막기 위해 짧게


class RunReporter:
    """수집 진행 상황을 Cloudflare KV 로 보고하는 경량 리포터.

    enabled=False 인 경우 모든 메서드는 no-op. 서비스 무중단 보장.
    """

    def __init__(
        self,
        admin_api: Optional[str] = None,
        token: Optional[str] = None,
        dry_run: bool = False,
    ) -> None:
        self.admin_api = (admin_api or os.getenv("BRIEFING_ADMIN_API") or "").rstrip("/")
        self.token = token or os.getenv("BRIEFING_REPORT_TOKEN") or ""
        self.dry_run = dry_run
        self.enabled = bool(self.admin_api and self.token)

        # 현재 실행 상태 (누적)
        self.run_id: str = ""
        self.started_at_ms: int = 0
        self.sources: List[Dict[str, Any]] = []  # 소스별 결과 누적
        self.total_target: int = 0
        self.total_actual: int = 0

        if not self.enabled:
            logger.info(
                "RunReporter 비활성 (admin_api=%s, token=%s) — 결과 전송 안함",
                bool(self.admin_api),
                bool(self.token),
            )

    # ──────────────────────────────────────────────────────────
    # 내부: HTTP 요청 헬퍼 (항상 성공한 것처럼 처리 — 원본 작업 방해 금지)
    # ──────────────────────────────────────────────────────────
    def _post(self, path: str, payload: Dict[str, Any]) -> None:
        if not self.enabled:
            return
        url = f"{self.admin_api}{path}"
        try:
            resp = requests.post(
                url,
                json=payload,
                headers={
                    "Authorization": f"Bearer {self.token}",
                    "Content-Type": "application/json",
                    "User-Agent": "MorningStockAI-Reporter/2.4.0",
                },
                timeout=_DEFAULT_TIMEOUT,
            )
            if resp.status_code >= 400:
                logger.warning(
                    "Reporter POST %s 실패: HTTP %s %s",
                    path,
                    resp.status_code,
                    resp.text[:200],
                )
        except requests.RequestException as exc:
            logger.warning("Reporter 네트워크 오류 (%s): %s", path, exc)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Reporter 예외 (%s): %s", path, exc)

    # ──────────────────────────────────────────────────────────
    # 공개 API
    # ──────────────────────────────────────────────────────────
    def start_run(self, total_sources: Optional[int] = None) -> str:
        """수집 시작 — runId 발급 + 초기 스냅샷 전송 (in_progress)."""
        self.run_id = f"run_{int(time.time())}_{uuid.uuid4().hex[:6]}"
        self.started_at_ms = int(time.time() * 1000)
        self.sources = []
        self.total_target = 0
        self.total_actual = 0

        if not self.enabled:
            return self.run_id

        snapshot = {
            "runId": self.run_id,
            "startedAt": self.started_at_ms,
            "status": "in_progress",
            "dryRun": self.dry_run,
            "totalSources": total_sources,
            "sources": [],
            "totalTarget": 0,
            "totalActual": 0,
        }
        self._post("/api/admin/record-run-progress", snapshot)
        logger.info("RunReporter 시작: runId=%s", self.run_id)
        return self.run_id

    def record_source(
        self,
        *,
        source_id: str,
        label: str,
        category: str,
        source_type: str,
        site: str,
        keyword_results: List[Dict[str, Any]],
        elapsed_sec: float,
    ) -> None:
        """단일 소스 수집 종료 시 호출 — 결과 누적 후 KV 부분 업데이트.

        keyword_results: [{keyword, target, actual, elapsed, status, error?}]
        """
        total_target = sum(int(kr.get("target", 0)) for kr in keyword_results)
        total_actual = sum(int(kr.get("actual", 0)) for kr in keyword_results)

        # 소스 상태 결정
        if total_target == 0:
            status = "skipped"
        elif total_actual == 0:
            status = "failed"
        elif total_actual < total_target:
            status = "partial"
        else:
            status = "ok"

        entry = {
            "id": source_id or "",
            "label": label,
            "category": category,
            "type": source_type,
            "site": site,
            "keywords": keyword_results,
            "totalTarget": total_target,
            "totalActual": total_actual,
            "elapsedSec": round(float(elapsed_sec), 2),
            "status": status,
            "finishedAt": int(time.time() * 1000),
        }
        self.sources.append(entry)
        self.total_target += total_target
        self.total_actual += total_actual

        if not self.enabled:
            return

        # 준실시간 업데이트 (부분 결과)
        snapshot = {
            "runId": self.run_id,
            "startedAt": self.started_at_ms,
            "status": "in_progress",
            "dryRun": self.dry_run,
            "sources": self.sources,
            "totalTarget": self.total_target,
            "totalActual": self.total_actual,
            "updatedAt": int(time.time() * 1000),
        }
        self._post("/api/admin/record-run-progress", snapshot)

    def finish_run(
        self,
        *,
        final_count_after_dedup: Optional[int] = None,
        error: Optional[str] = None,
    ) -> None:
        """수집 전체 종료 — 최종 결과 저장 (이력 append)."""
        finished_at = int(time.time() * 1000)
        duration_sec = round((finished_at - self.started_at_ms) / 1000.0, 2)

        # 전체 상태 결정
        if error:
            overall_status = "failed"
        elif not self.sources:
            overall_status = "skipped"
        else:
            # 성공 소스 비율 기준
            ok_count = sum(1 for s in self.sources if s["status"] == "ok")
            total = len(self.sources)
            if ok_count == total:
                overall_status = "ok"
            elif ok_count == 0:
                overall_status = "failed"
            else:
                overall_status = "partial"

        if not self.enabled:
            return

        payload = {
            "runId": self.run_id,
            "startedAt": self.started_at_ms,
            "finishedAt": finished_at,
            "durationSec": duration_sec,
            "status": overall_status,
            "dryRun": self.dry_run,
            "sources": self.sources,
            "totalTarget": self.total_target,
            "totalActual": self.total_actual,
            "finalCountAfterDedup": final_count_after_dedup,
            "error": error,
        }
        self._post("/api/admin/record-run-result", payload)
        logger.info(
            "RunReporter 종료: runId=%s, status=%s, %d→%d건 (%.1fs)",
            self.run_id,
            overall_status,
            self.total_target,
            self.total_actual,
            duration_sec,
        )


# ---------------------------------------------------------------------------
# 전역 싱글톤 (선택적 사용) — 간단한 파이프라인에서 편의를 위함
# ---------------------------------------------------------------------------
_global_reporter: Optional[RunReporter] = None


def get_reporter(dry_run: bool = False) -> RunReporter:
    """프로세스 전역 리포터 인스턴스 (lazy init)."""
    global _global_reporter
    if _global_reporter is None:
        _global_reporter = RunReporter(dry_run=dry_run)
    return _global_reporter


def reset_reporter() -> None:
    """테스트용 — 전역 인스턴스 초기화."""
    global _global_reporter
    _global_reporter = None
