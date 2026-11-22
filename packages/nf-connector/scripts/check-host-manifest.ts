import { dirname, join, resolve } from "node:path";
import manifest from "../manifest.json";
import { root } from "./build";

// Development-only check, run against an explicitly trusted, extracted host source tree.
// No generated artifacts or dependencies are installed in that directory.
const host = resolve(process.argv[2] ?? join(root, "../../.validation/release-source"));
const entrypoint = join(host, "server/lib/plugins/manifest.ts");
if (!await Bun.file(entrypoint).exists()) throw new Error("Pass the path to the trusted NF 0.9.14 source checkout");
const protocolRoot = dirname(Bun.resolveSync("@nf-hub/protocol",root));
const result = await Bun.build({entrypoints:[entrypoint],target:"bun",format:"esm",sourcemap:"none",plugins:[{
  name:"resolve-host-validator",
  setup(builder) {
    builder.onResolve({filter:/^@shared\//},({path})=>({path:join(host,"shared",path.slice(8)+".ts")}));
    builder.onResolve({filter:/^zod$/},()=>({path:Bun.resolveSync("zod",protocolRoot)}));
  },
}]});
if (!result.success || result.outputs.length !== 1) throw new Error(`Host manifest validator failed to build: ${result.logs.map(log=>log.message).join("; ")}`);
const contents = await result.outputs[0]!.text();
const moduleName: string = "nf-connector-local-host-validator";
Bun.plugin({ name: "in-memory-host-validator", setup(builder) { builder.module(moduleName, () => ({ contents, loader: "js" })); } });
const { safeParseManifest } = await import(moduleName);
const parsed = safeParseManifest(manifest);
if (!parsed.success) throw new Error(`Manifest rejected by host: ${JSON.stringify(parsed.error?.issues ?? parsed.issues ?? "invalid")}`);
console.log(`Host manifest accepted: ${manifest.pluginId} ${manifest.version}`);
