# Mock membership API (for testing UnO auto-renewal)

10 fake members split between a car wash plan ("2 washes/week") and a gym plan
("daily access"), both $200/month, with a realistic spread of expiry dates and
usage levels. "Today" is hardcoded as **2026-10-03** so results stay stable
regardless of when you actually run it.

No npm install needed -- it's plain Node, zero dependencies.

## Run it

```bash
node server.js
# Mock gym/carwash membership API listening on port 3000
```

To deploy on `gym.saasberry.in`: copy this whole folder to the server and run
`node server.js` behind your usual reverse proxy (nginx/Caddy), or point a
process manager (pm2, systemd) at `server.js`. `PORT` env var is respected.

## The 10 members

| ID   | Name         | Plan           | Expiry     | Visits/Req | Case                                  |
|------|--------------|----------------|------------|------------|----------------------------------------|
| M001 | John Carter  | Car wash       | 2026-10-05 | 9 / 8      | Over quota, expires in 2 days -> renew |
| M002 | Priya Nair   | Gym            | 2026-10-04 | 26 / 24    | Met quota, expires tomorrow -> urgent  |
| M003 | Alex Wong    | Car wash       | 2026-10-10 | 8 / 8      | Exactly met, 7-day window boundary     |
| M004 | Sara Kim     | Gym            | 2026-10-06 | 12 / 24    | Under quota -> nudge, not auto-renew   |
| M005 | Ben Torres   | Car wash       | 2026-10-02 | 4 / 8      | Already expired + under quota -> lapse |
| M006 | Maya Shah    | Gym            | 2026-10-08 | 0 / 24     | Zero visits -> clear non-renewal       |
| M007 | Liu Chen     | Car wash       | 2026-10-25 | 8 / 8      | Met quota but outside 7-day window     |
| M008 | Ravi Verma   | Gym            | 2026-10-03 | 24 / 24    | Expires TODAY, exactly met -> edge case|
| M009 | Emma Clarke  | Car wash       | 2026-10-09 | 7 / 8      | One visit short -> borderline fail     |
| M010 | Daniel Osei  | Gym            | 2026-10-20 | 25 / 25    | Met quota but outside window -> control|

Regenerate `data/attendance.json` any time with `node generate_attendance.js`
(it derives daily visit logs from `visitsThisMonth` in `members.json`).

## Endpoints

| Method | Path                                        | Purpose                                                        |
|--------|----------------------------------------------|------------------------------------------------------------------|
| GET    | `/api/health`                                 | Liveness check                                                   |
| GET    | `/api/v1/renewals`                            | Returns the sample Acme Corp renewal record                      |
| GET    | `/api/members`                                | Full member list (debugging)                                     |
| GET    | `/api/members/expiring?days=7`                | Members whose card expires within N days                         |
| GET    | `/api/members/:id/usage`                      | Visit count, requirement, and eligibility for one member         |
| GET    | `/api/members/eligible-for-renewal?days=7`    | **The one UnO should call.** Combines the two checks above and splits results into `eligible` (auto-renew) and `notEligible` (nudge). |
| POST   | `/api/members/:id/renew`                      | Mock-charges $200 and extends expiry by 1 month                  |

### Example: the one call that drives the whole workflow

```bash
curl "http://gym.saasberry.in/api/members/eligible-for-renewal?days=7"
```

```json
{
  "windowDays": 7,
  "eligible": [
    { "memberId": "M001", "name": "John Carter", "monthlyFee": 200, "visitsThisMonth": 9, "requiredVisits": 8, ... },
    { "memberId": "M002", "name": "Priya Nair", ... }
  ],
  "notEligible": [
    { "memberId": "M004", "name": "Sara Kim", "visitsThisMonth": 12, "requiredVisits": 24, ... }
  ]
}
```

### Note on Vercel deployment

The project directory is read-only once deployed (`EROFS` on write). The
server now writes renewals to `/tmp/members.runtime.json` instead of the
bundled `data/members.json`, and reads from that file first if it exists.

This means: renewals persist for as long as the same serverless instance
stays warm, then reset to the clean seed data on the next cold start (which
happens often, could be minutes). Fine for testing the workflow logic --
not meant to survive as real state. For anything that needs to actually
persist, swap in Vercel KV, Postgres (Neon/Supabase), or similar.

### Mock payment failure (to test UnO's error handling)

A member renews successfully unless their `memberId`'s last digit is
divisible by 7 (none of the 10 defaults trigger this). Add a member ending in
`M007`/`M014`/etc. or rename one temporarily to test the declined-charge path
(`POST /renew` returns HTTP 402).

## Wiring this into the UnO workflow

Collapses the 3-step GET_EXPIRING / GET_USAGE / FILTER_ELIGIBLE chain from
before into **one REST task**, since this mock API does the join for you:

```
1. CHECK_ELIGIBLE_MEMBERS   (REST GET /api/members/eligible-for-renewal?days=7)
2. RENEW_MEMBER             (foreach over step 1's "eligible" list)
                               -> REST POST /api/members/${entry.value.memberId}/renew
3. NOTIFY_NOT_ELIGIBLE      (foreach over step 1's "notEligible" list)
                               -> REST call to your email/SMS provider
4. SUMMARY_REPORT           (follows 2 and 3)
```

Point the UnO REST task's endpoint definition at
`http://gym.saasberry.in` (or `http://localhost:3000` while testing locally),
no credentials needed since this mock has no auth layer -- add one before
this touches anything real.
