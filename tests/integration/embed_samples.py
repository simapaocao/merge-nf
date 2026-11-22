"""Two distinct loopback origins for manual keep-alive testing. Neither page is an NF instance.
Run `serve` as one background service, then `register` once. Reload the hub document for its new CSP.
"""
import contextlib
import json
import os
import secrets
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
sys.dont_write_bytecode=True
import psutil
from formal_client import Hub
from formal_env import LOOP, ORIGIN, endpoint_free, local, owner, read, require, write

PAGES={17921:'A',17922:'B'}
MARK='embedded-page-server.json'


class Page(BaseHTTPRequestHandler):
    def log_message(self,*args): pass  # Do not log headers, queries or browser inputs.
    def do_GET(self):
        port=self.server.server_address[1]
        if self.path!='/' or self.headers.get('Host')!=f'localhost:{port}':
            self.send_error(404); return
        name=PAGES[port]; nonce=secrets.token_urlsafe(18)
        body=f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>测试嵌入页 {name}</title>
        <style nonce="{nonce}">body{{background:#f6faf9;color:#172c29;font:16px/1.6 system-ui;margin:3rem}}h1{{font-size:24px}}input{{display:block;padding:.6rem;font:inherit;width:22rem;max-width:90%}}code{{background:#def;padding:.2rem}}</style>
        <h1>测试嵌入页 {name}</h1><p>本页是模拟页面，不是 NF。内容不会保存。</p>
        <div>loadId：<code id="load"></code></div><div>文档初始化：<span id="stamp"></span></div>
        <p><label>临时输入 {name}<input id="entry" autocomplete="off" spellcheck="false"></label></p>
        <script nonce="{nonce}">document.getElementById('load').textContent=crypto.randomUUID();document.getElementById('stamp').textContent=new Date().toISOString();document.getElementById('entry').value='';</script></html>'''.encode()
        self.send_response(200); self.send_header('Content-Type','text/html; charset=utf-8'); self.send_header('Content-Length',str(len(body)))
        self.send_header('Content-Security-Policy',f"default-src 'none'; script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors {ORIGIN['web']}")
        self.send_header('Cache-Control','no-store'); self.send_header('Referrer-Policy','no-referrer'); self.send_header('X-Content-Type-Options','nosniff')
        self.end_headers(); self.wfile.write(body)


def serve():
    require(read('initialized')==owner(),'Not the formal fixture')
    with contextlib.ExitStack() as stack:
        servers=[]
        for p in PAGES:
            endpoint_free(p); servers.append(stack.enter_context(ThreadingHTTPServer((LOOP,p),Page)))
        for server in servers[:-1]: threading.Thread(target=server.serve_forever,daemon=True).start()
        write(local('web',MARK),json.dumps({'owner':owner(),'pid':os.getpid(),'birth':psutil.Process().create_time()}),replace=True)
        print('Simulated, no-persistence test pages at http://localhost:17921/ and http://localhost:17922/',flush=True)
        servers[-1].serve_forever()


def register():
    m=json.loads(read('web',MARK)); require(m['owner']==owner(),'Unknown embed server')
    p=psutil.Process(m['pid']); argv=p.cmdline()
    require(p.create_time()==m['birth'] and (Path(p.cwd())/argv[-2]).resolve()==Path(__file__).resolve() and argv[-1]=='serve','Wrong embed process')
    require({(s.laddr.ip,s.laddr.port) for s in p.net_connections('tcp') if s.status=='LISTEN'}=={(LOOP,v) for v in PAGES},'Not the two fixture listeners')
    with Hub('web') as h:
        h.instance()  # require the already-recorded, fixture-owned DEV_HTTP instance and database
        existing=h.req('GET','/api/instances')['items']
        for port,name in PAGES.items():
            url=f'http://localhost:{port}'; alias=f'测试嵌入页 {name}'; file=f'embed-{name}.json'
            if not local('web',file).exists():
                require(not any(i['browserBaseUrl']==url for i in existing),'Refusing to adopt an existing instance')
                i=h.req('POST','/api/instances',status=201,json={'alias':alias,'group':'模拟保活验证','browserBaseUrl':url,'order':20 if name=='A' else 21})
                write(local('web',file),json.dumps({'owner':owner(),'id':i['id']}))
            rec=json.loads(read('web',file)); require(rec['owner']==owner(),'Foreign embed record')
            i=h.req('GET','/api/instances/'+rec['id']); require(i['browserBaseUrl']==url and i['alias']==alias,'Fixture instance changed')
            print(f'{name}: {url} instance={i["id"]}')

if __name__=='__main__':
    if sys.argv[1:]==['serve']: serve()
    elif sys.argv[1:]==['register']: register()
    else: raise SystemExit(__doc__)
