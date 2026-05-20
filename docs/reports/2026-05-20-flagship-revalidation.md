# 2026-05-20 Flagship Revalidation

结论：旗舰水准达标

## 本轮门禁结果

- source fingerprint: ad8ee9ce8f9a11c9b03a09e170d0b466958b36f388d5cb415262dbb96957b1bf
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

- JS raw: 149.60 KiB / 190.00 KiB
- JS gzip: 47.24 KiB / 65.00 KiB
- CSS raw: 75.97 KiB / 80.00 KiB
- CSS gzip: 13.51 KiB / 15.00 KiB

## Live Smoke

- stressLevel: 8
- cases: 22
- short no-tool answer: passed | latency=6538ms | events=140 | approvals=0 | traceBytes=0 | traceMaxEntry=0 | rollback=false | contextCompaction=false
- project file reading: passed | latency=15618ms | events=302 | approvals=2 | traceBytes=0 | traceMaxEntry=0 | rollback=false | contextCompaction=false
- debug failing fixture: passed | latency=21655ms | events=278 | approvals=6 | traceBytes=0 | traceMaxEntry=0 | rollback=false | contextCompaction=false
- documentation authoring: passed | latency=21051ms | events=324 | approvals=4 | traceBytes=0 | traceMaxEntry=0 | rollback=false | contextCompaction=false
- host observation approval: passed | latency=11961ms | events=308 | approvals=2 | traceBytes=0 | traceMaxEntry=0 | rollback=false | contextCompaction=false
- denied tool path: passed | latency=8287ms | events=188 | approvals=2 | traceBytes=0 | traceMaxEntry=0 | rollback=false | contextCompaction=false
- same task follow-up: passed | latency=11030ms | events=321 | approvals=0 | traceBytes=0 | traceMaxEntry=0 | rollback=false | contextCompaction=false
- latest turn revert and edit: passed | latency=6932ms | events=147 | approvals=0 | traceBytes=0 | traceMaxEntry=0 | rollback=false | contextCompaction=false
- long context compaction under low budget: passed | latency=3611ms | events=106 | approvals=0 | traceBytes=0 | traceMaxEntry=0 | rollback=false | contextCompaction=true
- multi-file debug with rollback: passed | latency=24762ms | events=406 | approvals=4 | traceBytes=0 | traceMaxEntry=0 | rollback=false | contextCompaction=false
- long debug follow-up with context compaction: passed | latency=51874ms | events=982 | approvals=4 | traceBytes=0 | traceMaxEntry=0 | rollback=true | contextCompaction=true
- pending guidance consumption: passed | latency=19684ms | events=197 | approvals=4 | traceBytes=0 | traceMaxEntry=0 | rollback=false | contextCompaction=false
- work root boundary: passed | latency=5524ms | events=116 | approvals=2 | traceBytes=0 | traceMaxEntry=0 | rollback=false | contextCompaction=false
- memory without direct skill promotion: passed
- explicit file tool coverage: passed | latency=14396ms | events=237 | approvals=4 | traceBytes=0 | traceMaxEntry=0 | rollback=false | contextCompaction=false
- active skill use coverage: passed | latency=11062ms | events=212 | approvals=2 | traceBytes=0 | traceMaxEntry=0 | rollback=false | contextCompaction=false
- web search tool coverage: passed | latency=8216ms | events=175 | approvals=2 | traceBytes=0 | traceMaxEntry=0 | rollback=false | contextCompaction=false
- repeated same-thread follow-up endurance: passed | latency=19453ms | events=418 | approvals=0 | traceBytes=0 | traceMaxEntry=0 | rollback=false | contextCompaction=false
- long command output materialization: passed | latency=8429ms | events=164 | approvals=2 | traceBytes=0 | traceMaxEntry=0 | rollback=false | contextCompaction=false
- concurrent no-tool task isolation: passed
- combined skill knowledge web search chain: passed | latency=13297ms | events=238 | approvals=4 | traceBytes=0 | traceMaxEntry=0 | rollback=false | contextCompaction=false
- knowledge rag citation: passed | latency=5217ms | events=97 | approvals=2 | traceBytes=0 | traceMaxEntry=0 | rollback=false | contextCompaction=false

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