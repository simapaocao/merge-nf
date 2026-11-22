import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { initializeAdmin } from './auth';
import { transferConfig } from './backup';
import { databasePath } from './config';
import { openDatabase } from './db';

const help = `Usage (DATABASE_PATH selects the active database):
  bun run admin init --username <name> [--password-file <private-file>]
  bun run admin backup --to <new-backup.sqlite>
  bun run admin restore --from <backup.sqlite>
Restore only to a NEW DATABASE_PATH with the service stopped. All instances must pair again.
Backups include the administrator password hash and should be stored privately.`;
function fromFile(file: string) {
  const fd = openSync(file,constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.size > 4096 || (process.platform !== 'win32' && (s.mode & 0o077))) throw new Error('Use a private regular password file, mode 0600 on Unix');
    const buf = Buffer.alloc(4097);
    try {
      let length=0;
      while (length < buf.length) { const n = readSync(fd,buf,length,buf.length-length,null); if (!n) break; length+=n; }
      if (length >= buf.length) throw new Error('Password file too large');
      return new TextDecoder('utf-8',{fatal:true}).decode(buf.subarray(0,length)).replace(/\r?\n$/,'');
    } finally { buf.fill(0); }
  } finally { closeSync(fd); }
}
async function hidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error('Use --password-file without an interactive TTY');
  const stdin = process.stdin, wasRaw = !!stdin.isRaw;
  process.stderr.write(prompt); stdin.setRawMode(true); stdin.setEncoding('utf8'); stdin.resume();
  try {
    return await new Promise<string>((resolve,reject) => {
      let value='';
      const finish = (error?: Error) => { stdin.off('data',handle); stdin.off('end',ended); stdin.off('error',ended); error ? reject(error) : resolve(value); };
      const ended = () => finish(new Error('Input cancelled'));
      const handle = (text: string) => {
        for (const ch of text) {
          if (ch === '\r' || ch === '\n') { finish(); return; }
          if (ch === '\x03' || ch === '\x04') { ended(); return; }
          if (ch === '\x7f' || ch === '\b') value = Array.from(value).slice(0,-1).join('');
          else if (ch >= ' ') value+=ch;
          if (value.length > 512) { finish(new Error('Password too long')); return; }
        }
      };
      stdin.on('data',handle); stdin.once('end',ended); stdin.once('error',ended);
    });
  } finally { stdin.setRawMode(wasRaw); stdin.pause(); process.stderr.write('\n'); }
}
export async function cli(argv: string[]) {
  const [cmd,...args] = argv;
  if (cmd === '--help' || cmd === 'help') { console.info(help); return; }
  const path = databasePath();
  if (cmd === 'init') {
    const {values} = parseArgs({args,options:{username:{type:'string'},'password-file':{type:'string'}}});
    if (!values.username) throw new Error(help);
    const password = values['password-file'] ? fromFile(values['password-file']) : await hidden('Password: ');
    if (!values['password-file'] && password !== await hidden('Confirm password: ')) throw new Error('Passwords differ');
    const db = openDatabase(path);
    try { await initializeAdmin(db,values.username,password); } finally { db.close(); }
    console.info('Administrator initialized.');
  } else if (cmd === 'backup') {
    const {values} = parseArgs({args,options:{to:{type:'string'}}}); if (!values.to) throw new Error(help);
    transferConfig('backup',path,values.to); console.info('Private configuration backup complete.');
  } else if (cmd === 'restore') {
    const {values} = parseArgs({args,options:{from:{type:'string'}}}); if (!values.from) throw new Error(help);
    transferConfig('restore',values.from,path); console.info('Configuration restored; all instances require re-pairing.');
  } else throw new Error(help);
}
if (import.meta.main) { if (process.platform !== 'win32') process.umask(0o077); cli(process.argv.slice(2)).catch(e=>{console.error(e instanceof Error ? e.message : 'Command failed');process.exitCode=1;}); }
