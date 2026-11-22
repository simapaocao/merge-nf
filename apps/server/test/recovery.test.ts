import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIMITS } from '@nf-hub/protocol';
import { digest, initializeAdmin, login, secret } from '../src/auth';
import { transferConfig } from '../src/backup';
import { openDatabase, readyToServe } from '../src/db';
import { createInstance, instanceRecord } from '../src/instances';
import { claim, credential, issueCode } from '../src/pairing';
import { BASE, cfg, makeActor, publish, run, summary } from './fixture';

test('重开活动库保留轮号；专用备份不可监听；恢复为全新库并废所有代、代码、会话、快照',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'nf-hub-recovery-'));
  try {
    const live=join(dir,'live.sqlite'), backup=join(dir,'backup.sqlite'), restored=join(dir,'restored.sqlite');
    let db=openDatabase(live);
    try {
      expect(()=>readyToServe(db)).toThrow(); const pw=secret(32);
      await initializeAdmin(db,'owner',pw,BASE); const session=await login(db,'owner',pw,()=>BASE);
      const a=makeActor(db,'alpha',BASE); await publish(db,a,[summary('private-summary')],BASE);
      const b=createInstance(db,cfg,{alias:'beta',browserBaseUrl:'https://beta.example.invalid'},BASE), pending=issueCode(db,b.id,BASE);
      db.close(); db=openDatabase(live); expect(run(db,a,BASE).runId).toBe(2);
      transferConfig('backup',live,backup); expect(()=>transferConfig('restore',backup,live)).toThrow();
      const exported=openDatabase(backup);
      try { expect(()=>readyToServe(exported)).toThrow('Backup'); } finally {exported.close();}
      transferConfig('restore',backup,restored); const recovered=openDatabase(restored);
      try {
        readyToServe(recovered); expect(instanceRecord(recovered,a.id)).toMatchObject({generation:a.generation+1,authState:'revoked',sessionCount:null});
        expect(()=>credential(recovered,a.hash)).toThrow(); expect(()=>claim(recovered,{...a.request,code:pending.code},BASE+1)).toThrow();
        expect(recovered.query('SELECT 1 FROM admin_sessions WHERE tokenHash=?').get(digest(session.token))).toBeNull();
        expect(recovered.query('SELECT 1 FROM session_summaries').get()).toBeNull();
        expect(recovered.query('SELECT 1 FROM sync_runs').get()).toBeNull();
        expect(await login(recovered,'owner',pw,()=>BASE)).toHaveProperty('auth');
      } finally {recovered.close();}
    } finally {db.close();}
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('保留语句引用超过 Bun 默认20及中心缓存128时，严格关库仍立即释放资源',()=>{
  const db=openDatabase(':memory:'), statements=Array.from({length:160},(_,n)=>db.query(`SELECT ${n}`));
  expect(statements[159]!.get()).toBeTruthy();
  expect(()=>db.close(true)).not.toThrow();
  expect(()=>statements[159]!.get()).toThrow();
});
test('配对码只存摘要，未过期拒绝覆盖，含边界的10分钟过期不可兑换',()=>{
  const db=openDatabase(':memory:');
  try {
    const i=createInstance(db,cfg,{alias:'test',browserBaseUrl:'https://one.example.invalid'},BASE), p=issueCode(db,i.id,BASE);
    expect(db.query('SELECT codeHash FROM pairings').get()).toEqual({codeHash:digest(p.code)});
    expect(()=>issueCode(db,i.id,BASE+1)).toThrow('REVOKE_FIRST');
    expect(()=>claim(db,{protocolVersion:1,confirmed:true,connectorVersion:'0.1.0',capabilities:['summary.v1'],scope:{mode:'all',includeArchived:false,acknowledgeHidden:true},code:p.code},BASE+LIMITS.pairingMs)).toThrow('INVALID_PAIRING');
    expect(issueCode(db,i.id,BASE+LIMITS.pairingMs).code).not.toBe(p.code);
  } finally {db.close();}
});
