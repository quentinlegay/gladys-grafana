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

## Configuration

1. Open the **Configuration** tab of the integration.
2. **Gladys account**: the e-mail and password of a Gladys account. A
   non-admin account is enough. The password is used once, to create an API
   key. The key is listed under **Settings → Sessions**, where you can revoke
   it.
3. **Grafana admin password**: at least 8 characters. The user name is
   `admin`.
4. Save, then click **Test the connection to Gladys**.

Grafana starts in about thirty seconds. Open it with the **Open Grafana** link
of the supervision screen, or at the address shown at the top of the
configuration (`http://<gladys-ip>:<port>`).

### Options

- **Read-only access without login**: anyone on your local network can view
  the dashboards without signing in, but cannot edit them. Handy for a wall
  tablet.
- **Generate the Gladys dashboards**: on by default.
- **Gladys URL (advanced)**: leave it empty. Only fill it in if the connection
  test fails, with the address of Gladys on your network (for example
  `http://192.168.1.10`).

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
- If you change the Grafana admin password in Gladys, the integration applies
  it in Grafana too.

## Troubleshooting

- **"Gladys refused the e-mail/password"**: check the account you entered.
- **"Gladys API unreachable"**: fill in the **Gladys URL** with the local IP
  address of your Gladys.
- **I can no longer sign in to Grafana**: if the password was changed directly
  in Grafana, reset it from the container with
  `grafana cli admin reset-admin-password <new>`, then enter it in the
  configuration.
