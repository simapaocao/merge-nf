import type { PublishScope } from "@nf-hub/protocol";
import type { ConnectorView } from "../src/controller";
import { PAIRING_KEY } from "../src/constants";
import { MAX_CA_PEM_CHARS, publicCertBody } from "../src/pem";

type Bridge = { request(method: string, params?: unknown): Promise<unknown> };
type Reply = ConnectorView & { ok: boolean; errorCode?: string };
const api = (globalThis as typeof globalThis & { narrafork?: Bridge }).narrafork;
const root = document.createElement("main"); document.body.appendChild(root);
function el<K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement, text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; parent.appendChild(node); return node;
}
const css = el("style", document.head);
css.textContent = `:root{color-scheme:light dark;font:15px/1.55 system-ui,sans-serif}*{box-sizing:border-box}body{margin:0}main{max-width:52rem;margin:auto;padding:clamp(12px,3vw,30px)}h1{font-size:1.55rem;margin:0}h2{font-size:1.08rem;margin:0 0 .6rem}p{margin:.3rem 0 .8rem}.muted,small{opacity:.78}section{border:1px solid #838c9160;border-radius:10px;padding:1rem;margin:.85rem 0}.field{display:grid;gap:4px;margin:.6rem 0}.check{display:flex;align-items:baseline;gap:.5rem;margin:.55rem 0}input:not([type=checkbox]),select,textarea{font:inherit;color:inherit;background:transparent;border:1px solid #7c858b;border-radius:5px;padding:.45rem;max-width:100%;width:100%}select{background:Canvas;color:CanvasText}input[type=checkbox]{flex:none}button{font:inherit;border:1px solid #7c858b;border-radius:5px;padding:.35rem .75rem;cursor:pointer;background:transparent;color:inherit}button:disabled{opacity:.45;cursor:default}button.primary{background:#19615e;border-color:#19615e;color:white}.actions{display:flex;gap:.45rem;flex-wrap:wrap;margin-top:.75rem}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.5rem}.metrics div{display:grid}.metrics strong{font-size:.96rem;overflow-wrap:anywhere}.notice{border-inline-start:3px solid #a66c20;padding-inline-start:.65rem}[hidden]{display:none!important}:focus-visible{outline:2px solid #389792;outline-offset:2px}`;
el("h1", root, "摘要连接设置"); el("p", root, "本插件只向你确认的中心发布会话摘要，不读取消息正文，也不接收中心下发的指令。");
const report = el("section", root); el("h2", report, "本机上报状态");
const metrics = el("div", report); metrics.className = "metrics";
const metric = (title: string) => { const d = el("div", metrics); el("small", d, title); return el("strong", d, "—"); };
const st = metric("当前状态"), stamp = metric("上次完整成功"), count = metric("上次摘要数"), capability = metric("项目名称"), errorCode = metric("最近错误码"), next = metric("下次尝试");
const activityState = metric("活动状态"), activityCount = metric("上次活动条目"), activityError = metric("活动错误码");
const notice = el("p", report, "读取宿主设置中…"); notice.className = "notice"; notice.setAttribute("role", "status");
const section = (title: string) => { const s = el("section", root); el("h2", s, title); return s; };
const settings = section("发布设置");
let seq = 0;
function field<K extends "input" | "select" | "textarea">(parent: HTMLElement, label: string, tag: K): HTMLElementTagNameMap[K] {
  const group = el("div", parent); group.className = "field"; const l = el("label", group, label), control = el(tag, group);
  control.id = `nf-connector-${++seq}`; l.htmlFor = control.id; return control;
}
function check(parent: HTMLElement, label: string) {
  const l = el("label", parent); l.className = "check"; const box = el("input", l); box.type = "checkbox"; el("span", l, label); return box;
}
const url = field(settings, "聚合中心 HTTPS 基址", "input"); url.type = "url"; url.placeholder = "https://hub.example.com"; url.autocomplete = "off";
const useCa = check(settings, "使用此中心专用的 CA 证书（公共 HTTPS 通常不需要）");
const caOptions = el("div", settings); caOptions.hidden = true;
el("p", caOptions, "只粘贴单张 CA 公共证书，不要粘贴私钥、服务器证书或证书链。通过独立可信渠道向管理员核对 SHA-256 指纹；不要使用待配对网站自己给出的指纹作为唯一依据。").className = "muted";
const caPem = field(caOptions, "CA 公共证书（PEM，最大 16 KiB）", "textarea"); caPem.maxLength = MAX_CA_PEM_CHARS; caPem.spellcheck = false; caPem.rows = 4;
const caHash = field(caOptions, "管理员确认的 SHA-256 指纹（十六进制，可含冒号）", "input"); caHash.maxLength = 95; caHash.spellcheck = false; caHash.autocomplete = "off";
const trustStatus = el("p", settings); trustStatus.style.overflowWrap = "anywhere";
const mode = field(settings, "发布范围", "select");
for (const [val, name] of [["none","不发布"],["projects","指定项目 / 独立会话"],["sessions","指定会话"],["all","整台实例"]] as const) { const o = el("option", mode, name); o.value = val; }
const projects = field(settings, "项目 ID（每行一个，精确匹配）", "textarea"), sessions = field(settings, "会话 ID（每行一个，精确匹配）", "textarea");
const standalone = check(settings, "同时发布没有项目的独立会话"), hidden = check(settings, "我了解整台范围可能包含隐藏会话或子代理，仍确认纳入"), archived = check(settings, "包括归档会话");
const names = check(settings, "在宿主允许时发布项目名称；取消则始终只提供项目 ID");
const interval = field(settings, "同步间隔（秒，5–3600，默认 30）", "input"); interval.type = "number"; interval.min = "5"; interval.max = "3600"; interval.step = "1"; interval.value = "30";
el("p", settings, "插件以后台身份查询，不继承网页当前账号的列表权限。会话 ID 白名单和独立会话可能需要在本机扫描较大列表；只有入选摘要会发给中心。").className = "muted";
const consent = check(settings, "我确认上述中心和范围，同意发布 ID、标题、状态、项目及时间摘要");
const saveBar = el("div", settings); saveBar.className = "actions";
const save = el("button", saveBar, "保存设置并保持暂停");
const activitySection = section("需要处理与后台活动（可选）");
el("p", activitySection, "勾选后，每轮基础摘要发布成功后，再向同一中心额外发布一次“待回复、待确认、错误、未读、后台活动数”的计数与布尔状态。").className = "muted";
el("p", activitySection, "这是会话级安全状态，不代表当前登录账号的个人收件箱，也不代表你本人有权处理；实际能否操作以原站登录账号的权限为准。").className = "muted";
el("p", activitySection, "只包含已发布的会话 ID 与上述状态，不包含任何消息正文、标题之外的文本、审批内容或权限明细。默认关闭，不勾选就不查询也不发送。").className = "muted";
const activityEnabled = check(activitySection, "同步待回复、确认、错误、未读及后台活动状态（不含内容）");
const activityBar = el("div", activitySection); activityBar.className = "actions";
const activitySave = el("button", activityBar, "保存活动状态选项");
const activityNote = el("p", activitySection); activityNote.className = "notice"; activityNote.setAttribute("role", "status");
const linking = section("配对与重新授权");
el("p", linking, "先在中心为该实例签发一次性配对码。更换地址、CA 信任、范围或项目名称能力前，须在中心撤销旧代并清除旧快照，再重新配对。");
const secret = field(linking, "一次性配对码（不回显已保存的凭据）", "input"); secret.type = "password"; secret.autocomplete = "new-password"; secret.spellcheck = false; secret.maxLength = 22;
const revoked = check(linking, "如有旧授权，我已在原中心撤销，旧代令牌和摘要已清除");
const linkBar = el("div", linking); linkBar.className = "actions";
const pair = el("button", linkBar, "确认配对并开始同步"); pair.className = "primary";
const forget = el("button", linkBar, "清除本地配对以便重配");
const run = section("同步控制"); const runBar = el("div", run); runBar.className = "actions";
const sync = el("button", runBar, "立即同步"), pause = el("button", runBar, "暂停上报"), resume = el("button", runBar, "恢复上报"), refresh = el("button", runBar, "刷新状态");
el("p", run, "暂停、停用或清除本地配对不会撤销中心已存数据；已发出的请求仍可能到达。要作废凭据并删除该代摘要，请在聚合中心执行撤销。");
const help = el("details", root); el("summary", help, "激活、网络与凭据说明");
el("p", help, "启用不一定表示后台已激活。若显示 inactive，请打开插件设置页触发 onView、在宿主显式激活，或重启 NF 触发 onStartup。宿主退出后停止新轮；重启只重新采集，不补发旧包。");
el("p", help, "请只在受信任的单用户 NF 中安装。本插件默认使用运行时信任的 HTTPS 证书，不跟随重定向。专用 CA 只用于此插件到所确认中心的请求，仍验证证书链和主机名，不改变系统或浏览器信任。local-process 的网络声明不是操作系统沙箱；Podman 默认无网络，需单独明确批准出站。");
el("p", help, "配对码和上报令牌保存在本插件的宿主 secret vault，非秘密设置在本插件 storage。vault 不保证静态加密，请保护宿主文件及备份。不要在此输入 NF 管理令牌。");
const labels: Record<string,string> = {inactive:"尚未激活","host-unavailable":"未能读取宿主状态",unconfigured:"未配对",paused:"已暂停",pairing:"配对中",ready:"等待下一轮",collecting:"正在同步",backoff:"退避重试","auth-rejected":"凭据已失效","re-pair-required":"需要重新配对"};
const activityLabels: Record<string,string> = {unknown:"未知",available:"可用",unsupported:"本机或中心不支持",denied:"无查询权限"};
let view: ConnectorView | null = null, busy = false, dirty = false, loaded = false, editingPause: Promise<void> | null = null;
/** Separate draft flag: the activity opt-in never marks the main settings form dirty and never blocks sync/pause. */
let activityDirty = false;
const controls = [save, pair, forget, sync, pause, resume, refresh, activitySave];
const time = (n: number | null) => n === null ? "—" : new Date(n).toLocaleString();
function modeFields() {
  projects.parentElement!.hidden = mode.value !== "projects"; standalone.parentElement!.hidden = mode.value !== "projects";
  sessions.parentElement!.hidden = mode.value !== "sessions"; hidden.parentElement!.hidden = mode.value !== "all"; archived.disabled = mode.value === "none";
}
function availability() {
  controls.forEach(b => b.disabled = busy || !api || !loaded);
  if (!busy && loaded && api) {
    pair.disabled = !!view?.paired; forget.disabled = !(view?.paired || view?.settings.requiresRevocation);
    resume.disabled = dirty || !view?.paired || !view.settings.paused; sync.disabled = dirty || !view?.paired || view.settings.paused;
    pause.disabled = !view?.paired || view.settings.paused;
  }
  if (view?.status.state === "host-unavailable") for (const b of controls) b.disabled = true;
  refresh.disabled = !api || busy;
}
function paint(v: ConnectorView, form: boolean) {
  view = v; loaded = true; const cfg = v.settings, s = v.status;
  st.textContent = labels[s.state] ?? "未知"; stamp.textContent = time(s.lastSuccessAt); count.textContent = s.lastCount === null ? "—" : String(s.lastCount); next.textContent = time(s.nextAttemptAt);
  capability.textContent = v.includesProjectNames === true ? (s.lastErrorCode === "PROJECT_QUERY_FAILED" ? "已授权，查询失败" : "名称及 ID") : v.includesProjectNames === false ? "仅项目 ID" : "配对时确定"; errorCode.textContent = s.hostReadError ? `${s.lastErrorCode} · ${s.hostReadError.method} · ${s.hostReadError.hostCode} (${s.hostReadError.rpcCode ?? "—"})` : s.lastErrorCode ?? "—";
  // Activity health is displayed on its own line so a side-channel problem never reads as a broken base summary.
  const a = v.activity;
  activityState.textContent = !v.activityPreferenceSaved ? "选项未确认，已暂停活动同步" : !v.activityEnabled ? "未启用" : activityLabels[a.support] ?? "未知";
  activityCount.textContent = a.lastCount === null ? "—" : String(a.lastCount);
  activityError.textContent = a.lastErrorCode ?? "—";
  trustStatus.textContent = cfg.centerCaSha256 === null ? "已保存的信任方式：运行时默认 CA。" : `已核对的中心专用 CA（SHA-256）：${cfg.centerCaSha256.toUpperCase().match(/../g)!.join(":")}`;
  if (form) {
    useCa.checked = cfg.centerCaPem !== null; caOptions.hidden = !useCa.checked;
    caPem.value = cfg.centerCaPem ?? ""; caHash.value = cfg.centerCaSha256 ?? "";
    url.value = cfg.baseUrl; mode.value = cfg.scope.mode; interval.value = String(cfg.intervalMs / 1000); names.checked = cfg.wantProjectNames; consent.checked = cfg.confirmed;
    projects.value = cfg.scope.mode === "projects" ? cfg.scope.projectIds.join("\n") : ""; sessions.value = cfg.scope.mode === "sessions" ? cfg.scope.sessionIds.join("\n") : "";
    standalone.checked = cfg.scope.mode === "projects" && cfg.scope.includeStandalone; hidden.checked = cfg.scope.mode === "all"; archived.checked = cfg.scope.includeArchived; dirty = false; modeFields();
  }
  // The opt-in checkbox mirrors the stored preference; a pending local edit is not overwritten by the 5s status poll.
  if (!activityDirty) activityEnabled.checked = v.activityEnabled;
  activitySave.disabled = busy || !api || !loaded;
  availability();
}
const hints: Record<string,string> = {RPC_DENIED:"宿主拒绝了读取。请检查插件已有授权后刷新；取消勾选或确认撤销无法解决。",HOST_UNAVAILABLE:"尚未读到宿主真实状态，未改写配对。请确认插件已激活后刷新。",SECRET_UNAVAILABLE:"宿主凭据无法读取，不会使用或覆盖它；请先检查本机 vault。",CA_CHANGED:"中心 CA 已更换，旧凭据已停用；请先在旧中心撤销，再重新配对。",CA_INVALID:"需要一张真实的 CA 公共证书；不能输入私钥、服务器证书或证书链。",CA_FINGERPRINT_MISMATCH:"输入的 SHA-256 与证书不匹配。请通过可信渠道重新核对。",CONFIG_INVALID:"检查 HTTPS 地址、范围、唯一 ID 及同步间隔。",CONSENT_REQUIRED:"请选择非空范围，勾选同意并保存。",PAIRING_REQUIRED:"请输入当前中心签发的新配对码。",CENTRAL_REVOCATION_REQUIRED:"先在旧中心撤销旧代，再清除本地配对并确认已撤销。",PAIRING_FAILED:"配对被拒绝，请核对中心与一次性配对码。",PAIRING_UNCERTAIN:"未确认配对是否完成。请先撤销该代，再重新签发配对码。",PROJECT_QUERY_FAILED:"本轮未提交。请恢复项目查询权限，或在中心撤销并重新配对为仅 ID。",AUTH_REJECTED:"上报凭据被拒，已停止。请在中心重新授权。",INACTIVE:"请在宿主激活插件或重启 NF。",BUSY:"当前轮正在执行，不会重复启动。"};
class DisplayError extends Error {}
/** Activity-only explanations. They never describe the base summary connection as broken. */
const activityHints: Record<string,string> = {ACTIVITY_UNSUPPORTED:"本机 NarraFork 或该聚合中心暂不支持活动状态，基础摘要同步不受影响。",ACTIVITY_PERMISSION_DENIED:"本机未授予读取活动状态的权限；基础摘要同步不受影响。",ACTIVITY_QUERY_FAILED:"本轮未能读取活动状态，将在下一轮重试；基础摘要已正常发布。",ACTIVITY_INCOMPLETE:"活动状态与本轮已发布的会话不一致，本轮未发送活动数据。",ACTIVITY_TIMEOUT:"读取活动状态超时，本轮未发送活动数据。",ACTIVITY_LIMIT_EXCEEDED:"活动状态条目超出上限，本轮未发送活动数据。",ACTIVITY_RESPONSE_INVALID:"中心返回了无法识别的活动确认，本轮未记录为成功。",ACTIVITY_PREFERENCE_READ_FAILED:"未能读取已保存的活动选项。本次运行已暂停活动同步，基础摘要不受影响；请重新保存活动选项。",ACTIVITY_PREFERENCE_WRITE_FAILED:"活动选项未保存成功。本次运行已暂停活动同步，但重启后的状态尚未确认；请重试保存。"};

async function command(action: string, input?: unknown): Promise<ConnectorView> {
  if (!api) throw new DisplayError("请从 NF 插件设置页打开。");
  const result = await api.request("commands.execute", { commandId: `connector-${action}`, ...(input === undefined ? {} : { input }) }) as { status?: string; output?: Reply };
  if (result?.status !== "succeeded" || !result.output) throw new DisplayError("宿主未执行该操作，请检查是否已激活。");
  if (!result.output.ok) { const code = result.output.errorCode ?? ""; paint(result.output, false); throw new DisplayError((action === "activity" ? activityHints[code] : undefined) ?? hints[code] ?? `操作失败（${/^[A-Z_]{1,40}$/.test(code) ? code : "HOST_UNAVAILABLE"}）。`); }
  return result.output;
}
function readDraft() {
  let scope: PublishScope;
  const ids = (text: string) => text.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
  if (mode.value === "all") { if (!hidden.checked) throw new DisplayError("请选择是否确认纳入隐藏项和子代理。"); scope = { mode:"all", acknowledgeHidden:true, includeArchived:archived.checked }; }
  else if (mode.value === "projects") scope = { mode:"projects", projectIds:ids(projects.value), includeStandalone:standalone.checked, includeArchived:archived.checked };
  else if (mode.value === "sessions") scope = { mode:"sessions", sessionIds:ids(sessions.value), includeArchived:archived.checked };
  else scope = { mode:"none",includeArchived:false };
  const centerCaSha256 = useCa.checked ? caHash.value.trim().replace(/:/g, "").toLowerCase() : null;
  if (useCa.checked && !publicCertBody(caPem.value)) throw new DisplayError("需要单张有效的 CA 公共 PEM，不能使用私钥、路径或证书链。");
  if (centerCaSha256 !== null && !/^[0-9a-f]{64}$/.test(centerCaSha256)) throw new DisplayError("请输入从可信渠道核对的 SHA-256 证书指纹。");
  return { baseUrl:url.value.trim(), centerCaPem:useCa.checked ? caPem.value : null, centerCaSha256, intervalMs: Number(interval.value) * 1000, scope, wantProjectNames:names.checked, confirmed:consent.checked };
}
async function operation(work: () => Promise<void>) {
  if (busy) return; busy = true; availability();
  try { if (editingPause) await editingPause; await work(); }
  catch (err) { notice.textContent = err instanceof DisplayError ? err.message : "宿主请求失败；请检查激活状态和插件权限。"; }
  finally { busy = false; availability(); }
}
for (const input of [url, useCa, caPem, caHash, mode, projects, sessions, standalone, archived, hidden, names, interval, consent]) input.addEventListener("input", () => {
  if (!loaded) return;
  dirty = true; if (input !== consent && input !== interval) consent.checked = false;
  if (input === caPem || input === useCa || input === url) caHash.value = "";
  if (input === useCa) caOptions.hidden = !useCa.checked;
  if (input === mode && mode.value !== "all") hidden.checked = false;
  modeFields(); availability();
  if (view?.paired && !view.settings.paused && !editingPause) {
    editingPause = command("pause").then(v => { paint(v,false); notice.textContent = "本机已暂停。请保存新设置；更换授权需先在中心撤销。"; }, () => { notice.textContent = "未能确认本地暂停，请在宿主停用或在中心撤销。"; }).finally(() => { editingPause = null; });
  }
});
save.onclick = () => operation(async () => { const v = await command("configure", readDraft()); paint(v,true); notice.textContent = v.settings.requiresRevocation ? hints.CENTRAL_REVOCATION_REQUIRED! : "设置已保存，未启动上报。"; });
pair.onclick = () => operation(async () => {
  const draft = readDraft(); if (!draft.confirmed || draft.scope.mode === "none") throw new DisplayError(hints.CONSENT_REQUIRED);
  if (!/^[A-Za-z0-9_-]{22}$/.test(secret.value)) throw new DisplayError("请输入中心签发的 22 位一次性配对码。");
  const before = await command("configure", draft); paint(before,true);
  if (before.settings.requiresRevocation && !revoked.checked) throw new DisplayError(hints.CENTRAL_REVOCATION_REQUIRED);
  const code = secret.value; secret.value = "";
  await api!.request("secrets.set", { key:PAIRING_KEY, value:JSON.stringify({ code, binding:before.binding }) });
  const v = await command("pair", {centralRevocationAcknowledged:revoked.checked}); revoked.checked = false; paint(v,true);
  notice.textContent = v.includesProjectNames ? "已配对，正在启动首次完整同步。" : "已配对，本授权代只提供项目 ID，不包含项目名称。";
});
forget.onclick = () => operation(async () => { if (!revoked.checked) throw new DisplayError("请先在中心撤销旧授权，并勾选已撤销确认。"); const v = await command("forget"); secret.value = ""; paint(v,true); notice.textContent = "本地配对已清除；这不代表中心撤销完成。"; });
activityEnabled.addEventListener("input", () => { if (!loaded) return; activityDirty = true; activitySave.disabled = busy || !api || !loaded; });
activitySave.onclick = () => operation(async () => {
  try {
    const v = await command("activity", { enabled: activityEnabled.checked }); activityDirty = false; paint(v, false);
    activityNote.textContent = !v.activityPreferenceSaved ? "活动选项尚未确认保存，本次运行已暂停活动同步。"
      : v.activityNeedsClear ? "已保存。下一轮完整同步成功后，会清除中心已有或在途的活动状态；重新开启后会再采集新状态。"
      : v.activityEnabled ? (v.settings.paused ? "已保存。恢复上报后，将在下一轮完整同步成功后开始发送活动状态。" : "已保存。将在下一轮完整同步成功后开始发送活动状态。")
      : "已保存。不再查询或发送活动状态，基础摘要同步不受影响。";
  } catch (error) {
    activityNote.textContent = error instanceof DisplayError ? error.message : "活动选项未确认保存，本次运行已暂停活动同步，请重试。";
  }
});
for (const [button, commandId, message] of [[sync,"sync","已安排一次完整同步。"],[pause,"pause","已暂停本地上报；中心数据未被删除。"],[resume,"resume","已恢复上报。"]] as const) button.onclick = () => operation(async () => { paint(await command(commandId),false); notice.textContent = message; });
async function update(form: boolean, retryRead = false) { const v = await command("status", retryRead ? { retryRead:true } : undefined); paint(v, form || (view?.status.state === "host-unavailable" && v.status.state !== "host-unavailable")); const err = v.status.lastErrorCode; const act = v.activity.lastErrorCode; if (err && hints[err]) notice.textContent = hints[err]!; else if (form) notice.textContent = !v.active ? hints.INACTIVE! : v.settings.requiresRevocation ? hints.CENTRAL_REVOCATION_REQUIRED! : "设置已载入。"; if (act && activityHints[act]) activityNote.textContent = activityHints[act]!; }
refresh.onclick = () => operation(() => update(!dirty,true)); modeFields(); availability();
if (api) { void operation(() => update(true,true)); const poll = setInterval(() => { if (!document.hidden && !busy && !editingPause) void update(false).catch(() => { notice.textContent = "无法刷新状态，请检查宿主是否已激活。"; }); },5000); window.addEventListener("pagehide", () => clearInterval(poll),{once:true}); }
else notice.textContent = "请在 NarraFork 的插件设置页打开本面板。";
