process.env.DATA_DIR=`/tmp/rs-letterboxd-import-${process.pid}`;
process.env.SESSION_SECRET="test-secret-that-is-at-least-32-chars-long";
process.env.NODE_ENV="test";
import test,{before} from "node:test";
import assert from "node:assert/strict";
import { db, initializeDatabase } from "../src/db.js";
import { previewLetterboxdImport, getLetterboxdImport, commitLetterboxdImport } from "../src/services/letterboxd-import-service.js";

const dh="Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date";
const wh="Date,Name,Year,Letterboxd URI";
const file=(name,text)=>({name,type:"text/csv",buffer:Buffer.from(text)});
const movie=(id,title,year)=>({id,title,original_title:title,release_date:`${year}-06-01`,poster_path:`/${id}.jpg`,runtime:100,vote_average:7,genres:[{name:"Drama"}],belongs_to_collection:null});
let uid;
before(()=>{ initializeDatabase(); uid=Number(db.prepare("INSERT INTO users(username,password_hash,timezone) VALUES ('importer','x','America/New_York')").run().lastInsertRowid); });

test("preview groups title/year searches, caps concurrency at four, auto-selects only unique exact matches, and does not create watches",async()=>{
 let active=0,max=0,calls=[];
 const found={Exact:[movie(1,"Exact",2024)],Ambiguous:[movie(2,"Ambiguous",2024),{...movie(3,"Other",2024),original_title:"Ambiguous"}],Missing:[]};
 const searchMovies=async(q,page,opts)=>{ calls.push([q,page,opts]); active++; max=Math.max(max,active); await new Promise(r=>setTimeout(r,5)); active--; return {page:1,total_pages:1,results:found[q]||[movie(q.charCodeAt(0),q,2024)]}; };
 const names=["Exact","Exact","Ambiguous","Missing","Four","Five","Six"];
 const csv=`${wh}\n${names.map((n,i)=>`2026-09-0${i+1},${n},2024,https://letterboxd.com/film/${n.toLowerCase()}-${i}/`).join("\n")}\n`;
 const beforeWatches=db.prepare("SELECT COUNT(*) c FROM watches WHERE user_id=?").get(uid).c;
 const preview=await previewLetterboxdImport(uid,[file("watched.csv",csv)],{db,searchMovies,now:()=>new Date("2026-09-03T12:00:00Z")});
 assert.ok(preview.job_id); assert.ok(preview.commit_token); assert.equal(preview.counts.total,7); assert.equal(calls.filter(x=>x[0]==="Exact").length,1); assert.ok(max<=4);
 assert.deepEqual(calls[0].slice(1),[1,{primaryReleaseYear:2024}]);
 assert.equal(preview.rows.find(r=>r.name==="Exact").resolution_state,"auto_selected");
 assert.equal(preview.rows.find(r=>r.name==="Ambiguous").resolution_state,"choice_required");
 assert.equal(preview.rows.find(r=>r.name==="Missing").resolution_state,"choice_required");
 assert.ok(preview.rows.every(r=>JSON.stringify(r.candidates).length<5000));
 assert.equal(db.prepare("SELECT COUNT(*) c FROM watches WHERE user_id=?").get(uid).c,beforeWatches);
 const stored=getLetterboxdImport(uid,preview.job_id,{db}); assert.equal(stored.commit_token,undefined); assert.equal(stored.rows.length,7);
});

test("commit validates details before one transaction, imports diary first, covers watched overlap, and replays identically",async()=>{
 const searchMovies=async(q)=>({page:1,total_pages:1,results:[movie(20,q,2024)]}); let detailActive=0,maxDetails=0;
 const movieDetails=async id=>{detailActive++;maxDetails=Math.max(maxDetails,detailActive);await new Promise(r=>setTimeout(r,3));detailActive--;return movie(id,"Overlap",2024)};
 const preview=await previewLetterboxdImport(uid,[
  file("diary.csv",`${dh}\n2026-09-03,Overlap,2024,https://letterboxd.com/film/overlap/,4.5,Yes,"drama,home",2026-09-01\n`),
  file("watched.csv",`${wh}\n2026-09-02,Overlap,2024,https://letterboxd.com/film/overlap/\n`)
 ],{db,searchMovies});
 const result=await commitLetterboxdImport(uid,preview.job_id,{token:preview.commit_token,decisions:[]},{db,movieDetails});
 assert.deepEqual(result.counts,{imported:1,already_imported:1,skipped:0,error:0}); assert.ok(maxDetails<=4);
 const watches=db.prepare("SELECT * FROM watches WHERE user_id=? AND tmdb_id=20").all(uid); assert.equal(watches.length,1);
 assert.equal(watches[0].competition_eligibility,"unverified_import"); assert.equal(watches[0].visibility,"private"); assert.equal(watches[0].points,0); assert.equal(watches[0].personal_rating,90); assert.equal(watches[0].tags_json,'["drama","home"]'); assert.equal(watches[0].watched_at_utc,"2026-09-01T16:00:00.000Z");
 const rows=db.prepare("SELECT file_kind,resolution_state,watch_id FROM letterboxd_import_rows WHERE job_id=(SELECT id FROM letterboxd_import_jobs WHERE public_job_id=?) ORDER BY file_kind").all(preview.job_id); assert.equal(new Set(rows.map(r=>r.watch_id)).size,1);
 assert.deepEqual(await commitLetterboxdImport(uid,preview.job_id,{token:preview.commit_token,decisions:[]},{db,movieDetails}),result);
 await assert.rejects(commitLetterboxdImport(uid,preview.job_id,{token:"wrong",decisions:[]},{db,movieDetails}),e=>e.status===409);
});

test("explicit decisions are complete and bound; selected details are validated before mutation",async()=>{
 const candidates=[movie(31,"Choice",2024),movie(32,"Choice",2024)];
 const preview=await previewLetterboxdImport(uid,[file("watched.csv",`${wh}\n2026-09-01,Choice,2024,https://letterboxd.com/film/choice/\n`)],{db,searchMovies:async()=>({results:candidates})});
 await assert.rejects(commitLetterboxdImport(uid,preview.job_id,{token:preview.commit_token,decisions:[]},{db,movieDetails:async id=>movie(id,"Choice",2024)}),e=>e.status===400);
 const row=preview.rows[0];
 await assert.rejects(commitLetterboxdImport(uid,preview.job_id,{token:preview.commit_token,decisions:[{row_id:row.id,action:"select",tmdb_id:999}]},{db,movieDetails:async id=>movie(id,"Choice",2024)}),e=>e.status===400);
 assert.equal(db.prepare("SELECT state FROM letterboxd_import_jobs WHERE public_job_id=?").get(preview.job_id).state,"preview");
 await assert.rejects(commitLetterboxdImport(uid,preview.job_id,{token:preview.commit_token,decisions:[{row_id:row.id,action:"select",tmdb_id:31}]},{db,movieDetails:async()=>movie(31,"Choice",2023)}),/year/i);
 assert.equal(db.prepare("SELECT COUNT(*) c FROM watches WHERE import_event_key=?").get(row.import_event_key).c,0);
 const result=await commitLetterboxdImport(uid,preview.job_id,{token:preview.commit_token,decisions:[{row_id:row.id,action:"skip"}]},{db,movieDetails:async()=>{throw new Error("must not call")}}); assert.equal(result.counts.skipped,1);
});

test("TMDB outage leaves no preview job and late transaction abort rolls back for retry",async()=>{
 const digestCount=()=>db.prepare("SELECT COUNT(*) c FROM letterboxd_import_jobs WHERE user_id=?").get(uid).c; const before=digestCount();
 await assert.rejects(previewLetterboxdImport(uid,[file("watched.csv",`${wh}\n2026-09-01,Outage,2024,https://letterboxd.com/film/outage/\n`)],{db,searchMovies:async()=>{throw new Error("TMDB down")}}),/TMDB down/); assert.equal(digestCount(),before);
 const preview=await previewLetterboxdImport(uid,[file("diary.csv",`${dh}\n2026-09-03,Rollback,2024,https://letterboxd.com/film/rollback/,5,,,2026-09-02\n`)],{db,searchMovies:async()=>({results:[movie(41,"Rollback",2024)]})});
 db.exec("CREATE TEMP TRIGGER import_late_fail BEFORE UPDATE ON letterboxd_import_jobs WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'late import abort'); END;");
 await assert.rejects(commitLetterboxdImport(uid,preview.job_id,{token:preview.commit_token,decisions:[]},{db,movieDetails:async()=>movie(41,"Rollback",2024)}),/late import abort/); db.exec("DROP TRIGGER import_late_fail");
 assert.equal(db.prepare("SELECT state FROM letterboxd_import_jobs WHERE public_job_id=?").get(preview.job_id).state,"preview"); assert.equal(db.prepare("SELECT COUNT(*) c FROM watches WHERE import_event_key LIKE 'diary:%rollback%'").get().c,0);
 const result=await commitLetterboxdImport(uid,preview.job_id,{token:preview.commit_token,decisions:[]},{db,movieDetails:async()=>movie(41,"Rollback",2024)}); assert.equal(result.counts.imported,1);
});

test("jobs are owner-isolated and previews expire",async()=>{
 const other=Number(db.prepare("INSERT INTO users(username,password_hash) VALUES ('otherimport','x')").run().lastInsertRowid);
 const now=new Date("2026-09-03T12:00:00Z"); const preview=await previewLetterboxdImport(uid,[file("watched.csv",`${wh}\n2026-09-01,Expire,2024,https://letterboxd.com/film/expire/\n`)],{db,now:()=>now,searchMovies:async()=>({results:[movie(51,"Expire",2024)]})});
 assert.throws(()=>getLetterboxdImport(other,preview.job_id,{db}),e=>e.status===404);
 await assert.rejects(commitLetterboxdImport(uid,preview.job_id,{token:preview.commit_token,decisions:[]},{db,now:()=>new Date("2026-09-04T13:00:00Z"),movieDetails:async()=>movie(51,"Expire",2024)}),e=>e.status===410);
});

test("concurrent identical commits converge on one immutable result",async()=>{
 const preview=await previewLetterboxdImport(uid,[file("watched.csv",`${wh}\n2026-09-01,Concurrent,2024,https://letterboxd.com/film/concurrent/\n`)],{db,searchMovies:async()=>({results:[movie(61,"Concurrent",2024)]})});
 const input={token:preview.commit_token,decisions:[]},deps={db,movieDetails:async()=>{await new Promise(r=>setTimeout(r,5));return movie(61,"Concurrent",2024);}};
 const [a,b]=await Promise.all([commitLetterboxdImport(uid,preview.job_id,input,deps),commitLetterboxdImport(uid,preview.job_id,input,deps)]);assert.deepEqual(a,b);assert.equal(db.prepare("SELECT COUNT(*) c FROM watches WHERE user_id=? AND import_event_key=?").get(uid,preview.rows[0].import_event_key).c,1);
});


test("preview persists bounded invalid rows while valid rows remain committable",async()=>{
 const csv=`${wh}\n2026-02-30,Bad Date,2024,https://letterboxd.com/film/bad-date/\n2026-09-01,Valid Row,2024,https://letterboxd.com/film/valid-row/\n`;
 const preview=await previewLetterboxdImport(uid,[file("watched.csv",csv)],{db,searchMovies:async(q)=>({results:[movie(71,q,2024)]})});
 assert.deepEqual(preview.counts,{total:2,resolved:1,choice_required:0,invalid:1});
 const invalid=preview.rows.find(row=>row.resolution_state==="invalid");
 assert.equal(invalid.source_row_number,2); assert.match(invalid.error,/date/i); assert.deepEqual(invalid.candidates,[]);
 const stored=getLetterboxdImport(uid,preview.job_id,{db}); assert.equal(stored.counts.invalid,1);
 const result=await commitLetterboxdImport(uid,preview.job_id,{token:preview.commit_token,decisions:[]},{db,movieDetails:async()=>movie(71,"Valid Row",2024)});
 assert.deepEqual(result.counts,{imported:1,already_imported:0,skipped:0,error:1});
 assert.equal(db.prepare("SELECT COUNT(*) c FROM watches WHERE user_id=? AND tmdb_id=71 AND deleted_at IS NULL").get(uid).c,1);
});

test("a later diary bundle retires an earlier watched-only placeholder",async()=>{
 const searchMovies=async(q)=>({results:[movie(81,q,2024)]}),movieDetails=async()=>movie(81,"Evolving",2024);
 const first=await previewLetterboxdImport(uid,[file("watched.csv",`${wh}\n2026-09-01,Evolving,2024,https://letterboxd.com/film/evolving/\n`)],{db,searchMovies});
 await commitLetterboxdImport(uid,first.job_id,{token:first.commit_token,decisions:[]},{db,movieDetails});
 const second=await previewLetterboxdImport(uid,[
  file("diary.csv",`${dh}\n2026-09-03,Evolving,2024,https://letterboxd.com/film/evolving/,4.5,,,2026-08-30\n`),
  file("watched.csv",`${wh}\n2026-09-01,Evolving,2024,https://letterboxd.com/film/evolving/\n`)
 ],{db,searchMovies});
 const result=await commitLetterboxdImport(uid,second.job_id,{token:second.commit_token,decisions:[]},{db,movieDetails});
 assert.deepEqual(result.counts,{imported:1,already_imported:1,skipped:0,error:0});
 const active=db.prepare("SELECT * FROM watches WHERE user_id=? AND tmdb_id=81 AND deleted_at IS NULL").all(uid);
 assert.equal(active.length,1); assert.equal(active[0].source_date_kind,"watched_day"); assert.equal(active[0].personal_rating,90);
 const retired=db.prepare("SELECT * FROM watches WHERE user_id=? AND tmdb_id=81 AND source_date_kind='marked_watched_day'").get(uid);
 assert.ok(retired.deleted_at); assert.equal(retired.deleted_reason,"letterboxd_diary_reconciled");
});


test("combined row limits count invalid source rows before the bounded error cap",async()=>{
 const rows=(prefix,count)=>Array.from({length:count},(_,i)=>`2026-02-30,${prefix}${i},2024,https://letterboxd.com/film/${prefix.toLowerCase()}-${i}/`).join("\n");
 const files=[file("diary.csv",`${dh}\n${Array.from({length:5001},(_,i)=>`2026-02-30,D${i},2024,https://letterboxd.com/film/d-${i}/,,,,2026-02-30`).join("\n")}\n`),file("watched.csv",`${wh}\n${rows("W",5000)}\n`)];
 await assert.rejects(previewLetterboxdImport(uid,files,{db,searchMovies:async()=>{throw new Error("must not search")}}),e=>e.status===413&&/10,000/.test(e.message));
 const tooManyInvalid=file("watched.csv",`${wh}\n${rows("I",101)}\n`);
 await assert.rejects(previewLetterboxdImport(uid,[tooManyInvalid],{db,searchMovies:async()=>{throw new Error("must not search")}}),e=>e.status===400&&e.rowErrors?.length===100&&/more than 100/i.test(e.message));
});
