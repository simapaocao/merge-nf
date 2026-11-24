import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { authSchema, routes, type Auth, type ChangesWithInstances } from '@nf-hub/protocol';
import { api, type ApiClient } from '../lib/api';
import { ApiError } from '../lib/errors';
import { parseIntent, reloadDocument } from '../lib/navigation';
import { clearTabs, tabsServerEpoch } from '../lib/tabs';

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } });
type EventMessage = { kind: 'logout' } | { kind: 'instance-reset'; instanceId: string };
export type ReadView = {epoch:number; verified:boolean};
export const privateKey = (session:number, kind:string, epoch:number) => ['private',session,kind,epoch] as const;
/** Synchronously retire old query keys before publishing the new identity set to observers. */
export function replacePrivateView(client:QueryClient, transport:ApiClient, session:number, snapshot:ChangesWithInstances|null):ReadView {
  const epoch=transport.fenceReads(snapshot?.version ?? null);
  void client.cancelQueries({queryKey:['private']},{silent:true,revert:false});
  client.removeQueries({queryKey:['private']});
  if (snapshot) client.setQueryData(privateKey(session,'instances',epoch),{items:snapshot.instances});
  return {epoch,verified:!!snapshot};
}
type State = {
  view:ReadView; installView:(session:number,snapshot:ChangesWithInstances|null)=>boolean;
  /** Stable database epoch, preserved across read fences and transient failures. */
  serverEpoch:string|null;
  auth: Auth | null; ready: boolean; initialError: unknown; revision: number; removedInstance: { id: string; revision: number } | null;
  signIn: (username: string, password: string) => Promise<void>; signOut: () => Promise<void>;
  refreshAuth: () => void; resetInstance: (instanceId: string) => void;
};
const AppState = createContext<State | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<Auth | null>(null);
  const [ready, setReady] = useState(false);
  const [initialError, setInitialError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  const [removedInstance, setRemovedInstance] = useState<State['removedInstance']>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const authAttempt = useRef(0);

  const hardRevision=useRef(0);
  const [view,setView]=useState<ReadView>({epoch:api.readEpoch,verified:false});
  const [serverEpoch,setServerEpoch]=useState<string|null>(null);
  const installView=useCallback((session:number,snapshot:ChangesWithInstances|null)=>{
    if (hardRevision.current!==session) return false;
    if(snapshot) setServerEpoch(previous=>tabsServerEpoch(snapshot.version) ?? previous);
    setView(replacePrivateView(queryClient,api,session,snapshot)); return true;
  },[]);
  const clearData = useCallback(() => {
    const next=++hardRevision.current;
    setView(replacePrivateView(queryClient,api,next,null)); setRevision(next);
  }, []);
  const clearAuth = useCallback(() => {
    authAttempt.current++;
    // Synchronous for logout, 401 and the cross-window logout broadcast; storage denial is harmless.
    try { clearTabs(window.sessionStorage); } catch { /* sessionStorage may be disabled. */ }
    setServerEpoch(null);
    api.reset(); api.setAuth(null);
    setAuth(null);
    setReady(true);
    setInitialError(null);
    clearData();
  }, [clearData]);
  const refreshAuth = useCallback(() => {
    const attempt = ++authAttempt.current;
    setReady(false);
    setInitialError(null);
    void api.read(routes.me, authSchema).then(value => {
      if (authAttempt.current !== attempt) return;
      api.setAuth(value); setAuth(value); setReady(true);
    }).catch(error => {
      if (authAttempt.current !== attempt) return;
      if (!(error instanceof ApiError && error.code === 'UNAUTHENTICATED')) setInitialError(error);
      setReady(true);
    });
  }, []);
  const resetInstance = useCallback((instanceId: string) => {
    clearData();
    setRemovedInstance(value => ({ id: instanceId, revision: (value?.revision ?? 0) + 1 }));
    channel.current?.postMessage({ kind: 'instance-reset', instanceId } satisfies EventMessage);
  }, [clearData]);

  useEffect(() => {
    api.onUnauthorized = clearAuth;
    const bus = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('nf-hub-private-state');
    channel.current = bus;
    if (bus) bus.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (!data || typeof data !== 'object' || !('kind' in data)) return;
      if (data.kind === 'logout') clearAuth();
      if (data.kind === 'instance-reset' && 'instanceId' in data && typeof data.instanceId === 'string') {
        clearData(); setRemovedInstance(value => ({ id: data.instanceId as string, revision: (value?.revision ?? 0) + 1 }));
      }
    };
    refreshAuth();
    return () => { api.onUnauthorized = undefined; bus?.close(); channel.current = null; };
  }, [clearAuth, clearData, refreshAuth]);

  const signIn = useCallback(async (username: string, password: string) => {
    const { data } = await api.request(routes.login, authSchema, { method: 'POST', body: { username, password } });
    if (!data) throw new ApiError('INVALID_RESPONSE');
    api.setAuth(data);
    reloadDocument(parseIntent(window.location.hash));
  }, []);
  const signOut = useCallback(async () => {
    await api.request(routes.logout, authSchema, { method: 'POST' });
    channel.current?.postMessage({ kind: 'logout' } satisfies EventMessage);
    clearAuth();
  }, [clearAuth]);
  return <AppState.Provider value={{ view, serverEpoch, installView, auth, ready, initialError, revision, removedInstance, signIn, signOut, refreshAuth, resetInstance }}>
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  </AppState.Provider>;
}
export function useAppState(): State {
  const value = useContext(AppState);
  if (!value) throw new Error('Missing AppStateProvider');
  return value;
}
