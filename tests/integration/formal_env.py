"""Owned, fixed-loopback integration fixture. No endpoint, DB or profile overrides."""
import hashlib
import json
import os
import secrets
import shutil
import socket
import stat
import subprocess
import time
from pathlib import Path

import psutil

ROOT = Path(__file__).absolute().parents[2]
VAL = ROOT / '.validation'
STATE = VAL / 'formal'
NF_EXE = VAL / 'narrafork-0.9.14-windows-x64.exe'
NF_HASH = '7709484310347fa2affc4aec7b3432042674baf5547dd5bad4095ec85390017a'
PLUGIN = 'local.nf-hub.connector'
LOOP = '127.0.0.1'
PORT = {'nf': 17873, 'tls': 17910, 'web': 17900}
ORIGIN = {'nf': 'http://127.0.0.1:17873', 'tls': 'https://127.0.0.1:17910', 'web': 'http://127.0.0.1:17900'}
BROWSER = {'tls': 'https://localhost:17874', 'web': 'http://localhost:17873'}
USER = {'nf': 'formal_nf', 'tls': 'formal_tls', 'web': 'formal_web'}
MAGIC = 'nf-workbench/formal-loopback/v1'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def real(path):
    require(path.is_absolute() and path == path.resolve(), 'Refusing redirected path')
    if path.is_file():
        require(path.stat().st_nlink == 1, 'Refusing linked regular file')
    return path


def local(*parts):
    path = STATE.joinpath(*parts)
    require(path.is_relative_to(STATE) and '..' not in path.parts, 'Not a fixture path')
    return real(path)


def owner():
    marker = local('owner.json')
    require(marker.is_file(), 'Run explicit init in a new, empty .validation/formal first')
    obj = json.loads(marker.read_text(encoding='utf8'))
    require(obj.get('type') == MAGIC and isinstance(obj.get('nonce'), str) and len(obj['nonce']) == 32, 'Unknown formal fixture')
    return obj['nonce']


def mkdir(*parts):
    path = local(*parts)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(path.is_dir() and path == path.resolve(), 'Unsafe directory')
    return path


def write(path, value, *, replace=False):
    require(path.is_relative_to(STATE) and '..' not in path.parts, 'Not a fixture file')
    real(path)
    data = value if isinstance(value, bytes) else value.encode('utf8')
    target = path.with_name(path.name + '.' + secrets.token_hex(6) + '.tmp') if replace else path
    with os.fdopen(os.open(real(target), os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os,'O_BINARY',0), 0o600), 'wb') as f:
        f.write(data)
    if replace:
        target.replace(path)


def read(*parts):
    path = local(*parts)
    require(path.is_file() and path.stat().st_size < 128_000, 'Fixture record missing or invalid')
    if os.name != 'nt':
        require(not (stat.S_IMODE(path.stat().st_mode) & 0o077), 'Unsafe fixture permissions')
    return path.read_text(encoding='utf8')


def file_hash(path):
    with real(path).open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def executable(name):
    value = shutil.which(name)
    require(value, f'{name} is required on PATH')
    path = Path(value).resolve()
    if name == 'bun' and path.suffix.lower() in {'.cmd','.bat'}:
        # npm's Windows shim is not the process actually listening on the socket.
        path = (path.parent/'node_modules/bun/bin/bun.exe').resolve(strict=True)
    return path


def environment(role):
    """Use an allowlist, not a copy of the real user's environment or profile."""
    owner()
    require(role in PORT, 'Unknown role')
    home, tmp, nf, cache = [mkdir(role, n) for n in ('home', 'tmp', 'nf-home', 'cache')]
    bun, node, git = [executable(n) for n in ('bun', 'node', 'git')]
    dirs = [bun.parent, node.parent, git.parent]
    env = {}
    if os.name == 'nt':
        system = Path(os.environ['SystemRoot'])
        dirs.extend([system, system/'System32', system/'System32/WindowsPowerShell/v1.0', executable('bash').parent])
        env.update(SystemRoot=str(system), WINDIR=str(system), ComSpec=str(system/'System32/cmd.exe'),
                   PATHEXT='.COM;.EXE;.BAT;.CMD', HOMEDRIVE=home.drive, HOMEPATH=str(home)[len(home.drive):],
                   APPDATA=str(mkdir(role,'home','AppData','Roaming')), LOCALAPPDATA=str(mkdir(role,'home','AppData','Local')))
    else:
        dirs.extend([Path('/bin'), Path('/usr/bin')])
    env.update(PATH=os.pathsep.join(map(str,dict.fromkeys(dirs))), HOME=str(home), USERPROFILE=str(home),
               TEMP=str(tmp), TMP=str(tmp), TMPDIR=str(tmp), NARRAFORK_HOME=str(nf),
               XDG_CONFIG_HOME=str(mkdir(role,'home','config')), XDG_DATA_HOME=str(mkdir(role,'home','data')),
               XDG_CACHE_HOME=str(cache), CODEX_HOME=str(mkdir(role,'home','codex')), BUN_INSTALL=str(mkdir(role,'bun')),
               BUN_INSTALL_CACHE_DIR=str(cache), npm_config_cache=str(mkdir(role,'npm-cache')),
               GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=str(home/'.gitconfig'), GIT_TERMINAL_PROMPT='0',
               BUN_GARBAGE_COLLECTOR_LEVEL='1', BUN_RUNTIME_TRANSPILER_CACHE_PATH='0', DO_NOT_TRACK='1')
    check = 'const o=require("node:os");console.log(JSON.stringify([o.homedir(),o.tmpdir(),process.env.NARRAFORK_HOME,process.env.CODEX_HOME]))'
    actual = subprocess.check_output([bun,'--no-env-file','-e',check],cwd=local(role),env=env,timeout=20,stderr=subprocess.DEVNULL)
    require(list(map(Path,json.loads(actual))) == [home,tmp,nf,home/'codex'], 'Isolation preflight failed')
    return env


def endpoint_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        sock.bind((LOOP,port))


def is_process(role, proc):
    expected = NF_EXE if role == 'nf' else executable('bun')
    if Path(proc.exe()).resolve() != expected or Path(proc.cwd()).resolve() != (local(role) if role == 'nf' else ROOT):
        return False
    args = proc.cmdline()
    if role == 'nf':
        return args[1:] == ['--serve', '--host=127.0.0.1', '--port=17873']
    return any(a.replace('\\','/') == 'apps/server/src/main.ts' or Path(a) == ROOT/'apps/server/src/main.ts' for a in args[1:])


def listens(proc, port):
    sockets = {(c.laddr.ip,c.laddr.port) for c in proc.net_connections(kind='inet') if c.status == psutil.CONN_LISTEN}
    return sockets == {(LOOP,port)}


def owned_listener(role):
    """Read-only ownership check. Does not read the process environment or authentication state."""
    nonce = owner()
    require(role in PORT, 'Unknown endpoint')
    record = json.loads(read(role, 'listener.json'))
    require(record['owner'] == nonce and record['role'] == role, 'Foreign listener record')
    proc = psutil.Process(record['pid'])
    require(abs(proc.create_time() - record['birth']) < .002 and is_process(role,proc) and listens(proc,PORT[role]), 'Listener is not this isolated process')
    return proc


def guard(role):
    """For a credentialed request also attest the matched child's DB and profile paths."""
    proc = owned_listener(role)
    env = {k.upper():v for k,v in proc.environ().items()}
    require(Path(env.get('NARRAFORK_HOME','')) == local(role,'nf-home') and Path(env.get('HOME','')) == local(role,'home'), 'Foreign process profile')
    if role != 'nf':
        require(Path(env.get('DATABASE_PATH','')) == local(role,'hub.sqlite') and env.get('PUBLIC_URL') == ORIGIN[role], 'Foreign database or center')
    return proc


def remember_listener(role, child):
    deadline = time.monotonic()+70
    while time.monotonic()<deadline:
        require(child.poll() is None, f'{role} exited before opening its listener')
        root = psutil.Process(child.pid)
        for proc in [root, *root.children(recursive=True)]:
            try:
                if is_process(role,proc) and listens(proc,PORT[role]):
                    write(local(role,'listener.json'), json.dumps({'owner':owner(),'role':role,'pid':proc.pid,'birth':proc.create_time()}),replace=True)
                    guard(role)
                    print(f'{role} ready: {ORIGIN[role]}, verified loopback PID {proc.pid}',flush=True)
                    return proc
            except psutil.NoSuchProcess:
                continue
        time.sleep(.2)
    raise RuntimeError(f'{role} failed its isolated listener preflight')
