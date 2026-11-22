"""Clients for the disposable fixture only. No host/path/identity CLI options, no proxies or redirects."""
import contextlib
import json
import re
import uuid
import warnings
with warnings.catch_warnings():
    warnings.simplefilter('ignore', category=Warning)
    import requests
from formal_env import (LOOP, PORT, ORIGIN, BROWSER, USER, PLUGIN, ROOT, guard, owner, require, local, read, write, real, file_hash)

VERSION='0.1.2'
ARCHIVE = ROOT / f'packages/nf-connector/dist/{PLUGIN}-{VERSION}.nfplugin'
ARCHIVE_HASH='5d73dc3bb658dea26db234d057467cb212efa859bd16d9e9bcddb8b5709cd0f1'
TITLES={'selected':'正式连接器：白名单会话', 'excluded':'正式连接器：不应发布'}


def uid(value):
    require(isinstance(value,str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}',value), 'Unexpected fixture identifier')
    return value


def nowrite_error(value):
    return value if isinstance(value,str) and re.fullmatch(r'[A-Z0-9_]{1,64}',value) else 'UNSPECIFIED'


class LocalAPI:
    def __init__(self,role):
        require(role in PORT, 'Unknown fixture role'); self.role=role
        self.s=requests.Session(); self.s.trust_env=False
        self.s.verify=str(local('pki','ca.pem')) if role=='tls' else True

    def raw(self,method,path,**kwargs):
        guard(self.role)
        require(path.startswith('/api/') and not any(x in path for x in ('\\','://','..','//','#')), 'Nonlocal or unsupported API path')
        require(set(kwargs)<= {'json','params','headers','files'}, 'No transport overrides permitted')
        return self.s.request(method,ORIGIN[self.role]+path,timeout=35,allow_redirects=False,**kwargs)

    def req(self,method,path,status=None,**kwargs):
        r=self.raw(method,path,**kwargs)
        expected=(200<=r.status_code<300) if status is None else r.status_code==status
        require(expected, f'{self.role} {method} {path.split("?")[0]} HTTP {r.status_code} (response withheld)')
        return r.json() if r.content else None

    def __enter__(self): return self
    def __exit__(self,*_): self.s.close()


class NF(LocalAPI):
    def __init__(self,prepare=False):
        super().__init__('nf')
        registered=self.req('GET','/api/auth/status')['hasUsers']
        if not registered:
            require(prepare and not local('nf','fixtures.json').exists(),'New NF registration is opt-in')
        login={'username':USER['nf'],'password':read('nf','password-file')}
        if not registered: login['language']='zh-CN'
        res=self.req('POST','/api/auth/'+('login' if registered else 'register'),json=login)
        self.s.headers['Authorization']='Bearer '+res['token']
        me=self.req('GET','/api/auth/me'); require(me['role']=='admin' and me['username']==USER['nf'],'Foreign NF identity')

    def plugin(self):
        res=self.req('GET','/api/plugins'); rows=res if isinstance(res,list) else res['plugins']
        row=next((r for r in rows if r.get('pluginId')==PLUGIN),None)
        return {**row,**(row.get('current') or {})} if row else None

    def prepare(self):
        if self.req('GET','/api/user-preferences')['setupWizardCompleted'] is False:
            self.req('PATCH','/api/user-preferences',json={'setupWizardCompleted':True})
        require(self.req('GET','/api/user-preferences')['setupWizardCompleted'] is True,'Onboarding preference not persisted')
        if not local('nf','fixtures.json').exists():
            ids={}
            for key,title in TITLES.items():
                ids[key]=uid(self.req('POST','/api/narrators',json={'cwd':str(local('nf','workspace')), 'title':title})['id'])
            write(local('nf','fixtures.json'),json.dumps({'owner':owner(),**ids}))
        return self.samples()

    def samples(self):
        saved=json.loads(read('nf','fixtures.json')); require(saved['owner']==owner(),'Foreign NF samples')
        rows={k:self.req('GET','/api/narrators/'+uid(saved[k])) for k in TITLES}
        for key,row in rows.items():
            require(row['id']==saved[key] and row['title']==TITLES[key] and row['status']=='idle','Test narrator changed or missing')
        require(rows['selected']['id']!=rows['excluded']['id'],'Sample identities collide')
        return rows

    def install(self):
        require(file_hash(ARCHIVE)==ARCHIVE_HASH,'Connector archive missing or hash changed; review and pin the intended release')
        row=self.plugin()
        if not row:
            with ARCHIVE.open('rb') as f:
                self.req('POST','/api/plugins/install',files={'archive':(ARCHIVE.name,f,'application/zip')})
            row=self.plugin()
        require(row and row['version']==VERSION,'Another connector/version is installed; refusing replacement')
        if row['desiredState']!='enabled': self.req('POST','/api/plugins/'+PLUGIN+'/enable')
        require(self.plugin()['desiredState']=='enabled','Enabling connector failed')

    @contextlib.contextmanager
    def bridge(self):
        row=self.plugin(); require(row and row['version']==VERSION and row['desiredState']=='enabled','Expected installed connector')
        ses=self.req('POST','/api/plugins/ui/sessions',json={'pluginId':PLUGIN,'version':VERSION,'hash':row['hash'],
                     'contributionId':'summary-settings','surface':'settings','surfaceScope':'global','panelInstanceId':'formal-fixture'})
        p='/api/plugins/ui/sessions/'+uid(ses['session']['sessionId'])
        def call(method,params):
            require(method=='commands.execute' or (method=='secrets.set' and params.get('key')=='pairing-code'),'Not an integration bridge method')
            reply=self.req('POST',p+'/request',headers={'X-NarraFork-Plugin-Session':ses['sessionToken']},
                           json={'protocol':'narrafork.ui/1','kind':'request','id':str(uuid.uuid4()),'method':method,'params':params})
            if 'error' in reply: raise RuntimeError(method+' rejected by host: '+nowrite_error(reply['error'].get('code')))
            return reply['result']
        try: yield call
        finally: self.req('DELETE',p)


class Hub(LocalAPI):
    def __init__(self,role):
        require(role in ('tls','web'),'Unknown center'); super().__init__(role)
        self.s.headers['Origin']=ORIGIN[role]
        auth=self.req('POST','/api/auth/login',json={'username':USER[role],'password':read(role,'password-file')})
        self.s.headers['X-CSRF-Token']=auth['csrfToken']; require(self.req('GET','/api/auth/me')['username']==USER[role],'Foreign center identity')

    def __exit__(self,*exc):
        try: self.req('POST','/api/auth/logout',status=204)
        finally: self.s.close()

    def instance(self,create=False):
        role=self.role
        if not local(role,'instance.json').exists():
            require(create and not self.req('GET','/api/instances')['items'],'Refusing to adopt existing instances')
            row=self.req('POST','/api/instances',status=201,json={'alias':'隔离 NF' if role=='tls' else '隔离 NF · 浏览器预览',
                         'group':'正式联调' if role=='tls' else '开发预览','browserBaseUrl':BROWSER[role],'favorite':True})
            write(local(role,'instance.json'),json.dumps({'owner':owner(),'id':str(uuid.UUID(row['id']))}))
        saved=json.loads(read(role,'instance.json')); require(saved['owner']==owner(),'Foreign center record')
        i=self.req('GET','/api/instances/'+str(uuid.UUID(saved['id'])))
        require(i['id']==saved['id'] and i['browserBaseUrl']==BROWSER[role],'Instance origin changed: refusing to mutate')
        return i


def command(bridge,name,input_=None):
    p={'commandId':'connector-'+name}
    if input_ is not None: p['input']=input_
    reply=bridge('commands.execute',p)
    require(reply.get('status')=='succeeded' and isinstance(reply.get('output'),dict),'Host did not execute '+name+' ('+nowrite_error((reply.get('error') or {}).get('code'))+')')
    result=reply['output']; require(result.get('ok') is True, 'connector-'+name+': '+nowrite_error(result.get('errorCode')))
    return result
