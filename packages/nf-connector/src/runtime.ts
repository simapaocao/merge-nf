import { HOST_PROTOCOL, PLUGIN_ID, PLUGIN_VERSION } from "./constants";
import { ConnectorController } from "./controller";
import { ConnectorError, safeError } from "./errors";
import { type RpcMessage, StdioHostRpc } from "./host-rpc";

/** Host-origin commands only. No socket, HTTP listener, external event stream or remote command dispatch. */
export class PluginRuntime {
  private initialized = false;
  private activated = false;
  private lifecycle = 0;
  private ready: Promise<void> = Promise.resolve();
  private readonly controller: ConnectorController;
  constructor(readonly host: StdioHostRpc, private readonly write: (message: RpcMessage, done?: () => void) => void, private readonly exit: () => void, controller?: ConnectorController) {
    this.controller = controller ?? new ConnectorController(host);
  }
  hello(packageDigest?: string): void {
    this.write({ jsonrpc: "2.0", method: "hello", params: { pluginId: PLUGIN_ID, version: PLUGIN_VERSION, rpcProtocol: HOST_PROTOCOL, ...(packageDigest && /^(?:sha256:)?[a-f0-9]{64}$/i.test(packageDigest) ? { packageDigest } : {}), features: ["host_api.requests"] } });
  }
  async dispatch(message: RpcMessage): Promise<void> {
    if (!message.method) { this.host.accept(message); return; }
    if (message.id === undefined) {
      if (message.method === "shutdown" || message.method === "deactivate") this.stop();
      return;
    }
    const reply = (result: unknown) => this.write({ jsonrpc: "2.0", id: message.id!, result });
    const failure = (code: number, text: string) => this.write({ jsonrpc: "2.0", id: message.id!, error: { code, message: text } });
    try {
      if (message.method === "initialize") {
        if (this.initialized) return failure(-32600, "Already initialized");
        const params = message.params as { pluginId?: unknown; protocol?: unknown; features?: unknown } | null;
        if (params?.pluginId !== PLUGIN_ID || params.protocol !== HOST_PROTOCOL || !Array.isArray(params.features) || !params.features.includes("host_api.requests")) return failure(-32602, "Incompatible host");
        this.initialized = true; return reply({ initialized: true, protocol: HOST_PROTOCOL });
      }
      if (message.method === "shutdown") {
        this.stop(); this.host.close();
        return this.write({ jsonrpc: "2.0", id: message.id, result: { shutdown: true } }, this.exit);
      }
      if (message.method === "deactivate") { this.stop(); return reply({ deactivated: true }); }
      if (!this.initialized) return failure(-32603, "Not initialized");
      if (message.method === "activate") {
        if (this.activated) return reply({ activated: true });
        this.activated = true;
        const lifecycle = ++this.lifecycle;
        // Reply first: the manager must be able to mark the runtime active before a background host request.
        reply({ activated: true });
        this.ready = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
          if (this.lifecycle === lifecycle) await this.controller.activate();
        });
        return;
      }
      if (message.method === "health") return reply({ healthy: true, status: this.controller.view().status.state });
      if (message.method === "commands.invoke") {
        const params = message.params as { contributionId?: unknown; input?: unknown } | null;
        if (typeof params?.contributionId !== "string") return failure(-32602, "CONFIG_INVALID");
        try {
          await this.ready;
          const view = await this.controller.command(params.contributionId, params.input);
          return reply({ output: { ok: true, ...view } });
        } catch (error) {
          // Never echo exception text, RPC parameters, body, token or host data to the iframe.
          return reply({ output: { ok: false, errorCode: safeError(error), ...this.controller.view() } });
        }
      }
      return failure(-32601, "Method not supported");
    } catch (error) { return failure(-32603, error instanceof ConnectorError ? error.code : "HOST_UNAVAILABLE"); }
  }
  stop(): void { ++this.lifecycle; this.activated = false; this.controller.deactivate(); }
  close(): void { this.stop(); this.host.close(); }
}
