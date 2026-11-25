# NF Workbench · 多 NF 聚合工作台

把多台独立 NarraFork（NF）的原站放进同一个工作台，用只读摘要统一查看会话状态，再回到对应原站操作。中心应用不转发 NF 业务请求，也不合并各站账号或会话；需要 HTTPS 入口时可配合独立反向代理。

## 能做什么

- 同页切换多台 NF 原站；最多保留 **3 个 iframe**，按最近使用顺序淘汰，更多实例仍可配置。
- 汇总会话标题、状态、项目及时间，支持搜索和按实例、项目、状态筛选。
- 管理实例别名、分组、收藏、排序、浏览器入口及摘要授权。
- 原站嵌入与摘要同步独立验证；不能嵌入时，可在新窗口打开原站。
- 顶栏切换 NF、刷新或打开更多操作；实例列表默认完全收起，可用左上角按钮展开，浏览器会记住桌面选择。手机使用临时抽屉。
- 外观菜单提供跟随系统、浅色和深色；深色下可开启 OLED 纯黑。偏好保存在本浏览器，仅影响聚合外壳，各 NF 原站仍独立设置外观。
- 由每台 NF 上的连接器主动向中心上传；发布范围须在 NF 本机明确选择并同意，默认不发布。

```text
浏览器 ── 中心账号 ── Hub：网页 + 摘要 API + SQLite
   └── 各站独立登录 ── NF A / NF B / NF C 原站（iframe 或新窗口）
                           └── 连接器 ── HTTPS 只读摘要 ──> Hub
```

中心登录凭据、NF 原站登录凭据、连接器上报凭据是三套不同身份。不要把 NF 管理 token 填入连接器，也不要跨站复制登录 cookie。

## 环境与适用范围

- 使用 **Bun 1.3.14**；依赖版本以 [package.json](package.json) 和 [bun.lock](bun.lock) 为准。
- 基础摘要已验证组合：**NF 0.9.14 / 0.9.15 + 连接器 0.1.2**。当前连接器源码版本为 **0.1.4**，可选活动摘要需宿主提供对应只读查询；旧 0.1.2 设备继续使用基础摘要。清单中的 API/运行时范围不代表所有 NF 版本均已验证。
- Docker 方式面向 Linux，需要 Docker Engine 和 Compose v2。
- 源码归档工具与网页归档回归测试需要 **Python 3.11+**，并确保 `python` 命令在 `PATH` 中可用。
- 生产环境必须 HTTPS。每台 NF 使用独立 origin；**Hub 与每台 NF 必须使用不同 hostname，不能只换端口**，因为同 hostname 的 cookie 不按端口隔离。
- 浏览器要能访问 Hub 和各 NF 原站；每台 NF 的运行主机要能解析、访问并信任中心 HTTPS。

下文 `hub.example.net`、`nf-a.example.net`、`nf-a.vpn.example.net`、`hub.example.internal` 都是占位名称，请替换并配置真实 DNS/路由；它们不是开箱可用的服务。

## 本地开发与原生运行

所有命令从仓库根目录执行；环境变量写法适用于 POSIX shell / Git Bash。

### 1. 安装与初始化

```sh
bun install --frozen-lockfile
bun run admin init --username YOUR_ADMIN
```

把 `YOUR_ADMIN` 换成自己的中心管理员用户名。交互式 TTY 会隐藏输入并要求确认密码，密码需 12–512 字符；没有默认密码。初始化、服务和备份必须选择同一个 `DATABASE_PATH`，默认是 `.data/hub.sqlite`。

非交互场景使用预先安全创建的私有密码文件：

```sh
bun run admin init --username YOUR_ADMIN --password-file /secure/hub-admin-password.txt
```

Unix 下要求普通文件且权限为 `0600`；Windows 需自行限制文件 ACL。不要将密码写入命令参数、脚本、镜像或仓库；使用后按自己的秘密管理策略移除密码文件。

### 2. 直接运行构建后的网页

```sh
bun run build
PUBLIC_URL=http://127.0.0.1:17900 BIND_HOST=127.0.0.1 PORT=17900 DEV_HTTP=1 bun run start
```

访问 `http://127.0.0.1:17900`。后端默认静态目录是 `apps/web/dist`，不是 Vite 开发服务器；未构建网页时不能期待它自动生成静态资源。仅本机开发可显式启用 `DEV_HTTP=1`，生产禁止使用。

这里是中心界面的回环 HTTP 预览，**不等于正式连接器配对环境**：发布的插件设置要求 HTTPS，不能直接填入上述 HTTP 地址。端到端接入需准备 NF 主机可达且信任的中心 HTTPS 入口。

### 3. 前后端热更新

分别在两个终端运行：

```sh
# 终端一：后端监听 17900，但浏览器入口是 Vite 的 17901
PUBLIC_URL=http://127.0.0.1:17901 BIND_HOST=127.0.0.1 PORT=17900 DEV_HTTP=1 bun run dev:server

# 终端二
bun run dev:web
```

访问 `http://127.0.0.1:17901`。[Vite 配置](apps/web/vite.config.ts) 将 `/api` 代理到 17900，保留原 Host；后端还严格检查修改请求的 Origin。因此此模式的 `PUBLIC_URL` 必须是 **17901 的浏览器 origin**，不能仍填 17900，也不要混用 `localhost` 与 `127.0.0.1`。

### 4. 构建与检查

| 命令 | 用途 |
| --- | --- |
| `bun run start` | 运行中心后端源码 |
| `bun run build` | 构建服务端、网页和连接器代码 |
| `bun run build:server` | 仅构建服务端到 `apps/server/dist` |
| `bun run test` | 协议、后端、网页、连接器测试 |
| `bun run test:core` | 仅协议与后端测试 |
| `bun run typecheck` | 全工作区类型检查 |
| `bun run typecheck:core` | 仅核心类型检查 |
| `bun run --cwd packages/nf-connector package` | 重新构建并打包 NF 插件 |

`build` 不等于生成最新 `.nfplugin`，也不会自动上传或安装到 NF；发布插件需单独执行 `package`。

### 5. 原生生产配置

参考根 [.env.example](.env.example) 和 [配置校验](apps/server/src/config.ts)。`PUBLIC_URL` 是中心规范 HTTPS origin，不得带路径、查询或凭据。例如使用直接 TLS：

```sh
NODE_ENV=production DEV_HTTP=0 PUBLIC_URL=https://hub.example.net \
BIND_HOST=0.0.0.0 PORT=17900 \
TLS_CERT_FILE=/secure/tls/fullchain.pem TLS_KEY_FILE=/secure/tls/privkey.pem \
bun run start
```

也可使用受信 TLS 反向代理：不设置上述证书变量，非回环 HTTP 监听须设置 `TRUSTED_PROXY_IP` 为**唯一的直接 TCP 代理 peer IP**，并隔离、防火墙保护内部链路。代理必须保留与 `PUBLIC_URL` 一致的 Host；转发头不能代替 TLS 或 peer 身份验证。直接 TLS、固定代理 peer、本机开发三种配置不可混用。

[deploy/hub.sh](deploy/hub.sh) 提供 `serve / init / backup / restore` 原生命令包装，例如 `sh deploy/hub.sh init --username YOUR_ADMIN`；它与根脚本使用同一套后端和数据库配置。

## Linux Docker 部署

### 公网 HTTPS

先复制并编辑 [deploy/.env.example](deploy/.env.example)，将 `PUBLIC_URL` 改为自己的中心域名：

```sh
cp deploy/.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/compose.yaml build
docker compose --env-file deploy/.env -f deploy/compose.yaml run --rm --no-deps hub init --username YOUR_ADMIN
docker compose --env-file deploy/.env -f deploy/compose.yaml -f deploy/compose.public.yaml up -d
```

初始化命令需交互 TTY；自动化使用 `--password-file` 时，还须显式添加私有文件的只读挂载，不能把宿主路径直接当成容器内路径。

- [基础 Compose](deploy/compose.yaml) **不发布任何端口**。只有显式叠加 [public overlay](deploy/compose.public.yaml) 才映射公网 TCP 80/443 与 UDP 443；UDP 443 为可选 HTTP/3。
- 公网域名须解析到部署主机，并允许 ACME 所需的公网 TCP 80/443；[Caddyfile](deploy/Caddyfile) 负责 HTTPS、流式响应和 WebSocket 转发，保留原 Host。
- 默认桥接网段 `192.0.2.0/29` 为文档地址段，仅在此 Docker 网络内使用：Caddy 固定 `.2`、Hub 固定 `.3`，Hub 的 `TRUSTED_PROXY_IP=192.0.2.2`。换网段要同时调整静态地址和受信 peer，不能只改一处，也不要开放后端 17900。
- [Dockerfile](deploy/Dockerfile) 使用 Bun 1.3.14，以非 root 用户运行。使用新 named volume；复用已有卷或 bind mount 时先匹配镜像 UID 的所有权与私有目录权限。升级不要删除 `hub-data` 卷。

### 内网 HTTPS 与 NF 入口

内网部署需要预先准备证书，并按 [Caddyfile](deploy/Caddyfile) 注释只读挂载证书和私钥、配置 `tls`。模板不自动生成或安装内部 CA。浏览器信任、NF 运行时信任、插件专用 CA 是不同层次；给某台客户端导入 CA 不会自动改变 NF 服务器的信任。

NF 侧入口可参考 [deploy/Caddyfile.nf.example](deploy/Caddyfile.nf.example)，它**未被基础 Compose 加载**。固定 NF 上游必须是代理可达的受信 LAN/VPN 入口；跨不受信网络应使用经过验证的 HTTPS 上游。保留原站鉴权、安全响应头，流式/WebSocket 转发不能省略。

若 NF 上游 HTTPS 由私有 CA 签发，反向代理须单独信任**原 NF 的 CA**，并校验上游主机名；这与连接器设置中用于信任**聚合中心的 CA**不是同一条链路，不能混用。

不要通过关闭 TLS 校验、删除 CSP、全局允许所有 origin 或空 cookie 策略来强行接入。

### 只提供 HTTP 的 NF：加一层独立 HTTPS 前置

有些 NF 只监听 `http://10.8.0.12:7778` 这类 HTTP 入口。做法**不是**改设备服务，而是在它前面另起一层独立 HTTPS 前置，把 HTTP 包成 `https://10.8.0.12:8443`；设备原 HTTP 服务保持原样、不重启、不替换。

前置模板在 [deploy/http-device-https](deploy/http-device-https)，三件：`Caddyfile`、`compose.yaml`、`settings.env.example`。工作台「添加实例 / 编辑实例」中的「设备只有 HTTP 时的 HTTPS 前置方案」面板可直接下载这三份文件，下载内容与该目录逐字节相同。**填地址不会自动安装前置**，仍需按下面步骤自己部署。

最短步骤：

```sh
# 1. 在一个空目录里放好这三份文件，然后只编辑 settings.env.example
# 2. 启动前置
docker compose --env-file settings.env.example up -d
```

`settings.env.example` 里共 5 个变量，示例文件已全部填好；其中 `NF_HTTPS_PUBLIC_IP`、`NF_HTTPS_HOST_BIND`、`NF_HTTP_UPSTREAM_HOST` 必须按实际环境显式设置，`NF_HTTPS_PORT` 与 `NF_HTTP_UPSTREAM_PORT` 有默认值。`10.8.0.12:7778 → 10.8.0.12:8443` 就是可直接跑通的示例：

| 变量 | 含义 |
| --- | --- |
| `NF_HTTPS_PUBLIC_IP` | 必填。浏览器最终访问的 HTTPS 入口 IP/主机名；同时是证书名与 `default_sni` |
| `NF_HTTPS_PORT` | HTTPS 监听端口，宿主机与容器内一致；默认 `8443` |
| `NF_HTTPS_HOST_BIND` | 必填。宿主机绑定的受信地址，决定谁能连上前置 |
| `NF_HTTP_UPSTREAM_HOST` / `NF_HTTP_UPSTREAM_PORT` | 必填的设备原 HTTP 固定地址；端口默认 `7778` |

`NF_HTTPS_HOST_BIND` 只填一个受信地址，不要填 `0.0.0.0` 对外敞开。网关部署时 `NF_HTTPS_PUBLIC_IP` 可与 `NF_HTTP_UPSTREAM_HOST` 不同。另有一个 `NF_HTTPS_BIND` 由 compose 固定为容器内 `0.0.0.0`，不需要也不应该在 env 里填；只有原生运行 Caddy 时才需要自己设置它。

同一个网关要给多台设备各起一套时，把每套放进不同目录，或用 `-p` 指定不同项目名，并让各自的 `NF_HTTPS_PORT` 不同。容器名和数据卷都按项目名自动隔离，不会互相覆盖，也不会共用 CA 与证书。

启动后按顺序验证：

1. 浏览器打开 `https://10.8.0.12:8443`，确认能加载设备页面。证书由前置自建 CA 签发（`tls internal`），浏览器首次需信任该根证书。
2. 目标 NF 的 `allowedOrigins` 里精确加入**正式工作台 origin** 与**这个 HTTPS 入口 origin**，不要用 `*`。
3. 回到工作台填写 HTTPS 入口地址，再按[添加一台 NF](#添加一台-nf)正常配对。

边界与维护：

- **HTTP 到前置这一段只走设备本机、可信局域网或 VPN。** 带登录凭据的 HTTP 不要跨公网；公网只访问前置的 HTTPS 入口。
- 前置只原样转发设备的安全响应头，不删除 CSP、不改写 `X-Frame-Options`、不放宽 CORS、不伪造 Origin 来强行嵌入。
- 前置自带 CA，两个方向要分别配置：插件到中心的信任，在插件设置里贴中心 CA；浏览器信任前置，需要把前置的**公共根证书**导入浏览器/系统。
- 公共根证书在 Caddy data 目录下的 `pki/authorities/local/root.crt`（容器内即 `/data/caddy/pki/authorities/local/root.crt`）。**只分发这张公共证书，不导出私钥**；`front-data` 卷丢失等于私钥丢失，需要重新签发并重新信任。
- 容器只用非 root、只读根、丢弃全部能力，端口只绑一个受信地址，不使用 host 网络，也不改动其它容器或 Docker 全局配置。

没有 Docker 时，同一份 `Caddyfile` 可直接给原生 Caddy（Windows/Linux）用。`NF_HTTPS_BIND` 在原生运行下就是真实监听地址，只填一个受信网卡地址，并用防火墙限制来源：

```powershell
# Windows（PowerShell）：data/CA 留在自有目录，不写系统全局位置
$env:XDG_DATA_HOME="$PWD\.caddy-data"
$env:NF_HTTPS_PUBLIC_IP="10.8.0.12"; $env:NF_HTTPS_PORT="8443"; $env:NF_HTTPS_BIND="10.8.0.12"
$env:NF_HTTP_UPSTREAM_HOST="10.8.0.12"; $env:NF_HTTP_UPSTREAM_PORT="7778"
caddy run --config Caddyfile --adapter caddyfile
```

```sh
# Linux
XDG_DATA_HOME="$PWD/.caddy-data" NF_HTTPS_PUBLIC_IP=10.8.0.12 NF_HTTPS_PORT=8443 \
NF_HTTPS_BIND=10.8.0.12 NF_HTTP_UPSTREAM_HOST=10.8.0.12 NF_HTTP_UPSTREAM_PORT=7778 \
caddy run --config Caddyfile --adapter caddyfile
```

## 添加一台 NF

1. **准备原站入口。** 让浏览器可访问独立 HTTPS NF 地址，如 `https://nf-a.example.net`。在 NF 支持的嵌入配置中，精确允许中心 origin `https://hub.example.net`（例如受支持的 `allowedOrigins` 配置），使 CSP `frame-ancestors` 允许该中心；不要填 `*`。无法安全允许嵌入时使用新窗口。
2. **中心添加实例。** 登录 Hub →「连接管理」→「添加实例」，填写别名及浏览器使用的 NF 基址 `browserBaseUrl`，保存后点击「生成配对码」。一次性码为 22 字符，有效期 10 分钟；它不是 NF 登录密码。
3. **安装并激活连接器。** 在仓库根目录先运行 `bun run --cwd packages/nf-connector package` 构建并打包连接器，再在该 NF 的插件管理中安装本地产物 `packages/nf-connector/dist/local.nf-hub.connector-0.1.4.nfplugin`，确认权限后启用。若仍为 `inactive`，显式激活或打开「摘要连接设置」触发激活；启用可能只保存 desired 状态。
4. **填写中心地址。** 在插件设置中填 `https://hub.example.net`，即中心 API 基址，**不是 NF 自己的地址或自己的 `:7778`**。通常与浏览器访问中心的 URL 相同。插件从 NF 主机出站，内部域名也必须在 NF 主机可解析；浏览器的 hosts 文件不会自动作用于 NF。
5. **按需配置信任。** 公共 HTTPS 通常使用运行时默认 CA。自建 CA 时，只粘贴单张 CA 公共 PEM，不能是私钥、服务器叶证书或证书链；通过独立可信渠道核对该证书 **DER 的 SHA-256 指纹**。插件专用 CA 仅用于它到此中心的请求，仍验证证书链和主机名，不修改浏览器/系统信任。
6. **选择范围并同意。** 选择指定项目（可额外包含无项目独立会话）、指定会话，或明确确认可能包含隐藏项/子代理的整台范围；ID 每行一个、精确匹配。归档、项目名称是独立选项。确认同意发布摘要，然后「保存设置并保持暂停」。空范围不能配对。
7. **配对和验证。** 输入新码，点击「确认配对并开始同步」。首次完整同步后中心应出现摘要；默认每 30 秒同步，可设 5–3600 秒。进入工作台时，仍须在对应 NF 原站独立登录；首次登录后可刷新原站回到目标会话。

连接器不跟随 HTTP 重定向。若另行使用「IP 仅上传入口」，必须显式部署额外的 connector-only 代理路由、正确 Host 和证书校验；仓库模板并不自带这种入口，不能把某次部署的特殊地址当通用默认值。

### 可选活动摘要

连接器 0.1.3 的活动摘要**默认关闭**，与基础摘要使用相同的已发布会话范围，不修改已有配对、令牌或范围。宿主须提供 `narrafork.narrators.activity` 只读查询，中心须支持活动接收端点；升级插件本身不会给旧宿主补上该能力。

1. 打开「摘要连接设置」中的「需要处理与后台活动（可选）」。
2. 勾选「同步待回复、确认、错误、未读及后台活动状态（不含内容）」，点击「保存活动状态选项」。
3. 若基础同步已暂停，先恢复上报；活动状态从下一轮基础摘要成功发布后开始同步。

活动摘要仅含已发布会话 ID、待回复/确认/错误/未读布尔状态和后台活动数，不含消息正文、审批内容或权限明细。「需要处理」是会话级状态，不是当前用户的个人收件箱；**操作权限以原站登录账号为准**，回复、审批和执行仍回原站进行。

未提供或无法读取增强能力时显示「未提供」或 `—`，不把缺失数据当成 0，也不把 `waiting` 当待回复。仅部分实例提供增强时，界面显示已知数量和覆盖提示，不当作全局完整总数；基础摘要同步继续可用。

关闭该选项后不再采集活动；若已有中心活动记录，将在下一轮基础同步成功后撤回。暂停或离线时无法即时撤回，旧记录会按中心接收时间过期；需要立即废止上报授权时，在中心撤销该实例。

### 会话类型与父归属

连接器 0.1.4 从宿主公开会话列表中的 `primary` / `subagent` 类型识别主会话与子代理；直接父归属需要宿主提供 `narrafork.narrators.relationships`。父会话 ID 和标题仅在当前已授权、已同步范围内提供；缺少能力、关系未知或父会话在范围外时显示未提供，不用 ACL 根会话代替直接父，也不推测归属。

类型与父归属元数据随基础摘要自动同步，不受可选活动同步开关控制。准确的需要处理数量仍需宿主活动查询接口，并由用户开启可选活动摘要。

## 三种操作怎么选

- **新增设备**：添加实例 → 保存 → 生成一次性配对码 → 在设备插件的网页设置中填写中心地址与该码，完成一次配对。默认不发布任何摘要。
- **同一台设备只改 IP / 端口**：直接编辑保存，原授权、配对码与发布范围保留，不需要重新配对；浏览器按新地址加载页面，嵌入状态会回到「待验证」，重新确认一次即可。
- **换成另一台实际设备、调整发布范围或更换中心地址**：先撤销 → 再重新配对，不能在旧授权下静默沿用。撤销只废止令牌与中心摘要，不修改原站会话。

设备只有 HTTP 时，按[只提供 HTTP 的 NF](#只提供-http-的-nf加一层独立-https-前置)先部署前置，再把前置的 HTTPS 地址填为访问地址。

## 维护、撤销与恢复

### 授权轮换

- **中心撤销**会作废旧代上报凭据、清除中心摘要，不删除或修改原 NF 会话；中心「删除」还会移除实例配置。
- 暂停、停用、卸载插件或清除本地配对都**不等于中心撤销**，已发出的请求也可能到达。
- 更换插件中心基址、CA、范围或项目名称能力：先在旧中心撤销 → 清除本地配对 → 保存并确认新设置 → 在中心生成新码 → 重新配对。仅修改周期不需要换授权。
- 同一实例只更换浏览器入口的 IP/端口（同一台设备、同一中心、发布权限不变）：直接编辑保存即可，原摘要授权保留；浏览器侧地址变了，嵌入状态会回到「待验证」，重新确认一次嵌入即可。
- 更换真实设备、更换中心，或改变发布范围/权限：仍须先撤销 → 重新配对，不能在旧授权下静默沿用。
- NF 重启可由 `onStartup` 触发激活；只有已配对、设置与凭据绑定一致、已确认非空范围、未暂停且无需撤销时才恢复同步。已暂停的实例不会因重启自动恢复；重启重新采集，不补发旧包。
- 更新插件：重新构建/打包，再到各 NF 手动更新并核验激活状态。不会自动上传；已有凭据能否继续使用取决于绑定与授权状态。

### 配置备份与恢复

[管理 CLI](apps/server/src/cli.ts) 导出的是**配置备份**：含管理员密码哈希和实例展示配置，不含会话摘要、网页登录会话、配对码、上报凭据或授权范围。保护备份与数据目录，不要把备份当成服务数据库直接运行。

恢复必须停服，使用**全新 `DATABASE_PATH`**，目标及其 SQLite sidecar 不能已存在；仅接受此 CLI 创建的配置备份。恢复后所有实例都须重新配对。

原生示例（先停止服务，按实际路径替换）：

```sh
DATABASE_PATH=./.data/hub.sqlite bun run admin backup --to ./.data/config-backup.sqlite
DATABASE_PATH=./.data/restored-hub.sqlite bun run admin restore --from ./.data/config-backup.sqlite
```

启动服务时改用 `DATABASE_PATH=./.data/restored-hub.sqlite`；备份目标也必须是新路径，定期备份请使用不同文件名。

Docker 示例：

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml stop hub
docker compose --env-file deploy/.env -f deploy/compose.yaml run --rm --no-deps hub backup --to /data/config-backup.sqlite
docker compose --env-file deploy/.env -f deploy/compose.yaml run --rm --no-deps -e DATABASE_PATH=/data/restored-hub.sqlite hub restore --from /data/config-backup.sqlite
# 将 deploy/.env 中 DATABASE_PATH 改为 /data/restored-hub.sqlite 后再启动
docker compose --env-file deploy/.env -f deploy/compose.yaml -f deploy/compose.public.yaml up -d
```

备份仍在私有数据卷内，按自己的备份策略安全离机保存；不要用 `down -v` 做日常升级。内部 TLS 的证书/私钥与 CA 分发也需单独维护，不包含在上述配置导出中。

## 常见问题

| 现象 | 检查方式 |
| --- | --- |
| 原站拒绝嵌入，但摘要正常 | CSP/嵌入信任与插件同步是两条链路；检查精确 `frame-ancestors`、安全头及原站独立登录。不要删安全头；必要时新窗口打开。 |
| 插件按钮无效或没有看到错误 | 滚到面板顶部查看「本机上报状态」及错误提示；确认插件已激活、宿主权限可用，点击「刷新状态」。 |
| `CONSENT_REQUIRED` / `CONFIG_INVALID` | 检查非空范围、精确且无重复的 ID、归档选项和同意勾选；改地址/范围后需重新确认。 |
| `PAIRING_UNCERTAIN` | 不盲目重试旧码。先查中心对应新实例是否已配对，对该实例执行撤销以清除可能成功的授权，再签发新码重配。 |
| `CA_INVALID` / 指纹不匹配 / TLS 错误 | 检查单张公共 CA、DER SHA-256、证书有效期与 hostname；分别检查浏览器和 NF 主机信任，不能关闭验证。 |
| 内部域名浏览器能开，插件失败 | 在 NF 运行主机检查 DNS/hosts、路由及 CA；客户端配置不会自动同步到服务器。 |
| `BAD_ORIGIN` / 登录失败 | 检查规范 `PUBLIC_URL`、代理原始 Host、唯一受信 peer；开发时检查 Vite 的 17901 Origin，不要用放宽全局 CORS 解决。 |
| `PROJECT_QUERY_FAILED` | 恢复宿主项目查询权限；若改成仅项目 ID，先中心撤销再重新配对，不能在旧授权下静默降级。 |

状态阅读：

- `fresh`：最近完整成功快照不超过 120 秒；`stale`：超过该时间，旧数据仅供参考；`never`：尚无成功快照。
- `lost`：活跃授权超过 180 秒没有认证联络；不等于原 NF 服务必然离线，也不代替快照新鲜度。
- `0`：成功提交的空快照；`—` / 尚无记录：没有可用数值，不应当成零。
- `waiting` 只是摘要「等待中」状态，**不是等待审批**。审批与操作请回原站处理。

## 数据与安全边界

- 摘要仅含会话 ID、标题、状态、项目 ID（可选项目名）、最后消息时间与更新时间；**不采集消息正文**，不估算费用，不做统一审批、会话迁移或跨站命令执行。
- 只连接本人拥有、获明确授权的受信 NF。`query.read.narrators` **不是宿主强制的“只能读摘要”权限**；摘要投影和范围过滤由本插件实现。后台查询不继承网页当前账号的 ACL，可能扫描隐藏会话或子代理；整台范围尤其需要明确知情授权，不适合作为多租户隔离手段。
- 标题、项目名和 ID 仍可能敏感。中心管理员可见被授权摘要，应保护中心账号、数据库、主机和备份。
- NF 的 secret vault 不能视为静态加密保险箱；配对码/上报令牌依赖宿主文件及备份保护。`local-process` 的 network 声明也不是操作系统网络沙箱。
- 单次快照上限为 10,000 条；本机测试不构成公网 SLA。不同 NF 版本、嵌入策略、第三方 cookie 策略及网络环境仍需实际验证。

## 目录与交付物

| 路径 | 内容 |
| --- | --- |
| [apps/server](apps/server) | Bun / Hono 后端、SQLite、离线管理 CLI |
| [apps/web](apps/web) | React 工作台和 Vite 构建 |
| [packages/protocol](packages/protocol) | 摘要、URL、配对与网页 API 契约 |
| [packages/nf-connector](packages/nf-connector) | NF 连接器源码、设置面板及插件清单 |
| [deploy](deploy) | Linux 运行脚本、Docker / Caddy 模板与归档工具 |
| [deploy/http-device-https](deploy/http-device-https) | 给只提供 HTTP 的 NF 加 HTTPS 前置的三件模板；工作台可下载同一份内容 |
| `packages/nf-connector/dist/local.nf-hub.connector-0.1.4.nfplugin` | 运行 `bun run --cwd packages/nf-connector package` 后生成，在 NF 插件管理中安装 |
| `artifacts/nf-workbench-0.1.0.zip` | 运行下述源码归档命令后生成，含源码、网页构建及连接器；并非免依赖可执行程序 |
| `artifacts/nf-workbench-0.1.0.zip.sha256` / `artifacts/nf-workbench-0.1.0.manifest.json` | 由同次归档生成的 SHA-256 和文件清单 |

[源码归档工具](deploy/package-release.py) 使用显式白名单，需先完成网页构建与插件打包；它自身不安装依赖、不构建、不上传。可先用 `python deploy/package-release.py --list` 校验输入，再运行 `python deploy/package-release.py` 生成归档。解压交付包后仍需 Bun 1.3.14、`bun install --frozen-lockfile`、初始化中心账号及配置运行环境。
