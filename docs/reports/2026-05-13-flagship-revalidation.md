# 2026-05-13 Flagship Revalidation

结论：未达旗舰水准

## 阻断项

- live smoke report is missing a source fingerprint.

## 本轮门禁结果

- source fingerprint: b603f0bda67ad572fcd73956c46902a8c471642c201d05139972def472c4edcb
- lint: passed (data/test-reports/flagship-quality/lint.log)
- typecheck: passed (data/test-reports/flagship-quality/typecheck.log)
- unit: passed (data/test-reports/flagship-quality/unit.log)
- matrix: passed (data/test-reports/flagship-quality/matrix.log)
- stress: passed (data/test-reports/flagship-quality/stress.log)
- build: passed (data/test-reports/flagship-quality/build.log)
- web-budgets: passed (data/test-reports/flagship-quality/web-budgets.log)
- docs: passed (data/test-reports/flagship-quality/docs.log)
- e2e: passed (data/test-reports/flagship-quality/e2e.log)
- a11y: passed (data/test-reports/flagship-quality/a11y.log)
- no-old-control: passed (data/test-reports/flagship-quality/no-old-control.log)

## 前端预算

- JS raw: 176.31 KiB / 190.00 KiB
- JS gzip: 55.51 KiB / 65.00 KiB
- CSS raw: 70.92 KiB / 80.00 KiB
- CSS gzip: 12.68 KiB / 15.00 KiB

## Live Smoke

- stressLevel: 5
- cases: 15
- short no-tool answer: passed | latency=4566ms | events=104 | approvals=0 | traceBytes=4066 | traceMaxEntry=1271 | rollback=false | contextCompaction=false
- project file reading: passed | latency=15963ms | events=287 | approvals=2 | traceBytes=20558 | traceMaxEntry=2170 | rollback=false | contextCompaction=false
- debug failing fixture: passed | latency=36032ms | events=749 | approvals=6 | traceBytes=44389 | traceMaxEntry=2618 | rollback=false | contextCompaction=false
- documentation authoring: passed | latency=13085ms | events=199 | approvals=4 | traceBytes=23036 | traceMaxEntry=2491 | rollback=false | contextCompaction=false
- host observation approval: passed | latency=9981ms | events=197 | approvals=2 | traceBytes=12033 | traceMaxEntry=2235 | rollback=false | contextCompaction=false
- denied tool path: passed | latency=5252ms | events=113 | approvals=2 | traceBytes=7657 | traceMaxEntry=1688 | rollback=false | contextCompaction=false
- same task follow-up: passed | latency=7922ms | events=173 | approvals=0 | traceBytes=6465 | traceMaxEntry=1512 | rollback=false | contextCompaction=false
- latest turn revert and edit: passed | latency=12805ms | events=256 | approvals=0 | traceBytes=8671 | traceMaxEntry=1336 | rollback=false | contextCompaction=false
- long context compaction under low budget: passed | latency=6203ms | events=98 | approvals=0 | traceBytes=5439 | traceMaxEntry=1531 | rollback=false | contextCompaction=true
- multi-file debug with rollback: passed | latency=21003ms | events=292 | approvals=4 | traceBytes=47541 | traceMaxEntry=2612 | rollback=false | contextCompaction=false
- long debug follow-up with context compaction: passed | latency=48627ms | events=814 | approvals=6 | traceBytes=94588 | traceMaxEntry=2569 | rollback=true | contextCompaction=true
- pending guidance consumption: passed | latency=20613ms | events=284 | approvals=4 | traceBytes=37603 | traceMaxEntry=2100 | rollback=false | contextCompaction=false
- work root boundary: passed | latency=6337ms | events=138 | approvals=2 | traceBytes=8595 | traceMaxEntry=1634 | rollback=false | contextCompaction=false
- memory without direct skill promotion: passed
- knowledge rag citation: passed | latency=5389ms | events=110 | approvals=2 | traceBytes=10898 | traceMaxEntry=2138 | rollback=false | contextCompaction=false

## UI 截图与布局指标

- desktop/docs: overflow=0px, screenshot=data/test-reports/flagship-ui/screenshots/desktop-docs.png
- desktop/history: overflow=0px, screenshot=data/test-reports/flagship-ui/screenshots/desktop-history.png
- desktop/library: overflow=0px, screenshot=data/test-reports/flagship-ui/screenshots/desktop-library.png
- desktop/settings: overflow=0px, screenshot=data/test-reports/flagship-ui/screenshots/desktop-settings.png
- desktop/tasks: overflow=0px, screenshot=data/test-reports/flagship-ui/screenshots/desktop-tasks.png
- mobile/docs: overflow=0px, screenshot=data/test-reports/flagship-ui/screenshots/mobile-docs.png
- mobile/history: overflow=0px, screenshot=data/test-reports/flagship-ui/screenshots/mobile-history.png
- mobile/library: overflow=0px, screenshot=data/test-reports/flagship-ui/screenshots/mobile-library.png
- mobile/settings: overflow=0px, screenshot=data/test-reports/flagship-ui/screenshots/mobile-settings.png
- mobile/tasks: overflow=0px, screenshot=data/test-reports/flagship-ui/screenshots/mobile-tasks.png

截图文件：

- data/test-reports/flagship-ui/screenshots/desktop-docs.png
- data/test-reports/flagship-ui/screenshots/desktop-history.png
- data/test-reports/flagship-ui/screenshots/desktop-library.png
- data/test-reports/flagship-ui/screenshots/desktop-settings.png
- data/test-reports/flagship-ui/screenshots/desktop-tasks.png
- data/test-reports/flagship-ui/screenshots/mobile-docs.png
- data/test-reports/flagship-ui/screenshots/mobile-history.png
- data/test-reports/flagship-ui/screenshots/mobile-library.png
- data/test-reports/flagship-ui/screenshots/mobile-settings.png
- data/test-reports/flagship-ui/screenshots/mobile-tasks.png

## 视觉证据边界

- 本报告只自动汇总截图归档、横向溢出预算、E2E 与 a11y 结果；未把人工审美复核伪装成自动通过项。
- 若需要人工视觉签核，应在同一日期追加独立复核记录，并说明审阅者、视口、浏览器和阻断结论。

## 说明

- 只有所有硬门禁通过、无阻断项、live smoke 与 UI 指标齐全时，才能判定为旗舰水准。