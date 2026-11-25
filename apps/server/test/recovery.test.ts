import { expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIMITS, activityHash, sessionMetadataHash } from '@nf-hub/protocol';
import { receiveSessionMetadata } from '../src/session-metadata';
import { receiveActivity } from '../src/activity';
import { HubDatabase } from '../src/connection';
import { SCHEMA_VERSION } from '../src/migrations';
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
test('schema1/2专用备份只读恢复到schema3；配置保留而凭证/摘要/活动/父关系均空',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'nf-hub-legacy-backup-'));
  try {
    const live=join(dir,'live.sqlite'),currentBackup=join(dir,'current-backup.sqlite');
    const source=openDatabase(live);let id='';
    try {
      await initializeAdmin(source,'owner',secret(32),BASE);
      const a=makeActor(source,'configured',BASE);id=a.id;await publish(source,a,[summary('safe-id')],BASE);
      const base=instanceRecord(source,a.id),items=[{id:'safe-id',reply:true,approval:false,error:false,unread:false,backgroundWorkCount:1}];
      await receiveActivity(source,a.hash,{protocolVersion:1,generation:a.generation,runId:base.runSeq,baseHash:base.snapshotHash,available:true,count:1,hash:await activityHash(items),items},()=>BASE);
      const metadata=[{id:'safe-id',kind:'primary' as const,parentKnown:true,parentId:null}];
      await receiveSessionMetadata(source,a.hash,{protocolVersion:1,generation:a.generation,runId:base.runSeq,baseHash:base.snapshotHash,available:true,count:1,hash:await sessionMetadataHash(metadata),items:metadata},()=>BASE);
    } finally {source.close();}
    transferConfig('backup',live,currentBackup);
    for(const version of [1,2,3]){
      const legacy=join(dir,`schema${version}-backup.sqlite`),restored=join(dir,`restored${version}.sqlite`);
      copyFileSync(currentBackup,legacy);
      const old=new HubDatabase(legacy,{strict:true});
      try {
        if(version<3) old.exec('DROP TRIGGER retire_session_metadata_base; DROP TABLE session_metadata_items; DROP TABLE session_metadata_snapshots;');
        if(version<2) old.exec('DROP TRIGGER retire_activity_base; DROP TABLE activity_items; DROP TABLE activity_snapshots;');
        old.exec(`PRAGMA user_version=${version};`);
      } finally {old.close();}
      const bytes=readFileSync(legacy),modified=statSync(legacy).mtimeMs;
      transferConfig('restore',legacy,restored);
      expect(readFileSync(legacy).equals(bytes)).toBe(true);expect(statSync(legacy).mtimeMs).toBe(modified);
      expect(existsSync(legacy+'-wal')).toBe(false);expect(existsSync(legacy+'-shm')).toBe(false);
      const recovered=openDatabase(restored);
      try {
        expect(recovered.query<{user_version:number},[]>('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
        readyToServe(recovered);
        expect(instanceRecord(recovered,id)).toMatchObject({alias:'configured',authState:'revoked',sessionCount:null,lastSuccessAt:null,snapshotHash:null,scopeJson:null});
        for(const table of ['admin_sessions','connector_credentials','pairings','sync_runs','session_summaries','activity_snapshots','activity_items','session_metadata_snapshots','session_metadata_items']){
          expect(recovered.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({n:0});
        }
      } finally {recovered.close();}
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('恢复拒绝未知schema0/未来版本与live伪备份，所有被拒源只读且不产生目标文件',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'nf-hub-backup-versions-'));
  try {
    const live=join(dir,'live.sqlite'),backup=join(dir,'backup.sqlite');
    const source=openDatabase(live);
    try {await initializeAdmin(source,'owner',secret(32),BASE);} finally {source.close();}
    transferConfig('backup',live,backup);
    for(const version of [0,SCHEMA_VERSION+1,99]){
      const rejected=join(dir,`v${version}.sqlite`),target=join(dir,`restored-v${version}.sqlite`);
      copyFileSync(backup,rejected);
      const fixture=new HubDatabase(rejected,{strict:true});
      try {fixture.exec(`PRAGMA user_version=${version}`);} finally {fixture.close();}
      const bytes=readFileSync(rejected),modified=statSync(rejected).mtimeMs;
      expect(()=>transferConfig('restore',rejected,target)).toThrow('Wrong input database type/version');
      expect(readFileSync(rejected).equals(bytes)).toBe(true);expect(statSync(rejected).mtimeMs).toBe(modified);
      expect(existsSync(target)).toBe(false);
    }
    const bytes=readFileSync(live),target=join(dir,'live-cannot-restore.sqlite');
    expect(()=>transferConfig('restore',live,target)).toThrow('Wrong input database type/version');
    expect(readFileSync(live).equals(bytes)).toBe(true);expect(existsSync(target)).toBe(false);
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
