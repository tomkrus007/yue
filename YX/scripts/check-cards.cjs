const ts=require('typescript'),fs=require('fs'),assert=require('node:assert/strict');
const calls=[];let response={};
global.localStorage={getItem:()=>null};
const dependencies={
 'adaptivecards-templating':require('adaptivecards-templating'),
 '../config':{getServerPaths:()=>({uamApiUri:'https://trusted.example/api',cardUri:'https://trusted.example/cards'})},
 '../auth':{authService:{getAccessToken:()=> 'test-token'}},
 '../http':{httpJson:async(url,options)=>{calls.push({url,options});return response},postForm:async(url,params,options)=>{calls.push({url,params,options});return response},httpArrayBuffer:async()=>new ArrayBuffer(0)},
};
const m={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync('src/services/im/cards.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>dependencies[id],m,m.exports);
(async()=>{
 const c=m.exports;
 assert.throws(()=>c.cardHttpUrl('javascript:alert(1)'));assert.throws(()=>c.cardHttpUrl('https://u:p@host/'));
 await c.queryCard('https://external.example/');assert.equal(calls.at(-1).options.token,'');
 await c.queryCard('https://trusted.example/');assert.equal(calls.at(-1).options.token,'test-token');
 response={data:{template:JSON.stringify({type:'AdaptiveCard',body:[{type:'TextBlock',text:'${name}'}]})}};
 const card=await c.loadCard({templateId:'a/b',data:{name:'测试'}});assert.equal(card.body[0].text,'测试');assert.match(calls.at(-1).url,/a%2Fb\?terminalType=4$/);
 response={};await c.submitCard({url:'https://external.example/submit',method:'POST',params:{id:1}});assert.equal(calls.at(-1).options.token,'');assert.deepEqual(calls.at(-1).options.body,{id:1});
 await c.submitCard({url:'https://trusted.example/submit',method:'POST',contentType:'application/x-www-form-urlencoded',params:{id:1}});assert.equal(calls.at(-1).options.token,'test-token');
 await assert.rejects(()=>c.submitCard({url:'https://trusted.example/',method:'EVAL'}));
 await assert.rejects(()=>c.submitCard({url:'https://trusted.example/',method:'POST',params:'bad'}));
 response={success:false,message:'业务失败'};await assert.rejects(()=>c.submitCard({url:'https://trusted.example/',method:'POST'}),/业务失败/);
 response={code:500,message:'服务故障'};await assert.rejects(()=>c.queryCard('https://trusted.example/'),/服务故障/);
 await assert.rejects(()=>c.submitCard({url:'https://trusted.example/',method:'POST'}),/服务故障/);
 response={code:0};await c.queryCard('https://trusted.example/');
 await c.submitCard({url:'https://trusted.example/find?existing=1',method:'GET',params:{title:'中文 & x'}});
 const target=new URL(calls.at(-1).url);assert.equal(target.searchParams.get('title'),'中文 & x');assert.equal(target.searchParams.get('existing'),'1');
 const disabled=c.disableCardActions({body:[{type:'ActionSet',actions:[{type:'Action.Submit'}]},{type:'Container',selectAction:{type:'Action.Submit'},items:[{type:'Input.Text',inlineAction:{type:'Action.Submit'}}]}],actions:[{}]});
 assert(!JSON.stringify(disabled).includes('Action.Submit'));
 const blobs=[];const prepared=await c.cardImages({body:[{type:'Image',url:'https://external.example/p.png'}],backgroundImage:'https://external.example/bg.png',actions:[{type:'Action.OpenUrl',iconUrl:'https://external.example/icon.png'}]},blobs);
 assert.match(prepared.body[0].url,/^blob:/);assert.equal(prepared.backgroundImage,undefined);assert.equal(prepared.actions[0].iconUrl,undefined);assert.equal(blobs.length,1);
 for(const url of blobs) URL.revokeObjectURL(url);
 const rejected=await c.cardImages({type:'Image',url:'javascript:alert(1)'},[]);assert.equal(rejected.type,'TextBlock');assert.equal(rejected.url,undefined);
 const business={type:'Image',url:'https://business.example/id',params:{actions:[{type:'Image',url:'https://business.example/p'}],selectAction:'业务字段'},actions:['业务字段']};
 const withData={type:'AdaptiveCard',body:[{type:'Input.Text',value:business}],actions:[{type:'Action.Submit',data:business}]};
 const dataImages=await c.cardImages(withData,[]);assert.deepEqual(dataImages.actions[0].data,business);assert.deepEqual(dataImages.body[0].value,business);
 const inactive=c.disableCardActions({type:'AdaptiveCard',body:[{type:'Input.Text',value:business},{type:'Container',data:business,actions:[{}]}]});assert.deepEqual(inactive.body[0].value,business);assert.deepEqual(inactive.body[1].data,business);assert.equal(inactive.body[1].actions,undefined);
 console.log('卡片协议离线回归通过');
})().catch(e=>{console.error(e);process.exitCode=1});
