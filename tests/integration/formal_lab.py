"""Windows v0.9.14 fixture launcher. Usage: python -B tests/integration/formal_lab.py init|nf|tls|web|nf-front
Run init ONCE in an empty .validation/formal. Run each selected listener as its own service task.
Requires the phase-0 pinned binary, workspace dependencies, Python 3.11+, psutil, cryptography and pywin32.
All application logs are suppressed here; commands print only nonsecret fixed diagnostics and listener identity.
"""
import asyncio
import datetime as dt
import ipaddress
import json
import os
import secrets
import ssl
import subprocess
import sys

sys.dont_write_bytecode = True
from formal_env import (ROOT, STATE, VAL, LOOP, NF_EXE, NF_HASH, USER, ORIGIN, PORT, MAGIC,
                        require, read, write, local, real, mkdir, owner, file_hash, executable,
                        environment, endpoint_free, remember_listener, guard)


def pki():
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization as enc
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
    mkdir('pki')
    now = dt.datetime.now(dt.timezone.utc)
    def name(label): return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,label)])
    def draft(subject, issuer, key):
        return (x509.CertificateBuilder().subject_name(subject).issuer_name(issuer).public_key(key.public_key())
                .serial_number(x509.random_serial_number()).not_valid_before(now-dt.timedelta(minutes=5))
                .not_valid_after(now+dt.timedelta(days=7))
                .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()),False))
    ca_key = ec.generate_private_key(ec.SECP256R1()); ca_name = name('NF Workbench disposable formal CA')
    ca = (draft(ca_name,ca_name,ca_key).add_extension(x509.BasicConstraints(True,0),True)
          .add_extension(x509.KeyUsage(False,False,False,False,False,True,True,False,False),True).sign(ca_key,hashes.SHA256()))
    write(local('pki','ca.pem'), ca.public_bytes(enc.Encoding.PEM))
    write(local('pki','ca-sha256'), ca.fingerprint(hashes.SHA256()).hex())
    for role, san in [('tls',x509.IPAddress(ipaddress.ip_address(LOOP))),('nf-front',x509.DNSName('localhost'))]:
        key = ec.generate_private_key(ec.SECP256R1())
        cert = (draft(name('formal '+role),ca_name,key).add_extension(x509.BasicConstraints(False,None),True)
                .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),False)
                .add_extension(x509.SubjectAlternativeName([san]),False)
                .add_extension(x509.KeyUsage(True,False,False,False,False,False,False,False,False),True)
                .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),False).sign(ca_key,hashes.SHA256()))
        write(local('pki',role+'.key'), key.private_bytes(enc.Encoding.PEM, enc.PrivateFormat.PKCS8, enc.NoEncryption()))
        write(local('pki',role+'.pem'), cert.public_bytes(enc.Encoding.PEM))
    # The CA private key is never saved. Nothing is added to system or browser trust.


def core_env(role):
    env = environment(role)
    # bun run's inner invocation must not auto-load unrelated credentials from a project dotenv file.
    require(not any(p.name != '.env.example' for p in ROOT.glob('.env*')), 'Refusing a project with active .env files')
    env.update(DATABASE_PATH=str(local(role,'hub.sqlite')), PUBLIC_URL=ORIGIN[role], PORT=str(PORT[role]),
               BIND_HOST=LOOP, WEB_DIST=str(real(ROOT/'apps/web/dist')))
    if role == 'web':
        env.update(DEV_HTTP='1',NODE_ENV='development')
    else:
        env.update(NODE_ENV='production', TLS_CERT_FILE=str(local('pki','tls.pem')), TLS_KEY_FILE=str(local('pki','tls.key')))
    return env


def init():
    require(os.name=='nt' and NF_EXE.is_file() and file_hash(NF_EXE)==NF_HASH, 'Need the pinned Windows NF v0.9.14+54710b7 binary')
    require(real(VAL).is_dir(), 'Need phase-0 assets')
    mkdir(); require(not any(STATE.iterdir()), 'Refusing to initialize nonempty formal directory (never adopts existing data)')
    for port in [*PORT.values(),17874]: endpoint_free(port)
    write(local('owner.json'),json.dumps({'type':MAGIC,'nonce':secrets.token_hex(16)}))
    pki()
    for role in PORT:
        env = environment(role)
        write(local(role,'password-file'),secrets.token_urlsafe(27)+'9w!')
        if role != 'nf':
            args=[executable('bun'),'--no-env-file','run','admin','init','--username',USER[role],
                  '--password-file',local(role,'password-file')]
            # New DB only. Separate authentication and storage for the real TLS and DEV_HTTP centers.
            require(not local(role,'hub.sqlite').exists(), 'Unexpected database')
            subprocess.run(args,cwd=ROOT,env=core_env(role),stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,check=True,timeout=60)
        else:
            nf=local(role,'nf-home'); require(not any(nf.iterdir()), 'Unexpected NF profile')
            write(nf/'formal-owner',owner()); mkdir('nf','workspace')
            settings={'server':{'host':LOOP,'port':PORT['nf'],'openBrowser':'off','allowedOrigins':[ORIGIN['web'],ORIGIN['tls']]},
                      'vnet':{'enabled':False,'udp':{'enabled':False}}, 'update':{'autoDownload':False}}
            write(nf/'settings.json',json.dumps(settings))
    write(local('initialized'),owner()); print('Isolated profiles, per-role credentials, TLS certificates and two separate formal center DBs initialized.')


def job_group():
    # Own this launcher and its descendants only. Stop(service) consequently cannot leave an orphan host or worker.
    import win32api, win32job
    job=win32job.CreateJobObject(None,'Local\\NFWorkbenchFormal-'+secrets.token_hex(16))
    info=win32job.QueryInformationJobObject(job,win32job.JobObjectExtendedLimitInformation)
    info['BasicLimitInformation']['LimitFlags'] |= win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    win32job.SetInformationJobObject(job,win32job.JobObjectExtendedLimitInformation,info)
    win32job.AssignProcessToJobObject(job,win32api.GetCurrentProcess())
    return job


def service(role):
    job=job_group()
    require(job and read('initialized')==owner(), 'Run init first')
    while True:
        endpoint_free(PORT[role]); cwd=ROOT
        if role=='nf':
            require(file_hash(NF_EXE)==NF_HASH and read('nf','nf-home','formal-owner')==owner(),'Foreign host')
            s=json.loads(read('nf','nf-home','settings.json')); cfg=s['server']
            require(cfg['host']==LOOP and cfg['port']==PORT['nf'] and cfg['openBrowser']=='off' and not cfg.get('tls',{}).get('enabled')
                    and cfg['allowedOrigins']==[ORIGIN['web'],ORIGIN['tls']] and not s['vnet']['enabled'] and not s['vnet']['udp']['enabled'], 'Unsafe NF launch settings')
            env=environment('nf'); env.update(HOST=LOOP,PORT=str(PORT['nf']),NODE_ENV='production',NARRAFORK_MANAGER_MANAGED='1',
                NF_PLUGIN_BUN_PATH=str(executable('bun')),NODE_EXTRA_CA_CERTS=str(local('pki','ca.pem')))
            args=[NF_EXE,'--serve','--host='+LOOP,'--port='+str(PORT[role])]; cwd=local(role)
        else:
            env=core_env(role); require(local(role,'hub.sqlite').is_file(),'Unknown center DB')
            args=[executable('bun'),'--no-env-file','run','start']
        p=subprocess.Popen(args,env=env,cwd=cwd,stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL if role=='nf' else None,stderr=subprocess.DEVNULL if role=='nf' else None)
        target=remember_listener(role,p); code=p.wait()
        if role=='nf' and code==0 and local('nf','restart.json').is_file():
            ticket=json.loads(read('nf','restart.json')); local('nf','restart.json').unlink()
            require(ticket=={'pid':target.pid,'owner':owner()}, 'Foreign restart ticket')
            continue
        raise RuntimeError(f'{role} listener exited ({code}); start a new owned service if intended')


async def nf_front():
    """Loopback-only TLS frontend so the production browser URL is real. Forward bytes unchanged, including CSP."""
    guard('nf'); endpoint_free(17874)
    ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.minimum_version=ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(local('pki','nf-front.pem'),local('pki','nf-front.key'))
    async def client(r,w):
        upstream=None
        try:
            guard('nf'); nr,upstream=await asyncio.open_connection(LOOP,PORT['nf'])
            async def pump(src,dst):
                while (buf:=await asyncio.wait_for(src.read(65536),timeout=90)):
                    dst.write(buf); await dst.drain()
            tasks=[asyncio.create_task(pump(r,upstream)),asyncio.create_task(pump(nr,w))]
            _,pending=await asyncio.wait(tasks,return_when=asyncio.FIRST_COMPLETED)
            for t in pending: t.cancel()
            await asyncio.gather(*tasks,return_exceptions=True)
        except (OSError,RuntimeError): pass
        finally:
            w.close()
            if upstream: upstream.close()
    async with await asyncio.start_server(client,LOOP,17874,ssl=ctx,ssl_handshake_timeout=8) as server:
        print('Owned NF browser TLS frontend: https://localhost:17874 -> http://127.0.0.1:17873 (headers untouched)',flush=True)
        await server.serve_forever()


if __name__=='__main__':
    args=sys.argv[1:]
    if args==['init']: init()
    elif args==['nf-front']: asyncio.run(nf_front())
    elif len(args)==1 and args[0] in PORT: service(args[0])
    else: raise SystemExit(__doc__)
