# stock-watch

Vérifie régulièrement des articles sur plusieurs boutiques et envoie une notification ntfy sur le téléphone.
Ne se connecte à aucun compte et n'achète rien.

## Ce qui est surveillé (`watch.json`)

- **`products`** : une page produit précise (400coups.ch). Alerte quand le prix et le bouton « Ajouter au panier » apparaissent.
- **`searches`** : les listes de produits d'une boutique filtrées par mots-clés. Alerte quand un nouvel article correspondant apparaît, puis quand il devient commandable.
  - `shop` : `prestashop` (red-line.shop), `woocommerce` (mix-image.ch), `shopify` (poke-swiss.ch), `shopware` (amazingtoys.ch), `wix` (arcbleu.shop), `cscart` (400coups.ch) ou `playin` (play-in.com).
  - Shopware : la recherche est filtrée sur la langue par le site lui-même (`properties=<id de Französisch>`), puis le bot ouvre la page de la variante `variant` (« Französisch ») de chaque produit. L'adresse de chaque variante est trouvée une fois puis gardée en mémoire. Commandable = disponible ou en précommande.
  - `anyOf` : plusieurs jeux de groupes ; le nom doit contenir au moins un mot de **chaque** groupe d'**un** des jeux (ou l'article est dans une des `categories`). Actuellement : « Pokémon » + 30e/30ème/30 ans/30th, **ou** « Pokémon » + UPC/Ultra-Premium + Soirée/Journée/Nuit/Noctali/Mentali (pour écarter les anciens UPC).
  - Shopify : `pages` peut aussi pointer vers `/search/suggest.json?q=…` (10 résultats par requête) quand le catalogue est surtout des cartes à l'unité (Swiss-Pokeshop).
  - CS-Cart (400 Coups) : `hidden` = numéros de fiches 30 ans créées mais pas encore en ligne (trouvées par leur adresse, même en 404) ; le bot les ouvre à chaque passage et envoie « 👀 En ligne » quand elles apparaissent. `probe` = essaie les numéros suivants le plus haut connu pour découvrir les nouvelles fiches (gardées dans state.json). `pauseMs` = pause entre deux requêtes (le site renvoie vite des 429).
  - Wix : la page de catégorie contient la liste des produits ; avec une option « Langue », commandable = la langue voulue est en stock.
  - `exclude` / `excludeCategories` : aucun de ces mots, aucune de ces catégories (préfixe : `accessoires`).
  - `language` (ex. `FR`) : écarte les autres langues. Un article sans langue connue est gardé, marqué « (langue ?) ». Un article bilingue « FR/EN » compte comme FR.
  - `singles: "once"` (Shopify) : les cartes à l'unité (produits sans étiquette) ne sont annoncées qu'à leur apparition, pas à chaque réassort.
- Plus de 3 nouvelles cartes à l'unité d'un coup → **une seule** notification groupée. Les produits scellés ont toujours leur propre notification.

Ajouter un article 400 Coups = une entrée dans `products` (`name` + `url`).

## Déclenchement

- **cron-job.org**, toutes les 10 min : `POST https://api.github.com/repos/tchappuis42/stock-watch/actions/workflows/watch.yml/dispatches`
  - en-têtes : `Authorization: Bearer <jeton GitHub>`, `Accept: application/vnd.github+json`
  - corps : `{"ref":"main","inputs":{"report":"false"}}`
- **GitHub** lance aussi un passage de secours toutes les heures.
- **Actions → stock-watch → Run workflow** : test manuel, envoie toujours l'état actuel.

Secret requis : `NTFY_TOPIC` (Settings → Secrets and variables → Actions).

## Notifications

- **Surveillance démarrée** : premier passage d'une surveillance, avec l'état actuel.
- **🆕** : nouvel article correspondant aux mots-clés.
- **🚨 COMMANDABLE** : l'article peut être commandé. Les alertes d'un article commandable portent le tag ntfy `orderable` (lu par la fenêtre sur le PC).
- **👀 En ligne** : une fiche cachée (400 Coups) est devenue visible.
- **Changement** : le statut d'une page produit a changé.
- **⚠** : aucun produit lu sur une boutique depuis 3 passages, le format du site a sans doute changé.

Une notification qui n'a pas pu partir est renvoyée au passage suivant. Une boutique en erreur n'empêche plus les autres d'être vérifiées (le passage apparaît quand même en échec dans Actions).
- **Test OK / Test — Page non lue** : uniquement sur un test manuel.

## Fenêtre sur le PC

`viewer/ntfy_viewer.pyw` : petite fenêtre Windows qui affiche les notifications en direct, avec alerte quand un article devient commandable. Voir [viewer/README.md](viewer/README.md).
