# MT5 DEMO setup verification — 2026-10-25

PR #71 is open. The approved development workspace contains the read-only kit, consistent setup guidance and a preflight refusal for known incompatible EAs. 46 regression checks, 87 guards, both type checks and both production builds passed. The restarted API returns health 200 and anonymous identity 401; login returns 200. Download endpoints remain authenticated (anonymous requests return 401); package contents and hashes were exercised directly by the regression suite.

The unchanged v1.29 source compiled on the selected Mac with 0 errors and 2 warnings; its SHA-256 matches this workspace. Self-update remains disabled. No EA was attached, token created, control released, app published or broker order issued. The owner terminal sign-in and a corrected DEMO partial-close path remain outstanding. See TIER1_MT5_DEMO_READINESS.md and the JSON companion for bounded evidence.
