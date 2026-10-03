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

## Configuration

1. Ouvrez l'onglet **Configuration** de l'intégration.
2. **Compte Gladys** : l'e-mail et le mot de passe d'un compte Gladys. Un
   compte non administrateur suffit. Le mot de passe sert une seule fois, à
   créer une clé d'API. Cette clé apparaît dans **Paramètres → Sessions**, où
   vous pouvez la révoquer.
3. **Mot de passe administrateur Grafana** : 8 caractères minimum. Le nom
   d'utilisateur est `admin`.
4. Enregistrez, puis cliquez sur **Tester la connexion à Gladys**.

Grafana démarre en une trentaine de secondes. Ouvrez-le avec le lien
**Ouvrir Grafana** de l'écran de supervision, ou à l'adresse indiquée en haut
de la configuration (`http://<ip-de-gladys>:<port>`).

### Options

- **Consultation sans connexion** : toute personne de votre réseau local peut
  voir les tableaux de bord sans se connecter, mais pas les modifier. C'est
  pratique pour une tablette murale.
- **Générer les tableaux de bord Gladys** : activé par défaut.
- **URL de Gladys (avancé)** : laissez ce champ vide. Ne le remplissez que si
  le test de connexion échoue, avec l'adresse de Gladys sur votre réseau (par
  exemple `http://192.168.1.10`).

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
- Si vous changez le mot de passe administrateur Grafana dans Gladys,
  l'intégration l'applique aussi dans Grafana.

## Dépannage

- **« Gladys a refusé l'e-mail ou le mot de passe »** : vérifiez le compte
  saisi.
- **« API de Gladys injoignable »** : renseignez l'**URL de Gladys** avec
  l'adresse IP locale de votre Gladys.
- **Je ne peux plus me connecter à Grafana** : si le mot de passe a été changé
  directement dans Grafana, réinitialisez-le depuis le conteneur avec
  `grafana cli admin reset-admin-password <nouveau>`, puis saisissez-le dans
  la configuration.
