// Uses bundled TS modules and the real installed approval service. No models.
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {build} from 'esbuild'
import {ApprovalService,setApprovalPolicy} from '@deepseek-ai/dsh-user-approval'
import {gate,sleep} from './harness.mjs'
const root=await mkdtemp(join(tmpdir(),'dmb-units-'))
async function load(name){const file=join(root,name.replaceAll('/','-')+'.mjs');await build({entryPoints:[`src/${name}.ts`],outfile:file,bundle:true,platform:'node',format:'esm',logLevel:'silent'});return import(pathToFileURL(file))}
const {TaskStore}=await load('tasks'),{SessionLedger}=await load('ledger'),{SettingsSync}=await load('client/settings-sync'),{Semaphore}=await load('scheduler')
let failures=0,count=0
async function test(name,fn){try{await fn();count++;console.log('PASS '+name)}catch(e){failures++;console.error('FAIL '+name+': '+e.stack)}}
const record=(id,status='done',createdAt=Date.now())=>({id,status,createdAt,finishedAt:status==='done'?Date.now():undefined,task:'fixture',provider:'p',model:'a',progress:{steps:0,toolCalls:0,lastActivityAt:Date.now()}})
await test('active task survives 200 newer terminal records and cold load',async()=>{
 const path=join(root,'tasks.json'),s=new TaskStore(path);s.records.set('old',record('old','running',1));for(let i=0;i<201;i++)s.records.set('t'+i,record('t'+i));await s.flush();assert.ok(s.records.has('old'));assert.equal(s.records.size,201);const cold=new TaskStore(path);await cold.load();assert.ok(cold.records.has('old'))
})
await test('201 active tasks all survive flush and recovery',async()=>{
 const path=join(root,'active.json'),s=new TaskStore(path);for(let i=0;i<201;i++)s.records.set('a'+i,record('a'+i,'queued',i));await s.flush();assert.equal(s.records.size,201);const cold=new TaskStore(path);await cold.load();assert.equal(cold.records.size,201);cold.records.get('a0').status='cancelled';await cold.flush();assert.equal(cold.records.get('a1').status,'queued')
})
await test('task admission write failure is visible and retry succeeds',async()=>{
 const path=join(root,'blocked.json');await mkdir(path);const s=new TaskStore(path);s.records.set('x',record('x','queued'));await assert.rejects(s.flush(),/STORAGE_WRITE_FAILED/);assert.ok(s.error);await rm(path,{recursive:true});await s.flush();assert.equal(s.error,undefined);assert.equal(JSON.parse(await readFile(path,'utf8')).length,1)
})
await test('ledger concurrent first load does not lose records',async()=>{
 const path=join(root,'ledger.json'),s=new SessionLedger(path);await Promise.all(Array.from({length:30},(_,i)=>s.add('s'+i,{createdAt:i,title:'fixture'})));assert.equal((await s.entries()).length,30);assert.equal(Object.keys(JSON.parse(await readFile(path,'utf8'))).length,30)
})
await test('ledger write failures and malformed reads fail closed',async()=>{
 const path=join(root,'ledger-blocked.json');await mkdir(path);const s=new SessionLedger(join(path,'..','blocked-parent','ledger.json'));await s.entries();await writeFile(join(root,'blocked-parent'),'block');await assert.rejects(s.add('x',{createdAt:1,title:'fixture'}),/STORAGE_WRITE_FAILED/);assert.equal(await s.get('x'),undefined);await writeFile(join(root,'malformed.json'),'{');await assert.rejects(new SessionLedger(join(root,'malformed.json')).entries(),/STORAGE_READ_FAILED/)
})
await test('stale settings load cannot overwrite a newer load',async()=>{
 const a=gate(),b=gate();let n=0,visible;const s=new SettingsSync({read:()=>++n===1?a.promise:b.promise,write:async()=>{},publish:v=>visible=v});const first=s.load(),second=s.load();b.resolve({model:'b'});await second;a.resolve({model:'a'});await first;assert.equal(visible.model,'b')
})
await test('failed save rolls back itself while later selection persists',async()=>{
 const a=gate(),b=gate();let n=0,visible,saving;const s=new SettingsSync({read:async()=>({model:'a',effort:'low'}),write:()=>++n===1?a.promise:b.promise,publish:(v,busy)=>{visible=v;saving=busy}});await s.load();const first=s.save({model:'b'}),second=s.save({model:'c',effort:'high'});await sleep(0);assert.equal(n,1);assert.equal(visible.model,'c');a.promise.catch(()=>{});a.resolve(Promise.reject(new Error('fixture failure')));await first;assert.equal(visible.model,'c');assert.equal(saving,true);b.resolve({model:'c',effort:'high'});await second;assert.equal(visible.model,'c');assert.equal(saving,false)
})
await test('read started during save cannot overwrite acknowledged settings',async()=>{
 const read=gate(),write=gate();let calls=0,visible;const s=new SettingsSync({read:()=>++calls===1?Promise.resolve({model:'a'}):read.promise,write:()=>write.promise,publish:v=>visible=v});await s.load();const saving=s.save({model:'b'}),loading=s.load();write.resolve({model:'b'});await saving;read.resolve({model:'a'});await loading;assert.equal(visible.model,'b')
})
await test('official approval outcomes: allow once, reject, ask, cancel and no persistent grant',async()=>{
 const events=[];const session={get seq(){return events.length},eventAt:i=>events[i],append(type,data){events.push({type,data})}};session.append('turn/start',{turn:1})
 let calls=0,outcome='allowed-once';const service=Object.create(ApprovalService.prototype);Object.defineProperty(service,'ctx',{value:{waterfall(){calls++;return typeof outcome==='function'?outcome():Promise.resolve(outcome)}}});service.config={policy:'ask'}
 const req={agent:{session},toolName:'write',reason:'same fixture scope'}
 assert.equal(await service.request(req),'allowed-once');assert.equal(await service.request(req),'allowed-once');assert.equal(calls,2)
 assert.equal(await service.request({...req,toolName:'write-outside'}),'allowed-once');assert.equal(calls,3)
 outcome='rejected';assert.equal(await service.request(req),'rejected')
 setApprovalPolicy(session,'never');assert.equal(await service.request(req),'rejected');assert.equal(calls,4)
 assert.throws(()=>setApprovalPolicy(session,'always'),/must be/)
 setApprovalPolicy(session,'ask');const pending=gate(),abort=new AbortController();outcome=()=>pending.promise;const decision=service.request({...req,signal:abort.signal});await sleep(0);abort.abort();assert.equal(await decision,'cancelled');pending.resolve('allowed-once');assert.equal(events.at(-1).data.outcome,'cancelled')
})
await test('adopted live tasks reserve capacity and aborted queue never runs',async()=>{
 const semaphore=new Semaphore(()=>1),running=gate(),queued=new AbortController();let ran=false;const existing=semaphore.run(()=>running.promise,undefined,true);const waiting=semaphore.run(async()=>{ran=true},queued.signal);queued.abort(new Error('cancelled'));await assert.rejects(waiting,/cancelled/);running.resolve();await existing;assert.equal(ran,false)
})
console.log(`UNITS ${count} passed, ${failures} failed`);process.exitCode=failures?1:0
