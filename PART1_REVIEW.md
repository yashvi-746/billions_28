# Part 1 — Code review

All line numbers refer to the code as delivered (commit `e69cb7e`, "Starter: Meridian
Helpdesk as provided by Bilions"). Findings are ranked most → least important. Findings
1–5 were fixed (separate commits, listed at the end); 6–12 are documented only, as instructed.

## Ranking, with reasons

1. **Broken access control on ticket routes** — defeats the app's core promise
   ("separate customers... must not be able to see each other's tickets") and lets any
   authenticated user delete or reassign any ticket regardless of role. Confirmed live.
2. **Unauthenticated password overwrite via `invite/accept`** — an anonymous caller can
   permanently lock out any account, including admins, with no login required. Worse
   than a typical takeover: it's a whole-tenant denial-of-service and it's invisible
   from the UI, so nobody would notice until users start reporting they're locked out.
3. **Stored XSS in comments** — any org member can plant a script that runs in an
   agent's or admin's browser and steal their session token straight out of
   `localStorage`.
4. **SQL injection via `sortBy`/`order`** — confirmed with a time-based blind payload.
   Exploitable by any authenticated user, in the most heavily used endpoint in the app.
5. **Pagination off-by-one** — not a security issue, but a core-workflow bug: agents
   literally cannot see the 20 newest tickets on page 1. Confirmed against seed data.
6. **List filters don't refetch** — search/status/priority/sortBy silently do nothing.
7. **Race condition in ticket assignment** — two agents can both "win" a claim.
8. **N+1 query for comment counts** — real but bounded (20 extra queries per page load).
9. **Secrets committed to the repo, weak fallback JWT secret** — real risk if pushed,
   lower likelihood in a take-home.
10. **No rate limiting on login** — standard hardening item, not urgent for this app's
    threat model today.
11. **Client-supplied `isInternal` flag is trusted** — low impact given `is_internal`
    is currently cosmetic only.
12. **`priority` not validated before insert** — poor error UX, not a security issue.

I ranked exploitability × blast radius first (1–4), then a bug that visibly breaks the
main screen every single agent uses every day (5), then correctness/robustness/hygiene
issues roughly in order of how much damage they can do (6–12).

---

## 1. Broken access control on ticket routes — CRITICAL

**Where:** `server/src/routes/tickets.js:31–41` (GET `/:id`), `:62–73` (PATCH
`/:id/assign`), `:75–84` (DELETE `/:id`). `requireRole` is imported at the top of the
file and never used anywhere in it.

**What's wrong:** None of the three handlers check `ticket.org_id === req.user.orgId`.
`assign` and `delete` also apply no role check at all, even though the README states
claiming is agent-only and deleting is admin-only.

**Why it matters here:** I confirmed all three against the running app with seeded
accounts:
- `agent1@northwind.test` (org 1) fetched Cobalt's (org 2) ticket #2 in full, including
  an internal comment, via `GET /api/tickets/2`.
- The same token then deleted that Cobalt ticket via `DELETE /api/tickets/2` — `204`,
  gone from the DB.
- `user1@northwind.test`, a **requester**, successfully claimed a ticket via
  `PATCH /api/tickets/:id/assign` — `200`, with itself set as `assignee_id`.

This is a full breach of the org boundary the README calls out as a hard requirement,
plus a vertical privilege escalation (requester → agent-only action) and an
authorization bypass on a destructive action (delete, meant to be admin-only).

**How I'd fix it:** Add `ticket.org_id !== req.user.orgId → 404` to all three handlers
(404, not 403, so a caller can't distinguish "wrong org" from "doesn't exist" and
enumerate ids), and apply the already-imported `requireRole('agent', 'admin')` /
`requireRole('admin')` middleware to assign / delete respectively.

**Severity:** Critical.

---

## 2. Unauthenticated account takeover / lockout via `invite/accept`

**Where:** `server/src/routes/auth.js:42–54`.

**What's wrong:** Two separate bugs compound each other:
- No authentication and no invite-token check — any `userId` is accepted from anyone.
- The raw password is written straight into `password_hash` (`UPDATE users SET
  password_hash = ? WHERE id = ?`, line 49) — it's never hashed.

**Why it matters here:** This endpoint has **no UI route calling it anywhere in the
client** (confirmed by searching the whole `client/src` tree) — this is the finding the
brief says can only be found by reading, not by clicking through the app. User ids are
sequential integers starting at 1, so an anonymous script can walk `userId` 1..N.
I reproduced it end to end:

```
POST /api/auth/invite/accept {"userId":1,"password":"hacked123"}  → 200 {"ok":true}
```
`password_hash` for user 1 (`admin@northwind.test`) became the literal string
`hacked123`. Afterwards **neither** the real password nor the injected one could log
in (`bcrypt.compare` against a non-bcrypt string just returns false) — so this isn't
account takeover in the usual sense, it's an unauthenticated way to permanently lock
any account, admins included, faster than anyone could notice or react. Running it
against every seeded user id would lock the entire org out in seconds.

**How I'd fix it:** Hash the password before storing it, and require proof of a real,
unexpired invitation before accepting one. There's no invite-token table in this
schema — building one (issuing tokens, an admin "invite user" flow, expiry) is a
larger feature than fits inside "fix the top five," so I did the minimal thing that
closes the hole without a schema change: hash the password, and only allow the update
when `password_hash IS NULL` (i.e., a genuinely pending account). No seeded user has a
`NULL` hash, so this route is now inert against today's data by design — which is
correct, since there's no legitimate invite flow yet for it to serve. See
`DECISIONS.md` for the trade-off.

**Severity:** Critical.

---

## 3. Stored XSS via comment body — CRITICAL

**Where:** `client/src/features/tickets/TicketDetail.jsx:65`.

**What's wrong:** `<div dangerouslySetInnerHTML={{ __html: c.body }} />` renders every
comment's raw body as HTML with no sanitization.

**Why it matters here:** Any org member — including the lowest-privileged
`requester` role — can post a comment body like `<img src=x onerror=alert(1)>` and have
it stored and served back verbatim (confirmed: posted it via the comments API, it came
back unescaped in the ticket detail payload). It would then execute in the browser of
every agent and admin who opens that ticket. The JWT lives in `localStorage`
(`client/src/app/store.js:12`), which is readable by any script running on the page —
so this is a direct path from a low-privileged account to stealing an agent's or
admin's session.

**How I'd fix it:** There's no legitimate need for HTML comments here (no rich-text
editor exists in the UI), so render the body as plain text via normal React
interpolation (`{c.body}`), which auto-escapes. If rich text is wanted later, sanitize
server-side with an allow-list (e.g. DOMPurify) rather than trusting raw HTML.

**Severity:** Critical.

---

## 4. SQL injection via `sortBy` / `order` — CRITICAL

**Where:** `server/src/services/ticketService.js:38` (`ORDER BY t.${sortBy}
${order}`), fed unsanitised from `server/src/routes/tickets.js:22`
(`sortBy: req.query.sortBy || 'created_at'`).

**What's wrong:** `sortBy` and `order` are query-string values interpolated directly
into the SQL string. mysql2 placeholders can't parameterise identifiers (column names),
so the developer fell back to string interpolation — but never validated the value
against the small set of columns the UI actually offers.

**Why it matters here:** I confirmed this is exploitable, not theoretical: a request
with `sortBy=id,(SELECT SLEEP(3))` made the ticket-list endpoint hang for 3+ seconds
(server log shows the literal injected SQL: `ORDER BY t.(SELECT SLEEP(3)) desc`).
Time-based blind injection is a known technique for extracting data (or, at minimum,
this is a trivial and unauthenticated-adjacent — any logged-in user, including a
requester — denial-of-service lever against the whole API via connection-pool
exhaustion).

**How I'd fix it:** Whitelist `sortBy` against the handful of columns the UI's dropdown
actually offers, and `order` against `asc`/`desc`, mapping anything else to a safe
default rather than passing user input into the query string at all.

**Severity:** Critical.

---

## 5. Pagination off-by-one skips the newest tickets

**Where:** `server/src/services/ticketService.js:29` — `const offset = page *
PAGE_SIZE;`.

**What's wrong:** Should be `(page - 1) * PAGE_SIZE`. With `page` defaulting to `1`,
the very first page skips the first 20 rows.

**Why it matters here:** This isn't cosmetic — the ticket list defaults to newest
first, so page 1 is the page agents look at to see what just came in, and it always
misses the 20 newest tickets in the org. I confirmed it directly: with fresh seed data,
Northwind's single newest ticket (id 121, created 2026-09-08 20:56) never appeared on
page 1; the first row shown was id 113, the 21st-newest.

**How I'd fix it:** `const offset = (page - 1) * PAGE_SIZE`, with `page` clamped to a
minimum of 1 so `page=0` or negative values don't produce a negative offset.

**Severity:** High (functional, not security, but core-workflow-breaking).

---

## 6. List filters never trigger a refetch — documented only

**Where:** `client/src/features/tickets/TicketList.jsx:21–31`. The data-fetching
`useEffect` only depends on `[page]`, but reads `search`, `status`, `priority`, and
`sortBy` from component state inside the closure.

**What's wrong:** Typing in the search box, or changing the status/priority/sort
dropdowns, updates state but doesn't refetch — nothing visibly happens until the user
changes pages, at which point the *stale* filter values are finally sent.

**Why it matters here:** Every filter control in the UI silently does nothing on its
own. An agent searching for a specific ticket subject gets no results until they
happen to click "Next" and back.

**How I'd fix it:** Add `search, status, priority, sortBy` to the effect's dependency
array (and reset `page` to 1 on filter change, so a narrower result set doesn't strand
the user past its last page).

*I ended up fixing this one anyway, as a side effect of Part 2 — the "breached only"
filter I added needs a working refetch to do anything at all, so leaving this bug in
place would have meant shipping a filter that doesn't filter. See `DECISIONS.md`.*

**Severity:** Medium (correctness, high visibility, no data risk).

---

## 7. Race condition in ticket assignment — documented only

**Where:** `server/src/services/ticketService.js:89–102`, `assignTicket`.

**What's wrong:** It's a non-atomic check-then-act: `SELECT` the ticket, check
`assignee_id` in JavaScript, then `UPDATE`. Two concurrent `PATCH /:id/assign` calls
for the same unassigned ticket can both pass the check before either `UPDATE` runs.

**Why it matters here:** Two agents clicking "Claim" within the same moment (a
realistic scenario right after a P1 comes in and gets discussed on a team channel)
could both get told they successfully claimed it, with whichever `UPDATE` ran last
silently overwriting the other's claim — no `409` for the loser, unlike the intended
behaviour.

**How I'd fix it:** Make it one atomic statement: `UPDATE tickets SET assignee_id = ?,
status = 'pending' WHERE id = ? AND assignee_id IS NULL`, then check `affectedRows` to
decide `conflict` vs success, instead of a separate `SELECT`.

**Severity:** Medium (data-integrity edge case, low frequency, no security impact).

---

## 8. N+1 query for comment counts — documented only

**Where:** `server/src/services/ticketService.js:44–47` (original).

**What's wrong:** One extra round trip to the database per row on every page load — 20
extra queries for a full page of 20 tickets.

**Why it matters here:** Bounded (page size is fixed at 20) so it's not a runaway
problem, but it's needless latency on the single most-loaded endpoint, and it's the
kind of pattern that gets much worse if `PAGE_SIZE` or a "load more" pattern ever
changes.

**How I'd fix it:** One batched query with `WHERE ticket_id IN (...)` and `GROUP BY`
for the whole page. *I did fix this — see the Part 2 commit for `listTickets`; it was a
small, low-risk change made while already touching this function for the SLA work, not
one of the five.*

**Severity:** Low (performance, not correctness or security).

---

## 9. Secrets committed to the repository — documented only

**Where:** `server/.env` (committed — `.gitignore` at the repo root does not exclude
`.env`, only `node_modules/`, `dist/`, `*.log`), `server/src/config.js:16` (JWT secret
falls back to the literal string `'dev-secret-change-me'` if `.env` is ever missing).

**What's wrong:** A real-looking DB password (`Hd_pr0d_2026_Wq8x`) and a real JWT
signing secret are sitting in a tracked file, and the code has a hardcoded fallback
secret that would silently activate if the env var were ever unset in a real
deployment.

**Why it matters here:** For this exercise the risk is low (it's a private take-home
repo), but the pattern itself is exactly how production secrets end up in `git log`
forever. The hardcoded fallback is worse in principle: it means a misconfigured deploy
fails "safely" (the app still boots) instead of loudly, with every token in that
deployment signed by a secret anyone can read in the source.

**How I'd fix it:** Add `.env` to `.gitignore`, rotate the DB password and JWT secret,
and make `config.js` throw on boot if `JWT_SECRET` isn't set, rather than falling back
to a default.

**Severity:** Medium (real practice, low likelihood in this specific context).

---

## 10. No rate limiting on login — documented only

**Where:** `server/src/routes/auth.js:9–36`.

**What's wrong:** No throttling, lockout, or delay on repeated failed logins.

**Why it matters here:** Password brute-forcing is straightforward against this
endpoint today. Every seeded account currently shares the same password, which makes
this more of a real risk in this specific dataset than it would be with unique
passwords — though that's a seed-data property, not something I'd change in fixing
this finding.

**How I'd fix it:** Add a per-IP and/or per-account rate limit (e.g.
`express-rate-limit`) and/or a short exponential backoff after repeated failures on the
same account.

**Severity:** Medium (standard hardening, not urgent for this app's current exposure).

---

## 11. Client-supplied `isInternal` flag is trusted — documented only

**Where:** `server/src/routes/comments.js:11,24` (original).

**What's wrong:** `isInternal` comes straight from `req.body` with no check on the
caller's role. The client always sends `isInternal: false`
(`TicketDetail.jsx`, `addComment`), but nothing stops a direct API call from a
`requester` account setting it to `true`.

**Why it matters here:** Low impact today — the only difference `is_internal` makes is
a background colour in the UI (`styles.css:.comments li.internal`); it isn't currently
used to hide comments from requesters. It's worth flagging because the *name* implies a
trust boundary ("internal" = staff-only) that the code doesn't actually enforce, and if
someone later builds visibility rules on top of this flag without revisiting this
route, a requester could mark their own comment as if it were an internal staff note.

**How I'd fix it:** Only honour `isInternal: true` when `req.user.role` is `agent` or
`admin`; otherwise force it to `false` server-side regardless of what the client sent.

**Severity:** Low today; worth fixing before this flag is used for anything that
actually restricts visibility.

---

## 12. `priority` not validated before insert — documented only

**Where:** `server/src/routes/tickets.js:43–60` (original), `createTicket`.

**What's wrong:** `priority` from the request body is passed straight to the `INSERT`
with no check against the enum (`P1`/`P2`/`P3`).

**Why it matters here:** An invalid value doesn't fail gracefully — MySQL rejects it at
the `INSERT`, the error falls through to the generic error middleware
(`server/src/index.js:18–21`), and the caller gets an opaque `500 Internal server
error` instead of a clear `400`. Not a security issue (the error handler doesn't leak
details), just a rough edge.

**How I'd fix it:** Validate `priority` against `['P1','P2','P3']` in the route
handler and return `400` for anything else, same as the existing `subject`/`body`
check.

**Severity:** Low (input validation / UX, no security or data-integrity impact).

---

## Fixed (findings 1–5)

Commits, in order:

1. `fix(security): enforce org scoping and role checks on ticket routes`
2. `fix(security): invite/accept no longer allows anonymous password overwrite`
3. `fix(security): stop rendering comment bodies as raw HTML (stored XSS)`
4. `fix(security,bug): whitelist ticket sort column/order; fix pagination offset`
   (findings 4 and 5 together — same function, same commit, each still listed and
   ranked separately above since they're unrelated bugs)

Findings 6–12 are documented above but left untouched, except where noted inline (6 and
8 ended up touched as necessary/low-risk side effects of Part 2 work, explained in
`DECISIONS.md`).
