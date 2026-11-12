import {test} from "node:test";
import assert from "node:assert/strict";
import {pgTable,text,integer} from "drizzle-orm/pg-core";
import {checkSchema,exportedTables,schemaSql} from "../schemaCompatibility.js";
const table=pgTable("preflight",{id:integer().notNull(),label:text().default("safe"),runtime:text().$defaultFn(()=>"runtime")});
function metadata(overrides:Record<string,unknown>[]=[]){
 const queries:string[]=[];
 const rows=[{column_name:"id",data_type:"integer",is_nullable:"NO",has_default:false},{column_name:"label",data_type:"text",is_nullable:"YES",has_default:true},{column_name:"runtime",data_type:"text",is_nullable:"YES",has_default:false}].map(r=>({table_schema:"public",table_name:"preflight",is_identity:"NO",is_generated:"NEVER",...r,...overrides.find(o=>o.column_name===r.column_name)}));
 return {queries,query:async(q:string)=>{queries.push(q);return{rows:q.includes("current_schemas")?[{schemas:["public"]}]:q.includes("information_schema.tables")?[{table_schema:"public",table_name:"preflight"}]:q.includes("information_schema.columns")?rows:[]};}};
}
test("metadata inspection is explicitly read-only, rolls back, and ignores application defaults",async()=>{
 const db=metadata(),report=await checkSchema(db,exportedTables({table,duplicate:table,other:42}));
 assert.equal(report.compatible,true);assert.equal(report.expectedTables,1);assert.equal(db.queries[0],"BEGIN READ ONLY");assert.equal(db.queries.at(-1),"ROLLBACK");
 assert.ok(db.queries.every(q=>q.startsWith("SELECT ")||q==="BEGIN READ ONLY"||q==="ROLLBACK"));
});
test("missing table and column fail closed",async()=>{
 const db=metadata(),expected=exportedTables({table});expected[0].columns.push({name:"absent",sqlType:"text",notNull:false,requiresDefault:false});
 expected.push({name:"missing",columns:[]});const report=await checkSchema(db,expected);
 assert.equal(report.compatible,false);assert.deepEqual(report.issues.map(i=>i.issue),["MISSING_COLUMN","MISSING_TABLE"]);
});
test("reliable type/null/default mismatches are reported without leaking default expressions",async()=>{
 const report=await checkSchema(metadata([{column_name:"id",data_type:"text",is_nullable:"YES"},{column_name:"label",has_default:false}]),exportedTables({table}));
 assert.deepEqual(report.issues.map(i=>i.issue),["INCOMPATIBLE_TYPE","NULLABILITY_MISMATCH","MISSING_DATABASE_DEFAULT"]);
});
test("metadata errors still rollback",async()=>{
 const db=metadata(),query=db.query;db.query=async q=>{if(q.includes("information_schema.columns"))throw Error("failure");return query(q);};
 await assert.rejects(checkSchema(db,exportedTables({table})),/failure/);assert.equal(db.queries.at(-1),"ROLLBACK");
});

test("SQL mode emits only a read-only metadata query and safely quotes identifiers as values",()=>{
 const sql=schemaSql([{schema:"public",name:"table'quoted",columns:[{name:"col",sqlType:"text",notNull:false,requiresDefault:false}]}]);
 assert.ok(sql.startsWith("BEGIN READ ONLY;"));assert.ok(sql.endsWith("ROLLBACK;"));assert.ok(sql.includes("'table''quoted'"));
 assert.ok(sql.includes("information_schema.columns"));assert.ok(!/INSERT|UPDATE|DELETE|CREATE|ALTER/.test(sql));
});
