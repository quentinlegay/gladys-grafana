# Gladys Grafana integration

External integration for [Gladys Assistant](https://gladysassistant.com) that
runs **Grafana** next to Gladys, with the history of every Gladys device
available as a pre-configured data source, plus generated dashboards.
**Nothing to configure**: install it, open Grafana.

Built from the official
[integration template](https://github.com/GladysAssistant/integration-template-js)
with the [`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

User documentation: [docs/en.md](./docs/en.md) · [docs/fr.md](./docs/fr.md).

## Architecture

```
                 private network of the integration
 ┌───────────────────────────────────────────────────────────┐
 │ Grafana (sub-container)  ──Prometheus API──>  integration ─┼──host API──> Gladys
 │   :3000 published on the LAN                 :9090         │   (integration token)
 └───────────────────────────────────────────────────────────┘
```

- **Grafana is a sub-container** (`grafana/grafana`, pinned, `start: manual`,
  read-only rootfs). The integration writes its provisioning files under
  `/data/containers/grafana/…` first, then calls `startContainer`. Gladys
  picks the host port of the UI; the manifest only names it (`grafana_ui`) so
  the configuration screen can show `http://{{gladys_host}}:{{port:grafana_ui}}`.
- **Sub-containers cannot reach Gladys** (they only join the private network
  of their integration). So the integration itself is the data source: it
  serves the **Prometheus HTTP query API** on port 9090, which Grafana's
  built-in Prometheus data source speaks — no Grafana plugin to download.
  Grafana reaches it at `http://gladys-<selector>:9090`, with Basic
  credentials generated once and stored in `/data`.
- **The Gladys data is read with the integration token** — no Gladys account
  to configure. See [Waiting on Gladys core](#waiting-on-gladys-core).
- **The Grafana admin password is generated** on first start, kept in
  `/data`, and shown by the **Show the Grafana credentials** action of the
  Configuration screen.

### The data model

Every device feature (except cameras and text) is one series:

```
gladys_<category>_<type>{device, device_selector, feature, feature_selector,
                         room, room_selector, service, category, type, unit}
```

Range queries read `GET /api/v1/device_feature/aggregated_states` (buckets of
averages for numeric features, transitions for binary ones), converting the
absolute `[start, end]` into Gladys' relative `interval`/`offset` minutes, and
resample on the step grid with last-value-carried-forward, seeded by the
feature's `last_value`. Instant queries near "now" answer from `last_value`
without touching the history. Results are cached 30 s; the device list 60 s.

The supported PromQL subset (selectors, `sum/avg/min/max/count by|without`,
`abs/ceil/floor/round/clamp_min/clamp_max`, `+ - * / %`) is parsed by
`src/prometheus/parser.js`; anything else is refused with an explicit
message that Grafana shows under the query.

### Dashboards

`src/grafana/dashboards.js` generates **Gladys — Vue d'ensemble** from the
device list (one panel per metric, Grafana unit mapped from the Gladys unit,
`room` variable) and a static **Gladys — Appareil** dashboard. They are
rewritten when the device list changes (checked every 5 minutes, or with the
"Regenerate the dashboards" action); Grafana re-reads them every 30 s.

### Grafana admin password

Generated once (`/data/grafana-admin-secret`) and read by Grafana through
`GF_SECURITY_ADMIN_PASSWORD__FILE` (a file in the provisioning volume): it
never goes through the container env nor the public manifest.

## Waiting on Gladys core

Today the host API only returns the devices **created by the integration
itself** (`GET /api/integration/v1/device`) and has no history route. Until
Gladys exposes them, the integration runs, Grafana starts, and the data
source answers empty results; the overview dashboard explains why.

`src/gladys/api.js` already calls the routes this integration expects, with
the integration token. They mirror the existing user routes:

| Route (host API)                                           | Same answer as                                 |
| ---------------------------------------------------------- | ---------------------------------------------- |
| `GET /api/integration/v1/all_devices`                      | `GET /api/v1/device`                           |
| `GET /api/integration/v1/device_feature/aggregated_states` | `GET /api/v1/device_feature/aggregated_states` |

They should be gated by a manifest permission shown on the install screen,
like `location: true` gates `getHouses()`. A 404 (route unknown) or 403
(permission not granted) is treated as "not available yet", not as an
outage. Once the core change ships: declare the permission in the manifest,
raise `gladys_version`, and adjust the two paths in `src/gladys/api.js` if
the final names differ.

## Layout

```
index.js                     SDK wiring: setup, action, lifecycle
src/gladys/api.js            Gladys data through the host API (token)
src/gladys/catalog.js        devices -> Prometheus series
src/gladys/history.js        aggregated states, window conversion, cache
src/prometheus/parser.js     PromQL subset parser
src/prometheus/engine.js     evaluation on the step grid
src/prometheus/server.js     Prometheus HTTP API (node:http)
src/grafana/provisioning.js  data source / dashboards provisioning files
src/grafana/dashboards.js    generated dashboards
src/grafana/container.js     sub-container env and start
```

## Development

```bash
npm install
npm run format:check
npm run lint
npm test                      # node --test, Node >= 20 (the image runs Node 24)
npx github:GladysAssistant/integration-store .   # store admission rules
```

Releases: **Actions → Release → Run workflow** bumps the version in
`package.json` and in the manifest, tags, and publishes the multi-arch image
to `ghcr.io`.

## License

Apache-2.0
