"""Explicit steps: prepare, preview, install-pair, cycle, startup, safeAssertions.
prepare creates just two no-provider NF narrators and one instance per owned center. preview submits
one developer sample through the isolated DEV_HTTP protocol, NOT real connector evidence.
install-pair uses only the real user's plugin-settings command bridge, with explicit ID scope and CA.
cycle revokes ONLY the recorded TLS instance, waits for the real connector's AUTH_REJECTED, then re-pairs.
startup restarts ONLY the recorded NF via its supported lifecycle API. safeAssertions makes one public
health GET, verifies the installed worker, opens existing center summary metadata read-only, and reviews
previous evidence. It does not log in, take the fixture lock, write files or replay lifecycle actions.
No command accepts endpoint/path/credential arguments.
"""
import contextlib
import datetime as dt
import hashlib
import json
import re
import sys
import time

sys.dont_write_bytecode=True
import psutil
from formal_client import Hub, LocalAPI, NF, TITLES, PLUGIN, VERSION, command
from formal_env import BROWSER, ORIGIN, NF_EXE, guard, owner, local, read, write, require


def scope(samples): return {'mode':'sessions','sessionIds':[samples['selected']['id']],'includeArchived':False}


def poll(test,label,limit=35):
    until=time.monotonic()+limit
    while True:
        value=test()
        if value: return value
        require(time.monotonic()<until,'Timed out: '+label)
        time.sleep(.65)


def data_assertions(hub,samples, *, after=0):
    i=hub.instance(); page=hub.req('GET','/api/sessions',params={'includeArchived':'true'})
    stats=hub.req('GET','/api/overview'); dest=page['items']; selected=samples['selected']
    require(i['scope']==scope(samples) and i['connection']=='connected' and i['freshness']=='fresh', 'Scope, freshness or connection mismatch')
    require(i['lastError'] is None and i['sessionCount']==1 and i['lastSuccessAt']>after,'Missing new complete snapshot')
    require(page['total']==len(dest)==1 and dest[0]['id']==selected['id'] and dest[0]['instanceId']==i['id'],'Non-whitelisted member or wrong source')
    require(dest[0]['title']==TITLES['selected'] and dest[0]['status']==selected['status']=='idle' and dest[0]['projectId'] is None, 'Summary fields differ from real test narrator')
    require(set(dest[0])=={'id','title','status','projectId','lastMessageAt','updatedAt','instanceId','freshness','lastSuccessAt'},'Unexpected summary fields')
    expected_instances = len(hub.req('GET','/api/instances')['items']) if hub.role=='web' else 1
    require(stats['configuredInstances']==expected_instances and stats['connectedInstances']==1 and stats['freshInstances']==1
            and stats['freshCounts']=={'total':1,'working':0,'waiting':0,'idle':1,'archived':0,'unknown':0}, 'Overview totals differ from list')
    require(hub.req('GET','/api/sessions',params={'q':TITLES['excluded'],'includeArchived':'true'})['total']==0,'Excluded narrator appeared in search')
    require(hub.req('GET','/api/projects')['total']==0,'Unexpected project exposure')
    return {'generation':i['generation'],'lastSuccessAt':i['lastSuccessAt'],'published':1,'excluded':1,'status':'idle','fresh':True}


def await_success(hub,samples,after=0):
    def probe():
        i=hub.instance()
        require(not i['lastError'], 'Center reports '+str(i['lastError']))
        return i['lastSuccessAt'] and i['lastSuccessAt']>after
    poll(probe,'complete snapshot')
    return data_assertions(hub,samples,after=after)


def process_trust():
    nf=guard('nf'); require(nf.environ().get('NODE_EXTRA_CA_CERTS')==str(local('pki','ca.pem')), 'Missing startup-only host CA environment')
    matches=[]
    for p in nf.children(recursive=True):
        try:
            # Only inspect this packaged connector worker, never unrelated processes.
            if str(NF_EXE).lower()!=p.exe().lower() or not any(PLUGIN in a for a in p.cmdline()): continue
            env=p.environ()
            if PLUGIN in env.get('NF_PLUGIN_PACKAGE_DIR',''):
                matches.append(p)
                require(not any(k.upper()=='NODE_EXTRA_CA_CERTS' for k in env),'Unexpected host CA environment propagation')
        except psutil.NoSuchProcess: continue
    require(len(matches)==1,'Cannot confirm the isolated production connector worker')
    return {'workerPid':matches[0].pid,'workerInheritedHostCA':False}


def pair(nf,hub,samples,old_generation):
    i=hub.instance(); require(i['connection'] in ('unpaired','revoked'),'Refusing to replace a live authorization')
    with nf.bridge() as bridge:
        if old_generation==0:
            fresh=command(bridge,'status',{'retryRead':True})
            require(not fresh['paired'] and not fresh['settings']['baseUrl'] and not fresh['settings']['requiresRevocation'] and not fresh['status'].get('hostReadError'),'Not a clean unpaired initial plugin state')
        draft={'baseUrl':ORIGIN['tls'],'scope':scope(samples),'wantProjectNames':False,'confirmed':True,'intervalMs':15000,
               'centerCaPem':read('pki','ca.pem'),'centerCaSha256':read('pki','ca-sha256')}
        cfg=command(bridge,'configure',draft)
        require(not cfg['paired'] and cfg['settings']['paused'] and re.fullmatch(r'[0-9a-f]{64}',cfg['binding']),'Invalid local consent state')
        issued=hub.req('POST','/api/instances/'+i['id']+'/pairing',status=201)
        bridge('secrets.set',{'key':'pairing-code','value':json.dumps({'code':issued['code'],'binding':cfg['binding']})})
        paired=command(bridge,'pair',{'centralRevocationAcknowledged':old_generation>0 and i['connection']=='revoked'})
        require(paired['paired'] and paired['settings']['scope']==scope(samples),'Pair binding not confirmed')
        # Legitimate repeated claim with the same disposable one-time code must now fail. No auth cookie is attached.
        with LocalAPI('tls') as isolated_connector:
            repeated=isolated_connector.req('POST','/api/connector/pair',status=401,json={'protocolVersion':1,'code':issued['code'],
                        'scope':scope(samples),'confirmed':True,'connectorVersion':VERSION,'capabilities':['summary.v1']})
            require(repeated=={'error':{'code':'INVALID_PAIRING'}},'Disposable code was not single use')
    result=await_success(hub,samples)
    require(result['generation']>old_generation and hub.instance()['connectorVersion']==VERSION,'Old generation or wrong connector version')
    return {**result,'codeReuse':'401 INVALID_PAIRING',**process_trust()}


def revoke_cycle(nf,hub,samples):
    before=data_assertions(hub,samples); i=hub.instance()
    revoked=hub.req('POST','/api/instances/'+i['id']+'/revoke')
    require(revoked['generation']>before['generation'] and revoked['connection']=='revoked' and revoked['sessionCount'] is None,'Revocation did not clear generation')
    def empty():
        require(hub.req('GET','/api/sessions',params={'includeArchived':'true'})['total']==0 and hub.req('GET','/api/overview')['freshCounts'] is None,'Published summaries survived revocation')
    empty()
    # The real worker retries via its normal timer; no test code extracts/handles its long-lived reporting token.
    with nf.bridge() as bridge:
        def rejected():
            r=command(bridge,'status')
            return r['status']['state']=='auth-rejected' and r['status']['lastErrorCode']=='AUTH_REJECTED' and r['settings']['paused'] and not r['paired']
        poll(rejected,'real worker rejection and automatic pause',45)
        empty(); command(bridge,'forget')
    result=pair(nf,hub,samples,revoked['generation'])
    return {'before':before['generation'],'revoked':revoked['generation'],'rejected':'AUTH_REJECTED','rowsAfterRevoke':0,'restored':result}


def startup(nf,hub,samples):
    before=data_assertions(hub,samples); proc=guard('nf'); path=local('nf','restart.json')
    write(path,json.dumps({'owner':owner(),'pid':proc.pid}))
    scheduled=nf.req('POST','/api/system/lifecycle/signal')
    require(scheduled.get('success') is True,'Owned NF did not schedule a graceful restart')
    proc.wait(timeout=50)
    def next_listener():
        try:
            new=guard('nf'); return new if new.pid!=proc.pid else None
        except (RuntimeError,OSError,psutil.Error): return None
    new=poll(next_listener,'owned host replacement',70)
    # Until the production center has accepted a post-restart snapshot, make NO requests to the NF,
    # no panel opens, no commands and no explicit sync. NF's onStartup event must cause the run.
    fresh=await_success(hub,samples,max(before['lastSuccessAt'],int(new.create_time()*1000)))
    require(fresh['generation']==before['generation'],'Restart changed authorization')
    row=nf.plugin(); require(row['runtimeState']=='active','onStartup did not activate the plugin')
    return {'oldPid':proc.pid,'newPid':new.pid,'oldSuccessAt':before['lastSuccessAt'],'newHostBornAt':int(new.create_time()*1000),
            'postRestartSnapshot':fresh,'noPanelOrManualSync':True,**process_trust()}


def preview(nf,hub,samples):
    """A manually seeded DEV_HTTP browser dataset. Never represented as production connector traffic."""
    i=hub.instance(); source=samples['selected']; path='/api/instances/'+i['id']; marker=local('web','sample-client.json')
    with LocalAPI('web') as client:
        if not marker.is_file():
            require(i['connection']=='unpaired','Refusing to replace existing preview authorization')
            code=hub.req('POST',path+'/pairing',status=201)['code']
            claim=client.req('POST','/api/connector/pair',status=201,json={'protocolVersion':1,'code':code,'confirmed':True,'scope':scope(samples),
                             'connectorVersion':'0.0.1-preview','capabilities':['summary.v1']})
            write(marker,json.dumps({'owner':owner(),'id':i['id'],'generation':claim['generation'],'token':claim['token']}))
        record=json.loads(read('web','sample-client.json'))
        require(record['owner']==owner() and record['id']==i['id'],'Foreign preview source')
        client.s.headers['Authorization']='Bearer '+record['token']; wire={'protocolVersion':1,'generation':record['generation']}
        r=client.req('POST','/api/connector/runs',status=201,json=wire)
        stamp=source['updatedAt']; stamp=stamp if isinstance(stamp,int) else int(dt.datetime.fromisoformat(stamp.replace('Z','+00:00')).timestamp()*1000)
        summary={'id':source['id'],'title':TITLES['selected'],'status':source['status'],'projectId':None,'lastMessageAt':None,'updatedAt':stamp}
        tuples=[[summary[k] for k in ['id','title','status','projectId']]+[None,summary['lastMessageAt'],stamp]]
        h=hashlib.sha256(json.dumps(tuples,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
        client.req('POST','/api/connector/runs/'+str(r['runId'])+'/snapshot',json={**wire,'runId':r['runId'],'count':1,'hash':h,'summaries':[summary]})
    return {'kind':'seeded-dev-preview-NOT-connector-evidence','origin':ORIGIN['web'],'source':BROWSER['web'],'instance':i['id'],**data_assertions(hub,samples)}


@contextlib.contextmanager
def exclusive():
    import msvcrt
    owner(); path=local('mutation.lock')
    with path.open('a+b') as f:
        if not f.tell(): f.write(b'1'); f.flush()
        f.seek(0); msvcrt.locking(f.fileno(),msvcrt.LK_NBLCK,1)
        try: yield
        finally: f.seek(0); msvcrt.locking(f.fileno(),msvcrt.LK_UNLCK,1)


def main(mode):
    if mode not in {'prepare','preview','install-pair','cycle','startup','safeAssertions'}: raise SystemExit(__doc__)
    require(read('initialized')==owner(),'Unknown fixture')
    if mode=='safeAssertions':
        from formal_observe import observe
        return observe()  # Before every lock, credential read and login.
    with exclusive(), NF(prepare=mode=='prepare') as nf:
        if mode=='prepare':
            nf.prepare()
            for role in ('web','tls'):
                with Hub(role) as hub: hub.instance(create=True)
            return {'prepared':True,'fixtureNarrators':2,'firstPartyOnboardingComplete':True}
        samples=nf.samples()
        if mode=='preview':
            with Hub('web') as hub: return preview(nf,hub,samples)
        with Hub('tls') as hub:
            if mode=='install-pair':
                nf.install(); return pair(nf,hub,samples,0)
            if mode=='cycle': return revoke_cycle(nf,hub,samples)
            if mode=='startup': return startup(nf,hub,samples)
            raise RuntimeError('Unexpected developer fixture mode')


if __name__=='__main__':
    if len(sys.argv)!=2: raise SystemExit(__doc__)
    result=main(sys.argv[1]); print(json.dumps(result,ensure_ascii=True))
    if sys.argv[1] in {'install-pair','cycle','startup','preview'}:
        # Deliberately only bounded, public metrics above, never raw requests, returned credentials, cookies or codes.
        write(local(sys.argv[1]+'-evidence.json'),json.dumps(result,indent=2),replace=True)
