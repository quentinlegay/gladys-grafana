# Grafana

A ready-to-use Grafana next to Gladys, connected to the history of all your
devices: temperatures, humidity, energy, plugs, opening sensors… Nothing to
install or configure in Grafana.

## How it works

```
Grafana  ──>  this integration  ──>  Gladys
```

The integration runs Grafana in a container managed by Gladys and adds a
**Gladys** data source to it. When Grafana draws a chart, the integration
reads the history from Gladys and sends it back. Your data stays in Gladys:
nothing is copied.

## Installation

There is nothing to configure. Install the integration: Grafana starts in
about thirty seconds.

1. Open Grafana with the **Open Grafana** link of the supervision screen, or
   at the address shown in the **Configuration** tab.
2. In the **Configuration** tab, click **Show the Grafana credentials**. The
   user is `admin` and the password was generated at installation.
3. Sign in: the overview of your devices shows up.

> **Required Gladys version.** To read your devices, the integration needs a
> Gladys version that lets integrations read the device history. With an older
> version, Grafana works but stays empty, and the overview says so. The data
> shows up by itself once Gladys is updated.

## Provided dashboards

They live in the **Gladys** folder of Grafana:

- **Gladys — Vue d'ensemble** (overview): one chart per kind of measure in
  your home, with the right unit and a room filter. It updates by itself when
  you add a device. It is Grafana's home page.
- **Gladys — Appareil** (device): pick a device to see all its measures.

These dashboards are read-only. To customize one, use **Save as**: your copy
is never overwritten.

## Writing your own queries

The **Gladys** data source behaves like a Prometheus data source. Each device
feature is a series named `gladys_<category>_<type>`, with these labels:
`device`, `feature`, `room`, `service`, `unit`, `category` and `type`.

| Need                         | Query                                               |
| ---------------------------- | --------------------------------------------------- |
| Living room temperatures     | `gladys_temperature_sensor_decimal{room="Salon"}`   |
| Average temperature per room | `avg by (room) (gladys_temperature_sensor_decimal)` |
| Total power of the house     | `sum(gladys_energy_sensor_power)`                   |
| Unit conversion              | `gladys_temperature_sensor_decimal * 9 / 5 + 32`    |
| Every measure of one device  | `{device="Thermomètre salon"}`                      |

The Grafana query editor suggests the measure names and labels.

Supported: selectors (`=`, `!=`, `=~`, `!~`), `sum`, `avg`, `min`, `max` and
`count` (with `by` or `without`), `abs`, `ceil`, `floor`, `round`,
`clamp_min`, `clamp_max`, and the `+ - * / %` operators.

Range functions (`rate`, `[5m]`, `*_over_time`) are not available. Gladys
already aggregates the history to the chart resolution. To shift the period,
use the **Time shift** option of the panel.

## Good to know

- A value holds until the next one. A sensor that only reports on change is
  therefore drawn as a continuous line.
- Features whose history is turned off in Gladys only show their last value.
- If you change the `admin` password in Grafana, the **Show the Grafana
  credentials** button keeps showing the old one.
