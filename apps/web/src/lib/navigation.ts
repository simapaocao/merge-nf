export type View = 'sessions' | 'workbench' | 'connections';
export type LocationIntent = { view: View; instanceId?: string; sessionId?: string };
export function parseIntent(hash: string): LocationIntent {
  const [route, query = ''] = hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  const view: View = route === 'workbench' || route === 'connections' ? route : 'sessions';
  const instanceId = params.get('instance') || undefined;
  return { view, instanceId, sessionId: view === 'workbench' ? params.get('session') || undefined : undefined };
}
export function intentHash(intent: LocationIntent): string {
  const query = new URLSearchParams();
  if (intent.instanceId) query.set('instance', intent.instanceId);
  if (intent.sessionId && intent.view === 'workbench') query.set('session', intent.sessionId);
  return `#${intent.view}${query.size ? `?${query}` : ''}`;
}
export function navigate(intent: LocationIntent) { window.location.hash = intentHash(intent); }
/** A changed query forces a new document and therefore a new authenticated frame-src CSP. */
export function reloadDocument(intent: LocationIntent) {
  const next = new URL('/', window.location.origin);
  next.searchParams.set('view', Date.now().toString(36));
  next.hash = intentHash(intent);
  window.location.replace(next.href);
}
export function isMixedContent(hub: string, target: string): boolean {
  return new URL(hub).protocol === 'https:' && new URL(target).protocol === 'http:';
}
