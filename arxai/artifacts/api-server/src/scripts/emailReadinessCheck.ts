// Read existing connector configuration only. Does not send email, log addresses or keys,
// generate password-reset tokens, or claim provider/inbox delivery evidence.
import { inspectEmailConfiguration } from "../lib/email/resend.js";

const result = await inspectEmailConfiguration();
process.stdout.write(JSON.stringify(result) + "\n");
process.exitCode = result.configured ? 0 : 2;
