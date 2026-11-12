// Explicit local/admin CLI. Registration writes a future observation plan only.
// Usage: node --import tsx src/scripts/calibrationProspective.ts register plan.json
//        node --import tsx src/scripts/calibrationProspective.ts report USER_ID RUN_UUID
import {readFile} from "node:fs/promises";
import {registerProspective,readProspectiveReport} from "../lib/calibration/prospectiveStore.js";
import {pool} from "@workspace/db";
try {
 const [command,arg,id]=process.argv.slice(2);
 if(command==="register" && arg) console.log(JSON.stringify(await registerProspective(JSON.parse(await readFile(arg,"utf8"))),null,2));
 else if(command==="report" && arg && id && Number.isSafeInteger(Number(arg)) && Number(arg)>0) console.log(JSON.stringify(await readProspectiveReport(Number(arg),id),null,2));
 else throw new Error("Usage: register PLAN_JSON | report USER_ID RUN_UUID");
} catch(error) { console.error((error as Error).message);process.exitCode=1; }
finally {await pool.end();}
