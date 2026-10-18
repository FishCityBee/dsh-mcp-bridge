// Launched only by official-storage.mjs, with a newly-created test home.
// Electron's Node mode resolves the actual desktop runtime and native lease.
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {mkdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createInterface} from 'node:readline'
const [runtime,home,id,mode]=process.argv.slice(2)
if(!runtime||!home||!id||process.env.DSH_HOME!==resolve(home))throw new Error('ISOLATED_HOME_REQUIRED')
const req=createRequire(join(runtime,'package.json'))
const version=req('@deepseek-ai/dsh-session-persistence-jsonl/package.json').version
if(version!=='0.2.1-rc.2')throw new Error('PINNED_BACKEND_VERSION_REQUIRED')
const {Context}=await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')))
const backend=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-persistence-jsonl')))
const {SESSION_FORMAT_VERSION}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session')))
const root=join(home,'sessions');await mkdir(root,{recursive:true})
const ctx=new Context(),mount=ctx.plugin(backend,{root,compression:'none'})
await mount.await()
const store=ctx.get('sessionPersistence')
let writer
if(mode==='create'){
 writer=await store.create({version:SESSION_FORMAT_VERSION,id,createdAt:Date.now(),cwd:join(home,'workspace'),isSeeded:false})
 await writer.flush()
}
console.log(JSON.stringify({ready:true,pid:process.pid,backend:version,electron:process.versions.electron,node:process.version,platform:process.platform}))
try{
 for await(const line of createInterface({input:process.stdin})){
  const {ticket,action}=JSON.parse(line)
  try{
   let value
   if(action==='stat')value=await store.stat(id)
   else if(action==='read-count'){
    const reader=await store.open(id,'read')
    try{value=(await reader.read()).events.length}finally{await reader.close()}
   }
   else if(action==='try-write'){
    try{const other=await store.open(id,'write');await other.close();value={opened:true}}
    catch(error){value={opened:false,error:error.name}}
   }else if(action==='close-writer'){await writer?.close();writer=undefined;value=true}
   else if(action==='open-writer'){writer=await store.open(id,'write');value=true}
   else if(action==='append'){
    const seq=(await writer.read()).events.length,time=Date.now()
    await writer.append([{seq,time,type:'turn/start',data:{turn:1}},{seq:seq+1,time,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}])
    await writer.flush();value=(await writer.read()).events.length
   }else if(action==='stop'){console.log(JSON.stringify({ticket,value:true}));break}
   else throw new Error('UNKNOWN_TEST_COMMAND')
   console.log(JSON.stringify({ticket,value}))
  }catch(error){console.log(JSON.stringify({ticket,error:error.name+': '+error.message}))}
 }
}finally{await writer?.close();await mount.dispose()}
