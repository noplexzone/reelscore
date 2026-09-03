import test from "node:test";
import assert from "node:assert/strict";
import { parseLetterboxdCsv } from "../src/imports/letterboxd-csv.js";

const diaryHeader="Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date";
const watchedHeader="Date,Name,Year,Letterboxd URI";
const parse=(body,kind="diary")=>parseLetterboxdCsv(Buffer.from(body),kind);

test("parses official BOM/CRLF export and RFC4180 quoting into canonical values",()=>{
  const out=parse(`\ufeff${diaryHeader}\r\n2026-09-01,"A, ""Quoted""\nFilm",2024,https://letterboxd.com/film/a-quoted-film/,4.5,Yes,"Sci Fi, drama,SCI FI",2026-08-31\r\n`);
  assert.deepEqual(out.errors,[]); assert.equal(out.rows.length,1);
  assert.deepEqual(out.rows[0],{sourceRowNumber:2,fileKind:"diary",exportedDate:"2026-09-01",name:'A, "Quoted"\nFilm',year:2024,uri:"https://letterboxd.com/film/a-quoted-film",rating:90,rewatch:true,tags:["drama","sci fi"],sourceRecordedDate:"2026-08-31",sourceDateKind:"watched_day",importEventKey:"diary:https://letterboxd.com/film/a-quoted-film:2026-08-31:1"});
});

test("parses watched LF export and creates stable normalized URI keys",()=>{
 const out=parse(`${watchedHeader}\n2026-09-01,Alien,1979,https://LETTERBOXD.com/film/alien/?x=1#x\n`,"watched");
 assert.deepEqual(out.errors,[]); assert.equal(out.rows[0].uri,"https://letterboxd.com/film/alien"); assert.equal(out.rows[0].importEventKey,"watched:https://letterboxd.com/film/alien");
});

test("rejects malformed encoding, CSV, NUL, and non-exact headers",()=>{
 for(const [input,kind,pattern] of [[Buffer.from([0xff]),"watched",/UTF-8/i],[Buffer.from(`${watchedHeader}\n2026-01-01,"bad,2024,https://letterboxd.com/film/bad/`),"watched",/CSV/i],[Buffer.from(`${watchedHeader}\n2026-01-01,A\0,2024,https://letterboxd.com/film/a/`),"watched",/NUL/i],[Buffer.from("Name,Date,Year,Letterboxd URI\nA,2026-01-01,2024,https://letterboxd.com/film/a/"),"watched",/header/i],[Buffer.from(`${watchedHeader},Extra\n2026-01-01,A,2024,https://letterboxd.com/film/a/,x`),"watched",/header/i]]) assert.throws(()=>parseLetterboxdCsv(input,kind),pattern);
});

test("returns bounded row errors for invalid dates, names, years, URIs, ratings, rewatch, and tags",()=>{
 const rows=[
  "2026-02-30,A,2024,https://letterboxd.com/film/a/,,,good,2026-02-30",
  "2026-01-01,,2024,https://letterboxd.com/film/a/,,,good,2026-01-01",
  "2026-01-01,A,24,https://letterboxd.com/film/a/,,,good,2026-01-01",
  "2026-01-01,A,2024,http://letterboxd.com/film/a/,,,good,2026-01-01",
  "2026-01-01,A,2024,https://evil.example/film/a/,4.2,,good,2026-01-01",
  "2026-01-01,A,2024,https://letterboxd.com/film/a/,,No,good,2026-01-01",
  "2026-01-01,A,2024,https://letterboxd.com/film/a/,,,bad!,2026-01-01",
 ];
 const out=parse(`${diaryHeader}\n${rows.join("\n")}\n`); assert.equal(out.rows.length,0); assert.equal(out.errors.length,7);
 for(const e of out.errors){ assert.ok(e.row>=2); assert.ok(e.error.length<=200); }
});

test("enforces half-step ratings, tag and row bounds",()=>{
 for(const rating of ["0","0.1","5.5","01.0"]) assert.equal(parse(`${diaryHeader}\n2026-01-01,A,2024,https://letterboxd.com/film/a/,${rating},,,2026-01-01\n`).errors.length,1);
 assert.equal(parse(`${diaryHeader}\n2026-01-01,A,2024,https://letterboxd.com/film/a/,0.5,,,2026-01-01\n`).rows[0].rating,10);
 const tooMany=Array.from({length:21},(_,i)=>`tag${i}`).join(",");
 assert.equal(parse(`${diaryHeader}\n2026-01-01,A,2024,https://letterboxd.com/film/a/,,,"${tooMany}",2026-01-01\n`).errors.length,1);
 const lines=Array.from({length:10001},(_,i)=>`2026-01-01,A${i},2024,https://letterboxd.com/film/a${i}/`).join("\n");
 assert.throws(()=>parseLetterboxdCsv(Buffer.from(`${watchedHeader}\n${lines}`),"watched"),/10,000/);
});

test("rejects duplicate watched identities as a bounded row error",()=>{
 const out=parse(`${watchedHeader}\n2026-01-01,A,2024,https://boxd.it/abc\n2026-01-02,A,2024,https://boxd.it/abc\n`,"watched");
 assert.equal(out.rows.length,1); assert.equal(out.errors.length,1); assert.match(out.errors[0].error,/duplicate/i);
});


test("rejects a direct parser input larger than 2 MiB",()=>{
 const name="A".repeat(300);
 const lines=Array.from({length:7000},(_,i)=>`2026-01-01,${name}${i},2024,https://letterboxd.com/film/large-${i}/`).join("\n");
 const input=Buffer.from(`${watchedHeader}\n${lines}`);
 assert.ok(input.length>2*1024*1024);
 assert.throws(()=>parseLetterboxdCsv(input,"watched"),e=>e.status===413&&/2 MiB/i.test(e.message));
});
