# Part 2 — Decision notes

## What "responded" means

The spec says a ticket is breached if "we have not responded within the target." It
doesn't define "responded." I decided: **the earliest comment that is (a) not internal
and (b) authored by a user with role `agent` or `admin`.**

- A requester's own follow-up comment doesn't count — they can't be the one who
  answered themselves.
- An internal-only note (`is_internal = 1`) doesn't count — the customer hasn't
  actually heard anything yet, and the whole point of "unanswered too long" is about
  what the requester experiences.

This is implemented as a single SQL join (`server/src/services/sla.js`,
`FIRST_RESPONSE_JOIN_SQL`) rather than fetched per-ticket in JavaScript, so it's cheap
at list-page scale and the breach filter (below) can be expressed as SQL too.

## What happens to breach status once a ticket is resolved/closed

Not addressed by the spec. I decided **breach is a historical fact about whether the
target was met, independent of current status.** If a ticket was never responded to
before its target elapsed, it's breached — whether it's still `open` or was later
`resolved`/`closed` without ever getting a real reply. I considered clearing the badge
once a ticket leaves `open`/`pending`, but that would hide exactly the tickets support
most needs visibility into: the ones that got closed *without* the customer ever
hearing back. The `breached=true` filter still returns these regardless of status.

If Support wants a "breached and still open" view specifically, that's a `status` +
`breached` filter combination away — both are already independent query params.

## What counts as "now" for computing breach

Server clock, computed once per request (`new Date()` in `listTickets`/passed as a bound
parameter into the SQL condition) so the SLA fields on every row in a page, and the
`total` count, are consistent with each other within one response. I did not use SQL's
`NOW()` directly in both the row query and the count query, since those are two
separate round trips that could (rarely) straddle a clock tick and disagree at the
margin.

## Filtering to breached tickets, and pagination correctness

The spec says "Add a filter so the list can return only breached tickets." Because
breach isn't a stored column, the straightforward-looking approach — fetch a page,
compute breach in JavaScript, filter — would silently break pagination and the `total`
count (you'd filter *after* `LIMIT`, so a page of 20 could shrink to fewer breached
rows, and `total` would count all tickets, not all breached ones). I expressed the
breach condition directly in SQL (`SLA_BREACHED_CONDITION_SQL`) and reused it in both
the row query's `WHERE` and the `total` count query, so `total`, `rows.length`, and
`pageCount` all agree. I checked this against an independent hand-written SQL query
for Northwind's seed data and got an exact match (81/81 breached tickets).

## Where the target hours live

The spec points at `server/src/config.js`'s `slaTargets` as the source of truth. I kept
it that way rather than duplicating the numbers in SQL: the SQL `CASE` expression is
built at module-load time from `config.slaTargets` (`server/src/services/sla.js`), so
changing a target in `config.js` changes behaviour everywhere without touching SQL.
(The generated SQL string embeds our own config values, not user input, so this isn't a
repeat of the sortBy injection finding.)

## Part 1 finding that changed how Part 2 was built

`TicketList`'s data-fetching `useEffect` only watched `page` (Part 1 finding #6), so
search/status/priority/sortBy never triggered a refetch. Adding a "breached only"
checkbox that also didn't refetch would have shipped a broken control, so I fixed the
dependency array as part of this feature rather than working around it — it's the same
function I was already extending, and the alternative (bolting a separate,
inconsistent fetch path onto just the new checkbox) would've been worse for the
codebase than the extra line in the diff. This is called out in the Part 2 client
commit message and in `PART1_REVIEW.md` finding #6.

## Edge cases

- **Ticket with zero comments:** `firstResponseAt` is `null`; breached only once
  `now > dueAt`. Verified against seed data (ticket #145, no comments, not yet due,
  correctly reported not breached).
- **`page` out of range / non-numeric:** clamped to a minimum of 1 in `listTickets`
  (pre-existing code already did `Number(page) || 1` at the route level; I added the
  `Math.max(1, ...)` clamp in the service while fixing the pagination bug).
- **Priority values outside `P1`/`P2`/`P3`:** can't currently occur — the DB column is
  an `ENUM('P1','P2','P3')` — so the SQL `CASE` doesn't need a default branch. If that
  enum is ever widened without updating `slaTargets`, a ticket with no matching `CASE`
  branch would get `NULL` target hours and therefore `NULL` due date; I left this
  un-guarded deliberately rather than picking a silent fallback target, since a
  missing SLA target for a new priority is a config gap that should be visible (a
  `NULL` due date), not papered over.
- **Client-side rendering when `sla` is briefly absent** (e.g. mid-load): the detail
  page guards with `ticket.sla &&` and the list badge with `t.sla?.breached &&`, so
  nothing throws before the first response lands.

## Tests

I didn't add an automated test suite (the constraint says tests are welcome, not
required). Instead I verified every code path against the live app and the seeded
data, using curl against the running server and a hand-written cross-check SQL query
run directly against MySQL — described inline in `PART1_REVIEW.md` and above. I'd
reach for tests first if this were headed to production: at minimum, one test per SLA
edge case above (no comments, internal-only response, requester self-reply, exactly-at
the due boundary) plus one asserting the `breached=true` filter's `total` matches an
unfiltered scan, since that's the part most likely to silently drift if the SQL is
ever refactored.
