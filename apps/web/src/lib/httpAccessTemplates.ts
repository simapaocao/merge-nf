import caddyfile from '../../../../deploy/http-device-https/Caddyfile?raw';
import compose from '../../../../deploy/http-device-https/compose.yaml?raw';
import settings from '../../../../deploy/http-device-https/settings.env.example?raw';

/**
 * 一件可下载的前置模板文件。
 * `name` 就是下载后的文件名，也是模板目录里的真实文件名。
 */
export type HttpFrontFile = { readonly name: string; readonly content: string };

/**
 * 给「只提供 HTTP 的设备」加一层独立 HTTPS 前置所需的全部文件。
 *
 * 内容来自仓库内唯一源 `deploy/http-device-https/`，通过构建期的 `?raw` 内联，
 * 因此下载到的就是该目录里逐字节相同的文件，不在前端另存副本。
 * 三件都是纯文本配置，不含任何私钥、令牌或真实环境备份。
 */
export const HTTP_FRONT_FILES: readonly HttpFrontFile[] = [
  { name: 'Caddyfile', content: caddyfile },
  { name: 'compose.yaml', content: compose },
  { name: 'settings.env.example', content: settings },
];

/**
 * 用普通 Blob 下载一个模板文件。
 *
 * 走浏览器本地 `Blob` + `a[download]`，不需要新增服务端接口，也不放宽 CSP
 * （`connect-src` 不参与，`a[download]` 不是导航）。下载后由使用者自行保存到
 * 空目录并编辑，网页不会代其安装或启动任何东西。
 */
export function downloadHttpFrontFile(file: HttpFrontFile): void {
  const url = URL.createObjectURL(new Blob([file.content], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 交给下一轮事件循环再释放，避免部分浏览器取消尚未开始的下载。
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
