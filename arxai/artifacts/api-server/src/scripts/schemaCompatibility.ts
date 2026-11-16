/** Metadata-only deployment preflight. Never imports the application DB pool/startup. */
import {is} from "drizzle-orm";
import {PgTable,getTableConfig} from "drizzle-orm/pg-core";
import {createRequire} from "node:module";
import {pathToFileURL} from "node:url";
import * as schema from "@workspace/db/schema";

export type MetadataClient={query:(query:string)=>Promise<{rows:Record<string,unknown>[]}>};
export function createMetadataClient(connectionString:string):MetadataClient&{connect:()=>Promise<void>;end:()=>Promise<void>}{
 const {Client}=createRequire(import.meta.url)("pg") as {Client:new(options:Record<string,unknown>)=>MetadataClient&{connect:()=>Promise<void>;end:()=>Promise<void>}};
 return new Client({connectionString,connectionTimeoutMillis:10000,statement_timeout:15000});
}
type Column={name:string;sqlType:string;notNull:boolean;requiresDefault:boolean};
export type ExpectedTable={schema?:string;name:string;columns:Column[]};
export function exportedTables(exports:Record<string,unknown>):ExpectedTable[]{
 const tables=new Map<string,ExpectedTable>();
 for(const value of Object.values(exports)) if(is(value,PgTable)){
  const config=getTableConfig(value);
  tables.set(`${config.schema??""}.${config.name}`,{schema:config.schema,name:config.name,columns:config.columns.map(c=>({
   name:c.name,sqlType:c.getSQLType(),notNull:c.notNull,
   // Runtime $defaultFn is not a database default; do not report it as missing.
   requiresDefault:c.default!==undefined||/^(smallserial|serial|bigserial)$/.test(c.getSQLType()),
  }))});
 }
 return [...tables.values()].sort((a,b)=>`${a.schema}.${a.name}`<`${b.schema}.${b.name}`?-1:1);
}
function expectedType(type:string):string|null{
 const t=type.toLowerCase().replace(/\s+/g," ").trim();
 const aliases:Record<string,string>={serial:"integer",smallserial:"smallint",bigserial:"bigint",int:"integer",int4:"integer",int8:"bigint",int2:"smallint",bool:"boolean",float8:"double precision",float4:"real",varchar:"character varying",timestamp:"timestamp without time zone",timestamptz:"timestamp with time zone",time:"time without time zone"};
 if(aliases[t])return aliases[t];
 if(["integer","smallint","bigint","boolean","text","uuid","json","jsonb","date","real","double precision","bytea","timestamp without time zone","timestamp with time zone","time without time zone","time with time zone"].includes(t))return t;
 // Length, precision, arrays, enums and custom types need richer comparison.
 return null;
}
export async function checkSchema(client:MetadataClient,expected:ExpectedTable[]=exportedTables(schema)){
 if(!expected.length)throw new Error("No exported PostgreSQL tables found");
 await client.query("BEGIN READ ONLY");
 try{
  const search=await client.query("SELECT current_schemas(true)::text[] AS schemas");
  const searchPath=search.rows[0]?.schemas as string[];
  const tables=await client.query("SELECT table_schema,table_name FROM information_schema.tables WHERE table_type='BASE TABLE'");
  const columns=await client.query("SELECT table_schema,table_name,column_name,data_type,is_nullable,(column_default IS NOT NULL) AS has_default,is_identity,is_generated FROM information_schema.columns");
  const tableKeys=new Set(tables.rows.map(r=>`${r.table_schema}.${r.table_name}`));
  const columnMap=new Map(columns.rows.map(r=>[`${r.table_schema}.${r.table_name}.${r.column_name}`,r]));
  const issues:{table:string;column?:string;issue:string;expected?:string;actual?:string}[]=[];
  let checkedColumns=0,uncheckedTypes=0;
  for(const table of expected){
   const resolved=table.schema??searchPath.find(s=>tableKeys.has(`${s}.${table.name}`));
   const name=`${resolved??table.schema??"<search_path>"}.${table.name}`;
   if(!resolved||!tableKeys.has(name)){issues.push({table:name,issue:"MISSING_TABLE"});continue;}
   for(const c of table.columns){
    const actual=columnMap.get(`${name}.${c.name}`);
    if(!actual){issues.push({table:name,column:c.name,issue:"MISSING_COLUMN"});continue;}
    checkedColumns++;
    const type=expectedType(c.sqlType);
    if(type===null)uncheckedTypes++;
    else if(type!==actual.data_type)issues.push({table:name,column:c.name,issue:"INCOMPATIBLE_TYPE",expected:type,actual:String(actual.data_type)});
    if(c.notNull!==(actual.is_nullable==="NO"))issues.push({table:name,column:c.name,issue:"NULLABILITY_MISMATCH",expected:c.notNull?"NOT NULL":"NULLABLE",actual:actual.is_nullable==="NO"?"NOT NULL":"NULLABLE"});
    if(c.requiresDefault&&actual.has_default===false&&actual.is_identity!=="YES"&&actual.is_generated==="NEVER")issues.push({table:name,column:c.name,issue:"MISSING_DATABASE_DEFAULT"});
   }
  }
  return {compatible:issues.length===0,expectedTables:expected.length,checkedColumns,uncheckedTypes,issues,
   limitations:["Metadata visible to this database role only; invisible tables fail closed as missing.","Does not verify indexes, constraints, triggers, permissions, enum members, default expressions, or unsupported type parameters."]};
 }finally{await client.query("ROLLBACK");}
}
// SQL mode is connection-free and returns only missing names. Use in a DB UI
// wrapped in the same explicit read-only transaction as the executable checker.
export function schemaSql(expected:ExpectedTable[]=exportedTables(schema)):string{
 const quote=(s:string)=>"'"+s.replaceAll("'","''")+"'";
 const values=expected.flatMap(t=>t.columns.map(c=>`(${t.schema?quote(t.schema):"NULL"},${quote(t.name)},${quote(c.name)})`));
 if(!values.length)throw new Error("No matching tables");
 return `BEGIN READ ONLY;
WITH required(schema_name,table_name,column_name) AS (VALUES
${values.join(",\n")}
), resolved AS (
 SELECT r.*,COALESCE(r.schema_name,(SELECT t.table_schema FROM information_schema.tables t
 WHERE t.table_name=r.table_name AND t.table_type='BASE TABLE' AND t.table_schema=ANY(current_schemas(true))
 ORDER BY array_position(current_schemas(true),t.table_schema::name) LIMIT 1)) AS resolved_schema FROM required r
)
SELECT COALESCE(r.resolved_schema,r.schema_name,'<search_path>') AS schema_name,r.table_name,r.column_name,
 CASE WHEN NOT EXISTS(SELECT 1 FROM information_schema.tables t WHERE t.table_schema=r.resolved_schema AND t.table_name=r.table_name AND t.table_type='BASE TABLE') THEN 'MISSING_TABLE' ELSE 'MISSING_COLUMN' END AS issue
FROM resolved r WHERE NOT EXISTS(SELECT 1 FROM information_schema.columns c
 WHERE c.table_schema=r.resolved_schema AND c.table_name=r.table_name AND c.column_name=r.column_name)
ORDER BY 1,2,3;
ROLLBACK;`;
}
async function main(){
 const selection=process.argv.find(a=>a.startsWith("--tables="))?.slice(9).split(",");
  const tables=exportedTables(schema).filter(t=>!selection||selection.includes(t.name));
  if(selection?.some(name=>!tables.some(t=>t.name===name)))throw new Error("Unknown selected table");
 if(process.argv.includes("--sql")){console.log(schemaSql(tables));return;}
 if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is required");
 const client=createMetadataClient(process.env.DATABASE_URL);
 try{await client.connect();const report=await checkSchema(client,tables);console.log(JSON.stringify(report,null,2));process.exitCode=report.compatible?0:1;}
 finally{await client.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{
 // Driver errors can contain connection strings/hostnames; emit no raw errors.
 console.error("Schema preflight failed: could not complete read-only metadata inspection.");process.exitCode=2;
});
