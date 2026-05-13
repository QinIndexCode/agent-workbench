# 2026-05-13 Flagship Revalidation

结论：未达旗舰水准

## 阻断项

- live smoke report was generated for a different source fingerprint: 3fca905dcf314b4f24b65ac0133e1a5e772898d7c0d08e2857b6a8cf8211786e.
- Live smoke failed: provider configuration (provider_configuration).

## 本轮门禁结果

- source fingerprint: 2225c18fe03fe2a71f0a5db1a4703bc546f62e8ddea02342126a3eabfd034e62
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
- cases: 1
- provider configuration: failed (provider_configuration)

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