# Performance

Performance is treated as a product feature, not an optimisation phase. The
budgets below are targets to measure against, not guarantees.

## Budgets

| Path | Target |
| --- | --- |
| Typical read, p95 | < 300 ms |
| Booking transaction, p95 | < 700 ms excluding the payment provider |
| Discovery home, p95 | < 400 ms |
| Cold start to first content | < 2 s on 4G |
| Frame rate | 60 fps floor, 120 fps where the display allows |

## Backend

**One aggregating call for the home screen.** `GET /v1/discovery/home` returns
every section. Eight section requests would each pay mobile-network latency
before anything could paint.

**Index-assisted geo filtering.** `ST_DWithin` against the GiST index on
`venues.location` filters before any join work, rather than computing a distance
for every venue in the country.

**LATERAL for the next slot.** Stops at the first matching row per offer instead
of aggregating the whole slots table and discarding all but the earliest.

**Every list is bounded.** Cursor pagination, hard `LIMIT`s, and a cap on map
pins that reports `truncated` so the UI can say "zoom in" rather than silently
showing a subset.

**Denormalised aggregates.** `venues.average_rating_hundredths` and `review_count`
are maintained on write; the feed would otherwise aggregate the reviews table per
card.

**Deliberate N+1 avoidance.** The business booking list resolves first-visit
status for the whole page in one query — the obvious per-row version is exactly
what makes a busy front desk feel slow.

## Mobile

**Cached-first navigation.** Tapping an offer prefetches its detail on
*press-in*, roughly 100 ms before navigation commits, so the detail screen
usually has data before it mounts. No white loading flash.

**Skeletons, never full-screen spinners.** They keep layout stable and remove the
content jump that makes an app feel cheap. The pulse runs on the UI thread via
Reanimated, so it keeps animating while the JS thread parses the response.

**Image variants.** Cards use `thumbnail`, galleries use `medium`/`large`. A feed
never downloads a 4000×3000 original to draw a 160 px tile.

**FlashList for long lists.** Recycles views instead of mounting one per row.

**Cache policy matched to volatility.** Discovery is stale-tolerant (5 min);
availability is treated as *always* stale and refetched on mount, because a stale
slot walks the user into a booking that fails.

**Debounced input.** Search waits 300 ms; the map viewport waits 400 ms. Querying
per keystroke or per pan frame wastes data and makes results flicker as
out-of-order responses land.

## Measure before optimising

Nothing here should be tuned on intuition. Before changing a query: `EXPLAIN
(ANALYZE, BUFFERS)`. Before changing a screen: the React Native profiler, looking
for re-renders, long JS tasks, oversized images and slow list items.

The discovery queries are written as explicit SQL partly so they can be pasted
into EXPLAIN unchanged.

## Not yet measured

No query has been run against a populated database, and no screen has been
profiled on a device. Every number above is a target, not an observation. Load
testing discovery, availability and booking is the first task of Phase 7.
