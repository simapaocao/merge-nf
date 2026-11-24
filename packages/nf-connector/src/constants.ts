export const PLUGIN_ID = "local.nf-hub.connector";
export const PLUGIN_VERSION = "0.1.3";
export const HOST_PROTOCOL = "narrafork.rpc/1";
export const SETTINGS_KEY = "connector-settings";
export const STATUS_KEY = "connector-status";
/** Opt-in activity preference. Deliberately outside `connector-settings` so it can never alter the binding digest. */
export const ACTIVITY_SETTINGS_KEY = "connector-activity";
export const CREDENTIAL_KEY = "report-credential";
export const PAIRING_KEY = "pairing-code";
export const GLOBAL_SCOPE = { type: "global" } as const;
export const HOST_METHODS = new Set([
  "storage.get", "storage.set", "secrets.list", "secrets.get", "secrets.set", "secrets.delete", "queries.execute",
]);
export const HOST_QUERIES = new Set(["narrafork.narrators.list", "narrafork.projects.list", "narrafork.narrators.activity"]);
