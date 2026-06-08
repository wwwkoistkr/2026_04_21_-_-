# v2.2.7 주소록 CRUD 풀패키지 업그레이드 리포트

**배포일:** 2026-04-21
**커밋:** (pending push)
**프로덕션:** https://morning-stock-briefing.pages.dev

## 🎯 배경
v2.2.6까지는 수신자 **추가/삭제/토글**만 가능했으나, 사용자 피드백으로 **삭제 안됨 이슈**와 **편집 기능 부재**가 확인됨. 이에 완전한 주소록 관리 시스템으로 업그레이드.

## ✅ 새로운 기능 (10가지)

### 백엔드 (src/index.tsx)
1. **PATCH /api/admin/recipients/:id** — email 필드 편집 지원 (중복 검증 + 자동 lowercase + trim)
2. **POST /api/admin/recipients/bulk** — 일괄 enable/disable/delete (actions: "enable" | "disable" | "delete")
3. **GET /api/admin/recipients/export** — JSON 다운로드 (schema: msaic-recipients-v1)
4. **POST /api/admin/recipients/import** — JSON 파일 일괄 등록 (mode: "merge" | "replace")
5. **GET /api/admin/recipients/backups** — 최근 7일 백업 목록
6. **POST /api/admin/recipients/backup** — 수동 백업 트리거
7. **자동 백업** — 변경 시 KV `recipients:backup:YYYYMMDD` 에 저장 (7일 TTL)
8. **이메일 정규화** — 저장 시 항상 lowercase + trim

### 프론트엔드 (public/static/admin.js + src/index.tsx)
9. **수신자 카드 UI 리디자인** — 체크박스 + 편집 버튼 + 삭제 버튼 (44x44px 모바일 친화)
10. **편집 모달** — 이메일과 별명을 한 번에 수정
11. **일괄 선택 툴바** — 전체 선택 / 활성화 / 비활성화 / 삭제 (선택된 항목만)
12. **Export/Import UI** — JSON 다운로드 & 파일 업로드 후 merge/replace 선택
13. **커스텀 확인 모달** — native confirm() 대신 사용 (showConfirm 함수 활용)

## 🧪 검증 완료 (로컬 E2E)

```
✅ PATCH 이메일 편집: r_mo838n71 → renamed@example.com → 원복 성공
✅ JSON Export: schema msaic-recipients-v1, exportedAt 포함
✅ JSON Import (merge): 2건 추가 성공, invalid-email 정상 에러
✅ 일괄 비활성화: affected: 1 (ok)
✅ 일괄 활성화: affected: 1 (ok)
✅ 일괄 삭제: 정리 완료
✅ 자동 백업: recipients:backup:20260421 (7일 TTL)
✅ 프로덕션 /api/health: v2.2.7
✅ admin.js 헤더: v2.2.7 확인
```

## 📝 사용법

### 편집
1. 수신자 카드에서 **[✏️]** 버튼 클릭 → 모달 팝업
2. 이메일 / 별명 수정 → **저장**
3. 중복 시 경고 토스트

### 삭제 (2가지 방법)
- **개별:** 카드 우측 **[🗑️]** 버튼 → 확인 모달 → 삭제
- **일괄:** 체크박스 선택 → 하단 툴바 **[🗑️ 삭제]** 버튼

### Export/Import
- **내보내기:** 📤 버튼 → `recipients-YYYYMMDD.json` 다운로드
- **가져오기:** 📥 버튼 → 파일 선택 → merge(추가) 또는 replace(교체) 선택

## 🔧 데이터 구조 (변경 없음 — 하위 호환)

```typescript
interface EmailRecipient {
  id: string           // r_xxxxxxx (base36 타임스탬프)
  email: string        // lowercase + trim
  label?: string       // 별명 (optional)
  enabled: boolean
  createdAt: string    // ISO 8601
  updatedAt?: string   // 편집 시 자동 추가
}
```

## 📌 남은 작업 (v2.2.8+ 후보)
- [ ] 발송 이력 필드 (lastSentAt, sentCount, lastFailedReason) — Python 워커에서 POST로 기록
- [ ] 수신자별 카테고리 태그 (예: 임원, 애널리스트, 테스트)
- [ ] 수신 구독 해지 토큰 링크 (List-Unsubscribe RFC 8058)

## 🔗 참고
- Production: https://morning-stock-briefing.pages.dev
- Preview: https://*.morning-stock-briefing.pages.dev
- GitHub: https://github.com/wwwkoistkr/2026_04_21_-_-
