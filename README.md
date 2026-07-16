# Libretto

[Kometa](https://kometa.wiki/) for your book stack. Libretto builds and maintains collections in [Kavita](https://www.kavitareader.com/) and [Audiobookshelf](https://www.audiobookshelf.org/) from recipes: declarative YAML files that say "this list of books belongs together, in this order, in that library". Items a recipe wants but your library lacks become an honest missing report, which a later milestone will feed to [LazyLibrarian](https://lazylibrarian.gitlab.io/) to drive acquisition.

> **Status: pre-alpha (M1, the walking skeleton).** The recipe contract, reconciler, scheduler, and REST API are live end to end against a built-in fake target. Real Kavita and Audiobookshelf clients, external list sources (Hardcover, NYT, Wikidata), and the acquisition leg are next. The architecture is written up in the [design document](https://github.com/thaynes43/haynesnetwork/blob/main/docs/designs/037-libretto-architecture.md).

## The stateless philosophy

Libretto keeps no database: recipes are YAML files you own, run history is a rotating JSON file, and ownership of the collections it produces is recovered from the targets themselves through a provenance marker embedded in each collection description. You can delete everything except your recipes folder and lose nothing that matters.

## Quick start

Libretto ships as a single container with one volume at `/config`. Until the real target clients land, run it against the built-in fake target:

```sh
docker run -d \
  --name libretto \
  -p 8080:8080 \
  -v ./libretto-config:/config \
  -e LIBRETTO_API_KEY=change-me \
  -e LIBRETTO_FAKE_TARGET=1 \
  ghcr.io/thaynes43/libretto:latest
```

Note: no image is published yet during pre-alpha, so build it locally first with `docker build -t ghcr.io/thaynes43/libretto:latest .`

Then drive it:

```sh
# liveness (no key needed)
curl http://localhost:8080/health

# save a recipe (see examples/recipes/expanse-starters.yml)
curl -X PUT http://localhost:8080/api/recipes/expanse-starters \
  -H 'Authorization: Bearer change-me' \
  -H 'Content-Type: application/json' \
  -d '{
    "targetLibrary": { "server": "kavita", "libraryId": "fake-library-1" },
    "name": "Expanse Starters",
    "builder": { "type": "static_ids", "ref": ["isbn:9780316129084", "isbn:9780316129060"] },
    "variables": { "syncMode": "sync", "ordered": true, "schedule": "manual" },
    "enabled": true
  }'

# apply it and watch the run
curl -X POST http://localhost:8080/api/apply \
  -H 'Authorization: Bearer change-me' \
  -H 'Content-Type: application/json' \
  -d '{ "scope": "expanse-starters" }'
curl -H 'Authorization: Bearer change-me' http://localhost:8080/api/runs

# read back the produced collection (recovered from the target by marker)
curl -H 'Authorization: Bearer change-me' http://localhost:8080/api/collections
```

For local development: `pnpm install`, then `pnpm dev` boots the same fake-target setup with a dev API key (`dev-key`) on port 8080.

## Configuration

Everything lives on the `/config` volume (override with `CONFIG_DIR`):

```
/config
  recipes/     one YAML file per recipe, filename = recipe id; yours to edit,
               written by Libretto only on an explicit API save
  state/       runs.json, the last 50 run records (losable)
  cache/       identifier resolution cache (losable; unused in M1)
```

Environment variables (all connection settings are validated at use, not at boot):

| Variable                                     | Purpose                                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `LIBRETTO_API_KEY`                           | Bearer key for everything under `/api`. Unset means the API is locked.                                      |
| `LIBRETTO_FAKE_TARGET`                       | `1` serves the in-memory fake target (dev and demo mode).                                                   |
| `CONFIG_DIR`                                 | Config volume path, default `/config`.                                                                      |
| `PORT`                                       | HTTP port, default `8080`.                                                                                  |
| `LOG_LEVEL`                                  | [pino](https://getpino.io/) level, default `info`.                                                          |
| `KAVITA_URL`, `KAVITA_API_KEY`               | Kavita connection (client ships in M2).                                                                     |
| `ABS_URL`, `ABS_TOKEN`                       | Audiobookshelf connection (client ships in M2).                                                             |
| `LAZYLIBRARIAN_URL`, `LAZYLIBRARIAN_API_KEY` | LazyLibrarian connection for the acquisition leg (M3).                                                      |
| `HARDCOVER_TOKEN`                            | [Hardcover](https://hardcover.app/) token for the series builder (M2).                                      |
| `NYT_API_KEY`                                | [NYT Books API](https://developer.nytimes.com/docs/books-product/1/overview) key for bestseller lists (M2). |

## Recipes

A recipe is one YAML file. The commented example in [`examples/recipes/expanse-starters.yml`](examples/recipes/expanse-starters.yml) is runnable against the fake target as is. The shape:

```yaml
id: expanse-starters
targetLibrary:
  server: kavita # kavita | abs
  libraryId: fake-library-1
name: Expanse Starters
builder:
  type: static_ids # the only M1 builder; the ref is the ordered identifier list
  ref:
    - isbn:9780316129084
    - isbn:9780316129060
variables:
  syncMode: sync # sync reconciles membership and order; append only ever adds
  ordered: true # the collection carries the builder's order
  acquisitionEnabled: false # reserved for the LazyLibrarian leg
  schedule: manual # cron expression, or manual for API-only runs
enabled: true
```

Safety rules the reconciler enforces:

- Ownership keys on the provenance marker in the collection description, never on the name. A renamed collection stays owned; a same-name collection without the marker is never touched.
- `append` never removes. A run that matches zero items flags a warning and leaves the collection alone.
- Deleting a recipe orphans its collection in the target; nothing is deleted remotely.
- Unmatched identifiers are reported in `missing[]`, never guessed at.

## API

All routes except `/health` require `Authorization: Bearer $LIBRETTO_API_KEY`.

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
| `GET /api/builders`, `GET /api/targets` | Discovery: available builder types and target status.                        |

## Development

Node 22+, [pnpm](https://pnpm.io/). `pnpm install`, then:

- `pnpm dev` runs the fake-target dev server with reload
- `pnpm test` runs the [Vitest](https://vitest.dev/) suite
- `pnpm lint`, `pnpm typecheck`, `pnpm build` are the CI gates

## License

[AGPL-3.0](LICENSE). If you run a modified Libretto as a service, share your changes.
