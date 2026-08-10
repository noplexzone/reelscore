process.env.DATA_DIR = `/tmp/rs-seasons-${process.pid}`;
process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";
process.env.NODE_ENV = "test";
process.env.APP_MODE = "self_hosted";
import { test } from "node:test";
import assert from "node:assert/strict";
const { db } = await import("../src/db.js");
const { createLeague, setMemberRole, archiveLeague } = await import("../src/services/league-service.js");
const { createSeason, updateScheduledSeason, cancelScheduledSeason, materializeSeasonState, materializeSeasonForActor, finalizeSeason, listSeasons, getSeason } = await import("../src/services/season-service.js");
let seq = 0;
const error = (code, pattern=/.*/) => (e) => e?.status === code && pattern.test(e.message);
function user(role="user") { seq++; return Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES (?,'x',?)").run(`season-user-${seq}`,role).lastInsertRowid); }
function fixture(timezone="UTC", member=true) {
  const ownerId=user(); const league=createLeague(ownerId,{name:`League ${seq}`,timezone,default_mode:"casual"}); let memberId=null;
  if(member){ memberId=user(); const now=new Date().toISOString(); db.prepare("INSERT INTO league_memberships(league_id,user_id,role,joined_at,created_at) VALUES (?,?,'member',?,?)").run(league.id,memberId,now,now); }
  return {ownerId,memberId,league};
}
const input=(x={})=>({name:"Cinema Year",start_date:"2098-01-01",end_date:"2098-02-01",mode:"casual",rule_version:"season-v1",...x});
function safe(v){const s=JSON.stringify(v); for(const k of ["membership_id","password_hash","email_normalized","evidence_json"]) assert.equal(s.includes(`\"${k}\"`),false,k);}

test("DST-safe future local dates become exact canonical midnight boundaries",()=>{
  const {ownerId,league}=fixture("America/New_York");
  const spring=createSeason(ownerId,league.id,input({name:"Spring",start_date:"2099-03-08",end_date:"2099-03-09"}));
  assert.equal(spring.starts_at,"2099-03-08T05:00:00.000Z"); assert.equal(spring.ends_at,"2099-03-09T04:00:00.000Z"); assert.equal(spring.timezone,"America/New_York");
  cancelScheduledSeason(ownerId,spring.id,{asOf:"2099-01-01T00:00:00.000Z"});
  const fall=createSeason(ownerId,league.id,input({name:"Fall",start_date:"2099-11-01",end_date:"2099-11-02"}));
  assert.equal(fall.starts_at,"2099-11-01T04:00:00.000Z"); assert.equal(fall.ends_at,"2099-11-02T05:00:00.000Z");
});

test("creation validates exact inputs, future dates, modes, snapshots, and half-open non-overlap",()=>{
  const {ownerId,league}=fixture("Europe/London"); const season=createSeason(ownerId,league.id,input({mode:"challenge"}));
  assert.equal(season.mode,"challenge"); assert.equal(season.rule_version,"season-v1"); assert.equal(season.timezone,"Europe/London");
  for(const bad of [input({start_date:"2098-1-01"}),input({start_date:"2098-02-30"}),input({end_date:"2098-01-01"}),input({mode:"ranked"}),input({rule_version:" "}),{...input(),timezone:"UTC"},{...input(),status:"active"}]) assert.throws(()=>createSeason(ownerId,league.id,bad),error(400));
  assert.throws(()=>createSeason(ownerId,league.id,input({name:"Overlap",start_date:"2098-01-15",end_date:"2098-03-01"})),error(409,/overlap/i));
  assert.equal(createSeason(ownerId,league.id,input({name:"Adjacent",start_date:"2098-02-01",end_date:"2098-03-01"})).starts_at,season.ends_at);
  const f=fixture("UTC",false); assert.throws(()=>createSeason(f.ownerId,f.league.id,input({start_date:"2020-01-01",end_date:"2020-02-01"})),error(400,/future/i));
  const broken=fixture("UTC",false); db.prepare("UPDATE leagues SET timezone='Not/A_Zone' WHERE id=?").run(broken.league.id);
  assert.throws(()=>createSeason(broken.ownerId,broken.league.id,input()),error(400,/timezone/i));
});

test("owner/admin manage seasons; members, outsiders, and global admins have no override",()=>{
  const {ownerId,memberId,league}=fixture(); const outsider=user(), globalAdmin=user("admin");
  assert.throws(()=>createSeason(memberId,league.id,input()),error(403)); assert.throws(()=>createSeason(outsider,league.id,input()),error(404)); assert.throws(()=>createSeason(globalAdmin,league.id,input()),error(404));
  setMemberRole(ownerId,league.id,memberId,"admin"); const season=createSeason(memberId,league.id,input()); assert.equal(getSeason(ownerId,season.id).id,season.id);
  assert.throws(()=>getSeason(outsider,season.id),error(404)); assert.throws(()=>getSeason(globalAdmin,season.id),error(404));
});

test("manager authorization covers update, cancel, materialize, and finalize",()=>{
  const {ownerId,memberId,league}=fixture(); const regular=user(); const joined=new Date().toISOString();
  db.prepare("INSERT INTO league_memberships(league_id,user_id,role,joined_at,created_at) VALUES (?,?,'member',?,?)").run(league.id,regular,joined,joined);
  setMemberRole(ownerId,league.id,memberId,"admin");
  const cancelled=createSeason(memberId,league.id,input({name:"Admin Cancel"}));
  assert.equal(updateScheduledSeason(memberId,cancelled.id,{name:"Admin Edited"}).name,"Admin Edited");
  assert.throws(()=>cancelScheduledSeason(regular,cancelled.id,{asOf:"2097-01-01T00:00:00.000Z"}),error(403));
  assert.equal(cancelScheduledSeason(memberId,cancelled.id,{asOf:"2097-01-01T00:00:00.000Z"}).status,"cancelled");
  const season=createSeason(memberId,league.id,input({name:"Admin Finalize"}));
  assert.throws(()=>materializeSeasonForActor(regular,season.id,{asOf:season.starts_at}),error(403));
  assert.equal(materializeSeasonForActor(memberId,season.id,{asOf:season.starts_at}).status,"active");
  assert.throws(()=>finalizeSeason(regular,season.id,{asOf:"2098-02-04T00:00:00.000Z"}),error(403));
  assert.equal(finalizeSeason(memberId,season.id,{asOf:"2098-02-04T00:00:00.000Z"}).status,"finalized");
});

test("archived leagues are historical read-only season records",()=>{
  const {ownerId,league}=fixture(); const season=createSeason(ownerId,league.id,input()); archiveLeague(ownerId,league.id);
  assert.equal(getSeason(ownerId,season.id).id,season.id);
  assert.throws(()=>createSeason(ownerId,league.id,input({name:"No New",start_date:"2098-03-01",end_date:"2098-04-01"})),error(409,/read-only/i));
  assert.throws(()=>updateScheduledSeason(ownerId,season.id,{name:"No Edit"}),error(409,/read-only/i));
  assert.throws(()=>cancelScheduledSeason(ownerId,season.id,{asOf:"2097-01-01T00:00:00.000Z"}),error(409,/read-only/i));
  assert.throws(()=>materializeSeasonState(season.id,{asOf:season.starts_at}),error(409,/read-only/i));
  assert.throws(()=>finalizeSeason(ownerId,season.id,{asOf:"2098-02-04T00:00:00.000Z"}),error(409,/read-only/i));
});

test("scheduled partial edits preserve future/non-overlap and stop at snapshot",()=>{
  const {ownerId,league}=fixture(); const first=createSeason(ownerId,league.id,input()); createSeason(ownerId,league.id,input({name:"Later",start_date:"2098-03-01",end_date:"2098-04-01"}));
  const edited=updateScheduledSeason(ownerId,first.id,{name:"Edited",end_date:"2098-02-15",mode:"verified",rule_version:"season-v2"}); assert.equal(edited.name,"Edited"); assert.equal(edited.mode,"verified");
  assert.throws(()=>updateScheduledSeason(ownerId,first.id,{end_date:"2098-03-02"}),error(409,/overlap/i)); assert.throws(()=>updateScheduledSeason(ownerId,first.id,{}),error(400)); assert.throws(()=>updateScheduledSeason(ownerId,first.id,{status:"active"}),error(400));
  materializeSeasonState(first.id,{asOf:first.starts_at}); assert.throws(()=>updateScheduledSeason(ownerId,first.id,{name:"Late"}),error(409,/started|snapshot/i)); assert.throws(()=>cancelScheduledSeason(ownerId,first.id,{asOf:"2097-01-01T00:00:00.000Z"}),error(409,/snapshot/i));
});

test("materialization snapshots strict pre-start episodes, username, cutoff, and excludes start/late joins",()=>{
  const {ownerId,memberId,league}=fixture(); const departed=user(), atStart=user(), late=user(); const season=createSeason(ownerId,league.id,input());
  const add=db.prepare("INSERT INTO league_memberships(league_id,user_id,role,joined_at,left_at,created_at) VALUES (?,?,'member',?,?,?)");
  add.run(league.id,departed,"2097-01-01T00:00:00.000Z","2098-01-15T00:00:00.000Z","2097-01-01T00:00:00.000Z"); add.run(league.id,atStart,season.starts_at,null,season.starts_at); add.run(league.id,late,"2098-01-02T00:00:00.000Z",null,"2098-01-02T00:00:00.000Z");
  db.prepare("UPDATE users SET username='snapshot-name' WHERE id=?").run(memberId); const active=materializeSeasonState(season.id,{asOf:season.starts_at});
  assert.equal(active.status,"active"); assert.equal(active.participants_locked_at,season.starts_at); assert.deepEqual(new Set(active.participants.map(p=>p.user_id)),new Set([ownerId,memberId,departed]));
  assert.equal(active.participants.find(p=>p.user_id===memberId).username,"snapshot-name"); assert.equal(active.participants.find(p=>p.user_id===departed).eligible_until,"2098-01-15T00:00:00.000Z"); safe(active);
  assert.deepEqual(materializeSeasonState(season.id,{asOf:"2098-01-02T00:00:00.000Z"}),active);
});

test("departure cutoff stays on original episode; rejoin never reactivates participant",()=>{
  const {ownerId,memberId,league}=fixture(); const season=createSeason(ownerId,league.id,input()); materializeSeasonState(season.id,{asOf:season.starts_at});
  const original=db.prepare("SELECT id FROM league_memberships WHERE league_id=? AND user_id=? AND left_at IS NULL").get(league.id,memberId); const cutoff="2098-01-10T00:00:00.000Z";
  db.prepare("UPDATE season_members SET eligible_until=? WHERE season_id=? AND membership_id=?").run(cutoff,season.id,original.id); db.prepare("UPDATE league_memberships SET left_at=? WHERE id=?").run(cutoff,original.id);
  db.prepare("INSERT INTO league_memberships(league_id,user_id,role,joined_at,created_at) VALUES (?,?,'member',?,?)").run(league.id,memberId,"2098-01-11T00:00:00.000Z","2098-01-11T00:00:00.000Z");
  assert.equal(getSeason(ownerId,season.id,{asOf:"2098-01-12T00:00:00.000Z"}).participants.find(p=>p.user_id===memberId).eligible_until,cutoff); assert.equal(db.prepare("SELECT COUNT(*) c FROM season_members WHERE season_id=? AND user_id=?").get(season.id,memberId).c,1);
});

test("lazy lifecycle observes exact [start,end), cancellation is replay-safe",()=>{
  const {ownerId,league}=fixture(); const season=createSeason(ownerId,league.id,input());
  assert.equal(getSeason(ownerId,season.id,{asOf:"2097-12-31T23:59:59.999Z"}).status,"scheduled"); assert.equal(getSeason(ownerId,season.id,{asOf:season.starts_at}).status,"active"); assert.equal(getSeason(ownerId,season.id,{asOf:"2098-01-31T23:59:59.999Z"}).status,"active"); assert.equal(getSeason(ownerId,season.id,{asOf:season.ends_at}).status,"finalizing");
  const next=createSeason(ownerId,league.id,input({name:"Cancel",start_date:"2098-02-01",end_date:"2098-03-01"})); const cancelled=cancelScheduledSeason(ownerId,next.id,{asOf:"2097-12-01T00:00:00.000Z"}); assert.equal(cancelled.status,"cancelled"); assert.deepEqual(cancelScheduledSeason(ownerId,next.id,{asOf:"2100-01-01T00:00:00.000Z"}),cancelled);
  const started=createSeason(ownerId,league.id,input({name:"Started",start_date:"2098-02-01",end_date:"2098-03-01"})); assert.throws(()=>cancelScheduledSeason(ownerId,started.id,{asOf:started.starts_at}),error(409,/started/i));
});

test("finalization materializes, enforces 72h and pending participant duplicate blocker, then freezes replay",()=>{
  const {ownerId,memberId,league}=fixture(); const season=createSeason(ownerId,league.id,input()); assert.throws(()=>finalizeSeason(ownerId,season.id,{asOf:"2098-02-03T23:59:59.999Z"}),error(409,/72/));
  const a=Number(db.prepare("INSERT INTO watches(user_id,tmdb_id,title,points,watched_at,watched_at_utc) VALUES (?,1,'A',0,'2098-01-10 00:00:00','2098-01-10T00:00:00.000Z')").run(memberId).lastInsertRowid); const b=Number(db.prepare("INSERT INTO watches(user_id,tmdb_id,title,points,watched_at,watched_at_utc) VALUES (?,1,'B',0,'2098-01-11 00:00:00','2098-01-11T00:00:00.000Z')").run(memberId).lastInsertRowid);
  const d=Number(db.prepare("INSERT INTO duplicate_cases(user_id,fingerprint,canonical_watch_id,candidate_watch_id,created_at) VALUES (?,?,?,?,?)").run(memberId,`dup-${seq}`,a,b,"2098-01-11T00:00:00.000Z").lastInsertRowid); assert.throws(()=>finalizeSeason(ownerId,season.id,{asOf:"2098-02-04T00:00:00.000Z"}),error(409,/duplicate/i));
  db.prepare("UPDATE duplicate_cases SET status='resolved',resolution='keep_both',resolved_at=? WHERE id=?").run("2098-02-03T00:00:00.000Z",d); const final=finalizeSeason(ownerId,season.id,{asOf:"2098-02-04T00:00:00.000Z"}); assert.equal(final.status,"finalized"); assert.ok(final.participants_locked_at); assert.deepEqual(finalizeSeason(ownerId,season.id,{asOf:"2100-01-01T00:00:00.000Z"}),final);
});

test("finalization ignores duplicate cases outside participant and creation cutoffs",()=>{
  const {ownerId,memberId,league}=fixture(); const season=createSeason(ownerId,league.id,input()); materializeSeasonState(season.id,{asOf:season.starts_at});
  const cutoff="2098-01-10T00:00:00.000Z"; const membership=db.prepare("SELECT membership_id FROM season_members WHERE season_id=? AND user_id=?").get(season.id,memberId);
  db.prepare("UPDATE season_members SET eligible_until=? WHERE season_id=? AND user_id=?").run(cutoff,season.id,memberId); db.prepare("UPDATE league_memberships SET left_at=? WHERE id=?").run(cutoff,membership.membership_id);
  const addWatch=(title,watched)=>Number(db.prepare("INSERT INTO watches(user_id,tmdb_id,title,points,watched_at,watched_at_utc) VALUES (?,9,?,0,?,?)").run(memberId,title,watched.replace('T',' ').slice(0,19),watched).lastInsertRowid);
  const afterA=addWatch("After A","2098-01-20T00:00:00.000Z"), afterB=addWatch("After B","2098-01-21T00:00:00.000Z");
  db.prepare("INSERT INTO duplicate_cases(user_id,fingerprint,canonical_watch_id,candidate_watch_id,created_at) VALUES (?,?,?,?,?)").run(memberId,`after-cutoff-${seq}`,afterA,afterB,"2098-01-21T00:00:00.000Z");
  const inA=addWatch("Late A","2098-01-05T00:00:00.000Z"), inB=addWatch("Late B","2098-01-06T00:00:00.000Z");
  db.prepare("INSERT INTO duplicate_cases(user_id,fingerprint,canonical_watch_id,candidate_watch_id,created_at) VALUES (?,?,?,?,?)").run(memberId,`late-case-${seq}`,inA,inB,"2098-02-01 12:00:00");
  assert.equal(finalizeSeason(ownerId,season.id,{asOf:"2098-02-04T00:00:00.000Z"}).status,"finalized");
});

test("scored seasons fail closed until projection reconciliation is available",()=>{
  const {ownerId,league}=fixture(); const season=createSeason(ownerId,league.id,input()); materializeSeasonState(season.id,{asOf:season.starts_at});
  const at="2098-01-10T00:00:00.000Z";
  db.prepare("INSERT INTO score_events(event_key,user_id,category,points,rule_version,metadata_json,created_at,effective_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(`projection-gate-${seq}`,ownerId,"watch_first",10,"test-v1","{}",at,at);
  assert.throws(()=>finalizeSeason(ownerId,season.id,{asOf:"2098-02-04T00:00:00.000Z"}),error(409,/projection/i));
  assert.equal(db.prepare("SELECT finalized_at FROM seasons WHERE id=?").get(season.id).finalized_at,null);
});

test("concurrent finalization is replay-safe and records one immutable timestamp",async()=>{
  const {ownerId,league}=fixture(); const season=createSeason(ownerId,league.id,input());
  const asOf="2098-02-04T00:00:00.000Z"; const {spawn}=await import("node:child_process");
  const source="const {finalizeSeason}=await import('./src/services/season-service.js');finalizeSeason(Number(process.argv[1]),Number(process.argv[2]),{asOf:process.argv[3]})";
  const run=()=>new Promise(resolve=>{const p=spawn(process.execPath,["--input-type=module","-e",source,String(ownerId),String(season.id),asOf],{cwd:process.cwd(),env:process.env,stdio:["ignore","ignore","pipe"]});let e="";p.stderr.on("data",x=>e+=x);p.on("close",code=>resolve({code,e}));});
  const results=await Promise.all([run(),run()]); assert.deepEqual(results.map(x=>x.code),[0,0],results.map(x=>x.e).join("\n"));
  assert.equal(db.prepare("SELECT finalized_at FROM seasons WHERE id=?").get(season.id).finalized_at,asOf);
});

test("private list/read, strict IDs/options, safe DTOs, and concurrent materialization",async()=>{
  const {ownerId,memberId,league}=fixture(); const outsider=user(); const season=createSeason(ownerId,league.id,input());
  assert.deepEqual(listSeasons(outsider,league.id),[]); assert.throws(()=>getSeason(outsider,season.id),error(404)); for(const id of ["1",0,-1,1.2,NaN,Infinity]) assert.throws(()=>getSeason(ownerId,id),error(400)); assert.throws(()=>getSeason(ownerId,season.id,{asOf:season.starts_at,x:1}),error(400));
  const {spawn}=await import("node:child_process"); const source="const {materializeSeasonState}=await import('./src/services/season-service.js');materializeSeasonState(Number(process.argv[1]),{asOf:process.argv[2]})";
  const run=()=>new Promise(resolve=>{const p=spawn(process.execPath,["--input-type=module","-e",source,String(season.id),season.starts_at],{cwd:process.cwd(),env:process.env,stdio:["ignore","ignore","pipe"]});let e="";p.stderr.on("data",x=>e+=x);p.on("close",code=>resolve({code,e}));}); const rs=await Promise.all([run(),run()]); assert.deepEqual(rs.map(x=>x.code),[0,0],rs.map(x=>x.e).join("\n"));
  const dto=getSeason(ownerId,season.id,{asOf:season.starts_at}); assert.equal(dto.participants.length,2); assert.equal(listSeasons(memberId,league.id,{asOf:season.starts_at})[0].status,"active"); safe(dto);
});

test("HTTP routes enforce auth, CSRF, private scope and strict IDs",async()=>{
  const {createServer}=await import("node:http"); const {createSession}=await import("../src/auth.js"); const {createApp}=await import("../src/index.js"); const {ownerId,league}=fixture("UTC",false); const outsider=user(); const os=createSession(ownerId,{ip:"127.0.0.1"}), xs=createSession(outsider,{ip:"127.0.0.1"}); const server=createServer(createApp()); await new Promise(r=>server.listen(0,"127.0.0.1",r)); const base=`http://127.0.0.1:${server.address().port}`, auth={Cookie:`session=${os.token}`};
  try{let r=await fetch(`${base}/api/leagues/${league.id}/seasons`);assert.equal(r.status,401);r=await fetch(`${base}/api/leagues/${league.id}/seasons`,{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify(input())});assert.equal(r.status,403);r=await fetch(`${base}/api/leagues/${league.id}/seasons`,{method:"POST",headers:{...auth,"X-CSRF-Token":os.csrfToken,"Content-Type":"application/json"},body:JSON.stringify(input())});assert.equal(r.status,201);const s=(await r.json()).season;safe(s);r=await fetch(`${base}/api/leagues/${league.id}/seasons/${s.id}`,{headers:{Cookie:`session=${xs.token}`}});assert.equal(r.status,404);r=await fetch(`${base}/api/leagues/${league.id}/seasons/${s.id}/materialize`,{method:"POST",headers:{...auth,"X-CSRF-Token":os.csrfToken,"Content-Type":"application/json"},body:JSON.stringify({asOf:s.starts_at})});assert.equal(r.status,400);r=await fetch(`${base}/api/leagues/${league.id}/seasons/${s.id}/materialize`,{method:"POST",headers:{...auth,"X-CSRF-Token":os.csrfToken}});assert.equal(r.status,409); for(const id of ["01","+1","1e0","bad"]){r=await fetch(`${base}/api/leagues/${league.id}/seasons/${id}`,{headers:auth});assert.equal(r.status,400);}}
  finally{await new Promise((r,j)=>server.close(e=>e?j(e):r()));}
});
