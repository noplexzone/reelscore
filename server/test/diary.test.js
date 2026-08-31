process.env.DATA_DIR = `/tmp/rs-diary-${process.pid}`;
process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long"; process.env.NODE_ENV="test"; process.env.APP_MODE="self_hosted";
import test from "node:test"; import assert from "node:assert/strict";
const {db,runMigrations}=await import("../src/db.js"); const {insertWatch}=await import("../src/repositories/watch-repository.js"); const {updateDiaryEntry}=await import("../src/services/diary-service.js"); const {reconcileMovieEligibility}=await import("../src/services/scoring-service.js"); const {resolveDuplicateCase}=await import("../src/services/duplicate-service.js");
const movie=id=>({id,title:`F-${id}`,vote_average:7,runtime:120,genres:[],credits:{cast:[],crew:[]}});let n=0;const user=()=>Number(db.prepare("INSERT INTO users(username,password_hash,timezone) VALUES (?,'x','America/Chicago')").run(`u${process.pid}-${++n}`).lastInsertRowid);const watch=(u,id,at="2035-01-10T12:00:00.000Z",x={})=>insertWatch({userId:u,movie:movie(id),watchedAt:at,...x});
test("schema 14 is idempotent and audit append-only",()=>{runMigrations();runMigrations();const c=new Set(db.prepare("PRAGMA table_info(watches)").all().map(x=>x.name));for(const x of ["personal_rating","review","private_notes","favorite","tags_json","venue","visibility"])assert.ok(c.has(x));assert.equal(db.prepare("SELECT COUNT(*) c FROM schema_versions WHERE version=14").get().c,1);const u=user(),w=watch(u,1).id;db.prepare("INSERT INTO watch_annotation_audit(user_id,watch_id,changed_fields_json,before_json,after_json) VALUES (?,?,'[]','{}','{}')").run(u,w);assert.throws(()=>db.prepare("DELETE FROM watch_annotation_audit WHERE watch_id=?").run(w),/append-only/i)});
test("metadata normalization, audit, provider identity, and strict validation",async()=>{const u=user(),o=user(),w=watch(u,11,undefined,{source:"plex",providerService:"plex",providerConnectionId:"a",providerEventId:"e"});reconcileMovieEligibility(u,[11]);const identity=db.prepare("SELECT source,provider_service,provider_connection_id,provider_event_id FROM watches WHERE id=?").get(w.id);const r=await updateDiaryEntry(u,w.id,{personal_rating:87,review:"Good",private_notes:"Secret",favorite:true,tags:[" Noir ","drama","noir"],venue:"Home",visibility:"friends"});assert.deepEqual(r.tags,["drama","noir"]);assert.deepEqual(db.prepare("SELECT source,provider_service,provider_connection_id,provider_event_id FROM watches WHERE id=?").get(w.id),identity);assert.equal(db.prepare("SELECT COUNT(*) c FROM watch_annotation_audit WHERE watch_id=?").get(w.id).c,1);for(const b of [{nope:true},{personal_rating:101},{favorite:1},{visibility:"world"},{tags:"noir"},{watched_at_utc:"2035-01-10"}])await assert.rejects(updateDiaryEntry(u,w.id,b),e=>e.status===400);await assert.rejects(updateDiaryEntry(o,w.id,{favorite:true}),e=>e.status===404)});
test("date edit reconciles effective time and rolls back all fields on failure",async()=>{const u=user(),w=watch(u,13,"2035-03-20T12:00:00.000Z");reconcileMovieEligibility(u,[13]);const r=await updateDiaryEntry(u,w.id,{watched_at_utc:"2035-01-21T02:00:00.000Z",review:"Backdated"});assert.equal(r.watched_day_local,"2035-01-20");assert.equal(db.prepare("SELECT effective_at FROM score_events WHERE watch_id=? AND season_id IS NULL AND reversed_at IS NULL AND reverses_event_id IS NULL").get(w.id).effective_at,r.watched_at_utc);const x=watch(u,14,"2035-04-10T12:00:00.000Z");reconcileMovieEligibility(u,[14]);db.exec("CREATE TEMP TRIGGER diary_fail BEFORE INSERT ON score_events WHEN NEW.watch_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'forced diary failure'); END;");await assert.rejects(updateDiaryEntry(u,x.id,{watched_at_utc:"2035-04-11T12:00:00.000Z",review:"no"}),/forced diary/);db.exec("DROP TRIGGER diary_fail");assert.deepEqual(db.prepare("SELECT watched_at_utc,review FROM watches WHERE id=?").get(x.id),{watched_at_utc:"2035-04-10T12:00:00.000Z",review:null})});


test("database rejects noncanonical diary ratings and tags while canonical service output succeeds",async()=>{
  const u=user(),w=watch(u,21).id;
  for(const value of [1.5,"50"]) assert.throws(()=>db.prepare("UPDATE watches SET personal_rating=? WHERE id=?").run(value,w),/personal_rating|CHECK/i);
  const invalid=["1","{}","null",JSON.stringify(Array.from({length:21},(_,i)=>`t${String(i).padStart(2,"0")}`)),'["noir","noir"]','["Noir"]','[" noir"]',JSON.stringify(["x".repeat(31)]),'["z","a"]'];
  for(const tags of invalid) assert.throws(()=>db.prepare("UPDATE watches SET tags_json=? WHERE id=?").run(tags,w),/tags_json|CHECK|malformed JSON/i, tags);
  const result=await updateDiaryEntry(u,w,{personal_rating:50,tags:[" Noir ","drama","noir"]});
  assert.equal(result.personal_rating,50); assert.deepEqual(result.tags,["drama","noir"]);
});

test("annotation audit survives REPLACE and UPSERT and prevents later watch owner drift",async()=>{
  const u=user(),other=user(),w=watch(u,22).id;
  await updateDiaryEntry(u,w,{review:"kept"});
  const row=db.prepare("SELECT * FROM watch_annotation_audit WHERE watch_id=?").get(w);
  assert.throws(()=>db.prepare(`INSERT OR REPLACE INTO watch_annotation_audit
    (id,user_id,watch_id,changed_fields_json,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(row.id,u,w,'[]','{}','{}',row.created_at),/append-only/i);
  assert.throws(()=>db.prepare(`INSERT INTO watch_annotation_audit
    (id,user_id,watch_id,changed_fields_json,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET before_json=excluded.before_json`)
    .run(row.id,u,w,'[]','{}','{}',row.created_at),/append-only/i);
  assert.throws(()=>db.prepare("UPDATE watches SET user_id=? WHERE id=?").run(other,w),/dependent diary audit/i);
  assert.equal(db.prepare("SELECT user_id FROM watches WHERE id=?").get(w).user_id,u);
  assert.equal(db.prepare("SELECT before_json FROM watch_annotation_audit WHERE id=?").get(row.id).before_json,row.before_json);
});

test("no-op PATCH appends no audit row and audits only normalized fields that changed",async()=>{
  const u=user(),w=watch(u,23).id;
  await updateDiaryEntry(u,w,{review:" same ",favorite:false,tags:[]});
  assert.equal(db.prepare("SELECT COUNT(*) c FROM watch_annotation_audit WHERE watch_id=?").get(w).c,1);
  const fields=JSON.parse(db.prepare("SELECT changed_fields_json FROM watch_annotation_audit WHERE watch_id=?").get(w).changed_fields_json);
  assert.deepEqual(fields,["review"]);
  await updateDiaryEntry(u,w,{review:"same",favorite:false,tags:[],watched_at_utc:"2035-01-10T12:00:00.000Z"});
  assert.equal(db.prepare("SELECT COUNT(*) c FROM watch_annotation_audit WHERE watch_id=?").get(w).c,1);
});

test("provider-attested direct and canonical watch dates are read-only",async()=>{
  const u=user();
  const direct=watch(u,31,"2035-01-10T12:00:00.000Z",{source:"plex",providerService:"plex",providerConnectionId:"c",providerEventId:"direct"});
  await assert.rejects(updateDiaryEntry(u,direct.id,{watched_at_utc:"2035-01-11T12:00:00.000Z"}),e=>e.status===409&&/read-only/i.test(e.message));
  const canonical=watch(u,32,"2035-01-10T12:00:00.000Z");
  const proof=watch(u,32,"2035-01-10T12:05:00.000Z",{source:"plex",providerService:"plex",providerConnectionId:"c",providerEventId:"merged"});
  db.prepare("UPDATE watches SET deleted_at='2035-01-12T00:00:00.000Z',deleted_reason='duplicate_merged',logical_canonical_watch_id=? WHERE id=?").run(canonical.id,proof.id);
  db.prepare(`INSERT INTO duplicate_cases(user_id,fingerprint,canonical_watch_id,candidate_watch_id,evidence_json,status,resolution,resolved_at)
    VALUES (?,?,?,?,?,'resolved','merge','2035-01-12T00:00:00.000Z')`).run(u,"duplicate-v1:32:2035-01-10",canonical.id,proof.id,"{}");
  await assert.rejects(updateDiaryEntry(u,canonical.id,{watched_at_utc:"2035-01-11T12:00:00.000Z"}),e=>e.status===409&&/read-only/i.test(e.message));
  const placeholder=watch(u,33,"2035-01-10T12:00:00.000Z");
  const placeholderProof=watch(u,33,"2035-01-10T12:05:00.000Z",{source:"plex",providerService:"plex",providerConnectionId:"c",providerEventId:"placeholder"});
  db.prepare("UPDATE watches SET deleted_at='2035-01-12T00:00:00.000Z',deleted_reason='placeholder_reconciled',logical_canonical_watch_id=? WHERE id=?").run(placeholder.id,placeholderProof.id);
  await assert.rejects(updateDiaryEntry(u,placeholder.id,{watched_at_utc:"2035-01-11T12:00:00.000Z"}),e=>e.status===409&&/read-only/i.test(e.message));
});

test("manual date edits create, remove, and atomically roll back duplicate quarantine",async()=>{
  const u=user();
  const provider=watch(u,41,"2035-01-10T15:00:00.000Z",{source:"plex",providerService:"plex",providerConnectionId:"c",providerEventId:"dup"});
  const manual=watch(u,41,"2035-01-12T15:00:00.000Z");
  reconcileMovieEligibility(u,[41]);
  await updateDiaryEntry(u,manual.id,{watched_at_utc:"2035-01-10T16:00:00.000Z"});
  assert.equal(db.prepare("SELECT status FROM duplicate_cases WHERE candidate_watch_id=? AND cancelled_at IS NULL").get(provider.id).status,"pending");
  assert.equal(db.prepare("SELECT points FROM watches WHERE id=?").get(provider.id).points,0);
  await updateDiaryEntry(u,manual.id,{watched_at_utc:"2035-01-12T15:00:00.000Z"});
  assert.equal(db.prepare("SELECT COUNT(*) c FROM duplicate_cases WHERE candidate_watch_id=? AND status='pending' AND cancelled_at IS NULL").get(provider.id).c,0);
  assert.ok(db.prepare("SELECT points FROM watches WHERE id=?").get(provider.id).points>0);
  await updateDiaryEntry(u,manual.id,{watched_at_utc:"2035-01-10T16:00:00.000Z"});
  assert.equal(db.prepare("SELECT COUNT(*) c FROM duplicate_cases WHERE candidate_watch_id=? AND status='pending' AND cancelled_at IS NULL").get(provider.id).c,1);

  const rollbackManual=watch(u,42,"2035-01-12T15:00:00.000Z");
  watch(u,42,"2035-01-10T15:00:00.000Z",{source:"plex",providerService:"plex",providerConnectionId:"c",providerEventId:"rollback"});
  db.exec("CREATE TEMP TRIGGER duplicate_fail BEFORE INSERT ON duplicate_cases BEGIN SELECT RAISE(ABORT,'forced duplicate failure'); END;");
  await assert.rejects(updateDiaryEntry(u,rollbackManual.id,{watched_at_utc:"2035-01-10T16:00:00.000Z",review:"rollback"}),/forced duplicate/);
  db.exec("DROP TRIGGER duplicate_fail");
  assert.deepEqual(db.prepare("SELECT watched_at_utc,review FROM watches WHERE id=?").get(rollbackManual.id),{watched_at_utc:"2035-01-12T15:00:00.000Z",review:null});
});

function frozenSeason(u,{kind="finalized",start="2035-01-10T00:00:00.000Z",end="2035-02-01T00:00:00.000Z"}={}){
  const league=Number(db.prepare("INSERT INTO leagues(name,timezone,owner_user_id,created_by_user_id) VALUES ('Diary league','UTC',?,?)").run(u,u).lastInsertRowid);
  const membership=Number(db.prepare("INSERT INTO league_memberships(league_id,user_id,role,joined_at) VALUES (?,?,'admin','2024-01-01T00:00:00.000Z')").run(league,u).lastInsertRowid);
  const season=Number(db.prepare("INSERT INTO seasons(league_id,name,mode,timezone,rule_version,starts_at,ends_at,created_by_user_id) VALUES (?,'Frozen','casual','UTC','competition-v1',?,?,?)").run(league,start,end,u).lastInsertRowid);
  db.prepare("INSERT INTO season_members(season_id,membership_id,user_id,username_snapshot,eligible_from) SELECT ?,?,id,username,? FROM users WHERE id=?").run(season,membership,start,u);
  db.prepare("UPDATE seasons SET participants_locked_at=? WHERE id=?").run(start,season);
  if(kind==="cancelled") db.prepare("UPDATE seasons SET cancelled_at=? WHERE id=?").run("2034-12-01T00:00:00.000Z",season);
  else if(kind==="archived") db.prepare("UPDATE leagues SET archived_at='2035-02-04T00:00:00.000Z' WHERE id=?").run(league);
  return {league,season};
}

test("date edits reject indirect chronology changes in finalized, cancelled, and archived seasons",async()=>{
  for(const [index,kind] of ["finalized","cancelled","archived"].entries()){
    const u=user(),movieId=50+index;
    const inside=watch(u,movieId,"2035-01-15T12:00:00.000Z");
    const outside=watch(u,movieId,"2035-04-20T12:00:00.000Z");
    reconcileMovieEligibility(u,[movieId]);
    const frozen=frozenSeason(u,{kind});
    if(kind==="finalized"){
      const {reconcileSeasonScoresForUser}=await import("../src/services/season-scoring-service.js");
      reconcileSeasonScoresForUser(u,{seasonIds:[frozen.season]});
      db.prepare("UPDATE seasons SET finalized_at='2035-02-04T00:00:00.000Z' WHERE id=?").run(frozen.season);
    }
    await assert.rejects(updateDiaryEntry(u,outside.id,{watched_at_utc:"2035-01-05T12:00:00.000Z"}),e=>e.status===409&&/season/i.test(e.message));
    assert.equal(db.prepare("SELECT watched_at_utc FROM watches WHERE id=?").get(outside.id).watched_at_utc,"2035-04-20T12:00:00.000Z");
    assert.equal(db.prepare("SELECT eligibility_reason FROM watches WHERE id=?").get(inside.id).eligibility_reason,"canonical_first_watch");
  }
});



test("unrelated diary edits preserve active merged provider proof",async()=>{
  const u=user();
  const canonical=watch(u,61,"2035-01-10T15:00:00.000Z");
  const provider=watch(u,61,"2035-01-10T16:00:00.000Z",{source:"plex",providerService:"plex",providerConnectionId:"c",providerEventId:"proof"});
  const caseId=Number(db.prepare(`INSERT INTO duplicate_cases(user_id,fingerprint,canonical_watch_id,candidate_watch_id,evidence_json)
    VALUES (?,?,?,?,?)`).run(u,"duplicate-v1:61:2035-01-10",canonical.id,provider.id,"{}").lastInsertRowid);
  await resolveDuplicateCase(u,caseId,"merge");
  const unrelated=watch(u,61,"2035-04-10T15:00:00.000Z");
  await updateDiaryEntry(u,unrelated.id,{watched_at_utc:"2035-04-11T15:00:00.000Z"});
  assert.equal(db.prepare("SELECT cancelled_at FROM duplicate_cases WHERE id=?").get(caseId).cancelled_at,null);
  await assert.rejects(updateDiaryEntry(u,canonical.id,{watched_at_utc:"2035-01-11T15:00:00.000Z"}),e=>e.status===409&&/read-only/i.test(e.message));
});

test("manual date edits reject entry into an already-ended season",async()=>{
  const u=user();
  const outside=watch(u,62,"2025-03-10T12:00:00.000Z");
  reconcileMovieEligibility(u,[62]);
  frozenSeason(u,{kind:"ended",start:"2025-01-01T00:00:00.000Z",end:"2025-02-01T00:00:00.000Z"});
  await assert.rejects(updateDiaryEntry(u,outside.id,{watched_at_utc:"2025-01-15T12:00:00.000Z"}),e=>e.status===409&&/ended/i.test(e.message));
  assert.equal(db.prepare("SELECT watched_at_utc FROM watches WHERE id=?").get(outside.id).watched_at_utc,"2025-03-10T12:00:00.000Z");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM score_events WHERE watch_id=? AND season_id IS NOT NULL").get(outside.id).c,0);
});
