# Libretto

[Kometa](https://kometa.wiki/) for your book stack. Libretto builds and maintains collections in [Kavita](https://www.kavitareader.com/) and [Audiobookshelf](https://www.audiobookshelf.org/) from recipes: declarative YAML files that say "this list of books belongs together, in this order, in that library". Items a recipe wants but your library lacks become an honest missing report, which — when a recipe opts in — Libretto feeds to [LazyLibrarian](https://lazylibrarian.gitlab.io/) to drive acquisition.

> **Status: pre-alpha (M3, acquisition).** Real Kavita and Audiobookshelf clients are live next to the M1 walking skeleton: the `hardcover_series` builder resolves a series from [Hardcover](https://hardcover.app/) into an ordered, identifier-keyed work list, and the reconciler materializes it as a Kavita collection or reading list, or an Audiobookshelf collection. **M3 wires `missing[]` into LazyLibrarian** so a recipe can acquire what your library lacks (see [The acquisition leg](#the-acquisition-leg-m3)). Remaining before beta: the NYT and Wikidata builders, and hardening. The architecture is written up in the [design document](https://github.com/thaynes43/haynesnetwork/blob/main/docs/designs/037-libretto-architecture.md).

Libretto is Kometa-like on purpose: YAML recipes in, collections out, logs and a REST API to watch it work. There is no built-in web interface; the API exists for automation and for other frontends to bind to.

## The stateless philosophy

Libretto keeps no database: recipes are YAML files you own, run history is a rotating JSON file, and ownership of the collections it produces is recovered from the targets themselves through a provenance marker embedded in each collection description. You can delete everything except your recipes folder and lose nothing that matters.

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
- **`addBookByISBN&isbn=`** introduces a book LazyLibrarian does not yet know, resolving the ISBN on **LazyLibrarian's own Google Books budget**. Libretto has no Google Books key and deliberately never acquires one — statelessness plus quota ownership keep that dependency on LazyLibrarian's side. This path is best-effort: the deployed instance's anonymous quota is throttled and often answers `No results for <isbn>`, which Libretto treats as a soft skip and retries on a later run.
- `findBook` / `findAuthor` (LazyLibrarian's live Google Books search) return `[]` for every query in this deployment, so a keyless "search then add" path is not viable. That is why acquisition is keyed on `getAllBooks` + `addBookByISBN` rather than a search.

Per missing work, per run:

1. **Resolve** it to a LazyLibrarian book — conservatively, exactly like the D-04 title fallback: normalized ISBN first, then noise-stripped title (with the author guard); **ambiguity is skipped, never a wrong add**.
2. **Already known and being acquired or held** (the format is `Wanted`, `Snatched`, `Open`, `Have`, `Matched`, or `Ignored`) → skip. Re-runs never duplicate.
3. **Known but the format is `Skipped`** (or untracked) → `queueBook` + `searchBook` for that format. This is the reliable drive.
4. **Unknown, with an ISBN** → `addBookByISBN`. On success the book enters LazyLibrarian and is driven to a search on a later run (once `getAllBooks` reveals its `BookID`). Unknown with no ISBN (ASIN-only) → skipped with a logged reason.

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

# discover library ids for targetLibrary.libraryId
curl -H 'Authorization: Bearer change-me' http://localhost:8080/api/targets

# save a recipe: The Expanse, in series order, as a Kavita reading list
curl -X PUT http://localhost:8080/api/recipes/expanse \
  -H 'Authorization: Bearer change-me' \
  -H 'Content-Type: application/json' \
  -d '{
    "targetLibrary": { "server": "kavita", "libraryId": "2" },
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
  cache/       TTL disk cache: resolved Hardcover series, per-series Kavita
               ISBN lookups (losable, rebuilds itself)
```

Environment variables (all connection settings are validated at use, not at boot):

| Variable                                     | Purpose                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LIBRETTO_API_KEY`                           | Bearer key for everything under `/api`. Unset means the API is locked.                                                                                 |
| `KAVITA_URL`, `KAVITA_API_KEY`               | Kavita connection. The API key is a Kavita user API key; Libretto authenticates with it via the plugin flow.                                           |
| `ABS_URL`, `ABS_TOKEN`                       | Audiobookshelf connection. A user API token or an API key, sent as a Bearer token.                                                                     |
| `HARDCOVER_TOKEN`                            | [Hardcover](https://hardcover.app/) token for the `hardcover_series` builder. Tokens expire each January 1st.                                          |
| `LIBRETTO_FAKE_TARGET`                       | `1` serves the in-memory fake target for both server kinds (demo and tests).                                                                           |
| `CONFIG_DIR`                                 | Config volume path, default `/config`.                                                                                                                 |
| `PORT`                                       | HTTP port, default `8080`.                                                                                                                             |
| `LOG_LEVEL`                                  | [pino](https://getpino.io/) level, default `info`.                                                                                                     |
| `LAZYLIBRARIAN_URL`, `LAZYLIBRARIAN_API_KEY` | [LazyLibrarian](https://lazylibrarian.gitlab.io/) connection for the acquisition leg (M3). The API key is the LazyLibrarian API key from its settings. |
| `LIBRETTO_ACQUISITION_CAP_PER_RUN`           | Max acquisition actions (LazyLibrarian adds + queue-drives) per recipe run. Default `10`.                                                              |
| `LIBRETTO_ACQUISITION_INTERVAL_MS`           | Spacing between LazyLibrarian write calls, in ms (estate politeness). Default `3000`.                                                                  |
| `NYT_API_KEY`                                | [NYT Books API](https://developer.nytimes.com/docs/books-product/1/overview) key for the NYT list builder (planned).                                   |

### Notes on the target accounts

- **Kavita collections and reading lists are per-user.** Whatever account owns the `KAVITA_API_KEY` owns everything Libretto creates. Libretto asks Kavita to promote its creations so other users see them; that only takes effect if the account has the Promote (or Admin) role. Use the same account other sync tooling in your stack already uses.
- **Audiobookshelf collections are shared per-library**, so any account with update permission works.
- **Hardcover paces itself** to the documented 60 requests/minute and caches resolved series on disk for six hours, so scheduled re-runs are cheap.

## Recipes

A recipe is one YAML file. The commented examples in [`examples/recipes/`](examples/recipes/) include a fake-target starter and a real Hardcover one. The shape:

```yaml
id: expanse
targetLibrary:
  server: kavita # kavita | abs
  libraryId: '2' # from GET /api/targets
name: The Expanse
builder:
  type: hardcover_series # or static_ids (the ref is then an identifier list)
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

## API

All routes except `/health` require `Authorization: Bearer $LIBRETTO_API_KEY`. This API is the contract surface other tools bind to; Libretto itself is driven by YAML and logs, Kometa-style.

| Method and path                         | What it does                                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /health`                           | Liveness, no auth.                                                                                              |
| `GET /api/recipes`                      | All recipes plus validation issues for broken files.                                                            |
| `GET /api/recipes/:id`                  | One recipe.                                                                                                     |
| `PUT /api/recipes/:id`                  | Validate and save (the explicit write; the only recipe writer).                                                 |
| `DELETE /api/recipes/:id`               | Delete the file; the produced collection is orphaned.                                                           |
| `POST /api/validate`                    | `{ recipe: {...} }` or `{ all: true }`, returns `issues[]`, mutates nothing.                                    |
| `POST /api/apply`                       | `{ scope: "all" \| "<recipeId>" }`, returns `{ runId }`.                                                        |
| `GET /api/runs`, `GET /api/runs/:id`    | Run history (last 50) with per-recipe counts, `missing[]`, and (when a recipe acquires) an `acquisition` block. |
| `GET /api/collections`                  | Produced collections, read back from the targets by marker.                                                     |
| `GET /api/builders`, `GET /api/targets` | Discovery: builder types (with availability) and target status.                                                 |

## Development

Node 22+, [pnpm](https://pnpm.io/). `pnpm install`, then:

- `pnpm dev` runs the fake-target dev server with reload
- `pnpm test` runs the [Vitest](https://vitest.dev/) suite (target clients are tested against fixture-backed stub servers; no live credentials anywhere)
- `pnpm lint`, `pnpm typecheck`, `pnpm build` are the CI gates

## License

[AGPL-3.0](LICENSE). If you run a modified Libretto as a service, share your changes.

> Container images publish to `ghcr.io/thaynes43/libretto` (`latest` and `sha` tags) on every merge to main.
