# AI log

I used Claude for essentially this whole exercise: reading the codebase, drafting the
review, writing and testing the fixes, and building the SLA feature. Roughly, the
prompts were: "read this codebase like a PR reviewer and find real bugs, not lint
issues," then "verify each finding actually reproduces against the running app before
writing it up," then "implement and test the top five fixes, one at a time, commit
each separately," then "build the SLA breach feature per this spec, deciding the open
questions and documenting them."

I did not take findings on faith — every security finding in `PART1_REVIEW.md` was
reproduced against the running app (MySQL + the actual API, seeded with `npm run
db:reset`) with curl, not just read off the source and assumed. Where the model's first
draft of something was wrong, here's what happened and how I caught it:

## Where it was wrong

**SQL parameter count mismatch in the SLA breach filter.** The first version of
`SLA_BREACHED_CONDITION_SQL` was drafted with the assumption that it needed two `?`
placeholders for "now" (one for each side of an OR-like check), and the calling code in
`listTickets` pushed `now, now` into the params array to match. The actual SQL only
had one `?`. Running `GET /api/tickets?breached=true` against the live server threw a
MySQL `ER_PARSE_ERROR` — the extra param shifted every parameter after it by one
position, so `LIMIT ?` ended up bound to a timestamp string instead of the page size,
and the error message showed the literal (wrong) SQL. Caught immediately because I was
running it against a real server rather than trusting it compiled; fixed by counting
the actual `?` occurrences in the string and pushing exactly one `now`. I then
cross-checked the fixed version by writing an independent SQL query by hand and running
it directly against MySQL — it returned the same count (81) as the API for Northwind's
breached tickets, which is the check I'd trust over "the code looks right."

**Backticks in a git commit message got executed by the shell.** I passed a commit
message to `git commit -m "..."` inside double quotes that contained backtick-quoted
code fragments like `` `ORDER BY` `` and `` `(page - 1) * PAGE_SIZE` `` — meant purely
as Markdown-style code formatting in the message text. Double-quoted strings in the
shell *do* expand backticks as command substitution, so the shell tried to execute
`page - 1) * PAGE_SIZE` as a command, failed with "page: not found," and silently
stripped those spans out of the actual commit message. Caught by reading back the
committed message with `git log --format=%B` right after and noticing the code spans
had vanished; fixed by rewriting the message to a file and using `git commit -F
<file>`, then `--amend`-ing the affected commit.

**A time-based SQL-injection proof-of-concept made the tool call itself time out.**
While confirming the `sortBy` injection finding, a `sortBy=id,(SELECT SLEEP(3))`
request against the (then still vulnerable) endpoint caused the shell command running
it to exceed the tool's own execution time limit and get killed before returning. Not
"wrong" exactly, but worth logging: I initially read the timeout as an ambiguous
failure and had to check the server's log file afterward, once it recovered, to
confirm the request really had executed the injected `SLEEP(3)` server-side (it had —
the log showed the query hanging on the literal injected SQL) rather than just
guessing that a timeout implied a vulnerability.

**Long-lived background processes kept dying between tool calls.** Early on I started
the API server with a plain `&` background job and it was gone by the next command —
no error, no log, just not there. I initially assumed `setsid`/`nohup` would fix it,
but even that was inconsistent in this sandbox. I caught this only because I always
`curl`'d a health check immediately after claiming to have started the server, rather
than assuming a "success"-looking command meant the process was actually still running
a step later — several early verification attempts came back with empty output for
exactly this reason before I switched to running "start server → test → stop server"
as one self-contained command each time.

## What I didn't just take on faith

- I ran the actual `npm run db:reset` against a real MySQL instance for every fix and
  for the final feature, rather than reasoning about the schema/seed script from
  reading it. (Setting up MySQL itself in this environment wasn't something the model
  got right first try either — the first `apt-get install mysql-server` attempt failed
  on an unrelated repository error from a Node.js apt source, unrelated to MySQL, and
  needed a second look at the log to confirm the MySQL package itself had actually
  installed successfully despite the noisy failure line.)
- Each of the five fixes was exercised with a positive and a negative case (e.g. for
  the access-control fix: confirm a cross-org request now gets `404`, *and* confirm a
  legitimate same-org admin action still gets `204`) rather than just confirming the
  vulnerability was closed.
- The client (`TicketList.jsx`/`TicketDetail.jsx`) changes were checked with an actual
  `vite build` to catch JSX/syntax mistakes, since there was no browser available to
  click through the UI in this environment — I could not visually confirm the badge
  styling or checkbox behavior in a rendered browser, which is a real gap in this
  verification and worth a human double-check before merging.

"I did not use AI" would not be an honest answer here — I want to be upfront that this
whole submission, including this log, was produced by an AI assistant working through
the exercise directly, verifying its own claims against a real running instance of the
app rather than by inspection alone.
