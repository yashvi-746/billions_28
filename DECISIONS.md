# Part 2 — Decision Notes

This document summarizes the architectural decisions made for the SLA breach tracking feature where the spec was ambiguous or silent.

---

## 1. What "Responded" Means
- **Decision**: The earliest comment that is **(a) not internal (`is_internal = 0`)** and **(b) authored by an `agent` or `admin`**.
- **Rationale**: Requesters cannot answer their own tickets, and internal notes are invisible to customers.
- **Implementation**: Single SQL `LEFT JOIN` (`FIRST_RESPONSE_JOIN_SQL`) rather than per-ticket JS fetching to maintain high performance.

---

## 2. Breach Persistence on Resolved/Closed Tickets
- **Decision**: Breach status is a **historical fact** about whether the target was met before the first response.
- **Rationale**: A ticket closed without a timely response remains breached. Support needs visibility into tickets resolved without meeting SLA targets.

---

## 3. Server Clock & SQL Pagination Integrity
- **Decision**: Evaluated once per HTTP request (`new Date()`) and passed into SQL queries.
- **Rationale**: Expressing breach status directly in SQL (`SLA_BREACHED_CONDITION_SQL`) ensures `total` counts, `pageCount`, and row limits (`LIMIT`/`OFFSET`) stay 100% accurate. Verified against seed data (81 breached tickets for Northwind).

---

## 4. Single Source of Truth for SLA Targets
- **Decision**: SQL `CASE` statements are dynamically generated from `server/src/config.js` (`slaTargets`).
- **Rationale**: Changing config targets automatically updates backend logic without altering SQL templates.

---

## 5. Part 1 Finding That Impacted Part 2
- **Decision**: Fixed `TicketList` filter refetch dependency array (Part 1 Finding #6).
- **Rationale**: Without this fix, checking "Only breached" would not trigger a refetch. Fixed alongside the new checkbox UI.

---

## 6. Edge Cases & Verification
- **Zero Comments**: `firstResponseAt` is `null`; breaches only when `now > dueAt`.
- **Page Clamping**: Clamped to a minimum of 1 (`Math.max(1, ...)`).
- **Verification**: Validated against live MySQL seed data with curl and hand-written SQL queries.

