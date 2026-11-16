import {test} from "node:test";
import assert from "node:assert/strict";
import {checkSchema,schemaSql,createMetadataClient,type ExpectedTable} from "../schemaCompatibility.js";
test("disposable database: exported schema matches and absent requirements fail closed",async()=>{
 assert.ok(process.env.DATABASE_URL,"Run only on a disposable QA database");
 const client=createMetadataClient(process.env.DATABASE_URL);
 await client.connect();
 try{
  const actual=await checkSchema(client);assert.deepEqual(actual.issues,[]);assert.ok(actual.expectedTables>100);
  const absent:ExpectedTable[]=[{name:"__qa_deliberately_absent_preflight_table",columns:[{name:"id",sqlType:"integer",notNull:true,requiresDefault:false}]},{schema:"public",name:"users",columns:[{name:"__qa_absent_column",sqlType:"text",notNull:false,requiresDefault:false}]}];
  const negative=await checkSchema(client,absent);assert.equal(negative.compatible,false);
  assert.deepEqual(negative.issues.map(i=>i.issue),["MISSING_TABLE","MISSING_COLUMN"]);
  // Execute the exact portable UI form; it also only queries metadata.
  const queryResults=await client.query(schemaSql(absent)) as unknown as {rows:Record<string,unknown>[]}[];
  assert.equal(queryResults[1].rows.length,2);
  assert.deepEqual(queryResults[1].rows.map(r=>r.issue).sort(),["MISSING_COLUMN","MISSING_TABLE"]);
 }finally{await client.end();}
});
