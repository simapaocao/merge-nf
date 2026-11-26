# 手机端（iPhone SE 3）适配与防缩放改造交接记录

## 1. 背景与 Commit 拆分说明

本次改造基于前序开发会话结束时的工作树完成。为了方便后续交接与回溯，已将改动清晰拆分为两次独立 commit：

1. **Commit 1 — `feat: add session kind metadata, focus mode, and tab activity polish`**
   - 完整保留并提交前序会话中未提交的改动（主/子会话元数据协议、连接器 `0.1.4`、服务端迁移与分组视图、需关注/全部模式、标签栏活性与概览精简等），未做任何逻辑删改。
2. **Commit 2 — `feat(web): adapt mobile UI for iPhone SE 3 and prevent pinch zoom`**
   - 仅包含本次针对手机端（重点 **iPhone SE 3，375×667 CSS 视口，iOS Safari**）的 UI 操作优化、防双指缩放/防输入框自动放大防护、新增单元测试、发布清单白名单更新，以及本文档初版。
3. **Commit 3 — `fix(auth): persist mobile login sessions with 30d sliding cookie and SameSite=Lax`**
   - 修复手机端频繁要求重新登录的问题：服务端会话有效期从固定 12 小时升级为 30 天并支持按 24 小时节流自动滑动续期；Cookie 改为 `SameSite=Lax` 并同时下发 `Max-Age` 与 `Expires`；登录表单补齐 `method="post"`、`name`/`id`/`htmlFor`/`type="submit"` 便于 iOS Safari / iCloud 钥匙串保存和自动填充密码。
4. **Commit 4 — `docs: record deployment and same-site NF subdomain setup in handoff`**
   - 记录 `10.8.0.1` 线上部署目录与同主域子域名（`nf1/nf2/nf12.smpc.asia`）改造方案。
5. **Commit 5 — `feat(web): add draggable tab reorder and multi-NF split screen`**
   - 实例标签栏支持鼠标拖拽排序（带左右插入提示线）、`Alt + ←/→` 键盘调序，以及「已打开」下拉菜单内 `↑/↓` 触屏调序；支持将标签直接拖入工作台边缘触发左/右/下分屏或拖入已有分屏切换/对调。
   - 新增多 NF 窗口分屏设置（`单屏` / `左右双屏` / `上下双屏` / `三屏并排` / `左主右双`），支持指针拖拽分隔线实时调宽（双击均分、键盘可调）、每个分屏独立切换实例/刷新/对调/全屏/关闭；保持所有 `iframe` 位于 `.iframe-area` 稳定 DOM 顺序中仅改定位尺寸，切分屏/对调/改大小均**不重载**已保活 NF 页面；分屏状态按账号隔离持久化到 `sessionStorage` 并在登出时同步清理。
6. **Commit 6 — `feat(web): enable iOS standalone PWA web app metadata`**
   - 为工作台补齐 iOS/Android 桌面全屏 Web App 元信息（`apple-mobile-web-app-capable`、`mobile-web-app-capable`、`apple-mobile-web-app-status-bar-style="default"`、`apple-mobile-web-app-title`），在不改动严格静态资源白名单（`package-release.py` / `static.test.ts`）的前提下支持添加到主屏幕以全屏 App 打开；同步在 `10.8.0.1` 上线 `/apple-touch-icon.png` 及独立只读反代容器 `nf-pwa-bridge`（给 `nf1/nf2/nf12.smpc.asia` 提供各子域名隔离的 AES-256-GCM 30 天 `HttpOnly; Secure; SameSite=Lax` Cookie 持久兜底与 `/api/_nf_pwa_bridge.js` 自动回填，应对 iOS `Web.app` 清理跨源 `iframe` `localStorage` 问题）。
7. **Commit 7 — `feat(web): compact mobile header and hide tab row by default`**
   - 手机端（`≤720px`）默认收起第二行实例标签栏且收起态完全隐藏（`display: none`，`0px`），在顶栏第一行提供带打开数量角标的一键展开/隐藏按钮（`.mobile-tabs-toggle`），并将顶栏单行高度从 `44px` 压缩至 `38px`（顶部总占用由 `84px` 降至 `38px`）；桌面端保持原样。同步升级 `10.8.0.1` 的 `nf-pwa-bridge`，增加 `/api/_nf_pwa_prefs` 与压缩加密 Cookie `__Host-nf_pwa_prefs`，自动持久化并首屏无闪烁恢复各 NF 的全部「外观与界面」本地设置（`mantine-color-scheme-value`、`narrafork_oled`、`narrafork_plugin_theme`、`narrafork_appearance_sync_v1:*`、`narrafork_background`、`narrafork_lang` 等）。

后续如需查看本次全部改动，可直接查看 Commit 2（`26e1628`）至 `HEAD`，与前序功能改动（`e6f789e`）完全解耦。

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
| `apps/server/src/auth.ts` | 会话有效期 `SESSION_MS` 由 12 小时调整为 30 天（无需数据库迁移）；新增 `renewSession()` 按 24 小时节流自动滑动续期；`sessionCookie()` 保持 `__Host-` / `HttpOnly` / `Secure` / 无 `Domain`，将 `SameSite=Strict` 改为 `SameSite=Lax` 并同时输出 `Max-Age` 与 `Expires`。 |
| `apps/server/src/web-routes.ts` | 登录与登出使用统一时钟写入 `Set-Cookie`；在 `/api/*` 鉴权中间件中对非登出请求按 24 小时节流自动续期并回写刷新后的 `Set-Cookie`。 |
| `apps/web/src/pages/LoginPage.tsx` | 登录表单补齐 `method="post"`、`htmlFor`/`id`/`name`、`type="text"`、`autoCorrect="off"` 及 `type="submit"`，改善 iOS Safari / iCloud 钥匙串密码保存与自动填充体验。 |
| `apps/server/test/auth-http.test.ts` | 补充 30 天 `Max-Age`/`Expires`/`SameSite=Lax`、24 小时节流滑动续期、登出不续期、超过 30 天不活跃失效等服务端鉴权测试。 |
| `apps/web/src/lib/tabs.ts` / `useInstanceTabs.ts` | 新增纯函数 `moveTab()` 与 `useInstanceTabs().reorder()`，支持按 `before`/`after` 调整标签顺序并保持 `activeId` 与 `{ v: 1, ids, active }` 存储格式不变。 |
| `apps/web/src/lib/splitLayout.ts` | 新增多 NF 分屏状态机与纯几何引擎（5 种布局、安全比例裁剪、自动对调、关闭降级、按账号隔离 `sessionStorage` 持久化与登出清理）。 |
| `apps/web/src/components/InstanceTabs.tsx` | 标签支持 HTML5 拖拽重排、`Alt+←/→` 键盘调序、「已打开」菜单 `↑/↓` 触屏排序，及分屏展示态高亮（`.in-split`）。 |
| `apps/web/src/pages/WorkbenchPage.tsx` / `App.tsx` / `hooks/useAppState.tsx` / `styles.css` | 顶栏新增「分屏布局」菜单；工作台采用无 DOM 重挂百分比定位渲染多 NF `iframe`，配套分屏标题栏、可拖拽分隔线（含跨域 iframe 指针遮罩）、拖入分屏落区，以及 375px 手机端顶栏与 `16px` 下拉防缩放适配。 |
| `apps/web/test/split-layout.test.tsx` | 新增 11 项单元测试覆盖标签拖拽排序、分屏状态转换、几何比例与分隔线、持久化隔离清理与标签栏分屏渲染语义；同步更新 `deploy/package-release.py` 白名单。 |

---

## 3. 约束遵守与已知边界

- **既有约束均已保留**：
  - 未添加内联 `<script>`，未修改 `apps/web/public/theme-init.js` 与服务端 CSP（`script-src 'self'`）。
  - 保留 `.iframe-area iframe` 的 `color-scheme: light dark` 与无 `filter` 约束。
  - 保留 `PageNavigation` 桌面/移动双语义与 `aria-current="page"` 断言、`InstanceTabBar` 无障碍与文案断言、`SessionCards.css` 隔离规则（不含 `:root` 与 `.session-table`）。
  - 桌面端（`>720px`）布局与原有交互行为未改动（仅对 `≤980px` 补齐 `.connection-paths > div` 单列修复，以及全局搜索框增加输入后的清空按钮）。
- **跨域 iframe 与 iOS Safari 边界**：
  - 防双指缩放逻辑作用于聚合工作台外壳与所有管理页面（全局会话、连接管理、登录页、抽屉、弹窗、顶栏与标签栏）。
  - 实例工作台内嵌的各 NF 原站 `iframe` 属于独立 origin，浏览器同源策略禁止父页面监听或拦截其内部触控手势；若原站内部页面需要禁止双指缩放，需在各 NF 原站前端单独处理。
  - 聚合工作台本身的登录态现已支持 30 天滑动持久化；但如果在 iPhone 上使用的是 Safari「无痕浏览」，关闭标签/浏览器仍会清空 Cookie。此外，若是指**工作台内嵌的某个 NF 原站**每次都要重新登录，通常是因为 iOS Safari 默认开启「阻止跨网站跟踪（ITP）」会拦截跨域 `iframe` 的第三方 Cookie（可在 iOS「设置 → Safari 浏览器 → 阻止跨网站跟踪」确认，或通过右上角「在新窗口打开」直连原站）。
- **线上部署与同主域子域名改造（已完成，位于 `10.8.0.1`）**：
  - **工作台发版目录**：`/opt/nf-workbench/mobile-se3-release-20261125T0622Z-a193369`（复用原 Bun 镜像，无服务器 build，切换前 DB 备份位于 `backup/hub.sqlite`，原目录 `focus-release-20261124T192919Z-13cc26bc3023` 与 `compose.before.yaml` 均保留）。
  - **同主域子域名方案（解决 iOS Safari 跨站 `iframe` 清空 NF `localStorage["narrafork_token"]` 问题）**：
    - 阿里云 DNS 新增 3 条 VPN 内网 A 记录指向 `10.8.0.1`：`nf1.smpc.asia`、`nf2.smpc.asia`、`nf12.smpc.asia`（记录 ID 存于 `/opt/nf-workbench/secrets/lego-nf/dns-a-records.json`）。
    - 独立签发 `*.smpc.asia` Let's Encrypt 泛域名证书至 `/opt/nf-workbench/tls-nf/live/current/`，配独立脚本 `/opt/nf-workbench/.deploy/vpn-nf/cert_nf_manager.py` 与每日自动续签定时器 `nf-workbench-nf-tls.timer`（原 `www.smpc.asia` 证书与 `nf-workbench-www-tls.timer` 未改动）。
    - 固定 `10.8.0.2:7778` 的 NarraFork Local CA 根证书至 `/opt/nf-workbench/.deploy/nf2-upstream-root.crt`（严格 TLS，未跳过校验）；在 `/opt/nf-workbench/.deploy/Caddyfile` 新增 `https://nf1.smpc.asia`（→ `https://10.8.0.1:7778`）、`https://nf2.smpc.asia`（→ `https://10.8.0.2:7778`）、`https://nf12.smpc.asia`（→ `http://10.8.0.12:7778`），保留旧 `nf-1.internal` / `nf-12.internal`；保持 `compose.yaml` (`0644`) 与 `Caddyfile` (`0444`) 权限以兼容原 `cert_manager.py` 校验，切前备份位于 `/opt/nf-workbench/.deploy/vpn-nf/backup-before-cutover/`。
    - 工作台数据库 3 台实例浏览器入口已更新为 `https://nf1.smpc.asia`、`https://nf2.smpc.asia`、`https://nf12.smpc.asia`（原连接器配对、代次与会话摘要完整保留，未改动或重启 3 台 NF 主机）。

---

## 4. 验证情况

- `bun run typecheck`：全部通过（core + web + nf-connector）。
- `bun run test`：全部通过（共 310 项测试 0 失败：protocol/server 72 + web 151 + nf-connector 87）。
- `bun run --cwd apps/web build`：构建成功，`apps/web/dist` 已更新。
- `deploy/package-release.py`：`check_source_inventory()` 与 `web_assets()` 校验通过。
