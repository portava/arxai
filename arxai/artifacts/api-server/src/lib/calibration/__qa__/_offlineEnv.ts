// Offline tests import modules that import @workspace/db, which refuses to
// load without DATABASE_URL. Nothing in these tests opens a connection.
process.env["DATABASE_URL"] ??= "postgres://offline:offline@127.0.0.1:1/offline";
