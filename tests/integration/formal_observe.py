"""Read-only observation of live public metadata and previous fixture evidence. No lifecycle replay."""
import contextlib
import hashlib
import http.client
import json
import re
import sqlite3
import time
import zipfile
from pathlib import Path
import psutil
from formal_client import ARCHIVE, ARCHIVE_HASH, PLUGIN, TITLES, VERSION
from formal_env import BROWSER, LOOP, NF_EXE, PORT, file_hash, local, owned_listener, owner, read, require


def observe():
    nf=owned_listener('nf'); hub=owned_listener('tls')
    # Exact uncredentialed, nonredirecting, fixed-loopback GET; no cookies, Origin, tokens or login.
    with contextlib.closing(http.client.HTTPConnection(LOOP,PORT['nf'],timeout=4)) as conn:
        conn.request('GET','/api/health'); res=conn.getresponse(); require(res.status==200,'NF is not ready')
        health=json.loads(res.read(65537)); ver=health.get('version',''); commit=health.get('commit','')
        require(health.get('status')=='ok' and ver.startswith('0.9.14') and '54710b7' in (ver+str(commit)), 'Wrong NF build or readiness')
    current=json.loads(read('nf','nf-home','plugins','current.json'))['plugins'][PLUGIN]
    digest=current['hash']; require(current['version']==VERSION and re.fullmatch('[0-9a-f]{64}',digest),'Unexpected installation pointer')
    prefix=('nf','nf-home','plugins','packages',PLUGIN,VERSION,digest)
    require(file_hash(ARCHIVE)==ARCHIVE_HASH,'Release archive changed')
    members={'manifest.json','server/index.js','ui/panel.iife.js'}
    with zipfile.ZipFile(ARCHIVE) as z:
        require(set(z.namelist())==members and len(z.namelist())==len(members),'Unexpected archive content')
        for name in members:
            require(file_hash(local(*prefix,name))==hashlib.sha256(z.read(name)).hexdigest(),'Installed '+name+' differs from approved archive')
    entry=local(*prefix,'server','index.js'); workers=[]
    for p in nf.children(recursive=True):
        try:
            if Path(p.exe())==NF_EXE and any(Path(arg)==entry for arg in p.cmdline()[1:]): workers.append(p.pid)
        except psutil.NoSuchProcess: continue
    require(len(workers)==1,'Expected one active worker for the verified package')
    ids=json.loads(read('nf','fixtures.json')); instance=json.loads(read('tls','instance.json'))
    require(ids['owner']==instance['owner']==owner() and ids['selected']!=ids['excluded'],'Foreign fixture markers')
    # Do not use immutable=1 on this live WAL DB: it could hide the newest committed snapshot.
    # Require both sidecars to pre-exist, use read-only URI, in-memory temp data and a read transaction.
    for s in ('','-wal','-shm'): require(local('tls','hub.sqlite'+s).is_file(),'Expected an already running TLS DB with existing WAL/SHM')
    allowed={'instances':{'id','generation','authState','browserBaseUrl','scopeJson','connectorVersion','sessionCount','lastSuccessAt','lastContactAt','lastError'},
             'session_summaries':{'id','instanceId','generation','title','status','projectId','projectName','lastMessageAt','updatedAt'}}
    def authorize(action,table,column,db_name,source):
        permitted=(action==sqlite3.SQLITE_SELECT or (action==sqlite3.SQLITE_READ and db_name=='main' and column in allowed.get(table,set())))
        return sqlite3.SQLITE_OK if permitted else sqlite3.SQLITE_DENY
    with contextlib.closing(sqlite3.connect(local('tls','hub.sqlite').as_uri()+'?mode=ro&cache=private',uri=True,timeout=3)) as db:
        db.row_factory=sqlite3.Row; db.execute('PRAGMA temp_store=MEMORY'); db.execute('PRAGMA query_only=ON')
        require(db.execute('PRAGMA query_only').fetchone()[0]==1,'SQLite query-only mode not active')
        db.execute('BEGIN'); db.set_authorizer(authorize)
        instances=db.execute('SELECT id,generation,authState,browserBaseUrl,scopeJson,connectorVersion,sessionCount,lastSuccessAt,lastContactAt,lastError FROM instances LIMIT 2').fetchall()
        summaries=db.execute('SELECT id,instanceId,generation,title,status,projectId,projectName,lastMessageAt,updatedAt FROM session_summaries LIMIT 2').fetchall()
    require(len(instances)==len(summaries)==1,'Only one fixture instance and one authorized summary expected')
    i,s=instances[0],summaries[0]; now=int(time.time()*1000)
    require(i['id']==instance['id']==s['instanceId'] and i['generation']==s['generation'] and i['authState']=='active'
            and i['browserBaseUrl']==BROWSER['tls'] and i['connectorVersion']==VERSION and i['sessionCount']==1 and i['lastError'] is None,'Unexpected live instance')
    require(json.loads(i['scopeJson'])=={'mode':'sessions','sessionIds':[ids['selected']],'includeArchived':False}
            and s['id']==ids['selected'] and s['title']==TITLES['selected'] and s['status']=='idle' and s['projectId'] is None and s['projectName'] is None,'Live scope or summary changed')
    require(0<=now-i['lastSuccessAt']<=120000 and 0<=now-i['lastContactAt']<=180000,'Center no longer has a fresh connected instance')
    # These are recorded developer observations, not actions performed by this read-only invocation.
    first,cycle,start=[json.loads(read(n+'-evidence.json')) for n in ('install-pair','cycle','startup')]
    require(first['published']==first['excluded']==1 and first['codeReuse']=='401 INVALID_PAIRING' and first['workerInheritedHostCA'] is False,'Invalid initial evidence')
    require(first['generation']<=cycle['before']<cycle['revoked']<cycle['restored']['generation']<=i['generation'] and cycle['rejected']=='AUTH_REJECTED' and cycle['rowsAfterRevoke']==0,'Invalid cycle evidence')
    require(start['oldPid']!=start['newPid'] and start['oldSuccessAt']<start['newHostBornAt']<start['postRestartSnapshot']['lastSuccessAt']<=i['lastSuccessAt']
            and start['postRestartSnapshot']['generation']<=i['generation'] and start['noPanelOrManualSync'] is True,'Invalid startup evidence')
    return {'mode':'read-only live metadata + prior evidence, not a lifecycle replay','nfBuild':ver,'nfPid':nf.pid,'corePid':hub.pid,
            'connector':VERSION,'approvedArchiveSha256':ARCHIVE_HASH,'installedMembersVerified':len(members),'workerPid':workers[0],
            'generation':i['generation'],'lastSuccessAt':i['lastSuccessAt'],'published':1,'excluded':1,'status':'idle','fresh':True,
            'recordedCycle':[cycle['before'],cycle['revoked'],cycle['restored']['generation']],'recordedStartupChecked':True}
