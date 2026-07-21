# Libretto

[Kometa](https://kometa.wiki/) for your book stack. Libretto builds and maintains collections in [Kavita](https://www.kavitareader.com/) and [Audiobookshelf](https://www.audiobookshelf.org/) from recipes: declarative YAML files that say "this list of books belongs together, in this order, in these libraries". One recipe can target **both** servers at once, so the same collection spans your ebooks and audiobooks. Items a recipe wants but your library lacks become an honest missing report, which — when a recipe opts in — Libretto feeds to [LazyLibrarian](https://lazylibrarian.gitlab.io/) to drive acquisition.

> **Status: pre-alpha (M3, acquisition).** Real Kavita and Audiobookshelf clients are live next to the M1 walking skeleton: the `hardcover_series` and `nyt_list` builders resolve, respectively, a [Hardcover](https://hardcover.app/) series and a [New York Times](https://developer.nytimes.com/docs/books-product/1/overview) bestseller list into an ordered, identifier-keyed work list, and the reconciler materializes it as a Kavita collection or reading list, or an Audiobookshelf collection. **M3 wires `missing[]` into LazyLibrarian** so a recipe can acquire what your library lacks (see [The acquisition leg](#the-acquisition-leg-m3)) — with `nyt_list` that means the estate can CHASE the current bestseller list. Remaining before beta: the Wikidata builder, and hardening. The architecture is written up in the [design document](https://github.com/thaynes43/haynesnetwork/blob/main/docs/designs/037-libretto-architecture.md).

Libretto is Kometa-like on purpose: YAML recipes in, collections out, logs and a REST API to watch it work. There is no built-in web interface; the API exists for automation and for other frontends to bind to.

## The stateless philosophy

Libretto keeps no database: recipes are YAML files you own, run history is a rotating JSON file, and ownership of the collections it produces is recovered from the targets themselves through a provenance marker embedded in each collection description. You can delete everything except your recipes folder and lose nothing that matters.

The marker is `[libretto:<recipeId>]`, or `[libretto:<recipeId>|cat=<Category>]` when the recipe sets a [category](#categories). A [multi-target](#multiple-targets-one-collection-across-kavita-and-audiobookshelf) recipe writes the SAME marker into every server's collection — the shared recipe id is how a downstream reader (for example a wall that merges your ebook and audiobook shelves) knows the two are one collection.

### The marker spike, resolved

Whether every target could actually carry that marker was an open design question. Verified from both projects' sources in M2:

- **Audiobookshelf: yes.** Collections have a writable `description` field on create (`POST /api/collections`) and update (`PATCH /api/collections/:id`), echoed back by every read.
- **Kavita: yes, on both container kinds.** Collection `summary` is writable via `POST /api/Collection/update` and reading-list `summary` via `POST /api/ReadingList/update`.

So the marker lives in the targets everywhere, and the sidecar ownership file the design held in reserve was never built.

### Identifier matching on Kavita, resolved

Kavita exposes ISBNs per **chapter** (that is, per book file), not per series: `GET /api/Series/volumes?seriesId=` and collect each chapter's `isbn`. Libretto does that per series and caches the result on disk (keyed by series id plus page count, so content changes refresh it). One honest caveat: Kavita only parses an epub ISBN when the OPF `<dc:identifier>` carries `opf:scheme="ISBN"` or an `isbn:`/`urn:isbn:` prefix it can validate. EPUB3 files without the scheme attribute yield no ISBN in Kavita, so such series cannot match on identifier alone. The conservative title fallback below recovers most of them; the rest appear in `missing[]`, and fixing the epub metadata (or re-tagging with a tool that writes the scheme attribute) is the permanent remedy.

Audiobookshelf is simpler: item metadata carries `isbn` and `asin` directly in the standard listing, no per-item fetches.

Matching is identifier-exact on both sides first (ISBN-10 is losslessly converted to ISBN-13; ASINs are uppercased). There is no title _fuzz_ — no edit-distance, no "close enough".

### Conservative title fallback (D-04)

Identifier matching is the ceiling only when both sides expose scheme'd identifiers, and Kavita epubs often do not. So when — and only when — a work finds no identifier match, Libretto tries one narrow fallback: a **noise-stripped exact full-title match**, guarded by author agreement, borrowing the conservative-pairing doctrine from the haynesnetwork ADR-065 book matcher. The rules that keep it honest:

- **Full-title equality after noise stripping** (case, diacritics, punctuation, a leading article, and bracketed edition/series tags folded away), never substring or prefix — so the franchise umbrella "Harry Potter" never absorbs "Harry Potter and the Chamber of Secrets".
- **Ambiguity is refused, never guessed.** If a normalized title maps to two or more distinct library items, or the author guard can't leave a single survivor, the work goes to `missing[]` rather than mispair.
- **Author is a guard applied when both sides supply it** (Audiobookshelf does; Kavita series carry none today): disjoint authors veto a title match; when either side has no author the full-title equality stands on its own.
- **Still no fuzz.** A US/UK divergence like _Sorcerer's Stone_ vs _Philosopher's Stone_ stays an honest miss.

Title-recovered items are **flagged** in the run: `counts.matchedByTitle` reports how many of `counts.matched` came from the fallback rather than an identifier (and each is logged with `matchedVia: "title"`). The fallback is **default-on**; set `variables.titleFallback: false` on a recipe to pin it to identifier-only matching.

## The acquisition leg (M3)

Today a recipe mirrors what your library already holds; works it wants but you lack land in `missing[]` and stop. Set `variables.acquisitionEnabled: true` (and configure `LAZYLIBRARIAN_URL` + `LAZYLIBRARIAN_API_KEY`) and Libretto takes the next step: it hands `missing[]` to [LazyLibrarian](https://lazylibrarian.gitlab.io/) as wants, and LazyLibrarian's own usenet-first provider priority does the hunting — SAB (usenet) first, MAM filling gaps only when its governor opens the gate. Libretto never touches provider priority or that governor; it only says "want these books".

Kavita recipes acquire **eBooks**; Audiobookshelf recipes acquire **AudioBooks**. LazyLibrarian tracks one book with two per-format statuses, so the format follows the recipe's target.

### Still stateless — LazyLibrarian is the ledger

There is no acquisition database. Every run recovers the truth from LazyLibrarian itself with a single `getAllBooks` call, which serves triple duty: the idempotency check (is this book already known and being acquired?), the resolver from a missing work to LazyLibrarian's `BookID`, and the per-format status read. Delete everything but your recipes and nothing is lost.

### The mechanism (verified against the real LazyLibrarian)

LazyLibrarian exposes a query-string command API. The commands and their real behavior were confirmed empirically against the deployed instance (build `40a389ea`, `BOOK_API=GoogleBooks`) before this was built:

- **`getAllBooks`** returns the whole book table — `BookID` (a Google Books volume id), `BookName`, `BookIsbn`, and the two per-format statuses `Status` (eBook) and `AudioStatus` (AudioBook). Reliable: it reads LazyLibrarian's own database, no Google Books call.
- **`queueBook&id=&type=eBook|AudioBook`** marks a format Wanted; **`searchBook&id=&type=`** fires the hunt. Both operate on a `BookID` already in the database, so they are the reliable, Google-Books-free drive.
- **`addBook&id=<volumeId>`** introduces a book by a known Google Books **volume id** — a specific, exact ingest that does not depend on LazyLibrarian's own keyless ISBN search. This is the path the **resolve broker** drives (see below).
- **`addBookByISBN&isbn=`** introduces a book by ISBN, resolving it on **LazyLibrarian's own Google Books budget**. Best-effort: the deployed instance's anonymous quota is throttled and often answers `No results for <isbn>`, which Libretto treats as a soft skip and retries on a later run. Kept as the **fallback** for when the resolve broker is unconfigured or returns no match.
- `findBook` / `findAuthor` (LazyLibrarian's live Google Books search) return `[]` for every query in this deployment, so a keyless "search then add" path is not viable.

#### The resolve broker (ISBN-first) — the M3 resolution fix

The keyless `addBookByISBN` path resolves close to nothing in practice (LazyLibrarian's anonymous Google Books quota is throttled), so acquisition of _new_ books stalled. The **resolve broker** owns reliable ISBN → Google-Books-volume-id resolution **Libretto-side**, mirroring the haynesnetwork hardened resolver: it tries `isbn:<isbn>` **first** (exact, one call), then a **guarded** `intitle:+inauthor:` fallback (a title-token coverage guard and a surname author guard, so a fuzzy leg can never resolve a _wrong_ work — a guard failure is an honest null). It requires a Google Books API key (`GOOGLE_BOOKS_API_KEY`); with no key it is disabled and acquisition keeps the prior `addBookByISBN` behavior (no regression). When it resolves, Libretto adds the want with `addBook(<volumeId>)` — the reliable ingest — instead of the throttled ISBN search. Exposed as a reusable service at `POST /api/resolve`.

**A Google Books failure is never a silent no-match.** The broker separates a genuine miss (`200 totalItems:0` / a guard reject) from an upstream failure. Every non-200 from Google Books is logged with its HTTP status and Google's error reason (never the API key). A **daily-quota 429** (`RESOURCE_EXHAUSTED` / "Queries per day") **latches a breaker** on that resolver instance so the remaining Google Books calls in the same pass short-circuit rather than burning attempts into a dead quota; the latch self-heals after a short cooldown so the next scheduled pass re-probes once the quota resets. Failures stay `resolved: null` (so `addBookByISBN` fallback and any downstream self-heal are unchanged), and `/api/resolve` reports **why** in an additive `reason` field — `resolved` \| `no_match` \| `quota_exhausted` \| `upstream_error`.

Per missing work, per run:

1. **Resolve** it to a LazyLibrarian book already in the database — conservatively, exactly like the D-04 title fallback: normalized ISBN first, then noise-stripped title (with the author guard); **ambiguity is skipped, never a wrong add**.
2. **Already known and being acquired or held** (the format is `Wanted`, `Snatched`, `Open`, `Have`, `Matched`, or `Ignored`) → skip. Re-runs never duplicate.
3. **Known but the format is `Skipped`** (or untracked) → `queueBook` + `searchBook` for that format. This is the reliable drive.
4. **Unknown** → the **resolve broker** maps it (ISBN-first, guarded title fallback) to a Google Books volume id and `addBook(<volumeId>)`. If the broker is unconfigured or finds no match but the work has an ISBN → `addBookByISBN` fallback. No volume id and no ISBN → skipped with a logged reason. On success the book enters LazyLibrarian and is driven to a search on a later run (once `getAllBooks` reveals its `BookID`).

### Pacing

Acquisition is capped and polite by construction:

- `LIBRETTO_ACQUISITION_CAP_PER_RUN` (default `10`) bounds the number of acquisition **actions** (adds and queue-drives) per recipe run. Resolution-only skips (already handled, no ISBN) do not consume the cap; overflow is deferred to the next run.
- `LIBRETTO_ACQUISITION_INTERVAL_MS` (default `3000`) spaces LazyLibrarian write calls apart, estate-wide politeness in the spirit of the 25/hr backfill precedent.

### Run reporting

When a recipe runs acquisition, its run record carries an `acquisition` block alongside `counts`:

- `queued` — a format was queued + searched (an existing book driven to a hunt).
- `added` — a book newly introduced to LazyLibrarian by ISBN (pending queue + search on a later run).
- `skipped` — intentionally not acted on: already being acquired or held, no ISBN, LazyLibrarian could not resolve the ISBN this run, or the per-run cap was reached.
- `errors` — a LazyLibrarian call threw. Acquisition is best-effort and never fails the reconcile.

Every work is also logged with its reason. Acquisition runs **only** when `acquisitionEnabled` is true, so a normal recipe's run shape is unchanged.

## Quick start

Libretto ships as a single container with one volume at `/config`:

```sh
docker run -d \
  --name libretto \
  -p 8080:8080 \
  -v ./libretto-config:/config \
  -e LIBRETTO_API_KEY=change-me \
  -e KAVITA_URL=http://kavita:5000 \
  -e KAVITA_API_KEY=<user api key, from Kavita user settings> \
  -e ABS_URL=http://audiobookshelf:80 \
  -e ABS_TOKEN=<user api token or api key> \
  -e HARDCOVER_TOKEN=<from hardcover.app account settings> \
  ghcr.io/thaynes43/libretto:latest
```

Note: no image is published yet during pre-alpha, so build it locally first with `docker build -t ghcr.io/thaynes43/libretto:latest .`

Every connection is optional and validated at use, not at boot: with only `KAVITA_*` set, ABS recipes fail honestly at run time and everything else works. To try Libretto with no servers at all, set `LIBRETTO_FAKE_TARGET=1` and it serves an in-memory demo target instead.

Drop a recipe in `./libretto-config/recipes/` (or PUT it through the API) and apply:

```sh
# liveness (no key needed)
curl http://localhost:8080/health

# discover library ids for targets[].libraryId
curl -H 'Authorization: Bearer change-me' http://localhost:8080/api/targets

# save a recipe: The Expanse, in series order, into BOTH Kavita and Audiobookshelf
curl -X PUT http://localhost:8080/api/recipes/expanse \
  -H 'Authorization: Bearer change-me' \
  -H 'Content-Type: application/json' \
  -d '{
    "targets": [
      { "server": "kavita", "libraryId": "2" },
      { "server": "abs", "libraryId": "<abs-library-uuid>" }
    ],
    "name": "The Expanse",
    "builder": { "type": "hardcover_series", "ref": "the-expanse" },
    "variables": { "syncMode": "sync", "ordered": true, "schedule": "0 5 * * *" },
    "enabled": true
  }'

# apply it and watch the run (counts + missing[])
curl -X POST http://localhost:8080/api/apply \
  -H 'Authorization: Bearer change-me' \
  -H 'Content-Type: application/json' \
  -d '{ "scope": "expanse" }'
curl -H 'Authorization: Bearer change-me' http://localhost:8080/api/runs

# read back the produced collections (recovered from the targets by marker)
curl -H 'Authorization: Bearer change-me' http://localhost:8080/api/collections
```

For local development: `pnpm install`, then `pnpm dev` boots the fake-target setup with a dev API key (`dev-key`) on port 8080.

## Configuration

Everything lives on the `/config` volume (override with `CONFIG_DIR`):

```
/config
  recipes/     one YAML file per recipe, filename = recipe id; yours to edit,
               written by Libretto only on an explicit API save
  state/       runs.json, the last 50 run records (losable)
  cache/       TTL disk cache: resolved Hardcover series and NYT lists,
               per-series Kavita ISBN lookups (losable, rebuilds itself)
```

Environment variables (all connection settings are validated at use, not at boot):

| Variable                                     | Purpose                                                                                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LIBRETTO_API_KEY`                           | Bearer key for everything under `/api`. Unset means the API is locked.                                                                                                                                             |
| `KAVITA_URL`, `KAVITA_API_KEY`               | Kavita connection. The API key is a Kavita user API key; Libretto authenticates with it via the plugin flow.                                                                                                       |
| `ABS_URL`, `ABS_TOKEN`                       | Audiobookshelf connection. A user API token or an API key, sent as a Bearer token.                                                                                                                                 |
| `HARDCOVER_TOKEN`                            | [Hardcover](https://hardcover.app/) token for the `hardcover_series` builder. Tokens expire each January 1st.                                                                                                      |
| `LIBRETTO_FAKE_TARGET`                       | `1` serves the in-memory fake target for both server kinds (demo and tests).                                                                                                                                       |
| `CONFIG_DIR`                                 | Config volume path, default `/config`.                                                                                                                                                                             |
| `PORT`                                       | HTTP port, default `8080`.                                                                                                                                                                                         |
| `LOG_LEVEL`                                  | [pino](https://getpino.io/) level, default `info`.                                                                                                                                                                 |
| `LAZYLIBRARIAN_URL`, `LAZYLIBRARIAN_API_KEY` | [LazyLibrarian](https://lazylibrarian.gitlab.io/) connection for the acquisition leg (M3). The API key is the LazyLibrarian API key from its settings.                                                             |
| `GOOGLE_BOOKS_API_KEY`                       | Google Books API key for the ISBN-first resolve broker (the M3 resolution fix). Unset ⇒ the broker is disabled and acquisition falls back to `addBookByISBN`. `GOOGLE_BOOKS_URL` overrides the base URL for tests. |
| `LIBRETTO_ACQUISITION_CAP_PER_RUN`           | Max acquisition actions (LazyLibrarian adds + queue-drives) per recipe run. Default `10`.                                                                                                                          |
| `LIBRETTO_ACQUISITION_INTERVAL_MS`           | Spacing between LazyLibrarian write calls, in ms (estate politeness). Default `3000`.                                                                                                                              |
| `NYT_API_KEY`                                | [NYT Books API](https://developer.nytimes.com/docs/books-product/1/overview) key for the `nyt_list` builder. Free tier is roughly 500 requests/day and 5/minute; Libretto paces and caches accordingly.            |

### Notes on the target accounts

- **Kavita collections and reading lists are per-user.** Whatever account owns the `KAVITA_API_KEY` owns everything Libretto creates. Libretto asks Kavita to promote its creations so other users see them; that only takes effect if the account has the Promote (or Admin) role. Use the same account other sync tooling in your stack already uses.
- **Audiobookshelf collections are shared per-library**, so any account with update permission works.
- **Hardcover paces itself** to the documented 60 requests/minute and caches resolved series on disk for six hours, so scheduled re-runs are cheap.
- **NYT paces itself** to the free tier's roughly 5 requests/minute, retries a `429` with exponential backoff, and caches each resolved list on disk for six hours (the lists refresh weekly), so a daily schedule stays well under the ~500/day quota.

## Recipes

A recipe is one YAML file. The commented examples in [`examples/recipes/`](examples/recipes/) include a fake-target starter, a real Hardcover series, a NYT bestseller list, and a comics collection; [`examples/authors/`](examples/authors/) ships the [Authors program](#categories). The shape:

```yaml
id: expanse
targets: # 1..N, one library per server (at most one kavita and one abs)
  - server: kavita # kavita | abs
    libraryId: '2' # from GET /api/targets
  - server: abs
    libraryId: '<abs-library-uuid>'
name: The Expanse
category: Sci-Fi # optional; recorded in the marker as |cat=Sci-Fi
builder:
  type: hardcover_series # static_ids | hardcover_series | nyt_list | hardcover_comics
  ref: the-expanse # Hardcover series slug or numeric id
variables:
  syncMode: sync # sync reconciles membership and order; append only ever adds
  ordered: true # ordered on kavita = reading list; unordered = collection
  acquisitionEnabled: false # M3: hand missing[] to LazyLibrarian to acquire (default false)
  titleFallback: true # D-04: conservative title match when identifiers miss (default true)
  schedule: '0 5 * * *' # cron expression, or manual for API-only runs
enabled: true
```

What `ordered` materializes as, per target:

|                | `ordered: true`                     | `ordered: false`                       |
| -------------- | ----------------------------------- | -------------------------------------- |
| Kavita         | reading list (positions maintained) | collection (unordered by nature)       |
| Audiobookshelf | collection (natively ordered)       | collection (source order written once) |

Safety rules the reconciler enforces:

- Ownership keys on the provenance marker in the collection description, never on the name. A renamed collection stays owned; a same-name collection without the marker is never touched.
- `append` never removes. A run that matches zero items flags a warning and leaves the collection alone.
- Deleting a recipe orphans its collection in the target; nothing is deleted remotely.
- Unmatched works are reported in `missing[]`, never guessed at.

### Multiple targets (one collection across Kavita and Audiobookshelf)

A recipe declares `targets`: an array of 1..N `{ server, libraryId }` entries, at most one per server (one Kavita, one Audiobookshelf). Libretto resolves the builder **once** and materializes the SAME work list into EACH target, each carrying the SAME marker. So "The Expanse, in ebook and audiobook" is ONE recipe, not two — and because both collections share the recipe id, a downstream reader that merges your shelves sees them as a single collection.

Everything is per-target from there: the ordered → container-kind mapping (above) is applied to each target on its own, `missing[]` is computed against each target's library (a book you hold in Kavita but not Audiobookshelf is missing only from Audiobookshelf), and — with `acquisitionEnabled` — each target acquires its own format (Kavita → eBooks, Audiobookshelf → AudioBooks). A run therefore records one result per target, and `GET /api/collections` returns one entry per (recipe, target). One target being unreachable never blanks the other.

**Back-compat.** A single-target recipe may still be written with `targetLibrary: { server, libraryId }` instead of `targets`; Libretto normalizes it to a one-entry `targets[]` on save, so existing recipe files keep validating. Provide one or the other, never both. The stored/emitted shape is always `targets`.

### Categories

An optional `category` string tags the produced collection. It is recorded in the provenance marker — `[libretto:<recipeId>|cat=<Category>]` — so a reader can group collections without any Libretto-specific coupling (the token is plain marker text). Categories are free-form; keep them free of `[`, `]`, and `|` (the marker delimiters). Changing a recipe's category and re-applying re-writes just the marker token on the already-produced collections, preserving any human-edited description prose.

The shipped **Authors program** ([`examples/authors/`](examples/authors/)) is 21 famous-author recipes that each use `category: Authors` and target both servers — a ready-made, format-agnostic "an author's whole canon" collection set. They use `{ title, author }` static entries (below), so they carry no external ids and work on any estate once you set your own `libraryId`s.

### Builders

A builder turns `builder.ref` into the ordered work list the reconciler matches against your library. `GET /api/builders` reports which are available in your instance (an external-source builder needs its env set).

| `type`             | `ref`                                              | Source and order                                                                                                                      |
| ------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `static_ids`       | an array of identifiers and/or `{ title, author }` | The ref itself, in order. No external source. See the note below.                                                                     |
| `hardcover_series` | a Hardcover series slug or numeric id              | Every book in the series ordered by series position ([Hardcover](https://hardcover.app/); needs `HARDCOVER_TOKEN`).                   |
| `nyt_list`         | a NYT `list_name_encoded` slug                     | The current [NYT bestseller list](https://developer.nytimes.com/docs/books-product/1/overview) ordered by rank (needs `NYT_API_KEY`). |
| `hardcover_comics` | an array of Hardcover series ids / slugs           | One-or-more comic **series**, matched at series grain and grouped into a collection (needs `HARDCOVER_TOKEN`). See below.             |

**`static_ids`** entries are usually identifier strings (`isbn:…`, `asin:…`, or any opaque id your target exposes), matched exactly. An entry may instead be a **`{ title, author }`** object: it carries no identifier, so it rides the conservative title+author fallback only (flagged `matchedVia: title_author`, counted in `matchedByTitle`), and `titleFallback: true` (the default) is required for it to match. This keeps a hand-curated canon self-contained — no external ID lookup at authoring time — which is exactly what the [Authors program](#categories) uses:

```yaml
builder:
  type: static_ids
  ref:
    - isbn:9780553293357 # an identifier entry, matched exactly
    - { title: Foundation, author: Isaac Asimov } # a title+author entry, matched by the fallback
```

**`nyt_list`** takes the `list_name_encoded` value of any current NYT Books list as its `ref` — for example `hardcover-fiction`, `trade-fiction-paperback`, `combined-print-and-e-book-fiction`, or `young-adult-hardcover`. The full set of valid names is the [`/lists/names.json`](https://api.nytimes.com/svc/books/v3/lists/names.json) endpoint, and an unknown `ref` fails the run with a message pointing there. Each entry contributes its `primary_isbn13`/`primary_isbn10` and every edition in `isbns[]` as match identifiers, and `ordered: true` yields a reading list ranked #1..#n. NYT titles arrive ALL-CAPS and are normalized to title case for display; matching is identifier-based (case-insensitive) either way.

Because `nyt_list` re-resolves to the _current_ list on every run, **turning `acquisitionEnabled: true` on a `nyt_list` recipe makes the estate chase the bestseller list**: each week's new entries your library lacks are handed to LazyLibrarian to acquire. Leave it `false` (the example ships that way) until you mean it. See [`examples/recipes/nyt-hardcover-fiction.yml`](examples/recipes/nyt-hardcover-fiction.yml).

#### Comics (series grain)

The other builders match at **work grain**: each `ref` resolves to per-book works, matched against your library one book at a time (by identifier, then the D-04 title fallback). That is exactly wrong for comics. A target like Kavita stores a whole comic — _Invincible_, _Scott Pilgrim_ — as **one series** holding its volumes as chapters, and comics expose no scheme'd ISBNs. So a per-volume Hardcover work list (`Invincible, Vol. 1: Family Matters`, …) matches a Kavita _series_ named `Invincible` zero times, by identifier or by title.

**`hardcover_comics`** matches at **series grain** instead. Its `ref` is an _array_ of Hardcover series ids or slugs; each resolves to ONE unit whose match key is the Hardcover **series name**, paired against your target's series name by the same conservative, noise-stripped, ambiguity-refusing equality the title fallback uses (a name that maps to two of your series lands in `missing[]` rather than mispair — there is no identifier path and no fuzz at series grain). The matched series become **one collection**, so listing several series in one recipe builds a multi-series "universe" — an _Invincible Universe_ of `Invincible` + `Guarding the Globe` is the point. Search for each series' ref with `GET /api/search?type=hardcover_comics&q=…` (it proxies the same Hardcover series search). See [`examples/recipes/invincible-universe-comics.yml`](examples/recipes/invincible-universe-comics.yml).

Two deliberate limits:

- **Grouping-only — no acquisition.** Comics acquisition is out of Libretto's scope (it belongs to a comics downloader, not the \*arr book stack), so `acquisitionEnabled: true` on a `hardcover_comics` recipe is a **validation error**, not a silent no-op.
- **Collections, not ordered reading lists (v1).** `ordered: false` (a collection of the matched series) is the comics sweet spot. `ordered: true` still works — it produces a Kavita reading list that concatenates each matched series' volumes in `ref` order (each series in its own natural volume order) — but Libretto does **not** interleave volumes across series into one Hardcover-global reading order; that finer ordering is deferred.

## API

All routes except `/health` require `Authorization: Bearer $LIBRETTO_API_KEY`. This API is the contract surface other tools bind to; Libretto itself is driven by YAML and logs, Kometa-style.

| Method and path                          | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                            | Liveness, no auth.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /api/recipes`                       | All recipes plus validation issues for broken files.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /api/recipes/:id`                   | One recipe.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `PUT /api/recipes/:id`                   | Validate and save (the explicit write; the only recipe writer).                                                                                                                                                                                                                                                                                                                                                                                                     |
| `DELETE /api/recipes/:id`                | Delete the file; the produced collection is orphaned.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `POST /api/validate`                     | `{ recipe: {...} }` or `{ all: true }`, returns `issues[]`, mutates nothing.                                                                                                                                                                                                                                                                                                                                                                                        |
| `POST /api/apply`                        | `{ scope: "all" \| "<recipeId>" }`, returns `{ runId }`.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GET /api/runs`, `GET /api/runs/:id`     | Run history (last 50) with per-recipe counts, `missing[]`, and (when a recipe acquires) an `acquisition` block.                                                                                                                                                                                                                                                                                                                                                     |
| `GET /api/collections`                   | Produced collections, read back from the targets by marker. One entry per (recipe, target), each tagging its `server`/`libraryId` and the marker's `category` (or `null`).                                                                                                                                                                                                                                                                                          |
| `GET /api/collections/:recipeId/missing` | The recipe's wanted-but-unheld member **identities** (`{ label, title, authors, isbn, identifiers }[]`) with held/missing counts — enough for a consumer to mint one request per missing book. Multi-target: a per-target breakdown in `targets[]` (each entry's `missing[]` is missing FROM that target); the top-level fields mirror the first reachable target.                                                                                                  |
| `POST /api/resolve`                      | Resolve `{ isbn?, title?, author?, identifiers? }` to a Google Books volume id (ISBN-first, guarded title fallback). Returns `{ resolved, reason }`: `resolved` is the volume or `null`, and the additive `reason` is `resolved` \| `no_match` \| `quota_exhausted` \| `upstream_error` (so a dead quota / upstream error is distinguishable from an honest miss — `resolved` is `null` for all three failure reasons). `503` when `GOOGLE_BOOKS_API_KEY` is unset. |
| `GET /api/search?type=&q=&limit=`        | Typeahead for a builder's `ref`: find a series/list by NAME. `hardcover_series` and `hardcover_comics` proxy Hardcover's series search (`{ ref, name, workCount?, author? }[]`, cached, rate-limit paced); `nyt_list` filters the built-in list names (no key, no external call); `static_ids` returns nothing (free-form). `{ type, query, results, truncated }`. Unknown `type` `400`; unconfigured source `503`.                                                 |
| `POST /api/preview`                      | `{ builder: {...}, limit? }` → the **member-level identities** a draft builder would resolve to (`{ label, title, author, isbn, position, identifiers }[]`) with `total` and a `truncated` flag (capped at 100), so a consumer can split held vs missing before save. Mutates nothing; `502` when the builder source is unavailable.                                                                                                                                |
| `GET /api/builders`, `GET /api/targets`  | Discovery: builder types (with availability) and target status.                                                                                                                                                                                                                                                                                                                                                                                                     |

## Development

Node 22+, [pnpm](https://pnpm.io/). `pnpm install`, then:

- `pnpm dev` runs the fake-target dev server with reload
- `pnpm test` runs the [Vitest](https://vitest.dev/) suite (target clients are tested against fixture-backed stub servers; no live credentials anywhere)
- `pnpm lint`, `pnpm typecheck`, `pnpm build` are the CI gates

## License

[AGPL-3.0](LICENSE). If you run a modified Libretto as a service, share your changes.

> Container images publish to `ghcr.io/thaynes43/libretto` (`latest` and `sha` tags) on every merge to main.
