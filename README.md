# Libretto

[Kometa](https://kometa.wiki/) for your book stack. Libretto builds and maintains collections in [Kavita](https://www.kavitareader.com/) and [Audiobookshelf](https://www.audiobookshelf.org/) from recipes: declarative YAML files that say "this list of books belongs together, in this order, in that library". Items a recipe wants but your library lacks become an honest missing report, which a later milestone will feed to [LazyLibrarian](https://lazylibrarian.gitlab.io/) to drive acquisition.

> **Status: pre-alpha (M2, real targets).** Real Kavita and Audiobookshelf clients are live next to the M1 walking skeleton: the `hardcover_series` builder resolves a series from [Hardcover](https://hardcover.app/) into an ordered, identifier-keyed work list, and the reconciler materializes it as a Kavita collection or reading list, or an Audiobookshelf collection. Remaining before beta: the NYT and Wikidata builders, the LazyLibrarian acquisition leg, and hardening. The architecture is written up in the [design document](https://github.com/thaynes43/haynesnetwork/blob/main/docs/designs/037-libretto-architecture.md).

Libretto is Kometa-like on purpose: YAML recipes in, collections out, logs and a REST API to watch it work. There is no built-in web interface; the API exists for automation and for other frontends to bind to.

## The stateless philosophy

Libretto keeps no database: recipes are YAML files you own, run history is a rotating JSON file, and ownership of the collections it produces is recovered from the targets themselves through a provenance marker embedded in each collection description. You can delete everything except your recipes folder and lose nothing that matters.

### The marker spike, resolved

Whether every target could actually carry that marker was an open design question. Verified from both projects' sources in M2:

- **Audiobookshelf: yes.** Collections have a writable `description` field on create (`POST /api/collections`) and update (`PATCH /api/collections/:id`), echoed back by every read.
- **Kavita: yes, on both container kinds.** Collection `summary` is writable via `POST /api/Collection/update` and reading-list `summary` via `POST /api/ReadingList/update`.

So the marker lives in the targets everywhere, and the sidecar ownership file the design held in reserve was never built.

### Identifier matching on Kavita, resolved

Kavita exposes ISBNs per **chapter** (that is, per book file), not per series: `GET /api/Series/volumes?seriesId=` and collect each chapter's `isbn`. Libretto does that per series and caches the result on disk (keyed by series id plus page count, so content changes refresh it). One honest caveat: Kavita only parses an epub ISBN when the OPF `<dc:identifier>` carries `opf:scheme="ISBN"` or an `isbn:`/`urn:isbn:` prefix it can validate. EPUB3 files without the scheme attribute yield no ISBN in Kavita, and such series can never match a recipe; the works they would have matched appear in `missing[]` instead. Fixing the epub metadata (or re-tagging with a tool that writes the scheme attribute) is the remedy.

Audiobookshelf is simpler: item metadata carries `isbn` and `asin` directly in the standard listing, no per-item fetches.

Matching is identifier-exact on both sides (ISBN-10 is losslessly converted to ISBN-13; ASINs are uppercased). There is no title fuzz: a work either matches by identifier or lands in `missing[]`.

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

| Variable                                     | Purpose                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `LIBRETTO_API_KEY`                           | Bearer key for everything under `/api`. Unset means the API is locked.                                        |
| `KAVITA_URL`, `KAVITA_API_KEY`               | Kavita connection. The API key is a Kavita user API key; Libretto authenticates with it via the plugin flow.  |
| `ABS_URL`, `ABS_TOKEN`                       | Audiobookshelf connection. A user API token or an API key, sent as a Bearer token.                            |
| `HARDCOVER_TOKEN`                            | [Hardcover](https://hardcover.app/) token for the `hardcover_series` builder. Tokens expire each January 1st. |
| `LIBRETTO_FAKE_TARGET`                       | `1` serves the in-memory fake target for both server kinds (demo and tests).                                  |
| `CONFIG_DIR`                                 | Config volume path, default `/config`.                                                                        |
| `PORT`                                       | HTTP port, default `8080`.                                                                                    |
| `LOG_LEVEL`                                  | [pino](https://getpino.io/) level, default `info`.                                                            |
| `LAZYLIBRARIAN_URL`, `LAZYLIBRARIAN_API_KEY` | LazyLibrarian connection for the acquisition leg (M3, not yet used).                                          |
| `NYT_API_KEY`                                | [NYT Books API](https://developer.nytimes.com/docs/books-product/1/overview) key for the M3 list builder.     |

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
  acquisitionEnabled: false # reserved for the LazyLibrarian leg (M3)
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

| Method and path                         | What it does                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /health`                           | Liveness, no auth.                                                           |
| `GET /api/recipes`                      | All recipes plus validation issues for broken files.                         |
| `GET /api/recipes/:id`                  | One recipe.                                                                  |
| `PUT /api/recipes/:id`                  | Validate and save (the explicit write; the only recipe writer).              |
| `DELETE /api/recipes/:id`               | Delete the file; the produced collection is orphaned.                        |
| `POST /api/validate`                    | `{ recipe: {...} }` or `{ all: true }`, returns `issues[]`, mutates nothing. |
| `POST /api/apply`                       | `{ scope: "all" \| "<recipeId>" }`, returns `{ runId }`.                     |
| `GET /api/runs`, `GET /api/runs/:id`    | Run history (last 50) with per-recipe counts and `missing[]`.                |
| `GET /api/collections`                  | Produced collections, read back from the targets by marker.                  |
| `GET /api/builders`, `GET /api/targets` | Discovery: builder types (with availability) and target status.              |

## Development

Node 22+, [pnpm](https://pnpm.io/). `pnpm install`, then:

- `pnpm dev` runs the fake-target dev server with reload
- `pnpm test` runs the [Vitest](https://vitest.dev/) suite (target clients are tested against fixture-backed stub servers; no live credentials anywhere)
- `pnpm lint`, `pnpm typecheck`, `pnpm build` are the CI gates

## License

[AGPL-3.0](LICENSE). If you run a modified Libretto as a service, share your changes.

> Container images publish to `ghcr.io/thaynes43/libretto` (`latest` and `sha` tags) on every merge to main.
