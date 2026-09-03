process.env.DATA_DIR=`/tmp/rs-letterboxd-http-${process.pid}`;
process.env.SESSION_SECRET="test-secret-that-is-at-least-32-chars-long";
process.env.NODE_ENV="test"; process.env.APP_MODE="self_hosted"; process.env.TMDB_API_KEY="test-key";
import test,{before,after} from "node:test"; import assert from "node:assert/strict"; import {createServer} from "node:http";
import {startTestServer,parseCookies} from "./helpers/server.js";
const wh="Date,Name,Year,Letterboxd URI"; let tmdb,server,owner,other;
const movie={id:603,title:"The Matrix",original_title:"The Matrix",release_date:"1999-03-30",runtime:136,vote_average:8.2,poster_path:null,genres:[],belongs_to_collection:null,credits:{cast:[],crew:[]}};
async function register(username){const r=await fetch(`${server.base}/api/auth/register`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username,password:"a sufficiently long password"})}); const body=await r.json(),cookies=parseCookies(r); return {csrf:body.csrf_token,cookie:Object.entries(cookies).map(([k,v])=>`${k}=${v}`).join("; ")};}
function form(parts){const f=new FormData();for(const [field,name,type,content] of parts)f.append(field,new Blob([content],{type}),name);return f;}
function req(path,account,{method="GET",body,csrf=true}={}){return fetch(server.base+path,{method,headers:{...(account?{cookie:account.cookie}:{}),...(account&&csrf?{"x-csrf-token":account.csrf}:{}),...(body&&! (body instanceof FormData)?{"content-type":"application/json"}:{})},body:body instanceof FormData?body:body===undefined?undefined:JSON.stringify(body)});}
before(async()=>{tmdb=createServer((request,response)=>{const u=new URL(request.url,"http://x");response.setHeader("content-type","application/json");if(u.pathname==="/search/movie"){assert.equal(u.searchParams.get("primary_release_year"),"1999");return response.end(JSON.stringify({results:[movie]}));}if(u.pathname==="/movie/603")return response.end(JSON.stringify(movie));response.statusCode=404;response.end("{}");});await new Promise(r=>tmdb.listen(0,"127.0.0.1",r));process.env.TMDB_BASE_URL=`http://127.0.0.1:${tmdb.address().port}`;server=await startTestServer();owner=await register("httpimport");other=await register("httpother");});
after(async()=>{if(server)await server.close();if(tmdb)await new Promise(r=>tmdb.close(r));});

test("preview requires auth and CSRF and accepts only strict named CSV multipart",async()=>{
 const valid=()=>form([["watched","watched.csv","text/csv",`${wh}\r\n2026-09-01,The Matrix,1999,https://letterboxd.com/film/the-matrix/\r\n`]]);
 assert.equal((await req("/api/imports/letterboxd/preview",null,{method:"POST",body:valid()})).status,401);
 assert.equal((await req("/api/imports/letterboxd/preview",owner,{method:"POST",body:valid(),csrf:false})).status,403);
 for(const parts of [[],[["wrong","watched.csv","text/csv",`${wh}\n`]],[["watched","bad.csv","text/csv",`${wh}\n`]],[["watched","watched.csv","application/json",`${wh}\n`]],[["watched","watched.csv","text/csv",`${wh}\n`],["watched","watched.csv","text/csv",`${wh}\n`]],[["diary","diary.csv","text/csv","x"],["watched","watched.csv","text/csv","x"],["extra","watched.csv","text/csv","x"]]]){const r=await req("/api/imports/letterboxd/preview",owner,{method:"POST",body:form(parts)});assert.equal(r.status,400,`${JSON.stringify(parts.map(p=>p.slice(0,3)))} => ${r.status}`);assert.deepEqual(Object.keys(await r.json()),["error"]);}
 const huge=form([["watched","watched.csv","text/csv",Buffer.alloc(2*1024*1024+1,97)]]);assert.equal((await req("/api/imports/letterboxd/preview",owner,{method:"POST",body:huge})).status,413);
});

test("preview/get/commit routes preserve owner isolation, safe errors, and idempotent replay",async()=>{
 const previewResponse=await req("/api/imports/letterboxd/preview",owner,{method:"POST",body:form([["watched","watched.csv","text/csv",`${wh}\n2026-09-01,The Matrix,1999,https://letterboxd.com/film/the-matrix/\n`]])});const text=await previewResponse.text();assert.equal(previewResponse.status,200,text);const preview=JSON.parse(text);
 assert.equal((await req(`/api/imports/letterboxd/${preview.job_id}`,other)).status,404);
 const got=await req(`/api/imports/letterboxd/${preview.job_id}`,owner);const gotText=await got.text();assert.equal(got.status,200,gotText);assert.equal(gotText.includes(preview.commit_token),false);
 for(const body of [null,{}, {token:preview.commit_token,decisions:"bad"}]){const r=await req(`/api/imports/letterboxd/${preview.job_id}/commit`,owner,{method:"POST",body});assert.equal(r.status,400);assert.deepEqual(Object.keys(await r.json()),["error"]);}
 const body={token:preview.commit_token,decisions:[]};const committed=await req(`/api/imports/letterboxd/${preview.job_id}/commit`,owner,{method:"POST",body});const result=await committed.json();assert.equal(committed.status,200);assert.equal(result.counts.imported,1);
 const replay=await req(`/api/imports/letterboxd/${preview.job_id}/commit`,owner,{method:"POST",body});assert.equal(replay.status,200);assert.deepEqual(await replay.json(),result);
 const bad=await req(`/api/imports/letterboxd/${preview.job_id}/commit`,owner,{method:"POST",body:{token:"different",decisions:[]}});assert.equal(bad.status,409);assert.deepEqual(Object.keys(await bad.json()),["error"]);
});
