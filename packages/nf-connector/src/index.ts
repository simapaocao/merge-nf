import { FrameDecoder, StdioHostRpc, encodeFrame, type RpcMessage } from "./host-rpc";
import { PluginRuntime } from "./runtime";

const decoder = new FrameDecoder();
const write = (message: RpcMessage, done?: () => void) => { process.stdout.write(encodeFrame(message), done); };
const host = new StdioHostRpc(write);
const runtime = new PluginRuntime(host, write, () => process.exit(0));
function exit(code: number): never { runtime.close(); return process.exit(code); }
process.stdin.on("data", chunk => {
  try {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    for (const message of decoder.push(bytes)) void runtime.dispatch(message).catch(() => exit(2));
  } catch { exit(2); }
});
process.stdin.on("end", () => exit(0));
process.stdin.on("error", () => exit(1));
process.stdout.on("error", () => exit(1));
process.once("SIGTERM", () => exit(0));
process.once("SIGINT", () => exit(0));
// Bare stdio is protocol-only. Never serialize exceptions, HTTP bodies or credentials to logs.
process.once("uncaughtException", () => exit(2));
process.once("unhandledRejection", () => exit(2));
runtime.hello(process.env.NF_PLUGIN_PACKAGE_DIGEST);
