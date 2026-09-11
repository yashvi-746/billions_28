# AI Log

I used AI assistance (Gemini / Claude) throughout this exercise to audit the codebase, draft security findings, implement fixes, and build the Part 2 SLA breach tracking feature.

---

## What I Asked
- "Audit this repository as a PR reviewer to identify critical security and logic bugs."
- "Verify each security vulnerability against a live running MySQL server before writing up findings."
- "Implement and test the top 5 highest-priority fixes individually, committing each separately."
- "Build the SLA breach tracking feature according to the product spec and document all architectural decisions."

---

## Where the AI Was Wrong & How I Caught It

1. **SQL Parameter Mismatch in SLA Query**
   - *Issue*: Initial draft included an extra `?` placeholder in `SLA_BREACHED_CONDITION_SQL`, causing parameter shift and `ER_PARSE_ERROR`.
   - *How I caught it*: Executed `GET /api/tickets?breached=true` against the live backend API server. Fixed by matching placeholder counts and verified with a direct hand-written MySQL query (returning 81 breached tickets for Northwind).

2. **Shell Execution of Backticks in Commit Messages**
   - *Issue*: Passing inline code backticks (e.g. `` `ORDER BY` ``) inside double-quoted `git commit -m` commands caused the shell to execute them as subcommands, stripping code spans.
   - *How I caught it*: Inspected `git log --format=%B` immediately after committing. Fixed by writing commit messages via file buffer (`git commit -F`).

3. **Silent Port Conflicts & Server Crashes**
   - *Issue*: Background API processes crashed silently on port collisions (`EADDRINUSE: 4000`).
   - *How I caught it*: Ran explicit HTTP health checks (`GET /api/health`) after process startup, identified orphaned Node PIDs via `netstat`/`taskkill`, and ensured clean startup scripts.

---

## Empirical Verification
- **Live Database Reset**: Every fix and feature was validated after running `npm run db:reset` against a real MySQL 8 container.
- **Negative & Positive Test Cases**: Verified authorization fixes (e.g., cross-org requests return `404`, legitimate admin actions return `204`).
- **Production Build**: Verified frontend JSX/CSS compilation via `npm run build` (`vite build`).

