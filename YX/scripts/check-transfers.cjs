// 在 YX/ 执行；真实响应流与原始 IPC 参数回归，不访问生产服务。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const calls = [], requests = [], written = [];
let channel, failChunk = false, refreshes = 0, responses = [], account = 'account-a', refreshHook = () => {}, chunkHook = () => {};
class Channel { set onmessage(callback) { this.callback = callback; } }
const dependencies = {
  '@tauri-apps/api/core': { Channel, invoke: async (command, args, options) => {
    calls.push({command, args, options});
    if (command === 'attachment_download_chunk') {
      assert.ok(args instanceof Uint8Array, '下载不得退化为JSON数字数组');
      assert.ok(args.length <= 256 * 1024, '单次IPC须限制大小');
      if (failChunk) throw Error('模拟磁盘错误');
      assert.equal(Number(options.headers['x-download-offset']), written.reduce((sum, bytes) => sum + bytes.length, 0));
      written.push(Uint8Array.from(args));
      chunkHook();
      return written.reduce((sum, bytes) => sum + bytes.length, 0);
    }
    if (command === 'attachment_download_commit') return {id: args.id, path: '/下载/YX/测试.bin'};
    if (command === 'media_stream_open') { channel = args.onRequest; return {id: 'opaque-lease', url: 'http://127.0.0.1:32123/opaque-lease'}; }
    if (command === 'media_response_chunk') assert.ok(args instanceof Uint8Array, '媒体响应须走原始字节通道');
  } },
  '@tauri-apps/plugin-http': { fetch: async (url, options) => { requests.push({url, options}); const next=responses.shift(); if (next instanceof Error || typeof next === 'string') throw next; return typeof next === 'function' ? await next(url, options) : await next; } },
  './media': { downloadCandidates: seg => ['https://store.example/'+seg.downloadUrl+'?access_token=current', 'https://gw.example/store/v2/'+seg.downloadUrl+'/download?access_token=current'] },
  '../auth': { authService: { getCurrentUserId: () => account, refreshToken: async () => { refreshes++; refreshHook(); return 'fresh'; } } },
};
const m={exports:{}};
new Function('require','module','exports',ts.transpileModule(fs.readFileSync('src/services/im/transfers.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>dependencies[id],m,m.exports);
const api=m.exports;
const seg={downloadUrl:'file-id',fileName:'测试.bin',extension:'mp4',size:600000};
const waitFor=async predicate=>{ for(let i=0;i<100;i++){if(predicate())return; await new Promise(resolve=>setTimeout(resolve,1));} throw Error('等待模拟事件超时'); };
(async()=>{
 const bytes=Uint8Array.from({length:600000},(_,i)=>i%251);
 responses.push(new Response(bytes,{headers:{'Content-Length':String(bytes.length)}}));
 const progress=[];
 const saved=await api.saveAttachment(seg,'download-id',new AbortController(),(received,total)=>progress.push({received,total}));
 assert.equal(saved.id,'download-id');
 assert.deepEqual(Buffer.concat(written.map(Buffer.from)),Buffer.from(bytes));
 assert.equal(progress.at(-1).received,600000);
 assert.equal(progress.at(-1).total,600000);
 assert.equal(calls.filter(c=>c.command==='attachment_download_chunk').length,3);
 written.length=0;failChunk=true;
 responses.push(new Response(bytes));
 await assert.rejects(()=>api.saveAttachment(seg,'failure',new AbortController(),()=>{}),/磁盘错误/);
 assert.ok(calls.some(c=>c.command==='attachment_download_cancel'&&c.args.id==='failure'));
 failChunk=false;
 const cancelled=new AbortController(); cancelled.abort();
 await assert.rejects(()=>api.saveAttachment(seg,'cancel',cancelled,()=>{}),/已取消/);
 written.length=0; responses.push(new Response(null,{status:401}),new Response('ok'));
 await api.saveAttachment(seg,'refresh',new AbortController(),()=>{}); assert.equal(refreshes,1);
 // 网络层失败（证书/DNS，plugin-http 按字符串 reject）自动切换到下一个候选地址完成下载。
 written.length=0; responses.push('error sending request for url (https://store.example/file-id)',new Response('fallback-ok'));
 await api.saveAttachment(seg,'fallback',new AbortController(),()=>{});
 assert.equal(requests.at(-1).url,'https://gw.example/store/v2/file-id/download?access_token=current');
 assert.equal(Buffer.concat(written.map(Buffer.from)).toString(),'fallback-ok');
 // HTTP 层错误不消耗其他候选，直接交给上层报错。
 responses.push(new Response(null,{status:404}));
 await assert.rejects(()=>api.saveAttachment(seg,'http-error',new AbortController(),()=>{}),/HTTP 404/);
 assert.equal(requests.filter(r=>r.url.includes('gw.example')).length,1);
 // 所有候选都网络失败时，向上抛出最后一个错误。
 responses.push('error sending request for url (https://store.example/file-id)','error sending request for url (https://gw.example/file-id)');
 await assert.rejects(()=>api.saveAttachment(seg,'all-network-error',new AbortController(),()=>{}),/error sending request/);
 const lease=await api.openMediaStream(seg,true);
 assert.ok(!lease.url.includes('access_token'), '本机播放器地址不得携带账号凭据');
 responses.push(new Response('456',{status:206,headers:{'Content-Range':'bytes 4-6/10','Content-Length':'3'}}));
 channel.callback({kind:'request',id:'seek-request',method:'GET',range:'bytes=4-6'});
 await waitFor(()=>calls.some(c=>c.command==='media_response_end'&&c.args.id==='seek-request'));
 assert.equal(requests.at(-1).options.headers.Range,'bytes=4-6');
 const head=calls.find(c=>c.command==='media_response_head'&&c.args.id==='seek-request').args.head;
 assert.equal(head.status,206);assert.equal(head.headers['content-range'],'bytes 4-6/10');
 await lease.close();assert.ok(calls.some(c=>c.command==='media_stream_close'&&c.args.id==='opaque-lease'));
 assert.equal(api.mediaMime({...seg,extension:'amr'},false),'audio/amr');
 // 迟到401不能刷新或继续读取旧账号文件。
 account='account-a';const beforeRefresh=refreshes,beforeRequests=requests.length;
 responses.push(async()=>{account='account-b';return new Response(null,{status:401})});
 const switched=new AbortController();
 await assert.rejects(()=>api.saveAttachment(seg,'switched-response',switched,()=>{}),/已取消/);
 assert.ok(switched.signal.aborted);assert.equal(refreshes,beforeRefresh);assert.equal(requests.length,beforeRequests+1);
 // 刷新过程中换账号，也不得使用新凭据重试旧地址。
 account='account-a';refreshHook=()=>{account='account-b'};responses.push(new Response(null,{status:401}));
 const refreshRequestCount=requests.length;
 await assert.rejects(()=>api.saveAttachment(seg,'switched-refresh',new AbortController(),()=>{}),/已取消/);
 assert.equal(requests.length,refreshRequestCount+1);refreshHook=()=>{};
 // 分片迟到时不再发布进度或提交，并清理原生临时文件。
 account='account-a';written.length=0;const lateProgress=[];
 chunkHook=()=>{account='account-b'};responses.push(new Response('late-chunk'));
 await assert.rejects(()=>api.saveAttachment(seg,'switched-chunk',new AbortController(),n=>lateProgress.push(n)),/已取消/);
 chunkHook=()=>{};assert.deepEqual(lateProgress,[0]);
 assert.ok(calls.some(c=>c.command==='attachment_download_cancel'&&c.args.id==='switched-chunk'));
 assert.ok(!calls.some(c=>c.command==='attachment_download_commit'&&c.args.id==='switched-chunk'));
 // 媒体租约绑定创建时账号，后续 Range 不得换用新账号发起网络。
 account='account-a';const oldLease=await api.openMediaStream(seg,true);const oldChannel=channel;
 account='account-b';const oldLeaseRequests=requests.length;
 oldChannel.callback({kind:'request',id:'old-account-range',method:'GET',range:'bytes=0-1'});
 await waitFor(()=>calls.filter(c=>c.command==='media_stream_close'&&c.args.id===oldLease.id).length>=2);
 assert.equal(requests.length,oldLeaseRequests);
 assert.ok(!calls.some(c=>c.command==='media_response_chunk'&&c.options?.headers['x-media-request']==='old-account-range'));
 // cancelAll 只取消指定账号的任务；迟到响应不写盘，已保存文件不受影响。
 const pinia=require('pinia');pinia.setActivePinia(pinia.createPinia());
 const storeModule={exports:{}};
 const storeDependencies={vue:require('vue'),pinia,'@tauri-apps/api/core':dependencies['@tauri-apps/api/core'],'../services/auth':dependencies['../auth'],'../services/im/transfers':api};
 new Function('require','module','exports',ts.transpileModule(fs.readFileSync('src/stores/downloads.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>storeDependencies[id],storeModule,storeModule.exports);
 const store=storeModule.exports.useDownloadsStore();let releaseA,releaseB;
 responses.push(new Promise(resolve=>{releaseA=resolve}),new Promise(resolve=>{releaseB=resolve}));
 account='account-a';const taskA=store.start(seg).catch(error=>error);const requestA=requests.at(-1);
 account='account-b';written.length=0;const taskB=store.start(seg);const requestB=requests.at(-1);
 const cancelling=store.cancelAll('account-a');
 assert.ok(requestA.options.signal.aborted);assert.ok(!requestB.options.signal.aborted);
 releaseA(new Response('late-a'));await cancelling;await taskA;
 releaseB(new Response('new-b'));await taskB;
 const oldJob=Object.entries(store.jobs).find(([key])=>key.startsWith('account-a|'))[1];
 const newJob=store.jobFor(seg);assert.equal(oldJob.state,'cancelled');assert.equal(newJob.state,'done');
 const nativeCancelCount=calls.filter(c=>c.command==='attachment_download_cancel'&&c.args.id===newJob.id).length;
 await store.cancelAll();assert.equal(calls.filter(c=>c.command==='attachment_download_cancel'&&c.args.id===newJob.id).length,nativeCancelCount);
 console.log('下载与媒体流回归通过：分块原始IPC、背压边界、进度、取消/磁盘失败清理、401刷新、候选地址切换、Range206、租约账号绑定及退出取消隔离。');
})().catch(error=>{console.error(error);process.exitCode=1});
