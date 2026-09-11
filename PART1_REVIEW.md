# Part 1 — Code Review

Findings are ranked strictly from **most → least critical** based on exploitability $\times$ blast radius. Findings **1–5 were fixed** in separate commits; **6–12 are documented only**.

---

## 🏆 Ranked Findings Overview

| # | Finding | Category | Status |
| :-: | :--- | :--- | :-: |
| **1** | Broken Access Control on Ticket Routes | Authorization / Org Scoping | **FIXED** |
| **2** | Unauthenticated Password Overwrite via `invite/accept` | Account Takeover / DoS | **FIXED** |
| **3** | Stored XSS via Comment Body | Session Theft / XSS | **FIXED** |
| **4** | SQL Injection via `sortBy` / `order` | SQL Injection / DoS | **FIXED** |
| **5** | Pagination Off-by-One Skips Newest Tickets | Functional Bug | **FIXED** |
| **6** | List Filters Never Trigger Refetch | Frontend UX Bug | Documented |
| **7** | Race Condition in Ticket Assignment | Concurrency / Integrity | Documented |
| **8** | N+1 Query for Comment Counts | Performance | Documented |
| **9** | Secrets Committed & Weak Fallback Secret | Hardening | Documented |
| **10** | No Rate Limiting on Login Endpoint | Brute-Force Risk | Documented |
| **11** | Unchecked Client-Supplied `isInternal` Flag | Privilege Escalation | Documented |
| **12** | Missing `priority` Enum Validation | Input Validation | Documented |

---

## 🛑 Top 5 Fixed Findings

### 1. Broken Access Control on Ticket Routes
- **Where**: `server/src/routes/tickets.js:31–84` (`GET /:id`, `PATCH /:id/assign`, `DELETE /:id`)
- **Issue**: Handlers omit `ticket.org_id === req.user.orgId` checks. `assign` and `delete` lack role authorization.
- **Impact**: Any user can view, claim, or delete tickets belonging to other customer organizations. Requesters can execute agent/admin actions.
- **Fix**: Added org-scoping validation (`404` for cross-org requests) and enforced `requireRole('agent', 'admin')` / `requireRole('admin')` middleware.
- **Severity**: **Critical**

### 2. Unauthenticated Password Overwrite (`invite/accept`)
- **Where**: `server/src/routes/auth.js:42–54`
- **Issue**: Endpoint requires no auth/invite token and stores unhashed passwords verbatim.
- **Impact**: Anonymous callers can overwrite any account's password (including admins), causing whole-tenant lockout.
- **Fix**: Password is hashed with bcrypt and updates are restricted to accounts where `password_hash IS NULL`.
- **Severity**: **Critical**

### 3. Stored XSS via Comment Body
- **Where**: `client/src/features/tickets/TicketDetail.jsx:65`
- **Issue**: Uses `dangerouslySetInnerHTML={{ __html: c.body }}` without HTML sanitization.
- **Impact**: Malicious scripts execute in agent/admin browsers, allowing session token theft from `localStorage`.
- **Fix**: Rendered comment bodies as plain text (`{c.body}`), leveraging React's built-in auto-escaping.
- **Severity**: **Critical**

### 4. SQL Injection via `sortBy` / `order`
- **Where**: `server/src/services/ticketService.js:38`
- **Issue**: Unsanitized query string parameters interpolated directly into `ORDER BY t.${sortBy} ${order}`.
- **Impact**: Time-based blind SQL injection (`sortBy=id,(SELECT SLEEP(3))`) causing API connection pool exhaustion.
- **Fix**: Whitelisted `sortBy` against allowed column names and `order` against `asc`/`desc`.
- **Severity**: **Critical**

### 5. Pagination Off-by-One Skips Newest Tickets
- **Where**: `server/src/services/ticketService.js:29`
- **Issue**: Calculates `offset = page * PAGE_SIZE` instead of `(page - 1) * PAGE_SIZE`.
- **Impact**: Page 1 defaults to skipping the 20 newest tickets in the organization.
- **Fix**: Updated offset formula to `(page - 1) * PAGE_SIZE` with `Math.max(1, page)` clamping.
- **Severity**: **High**

---

## 📝 Documented Findings (6–12)

### 6. List Filters Never Trigger Refetch
- **Where**: `client/src/features/tickets/TicketList.jsx:21–31`
- **Issue**: `useEffect` dependency array only contains `[page]`.
- **Impact**: Changing search, status, priority, or sort dropdowns does not update displayed results until page navigation occurs.
- **Fix**: Add filter state variables to `useEffect` dependency array.

### 7. Race Condition in Ticket Assignment
- **Where**: `server/src/services/ticketService.js:89–102`
- **Issue**: Non-atomic check-then-act (`SELECT` followed by `UPDATE`).
- **Impact**: Concurrent claims by two agents can both succeed, silently overwriting assignee status.
- **Fix**: Execute single atomic `UPDATE tickets SET assignee_id = ? WHERE id = ? AND assignee_id IS NULL`.

### 8. N+1 Query for Comment Counts
- **Where**: `server/src/services/ticketService.js:44–47`
- **Issue**: Issues 20 separate DB queries per page load to fetch comment counts.
- **Impact**: Unnecessary database round-trips and increased latency on ticket listing endpoint.
- **Fix**: Batch query using `WHERE ticket_id IN (...) GROUP BY ticket_id`.

### 9. Secrets Committed & Weak Fallback Secret
- **Where**: `server/.env` and `server/src/config.js:16`
- **Issue**: Tracked `.env` containing DB credentials and fallback JWT secret `'dev-secret-change-me'`.
- **Impact**: Exposure of secrets in source control and insecure silent fallbacks in production.
- **Fix**: Add `.env` to `.gitignore` and throw explicit error on boot if `JWT_SECRET` is unset.

### 10. No Rate Limiting on Login Endpoint
- **Where**: `server/src/routes/auth.js:9–36`
- **Issue**: No throttling or lockout mechanism on repeated failed logins.
- **Impact**: Vulnerable to automated credential brute-forcing attacks.
- **Fix**: Implement `express-rate-limit` middleware on `/api/auth/login`.

### 11. Unchecked Client-Supplied `isInternal` Flag
- **Where**: `server/src/routes/comments.js:11,24`
- **Issue**: Accepts `isInternal` from request body without role verification.
- **Impact**: Requesters could theoretically craft requests to mark comments as internal staff notes.
- **Fix**: Restrict `isInternal: true` setting to users with `agent` or `admin` roles server-side.

### 12. Missing `priority` Enum Validation
- **Where**: `server/src/routes/tickets.js:43–60`
- **Issue**: `priority` parameter passed directly to `INSERT` statement without enum check.
- **Impact**: Invalid values trigger unhandled DB errors resulting in opaque `500` HTTP responses.
- **Fix**: Validate `priority` against `['P1', 'P2', 'P3']` and return `400 Bad Request` for invalid inputs.

---

## 🛠️ Summary of Commits (Top 5 Fixes)

1. `0444689` `fix(security): enforce org scoping and role checks on ticket routes`
2. `5475445` `fix(security): invite/accept no longer allows anonymous password overwrite`
3. `04f7203` `fix(security): stop rendering comment bodies as raw HTML (stored XSS)`
4. `3a9f5e8` `fix(security,bug): whitelist ticket sort column/order; fix pagination offset`

