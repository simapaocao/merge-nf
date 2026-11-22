import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import manifest from "../manifest.json";
import { PLUGIN_ID, PLUGIN_VERSION } from "../src/constants";

export const root = resolve(import.meta.dir, "..");
export const dist = join(root, "dist");
export const entries = ["manifest.json", "server/index.js", "ui/panel.iife.js"] as const;
export async function build(): Promise<void> {
  if (manifest.pluginId !== PLUGIN_ID || manifest.version !== PLUGIN_VERSION || manifest.server.entry !== entries[1] || manifest.ui.entry !== entries[2]) throw new Error("Manifest and entry points disagree");
  await Promise.all([mkdir(join(dist,"server"),{recursive:true}),mkdir(join(dist,"ui"),{recursive:true})]);
  for (const [source, filename, target, format] of [["src/index.ts", entries[1], "bun", "esm"], ["ui/panel.ts",entries[2],"browser","iife"]] as const) {
    const result = await Bun.build({entrypoints:[join(root,source)], target, format, minify:true, sourcemap:"none", splitting:false, packages:"bundle"});
    if (!result.success || result.outputs.length !== 1) throw new Error(`Build failed (${source}): ${result.logs.map(l => l.message).join("; ")}`);
    await writeFile(join(dist,filename),Buffer.from(await result.outputs[0]!.arrayBuffer()));
  }
  await writeFile(join(dist,entries[0]),JSON.stringify(manifest,null,2)+"\n");
}
if (import.meta.main) { await build(); console.log(`Built ${manifest.pluginId} ${manifest.version}: ${entries.join(", ")}`); }
