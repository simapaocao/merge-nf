# 手机端（iPhone SE 3）适配与防缩放改造交接记录

## 1. 背景与 Commit 拆分说明

本次改造基于前序开发会话结束时的工作树完成。为了方便后续交接与回溯，已将改动清晰拆分为两次独立 commit：

1. **Commit 1 — `feat: add session kind metadata, focus mode, and tab activity polish`**
   - 完整保留并提交前序会话中未提交的改动（主/子会话元数据协议、连接器 `0.1.4`、服务端迁移与分组视图、需关注/全部模式、标签栏活性与概览精简等），未做任何逻辑删改。
2. **Commit 2 — `feat(web): adapt mobile UI for iPhone SE 3 and prevent pinch zoom`**
   - 仅包含本次针对手机端（重点 **iPhone SE 3，375×667 CSS 视口，iOS Safari**）的 UI 操作优化、防双指缩放/防输入框自动放大防护、新增单元测试、发布清单白名单更新，以及本文档。

后续如需查看本次全部改动，直接执行 `git show HEAD` 即可，与前序功能改动完全解耦。

---

## 2. 本次修改清单

| 文件 | 变更说明 |
| --- | --- |
| `apps/web/index.html` | Viewport 补充 `maximum-scale=1.0, minimum-scale=1.0, user-scalable=no, viewport-fit=cover`；新增 `format-detection: telephone=no` 防止 iOS Safari 误把 IP/端口/会话 ID 识别为电话号码；保持无内联脚本以兼容 CSP 与 `appearance.test.tsx`。 |
| `apps/web/src/lib/mobileViewport.ts` | 新增 `installMobileZoomGuard()`：通过 `{ passive: false }` 阻止 iOS Safari `gesturestart/gesturechange/gestureend` 以及多指 `touchstart/touchmove`（`touches.length > 1` 或 `scale !== 1`），解决 iOS Safari 忽略 `user-scalable=no` 导致的双指捏合放大问题，同时不影响单指滚动、点击与桌面端缩放。 |
| `apps/web/src/main.tsx` | 在应用入口调用 `installMobileZoomGuard()`（打包进 Vite 主 bundle，无需改动 `public/` 或服务器静态路由白名单）。 |
| `apps/web/src/components/Icon.tsx` | 新增 `filter` 图标，供手机端会话筛选折叠按钮使用。 |
| `apps/web/src/components/InstanceTabs.tsx` | 在无已打开实例标签时为 `.instance-tabs` 增加 `tabs-empty-state` 类，移动端据此自动收起空标签行以释放首屏高度。 |
| `apps/web/src/pages/SessionsPage.tsx` | 为搜索框新增一键清空按钮（`search-clear`）；新增仅在移动端生效的「筛选」折叠开关与生效筛选数量角标（`mobile-filter-toggle` / `mobile-collapsed`），默认折叠次级筛选栏，桌面端保持原样常驻展开。 |
| `apps/web/src/components/SessionCards.css` | 优化 `@media(max-width:720px)` 下会话分区标题（保持单行左右对齐）、卡片字号（标题 `14px`、元信息 `11–12px`）、点击按压态（`:active`）与切换按钮触控热区；保留 `session-cards.test.tsx` 要求的全部响应式断点与样式隔离约束。 |
| `apps/web/src/styles.css` | ① 全局防缩放与顺滑滚动基础（`touch-action: pan-x pan-y`、`overscroll-behavior`、`-webkit-text-size-adjust: 100%`、交互元素 `touch-action: manipulation`、安全区 `env(safe-area-inset-*)`）；② 移动端所有 `<input>`/`<select>` 统一 `16px` 杜绝 iOS Safari 聚焦自动放大；③ 375px 双行顶栏（第一行侧栏 + 「会话/工作台/连接」一键分段切换 + 工作台/外观/账户操作，≤355px 回退折叠菜单；第二行全宽独立实例标签栏）；④ 侧栏抽屉放宽至 `min(280px, 82vw)`，遮罩改为相对 `.app-body` 绝对定位；⑤ 会话列表（`.session-table`）在移动端转为纵向卡片行，彻底消除 `820px` 横向拖动；⑥ 修复 `.connection-paths > div` 在 ≤980px 下未转单列导致的三列挤压问题；⑦ 连接卡片危险操作区分隔离，所有弹窗改为底部抽屉卡片，登录页输入框与按钮触控放大。 |
| `apps/web/test/mobile-viewport.test.ts` | 新增单元测试，覆盖 `index.html` viewport/format-detection 配置、`installMobileZoomGuard()` 手势/双指拦截与单指放行及清理逻辑、移动端防输入放大 `16px` 与 `.connection-paths` 单列样式回归校验。 |
| `deploy/package-release.py` | 将新增的 `apps/web/src/lib/mobileViewport.ts` 与 `apps/web/test/mobile-viewport.test.ts` 纳入 `TEXT_GROUPS` 严格源码白名单，确保后续发布打包校验通过。 |

---

## 3. 约束遵守与已知边界

- **既有约束均已保留**：
  - 未添加内联 `<script>`，未修改 `apps/web/public/theme-init.js` 与服务端 CSP（`script-src 'self'`）。
  - 保留 `.iframe-area iframe` 的 `color-scheme: light dark` 与无 `filter` 约束。
  - 保留 `PageNavigation` 桌面/移动双语义与 `aria-current="page"` 断言、`InstanceTabBar` 无障碍与文案断言、`SessionCards.css` 隔离规则（不含 `:root` 与 `.session-table`）。
  - 桌面端（`>720px`）布局与原有交互行为未改动（仅对 `≤980px` 补齐 `.connection-paths > div` 单列修复，以及全局搜索框增加输入后的清空按钮）。
- **跨域 iframe 边界**：
  - 防双指缩放逻辑作用于聚合工作台外壳与所有管理页面（全局会话、连接管理、登录页、抽屉、弹窗、顶栏与标签栏）。
  - 实例工作台内嵌的各 NF 原站 `iframe` 属于独立 origin，浏览器同源策略禁止父页面监听或拦截其内部触控手势；若原站内部页面需要禁止双指缩放，需在各 NF 原站前端单独处理。
- **未改动线上/运行中环境**：
  - 未重启或修改任何运行中的 NF 宿主与连接器；`apps/web/dist` 已在本地重新构建，待你确认后按既有流程部署即可。

---

## 4. 验证情况

- `bun run typecheck`：全部通过（core + web + nf-connector）。
- `bun run test`：全部通过（含新增 `apps/web/test/mobile-viewport.test.ts`，前端共 140 项测试 0 失败）。
- `bun run --cwd apps/web build`：构建成功，`apps/web/dist` 已更新。
- `deploy/package-release.py`：`check_source_inventory()` 与 `web_assets()` 校验通过。
