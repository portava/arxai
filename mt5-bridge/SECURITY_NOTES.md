# ARX MT5 connection security

This package configures an execution-capable EA for read-only DEMO setup.
Its source is not structurally incapable of trading. Keep the supplied local
arms off, automated trading disabled and the platform controls unchanged.

The per-user bridge token authenticates MT5 to the selected ARX origin. It can
submit account, position and symbol data and interact with that connection's
bridge endpoints. Treat it as a credential, even during read-only setup.

The owner generates and copies the token inside the signed-in ARX setup page.
ARX stores a hash and shows the new value once. The retired shared environment
token is rejected. A missing token is not repaired by inventing a value, editing
the database, or borrowing another user's connection.

The included `.set` profile contains blank URL, token and account fields. Load
it before private entry. Do not distribute an exported profile after configuring
MT5. Keep broker passwords inside the broker's terminal login flow; never send
them to ARX or chat. Share only masked connection status and presence checks.

If a token is exposed, the owner uses the connection's revoke/regenerate flow
and updates the terminal privately. Do not generate a replacement in the shell.
Remote configuration and self-update are disabled in this setup profile.

Only allowlist the reviewed ARX HTTPS origin. A development preview has workspace
lifetime and authentication constraints; it is not a production deployment.
Do not weaken authentication or expose the workspace to bypass a connection
failure. Stop and resolve the specific failure.

The kit does not authorize broker orders, a production launch, stop release,
operator arming or legacy account ownership claims.
