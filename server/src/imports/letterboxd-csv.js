const HEADERS={
 diary:["Date","Name","Year","Letterboxd URI","Rating","Rewatch","Tags","Watched Date"],
 watched:["Date","Name","Year","Letterboxd URI"],
};
const MAX_FILE=2*1024*1024,MAX_ROWS=10000,MAX_ERRORS=100;
function fail(message,status=400){const e=new Error(message);e.status=status;throw e;}
function decode(buffer){if(!Buffer.isBuffer(buffer))fail("CSV input must be a buffer.");if(buffer.includes(0))fail("CSV contains a NUL byte.");try{return new TextDecoder("utf-8",{fatal:true}).decode(buffer).replace(/^\ufeff/,"");}catch{fail("CSV must be valid UTF-8.");}}
function records(text){const out=[];let row=[],field="",quoted=false,closed=false,i=0;
 while(i<text.length){const c=text[i];
  if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i+=2;continue;}quoted=false;closed=true;i++;continue;}field+=c;i++;continue;}
  if(closed){if(c===','){row.push(field);field="";closed=false;i++;continue;}if(c==='\n'||c==='\r'){row.push(field);out.push(row);row=[];field="";closed=false;if(c==='\r'){if(text[i+1]!=="\n")fail("Malformed CSV line ending.");i++;}i++;continue;}fail("Malformed CSV after closing quote.");}
  if(c==='"'){if(field.length)fail("Malformed CSV quote in unquoted field.");quoted=true;i++;continue;}
  if(c===','){row.push(field);field="";i++;continue;}
  if(c==='\n'||c==='\r'){row.push(field);out.push(row);row=[];field="";if(c==='\r'){if(text[i+1]!=="\n")fail("Malformed CSV line ending.");i++;}i++;continue;}
  field+=c;i++;
 }
 if(quoted)fail("Malformed CSV: unterminated quoted field.");
 if(closed||field.length||row.length){row.push(field);out.push(row);}
 return out;
}
function validDay(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const d=new Date(`${value}T00:00:00.000Z`);return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===value;}
function uri(value){let u;try{u=new URL(value);}catch{return null;}const host=u.hostname.toLowerCase().replace(/^www\./,"");if(u.protocol!=="https:"||!new Set(["letterboxd.com","boxd.it"]).has(host)||u.username||u.password||u.port||u.pathname==="/")return null;u.protocol="https:";u.hostname=host;u.search="";u.hash="";u.pathname=u.pathname.replace(/\/+$/,"");return u.toString().replace(/\/$/,"");}
function rating(value){if(value==="")return null;if(!/^(?:0\.5|[1-4](?:\.0|\.5)|5(?:\.0)?)$/.test(value))return undefined;return Math.round(Number(value)*20);}
function tags(value){if(value==="")return [];const values=[...new Set(value.split(",").map(x=>x.trim().toLowerCase()))].sort();if(values.some(x=>!x||x.length>30||!/^[a-z0-9][a-z0-9 _-]*$/.test(x))||values.length>20)return null;return values;}
function rowError(row,error,raw=[]){return {row,error:String(error).slice(0,200),snapshot:{exported_date:String(raw[0]??"").slice(0,10),name:String(raw[1]??"").slice(0,500),year:String(raw[2]??"").slice(0,4),uri:String(raw[3]??"").slice(0,1000)}};}
export function parseLetterboxdCsv(buffer,expectedKind){if(!Object.hasOwn(HEADERS,expectedKind))fail("Expected kind must be diary or watched.");if(Buffer.isBuffer(buffer)&&buffer.length>MAX_FILE)fail("CSV file must be at most 2 MiB.",413);const parsed=records(decode(buffer));if(!parsed.length)fail("CSV is empty.");const expected=HEADERS[expectedKind];if(parsed[0].length!==expected.length||parsed[0].some((x,i)=>x!==expected[i]))fail(`CSV header must exactly match the official ${expectedKind}.csv header.`);if(parsed.length-1>MAX_ROWS)fail("CSV exceeds the 10,000 row limit.",413);
 const rows=[],errors=[],occurrences=new Map(),watchedKeys=new Set();let sourceRowCount=0,errorCount=0;
 for(let i=1;i<parsed.length;i++){const raw=parsed[i];if(raw.length===1&&raw[0]==="")continue;sourceRowCount++;const n=i+1;let error=null;
  if(raw.length!==expected.length)error="Row has the wrong number of columns.";
  const exportedDate=raw[0]??"",name=raw[1]??"",yearText=raw[2]??"",normalizedUri=uri(raw[3]??"");
  const sourceRecordedDate=expectedKind==="diary"?(raw[7]??""):exportedDate;
  const parsedRating=expectedKind==="diary"?rating(raw[4]??""):null;
  const parsedTags=expectedKind==="diary"?tags(raw[6]??""):[];
  if(!error&&!validDay(exportedDate))error="Date must be a possible YYYY-MM-DD calendar date.";
  if(!error&&(typeof name!=="string"||!name.trim()||name.length>500))error="Name must contain 1 to 500 characters.";
  if(!error&&!/^(?:[1-9]\d{3})$/.test(yearText))error="Year must be a valid four-digit year.";
  if(!error&&!normalizedUri)error="Letterboxd URI must use an allowed HTTPS Letterboxd host.";
  if(!error&&!validDay(sourceRecordedDate))error=`${expectedKind==="diary"?"Watched Date":"Date"} must be a possible YYYY-MM-DD calendar date.`;
  if(!error&&parsedRating===undefined)error="Rating must be blank or a half-step from 0.5 to 5.0.";
  if(!error&&expectedKind==="diary"&&!new Set(["","Yes"]).has(raw[5]))error="Rewatch must be blank or Yes.";
  if(!error&&parsedTags===null)error="Tags must be 20 or fewer canonical tags of at most 30 characters.";
  if(error){errorCount++;if(errors.length<MAX_ERRORS)errors.push(rowError(n,error,raw));continue;}
  let importEventKey;if(expectedKind==="diary"){const base=`${normalizedUri}:${sourceRecordedDate}`,occurrence=(occurrences.get(base)||0)+1;occurrences.set(base,occurrence);importEventKey=`diary:${base}:${occurrence}`;}else{importEventKey=`watched:${normalizedUri}`;if(watchedKeys.has(importEventKey)){errorCount++;if(errors.length<MAX_ERRORS)errors.push(rowError(n,"Duplicate watched Letterboxd URI.",raw));continue;}watchedKeys.add(importEventKey);}
  rows.push({sourceRowNumber:n,fileKind:expectedKind,exportedDate,name:name.trim(),year:Number(yearText),uri:normalizedUri,rating:parsedRating,rewatch:expectedKind==="diary"&&raw[5]==="Yes",tags:parsedTags,sourceRecordedDate,sourceDateKind:expectedKind==="diary"?"watched_day":"marked_watched_day",importEventKey});
 }
 return {kind:expectedKind,rows,errors,sourceRowCount,errorCount,errorsTruncated:errorCount>errors.length};
}
