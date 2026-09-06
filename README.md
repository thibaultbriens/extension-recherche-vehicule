<div align="center">
  <img src="assets/vancheck-logo.png" alt="Logo VanCheck" width="220">

  # VanCheck

  **Le copilote qui analyse vos annonces de véhicules avant de prendre la route.**
</div>

VanCheck est une extension Chrome locale qui facilite la recherche d'un véhicule sur [Leboncoin](https://www.leboncoin.fr/). Elle prépare une analyse dans ChatGPT à partir de l'annonce et de vos critères, conserve le verdict obtenu, puis vous aide à suivre les échanges avec le vendeur.

> VanCheck est un projet indépendant. Il n'est ni affilié à Leboncoin ni approuvé par OpenAI.

## Fonctionnalités

- Analyse d'une annonce selon vos critères personnels : budget, dimensions, kilométrage, motorisation, usage ou points rédhibitoires.
- Envoi automatique du contexte vers ChatGPT, avec les photos et PDF utiles lorsque ceux-ci sont disponibles.
- Verdict synthétique, résumé et score sur 10 directement visibles dans l'annonce, les résultats, la messagerie et l'historique VanCheck.
- Suivi des nouvelles réponses du vendeur sans renvoyer inutilement tout l'historique.
- Proposition d'un message au vendeur, avec confirmation explicite avant tout envoi réel.
- Correction manuelle du score et du résumé, accompagnée de notes personnelles locales.
- Export JSON de l'historique.
- Stockage local dans le navigateur : aucun serveur VanCheck et aucun compte VanCheck.

## Prérequis

- Google Chrome ou un navigateur compatible avec les extensions Manifest V3.
- Un compte ChatGPT accessible sur `chatgpt.com`.
- Un compte Leboncoin pour utiliser le suivi de messagerie.

## Installation

VanCheck n'est pas encore distribué sur le Chrome Web Store. L'installation se fait depuis les sources :

1. Télécharger ce dépôt avec **Code → Download ZIP**, puis décompresser l'archive, ou le cloner avec Git.
2. Ouvrir `chrome://extensions` dans Chrome.
3. Activer le **Mode développeur**.
4. Cliquer sur **Charger l'extension non empaquetée**.
5. Sélectionner le dossier racine du projet, celui qui contient `manifest.json`.

Après une mise à jour des sources, cliquer sur **Recharger** dans la fiche de l'extension et actualiser les onglets Leboncoin et ChatGPT déjà ouverts.

## Utilisation

### Analyser une annonce

1. Ouvrir VanCheck depuis la barre d'outils de Chrome.
2. Enregistrer vos critères de recherche et, facultativement, l'adresse de votre projet ChatGPT.
3. Ouvrir une annonce de véhicule sur Leboncoin.
4. Cliquer sur **Analyser l'annonce**, puis sur **Ouvrir ChatGPT avec le prompt**.
5. Laisser l'onglet ChatGPT ouvert jusqu'à la confirmation de l'enregistrement de l'analyse.

VanCheck demande à ChatGPT un verdict, un score sur 10, une analyse argumentée et, si nécessaire, un message à envoyer au vendeur. Le résultat est ensuite reporté automatiquement sur Leboncoin.

### Suivre les réponses du vendeur

1. Ouvrir sur Leboncoin la conversation associée à une annonce déjà analysée.
2. Cliquer sur **Analyser la réponse** lorsqu'une nouvelle réponse du vendeur apparaît.
3. VanCheck rouvre la discussion ChatGPT liée à l'annonce et transmet uniquement les nouveaux éléments, pièces jointes comprises.
4. Le verdict et le score sont mis à jour à la fin de l'analyse.

Une réponse n'est marquée comme transmise qu'après la vérification de sa présence effective dans le message ChatGPT. Vos brouillons et vos propres messages sont préservés.

## Vie privée et permissions

Les critères, analyses, notes et identifiants de messages sont conservés dans `chrome.storage.local`. Les pièces jointes sont stockées temporairement le temps de leur transfert, puis supprimées du stockage de l'extension après confirmation.

VanCheck demande uniquement les accès nécessaires à son fonctionnement :

| Permission | Utilisation |
| --- | --- |
| `storage` | Enregistrer localement vos critères, analyses et préférences. |
| `https://www.leboncoin.fr/*` | Lire l'annonce affichée, enrichir l'interface et suivre la conversation ouverte. |
| `https://chatgpt.com/*` | Préparer le prompt et récupérer le résultat de l'analyse. |
| `https://attachments.messaging.bon-coin.net/*` | Récupérer les photos et PDF sélectionnés dans les réponses du vendeur. |

Les données envoyées à Leboncoin et à ChatGPT restent soumises à leurs politiques de confidentialité respectives. Prenez soin de ne pas transmettre d'informations personnelles inutiles.

## Limites connues

- L'extraction dépend de la structure HTML de Leboncoin et de ChatGPT, qui peut évoluer sans préavis.
- Seuls les messages actuellement chargés dans la page Leboncoin peuvent être analysés.
- Les pièces jointes sont limitées à 6 Mo au total par transfert.
- Une republication Leboncoin possédant un nouvel identifiant est considérée comme une nouvelle annonce.
- L'analyse générée ne remplace ni une inspection mécanique, ni un contrôle administratif, ni l'avis d'un professionnel.

## Développement

Le projet utilise du JavaScript natif et ne nécessite aucune étape de compilation.

```bash
npm ci
npm test
```

Les tests reposent sur Node.js et JSDOM. Ils utilisent des conversations fictives et n'envoient aucun message réel.

Principaux fichiers :

| Fichier | Rôle |
| --- | --- |
| `manifest.json` | Configuration Manifest V3 et permissions. |
| `content.js` | Intégration de l'analyse dans les annonces Leboncoin. |
| `messaging.js` | Lecture et suivi des conversations Leboncoin. |
| `chatgpt.js` | Préparation, envoi et récupération des analyses ChatGPT. |
| `background.js` | Coordination et stockage en arrière-plan. |
| `popup.html`, `popup.js`, `popup.css` | Interface et historique de l'extension. |
| `tests/` | Tests automatisés. |

## Contribuer

Les signalements de bugs et les contributions sont bienvenus. Avant de proposer une modification :

1. Créez une issue décrivant le problème ou l'amélioration.
2. Créez une branche dédiée.
3. Ajoutez ou adaptez les tests lorsque le comportement change.
4. Vérifiez que `npm test` réussit.
5. Ouvrez une pull request concise en expliquant le besoin et la solution retenue.

## Licence

Aucune licence n'est fournie pour le moment. Choisissez et ajoutez une licence open source avant de publier ou d'accepter des contributions.
