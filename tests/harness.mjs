// Offline boundary fixture. Uses the installed official approval implementation
// and executes the real model-selection waterfalls against a persistent header.
import {mkdtemp,mkdir,readFile,writeFile,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {ApprovalService} from '@deepseek-ai/dsh-user-approval'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js'
export const sleep=ms=>new Promise(r=>setTimeout(r,ms))
export const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
export async function fixture(seed) {
 const home=await mkdtemp(join(tmpdir(),'dmb-regression-'))
 const ws=join(home,'workspace');await mkdir(ws)
 process.env.DSH_HOME=home
 process.env.DSH_MCP_BRIDGE_MONITOR_MS='15'
 process.env.DSH_MCP_BRIDGE_PROGRESS_MS='25'
 await writeFile(join(home,'harness-mcp-token.txt'),'offline-fixture-only\n')
 const values={enabled:true,mode:'single',singleProvider:'p',singleModel:'a',singleEffort:'high',providerId:'p',providerDefaultModel:'a',providerDefaultEffort:'low',providerAllowOverrides:false,approvalMode:'inherit',autoApprove:false,defaultWorkspace:'ws',autoCleanupDays:0,command:'',commandResult:'',cleanupStatus:''}
 const config={pipePath:process.platform==='win32'?`\\\\.\\pipe\\dmb-regression-${process.pid}-${Math.random().toString(36).slice(2)}`:join(home,'bridge.sock'),httpEnabled:false,preset:'',maxConcurrentTasks:2,...Object.fromEntries(Object.keys(values).map(k=>[k,{get:()=>values[k]}]))}
 const handlers=new Map(),disposers=[],requests=[],sent=[],logs=[],live=new Map(),saved=new Map()
 const workspace={id:'ws',title:'Fixture',path:ws,sessionIds:[],async attachSession(id){if(!this.sessionIds.includes(id))this.sessionIds.push(id)},async detachSession(id){this.sessionIds=this.sessionIds.filter(x=>x!==id)}}
 const archived=[]
 const register=(table,name,fn,options)=>{const list=table.get(name)??[];options?.prepend?list.unshift(fn):list.push(fn);table.set(name,list);return ()=>{const i=list.indexOf(fn);if(i>=0)list.splice(i,1)}}
 const waterfall=(table,name,payload,terminal)=>{const list=table.get(name)??[];const run=i=>list[i]?(name==='system-prompt/assemble'?list[i](payload,{},()=>run(i+1)):list[i](payload,()=>run(i+1))):terminal();return run(0)}
 const f={home,ws,values,config,requests,sent,logs,live,saved,workspace,archived,createGate:null,resumeGate:null,answer:'allowed-once',asked:0}
 const approval=Object.create(ApprovalService.prototype)
 Object.defineProperty(approval,'ctx',{value:{waterfall(_target,_name,_req,next){f.asked++;return typeof f.answer==='function'?f.answer(_req,next):Promise.resolve(f.answer)}}})
 approval.config={policy:'ask'}
 const fileFor=id=>join(home,'sessions','fixture',id,'session.v4.jsonl')
 f.sessionFile=async(id,{mcp=false}={})=>{
  await mkdir(join(home,'sessions','fixture',id),{recursive:true})
  await writeFile(fileFor(id),JSON.stringify({type:'session/start',data:{id,cwd:ws}})+'\n')
  if(!workspace.sessionIds.includes(id))workspace.sessionIds.push(id)
  if(mcp){const file=join(home,'mcp-bridge','sessions.json');await mkdir(join(home,'mcp-bridge'),{recursive:true});let ledger={};try{ledger=JSON.parse(await readFile(file,'utf8'))}catch{}ledger[id]={title:'fixture',createdAt:1};await writeFile(file,JSON.stringify(ledger))}
  return fileFor(id)
 }
 f.agent=(id,options={},events=[],messages=[])=>{
  let idle=Promise.resolve(),control=new AbortController(),turn=events.filter(e=>e.type==='turn/start').length
  const scoped=new Map()
  const session={header:{id,cwd:ws},get seq(){return events.length},eventAt:i=>events[i],snapshotEvents:(from=0)=>events.slice(from),deriveMessages:()=>[...messages],requestHeader:()=>events.findLast(e=>e.type==='request/header')?.data.header,append(type,data){const e={type,data,seq:events.length};events.push(e);return e}}
  const agent={id,session,options,status:'idle',ctx:{on:(name,fn,opts)=>register(scoped,name,fn,opts)},inject(message){messages.push(message)},cancel(cause){control.abort(cause)},whenIdle:()=>idle,
   followup(message){
    sent.push({id,text:message.content[0].text});messages.push(message);control=new AbortController();agent.status='running';const t=++turn;session.append('turn/start',{turn:t});session.append('agent/inbox/spliced',{removedCount:1,inserted:[]})
    idle=(async()=>{
     let reason={kind:'completed'}
     try{
      const text=message.content[0].text
      const assembly=await waterfall(scoped,'system-prompt/assemble',{},()=>Promise.resolve({variables:{}}))
      await waterfall(scoped,'agent/pre-step',{agent,messages:[message],signal:control.signal,step:1},()=>Promise.resolve({kind:'enter',messages:[message],assembly}))
      if(control.signal.aborted)throw control.signal.reason
      session.append('step/start',{turn:t,step:1})
      const route=await waterfall(scoped,'agent/request',{agent,turn:t,step:1,signal:control.signal},()=>Promise.resolve(session.requestHeader()?.config??options))
      session.append('request/header',{header:{config:route},reason:'change'})
      const request={...route,sessionId:id,signal:control.signal,messages:[message]}
      const stream=waterfall(handlers,'llm/stream',request,()=>{requests.push({...route,id,text});return (async function*(){yield {type:'fixture'}})()})
      for await(const _chunk of stream) {}
      if(text.includes('approval'))await approval.request({agent,toolName:text.includes('expanded')?'write-outside':'write',signal:control.signal,reason:'fixture scope'})
      const ms=Number(/slow:(\d+)/.exec(text)?.[1]??0)
      if(ms)await Promise.race([sleep(ms),new Promise(r=>control.signal.addEventListener('abort',r,{once:true}))])
      if(control.signal.aborted)throw control.signal.reason
      if(text.includes('fatal'))reason={kind:'error',error:{code:'AUTH',message:'fixture model failure'}}
      if(text.includes('external-stop'))reason={kind:'aborted',reason:{kind:'user'}}
      if(text.includes('retry'))session.append('tool/result',{error:'recoverable fixture error'})
      messages.push({role:'assistant',content:[{type:'text',text:'fixture completed'}]})
     }catch(e){reason=control.signal.aborted?{kind:'aborted',reason:control.signal.reason}:{kind:'error',error:{code:'UNKNOWN',message:String(e?.message??e)}}}
     session.append('turn/end',{turn:t,reason});agent.status='idle'
    })()
   }}
  saved.set(id,{events,messages,options});return agent
 }
 const ctx={logger:Object.fromEntries(['info','warn','error'].map(k=>[k,m=>logs.push(String(m))])),effect(fn){const d=fn();if(typeof d==='function')disposers.push(d)},on:(n,fn,o)=>register(handlers,n,fn,o),get(name){return this[name]},approval,
  settings:{async update(_ns,patch){Object.assign(values,patch);for(const fn of handlers.get('loader/volatile-update')??[])fn();return {value:{...values}}},configure:()=>()=>{}},
  llm:{listProviders:()=>[{id:'p',name:'P'},{id:'q',name:'Q'}],listModels:async p=>p==='p'?[{id:'a',name:'A'},{id:'b',name:'B'}]:[{id:'c',name:'C'}],resolveModelInfo:async()=>({reasoning:{efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}],defaultEffort:'low'}})},
  agentDefaultModel:{currentSelection:()=>({provider:'p',model:'a'})},agentPresets:{resolve:async()=>({id:'standard'}),mount:async()=>{}},
  sessionPersistence:{root:join(home,'sessions'),async stat(id){try{const file=fileFor(id),s=await stat(file),header=JSON.parse((await readFile(file,'utf8')).split('\n')[0]).data;if(header.id!==id)return undefined;return {header,revision:`${s.size}:${s.mtimeMs}`}}catch(e){if(e.code==='ENOENT')return undefined;throw e}}},
  agents:{get:id=>live.get(id),async create(opts){if(f.createGate)await f.createGate.promise;const agent=f.agent(opts.sessionId,opts.agentOptions);await opts.setup?.(agent.ctx,agent);await f.sessionFile(opts.sessionId);live.set(opts.sessionId,agent);return {agent,async dispose(){agent.cancel({kind:'disposed'});await agent.whenIdle();live.delete(opts.sessionId)}}},async resume(opts){if(f.resumeGate)await f.resumeGate.promise;const stored=saved.get(opts.resumeSessionId)??{};const agent=f.agent(opts.resumeSessionId,opts.agentOptions,stored.events,stored.messages);await opts.setup?.(agent.ctx,agent);live.set(opts.resumeSessionId,agent);return {agent,async dispose(){agent.cancel({kind:'disposed'});await agent.whenIdle();live.delete(opts.resumeSessionId)}}}},
  workspaceRegistry:{list:()=>[workspace],get:()=>workspace,resolveByPath:async()=>workspace,archivedSessionIds:archived,pinnedSessionIds:[],async archiveSession(id){archived.push(id);live.get(id)?.cancel({kind:'user'})},async unarchiveSession(id){const i=archived.indexOf(id);if(i>=0)archived.splice(i,1)},async unpinSession(){}}
 }
 f.ctx=ctx
 await seed?.(f)
 const root=new URL('../',import.meta.url)
 const {apply}=await import(process.env.DMB_TEST_HOST_URL??new URL('dist-package/lib/index.js',root))
 apply(ctx,config);await sleep(60)
 const client=new Client({name:'offline-regression',version:'0'})
 await client.connect(new StdioClientTransport({command:process.execPath,args:[process.env.DMB_TEST_RELAY??new URL('dist-package/bin/stdio.mjs',root).pathname.replace(/^\/(\w:)/,'$1')].map(decodeURIComponent),env:{...process.env,DSH_HOME:home,DSH_MCP_BRIDGE_PIPE:config.pipePath}}))
 f.client=client
 f.call=async(name,args={})=>{const result=await client.callTool({name,arguments:args});let body=result.content?.[0]?.text;try{body=JSON.parse(body)}catch{}return {error:!!result.isError,body}}
 f.close=async()=>{for(const a of live.values())a.cancel?.({kind:'disposed'});await client.close();for(const d of disposers.reverse())await d();await sleep(30)}
 return f
}
