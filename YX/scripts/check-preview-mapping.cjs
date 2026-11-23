const ts=require('typescript'),fs=require('fs'),assert=require('node:assert/strict');
const m={exports:{}};
new Function('require','module','exports',ts.transpileModule(fs.readFileSync('src/services/im/preview-mapping.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true,target:ts.ScriptTarget.ES2022}}).outputText)(require,m,m.exports);
const {previewMapping,mapPreviewUrl,createPreviewMappingCache}=m.exports;
(async()=>{
 const mapping=previewMapping("{ReplaceRequestUri:{'https://old.example/':'https://new.example/'},}");
 assert.equal(new URL(mapPreviewUrl('https://preview.example/?furl='+encodeURIComponent('https://old.example/a?x=1'),mapping)).searchParams.get('furl'),'https://new.example/a?x=1');
 assert.equal(mapPreviewUrl('https://preview.example/',mapping),'https://preview.example/');
 // 官方对页面地址与 furl 都做 ReplaceRequestUri 前缀映射；页面地址映射后 furl 保持原样。
 const pageMapping={'https://store/':'https://store.example.com/store/'};
 const page=mapPreviewUrl('https://store/preview/view?furl='+encodeURIComponent('https://store.example.com/store/getFile?fileId=a'),pageMapping);
 assert.equal(page,'https://store.example.com/store/preview/view?furl=https%3A%2F%2Fstore.example.com%2Fstore%2FgetFile%3FfileId%3Da');
 // 改写 furl 不会改变它自身的编码层数（服务端双编码时保持双编码）。
 const doubled=mapPreviewUrl('https://store/preview/error?furl=https%253A%252F%252Fx%252Fa',pageMapping);
 assert.equal(doubled,'https://store.example.com/store/preview/error?furl=https%253A%252F%252Fx%252Fa');
 for(const value of [null,'bad',{}, {ReplaceRequestUri:{'https://a/':'javascript:alert(1)'}},{ReplaceRequestUri:{'https://a/':'https://user:pass@host/'}}]) assert.deepEqual(previewMapping(value),{});
 assert.throws(()=>mapPreviewUrl('https://user:pass@host/',{}));
 const cache=createPreviewMappingCache();let calls=0;
 const load=async()=>{calls++;return{ReplaceRequestUri:mapping}};
 await Promise.all([cache('account1/company1',load),cache('account1/company1',load)]);assert.equal(calls,1);
 await cache('account2/company1',load);await cache('account1/company2',load);assert.equal(calls,3);
 assert.deepEqual(await cache('failure',async()=>{throw Error('offline')}),{});
 await cache('failure',load);assert.equal(calls,4);
 console.log('预览映射离线回归通过');
})().catch(e=>{console.error(e);process.exitCode=1});
