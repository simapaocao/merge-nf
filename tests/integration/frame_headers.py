"""Public HTTP response evidence only, not a headless browser or an embed success test."""
import ipaddress
import json
import socket
import sys
sys.dont_write_bytecode=True
from formal_client import NF, Hub, LocalAPI
from formal_env import BROWSER, ORIGIN, guard, require


def frame_headers():
    addresses={r[4][0] for r in socket.getaddrinfo('localhost',None,type=socket.SOCK_STREAM)}
    require(addresses and all(ipaddress.ip_address(a).is_loopback for a in addresses), 'Non-loopback localhost resolution')
    with NF() as nf:
        sample=nf.samples()['selected']['id']
    def inspect(r):
        directives=[d.strip() for h in r.raw.headers.getlist('Content-Security-Policy') for d in h.split(';')]
        return {'status':r.status_code,'html':r.headers.get('Content-Type','').split(';')[0]=='text/html',
                'frameAncestors':[d for d in directives if d.startswith('frame-ancestors ')],
                'frameSrc':[d for d in directives if d.startswith('frame-src ')],
                'X-Frame-Options':r.raw.headers.getlist('X-Frame-Options'),'redirect':r.is_redirect}
    with LocalAPI('nf') as guest:
        child={}
        for route in ['/', '/narrators/'+sample]:
            guard('nf')
            with guest.s.get(BROWSER['web']+route,allow_redirects=False,timeout=15) as r: child[route]=inspect(r)
    with Hub('web') as h:
        guard('web')
        with h.s.get(ORIGIN['web']+'/',allow_redirects=False,timeout=15) as r: logged=inspect(r)
    with LocalAPI('web') as g:
        guard('web')
        with g.s.get(ORIGIN['web']+'/',allow_redirects=False,timeout=15) as r: anon=inspect(r)
    return {'origin':ORIGIN['web'],'guestShell':anon,'authenticatedShell':logged,'childOrigin':BROWSER['web'],'childRoutes':child,
            'localhostResolution':sorted(addresses),'note':'HTTP metadata only; does not establish a successful browser load.'}

if __name__=='__main__':
    if len(sys.argv)!=1: raise SystemExit(__doc__)
    print(json.dumps(frame_headers(),ensure_ascii=True,indent=2))
