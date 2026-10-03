# Grafana

Un Grafana prêt à l'emploi à côté de Gladys, branché sur l'historique de tous
vos appareils : températures, humidité, consommation, prises, capteurs
d'ouverture… Rien à installer ni à configurer dans Grafana.

## Fonctionnement

```
Grafana  ──>  cette intégration  ──>  Gladys
```

L'intégration lance Grafana dans un conteneur géré par Gladys et lui ajoute
une source de données **Gladys**. Quand Grafana affiche un graphique,
l'intégration lit l'historique dans Gladys et le lui renvoie. Vos données
restent dans Gladys : rien n'est copié.

## Installation

Il n'y a rien à configurer. Installez l'intégration : Grafana démarre en une
trentaine de secondes.

1. Ouvrez Grafana avec le lien **Ouvrir Grafana** de l'écran de supervision,
   ou à l'adresse affichée dans l'onglet **Configuration**.
2. Dans l'onglet **Configuration**, cliquez sur **Afficher les identifiants
   Grafana**. L'utilisateur est `admin` et le mot de passe a été généré à
   l'installation.
3. Connectez-vous : la vue d'ensemble de vos appareils s'affiche.

> **Version de Gladys requise.** Pour lire vos appareils, l'intégration a
> besoin d'une version de Gladys qui autorise les intégrations à lire
> l'historique des appareils. Avec une version plus ancienne, Grafana
> fonctionne mais reste vide, et la vue d'ensemble l'indique. Les données
> apparaissent d'elles-mêmes après la mise à jour de Gladys.

## Tableaux de bord fournis

Ils se trouvent dans le dossier **Gladys** de Grafana :

- **Gladys — Vue d'ensemble** : un graphique par type de mesure présent chez
  vous, avec la bonne unité et un filtre par pièce. Il se met à jour tout seul
  quand vous ajoutez un appareil. C'est la page d'accueil de Grafana.
- **Gladys — Appareil** : choisissez un appareil pour voir toutes ses mesures.

Ces tableaux de bord sont en lecture seule. Pour les personnaliser, faites
**Enregistrer sous** : votre copie ne sera jamais écrasée.

## Écrire ses propres requêtes

La source **Gladys** se comporte comme une source Prometheus. Chaque
fonctionnalité d'appareil est une série nommée
`gladys_<catégorie>_<type>`, avec ces étiquettes : `device`, `feature`,
`room`, `service`, `unit`, `category` et `type`.

| Besoin                          | Requête                                             |
| ------------------------------- | --------------------------------------------------- |
| Températures du salon           | `gladys_temperature_sensor_decimal{room="Salon"}`   |
| Température moyenne par pièce   | `avg by (room) (gladys_temperature_sensor_decimal)` |
| Puissance totale de la maison   | `sum(gladys_energy_sensor_power)`                   |
| Conversion d'unité              | `gladys_temperature_sensor_decimal * 9 / 5 + 32`    |
| Tous les capteurs d'un appareil | `{device="Thermomètre salon"}`                      |

L'éditeur de requêtes de Grafana propose les noms de mesures et les
étiquettes.

Sont reconnus : les sélecteurs (`=`, `!=`, `=~`, `!~`), `sum`, `avg`, `min`,
`max` et `count` (avec `by` ou `without`), `abs`, `ceil`, `floor`, `round`,
`clamp_min`, `clamp_max`, ainsi que les opérations `+ - * / %`.

Les fonctions sur des plages de temps (`rate`, `[5m]`, `*_over_time`) ne sont
pas disponibles. Gladys agrège déjà l'historique à la résolution du
graphique. Pour décaler la période, utilisez l'option **Time shift** du
panneau.

## Bon à savoir

- Une valeur est conservée jusqu'à la suivante. Un capteur qui ne remonte
  qu'en cas de changement affiche donc une ligne continue.
- Les fonctionnalités dont l'historique est désactivé dans Gladys n'affichent
  que leur dernière valeur.
- Si vous changez le mot de passe `admin` dans Grafana, le bouton **Afficher
  les identifiants Grafana** affichera toujours l'ancien.
