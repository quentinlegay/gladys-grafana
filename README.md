# Gladys Grafana integration

External integration for [Gladys Assistant](https://gladysassistant.com) that
runs **Grafana** next to Gladys, with the history of every Gladys device
available as a pre-configured data source, plus generated dashboards.

Built from the official
[integration template](https://github.com/GladysAssistant/integration-template-js)
with the [`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

User documentation: [docs/en.md](./docs/en.md) · [docs/fr.md](./docs/fr.md).

## Architecture

```
                 private network of the integration
 ┌───────────────────────────────────────────────────────────┐
 │ Grafana (sub-container)  ──Prometheus API──>  integration ─┼──REST──> Gladys
 │   :3000 published on the LAN                 :9090         │   /api/v1/device
 └───────────────────────────────────────────────────────────┘   /api/v1/device_feature/aggregated_states
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
- **The integration token only opens the host API**, which does not expose the
  other integrations' devices nor their history. The integration therefore
  logs in once with a Gladys account (e-mail/password from the config), trades
  the session for an API key (`POST /api/v1/session/api_key`, revocable in
  Settings → Sessions), revokes the login session and keeps the key in `/data`.
  A refused key triggers one new login.

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

It goes through `GF_SECURITY_ADMIN_PASSWORD__FILE` (a file in the provisioning
volume), never through the container env nor the public manifest. Grafana only
reads it when it creates its database, so a later change is applied through
the Grafana API with the previous password, remembered in `/data`.

## Layout

```
index.js                     SDK wiring: config, actions, lifecycle
src/config.js                defaults + normalization of the config
src/gladys/api.js            Gladys REST client (login -> API key)
src/gladys/catalog.js        devices -> Prometheus series
src/gladys/history.js        aggregated states, window conversion, cache
src/prometheus/parser.js     PromQL subset parser
src/prometheus/engine.js     evaluation on the step grid
src/prometheus/server.js     Prometheus HTTP API (node:http)
src/grafana/provisioning.js  data source / dashboards provisioning files
src/grafana/dashboards.js    generated dashboards
src/grafana/container.js     sub-container env, start, admin password sync
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
