# Design — Authentification locale mono-utilisateur pour `services/mcp-server`

**Date :** 2026-07-18
**Issue :** [#8](https://github.com/jamon8888/hacienda-private/issues/8) — *no authenticated-subject/identity model*
**Code de référence :** branche `plan5-security-gdpr` (PR #6, **CLOSED** par le propriétaire — voir §6). Le fix se construit sur `main`.
**Statut :** design validé, prêt pour plan d'implémentation

---

## 1. Problème

`services/mcp-server` n'a **aucune identité authentifiée par requête** entre la couche
transport (HTTP `handle()` / MCP stdio `runMcp()`) et `AppContext`. En conséquence, quatre
contrôles de sécurité/audit sont des **fictions** (no-ops) :

| # | Contrôle | Fichier | Pourquoi c'est un no-op aujourd'hui |
|---|----------|---------|--------------------------------------|
| 1 | `createAppContext()` | `src/index.ts` | `tokenScopes = ["read","ingest","redact","admin"]` figé, une fois par process, partagé par toutes les requêtes |
| 2 | `authorize()` | `src/mcp/scopes.ts` | `matter.id !== requestedMatterId` toujours faux (le matter est fetché *par* ce même id) → tautologie, ne peut jamais refuser |
| 3 | `actorFor()` | `src/mcp/tools.ts` | l'audit enregistre `mcp:<scopes>`, identique pour tout appelant → aucune identité dans `audit_log` |
| 4 | `requireConsent()` | `src/mcp/consent.ts` | subject figé à `"*"` → les grants de consentement par-sujet sont write-only, jamais distingués à l'enforcement |

**Exposition réelle** (faible mais non nulle) : le serveur bind `127.0.0.1` par défaut
(`config.ts`), donc pas exploitable à distance. Le risque est **local** : sans contrôle
d'origine ni credential, n'importe quel autre process — ou **n'importe quel onglet navigateur
ouvert sur la même machine** — peut appeler tout endpoint HTTP, y compris une future route
destructive, via `fetch("http://localhost:8787/...", {method:"DELETE"})`, sans aucun credential.

## 2. Contexte & contraintes

- **Outil local-first, mono-propriétaire** ("owner-launched"). Il n'y a **qu'un seul humain**.
  Ce n'est pas un serveur multi-tenant et ne doit pas le devenir dans ce design.
- **Personas cibles = professions réglementées** (avocats, notaires). Le critère dominant est la
  **défendabilité et l'auditabilité** des contrôles (accountability RGPD, Art. 30), pas
  l'hygiène maximale d'un secret. **Un contrôle qui ment est un risque de conformité**, pas
  seulement un risque technique — c'est la vraie raison de corriger.
- Le **client HTTP principal** est l'UI web servie par ce même serveur (export statique Next.js
  `apps/web/out`, cf. `2026-07-17-wasm-web-ui-e2e-design.md`).
- `config.ts` possède déjà un hook `jwtSecret` ; `@xberg-io/core` exporte déjà
  `AuthScopes = "read" | "ingest" | "redact" | "admin"` ; la table `consent(subject, matter_id, scope)`
  et `isConsentActive(subject, ...)` prennent déjà un vrai `subject`.

### Recadrage central

« S'authentifier en local pour un utilisateur solo » **n'est pas** un login. Il n'y a personne à
distinguer d'un autre utilisateur. On distingue **« un appelant que le propriétaire a autorisé »**
de **« un process/onglet qui passait par là »**. C'est une **capability (secret partagé) + un
contrôle d'origine**, pas une preuve d'identité.

Et les **deux surfaces n'ont pas le même problème** :

- **MCP stdio** : le process est *spawné* par le client propriétaire (Claude Desktop) via des
  pipes stdin/stdout, sans réseau. Celui qui a lancé le process **est** le propriétaire. Le spawn
  *est* l'authentification. → aucun token nécessaire, et c'est **honnête**, pas un raccourci.
- **HTTP loopback** : seule surface avec un vrai trou (drive-by tab, autre process local). C'est
  la seule qui a besoin d'un credential + garde d'origine.

## 3. Décisions retenues (arbitrages)

| Décision | Choix retenu | Alternative écartée & raison |
|----------|--------------|------------------------------|
| Nature du credential | **Token opaque aléatoire 256 bits** | JWT — pour un solo, les claims `{subject:"owner", scopes, matter_ids}` sont constantes ; JWT émis+vérifié par le même process = cérémonie (YAGNI). Chemin d'upgrade gardé ouvert. |
| Cycle de vie / distribution | **Persisté `~/.xberg/session.token` en 0600**, injecté dans `GET /` | Éphémère-par-lancement — moins bon storytelling d'audit ; un client non-navigateur devrait copier depuis stdout. |
| Scopes | **Conservés, pilotés par config, défaut = tous** | Suppression totale — perd le garde-fou "lecture seule / consultation" réaliste en déontologie, et re-câbler plus tard coûte plus que garder une version honnête. RBAC complet — sur-engineering. |
| Contrôle d'origine | **Garde `Sec-Fetch-Site`/`Origin` obligatoire** sur HTTP | CORS permissif — l'inverse du besoin. |
| Identité MCP stdio | **Implicite `subject:"owner"`, pas de token** | Handshake d'auth stdio — inutile, le spawn est déjà la frontière. |

**Storytelling d'audit** (pour un DPO/client) : *« le credential est un fichier protégé par les
permissions OS, même frontière de confiance que la clé de vault »*. Un process capable de lire
`session.token` pourrait déjà lire la SQLite et le vault → la persistance n'ajoute **aucune**
surface d'exposition.

## 4. Architecture cible

### 4.1 Séparation contexte-process / principal-par-requête

Le cœur du fix. `tokenScopes` quitte `AppContext` (process-wide) pour un `Principal` dérivé
**par requête / par lancement**.

```ts
// Inchangé : état partagé du process
export interface AppContext {
  config: AppConfig;
  store: MetadataStore;
  models: ModelCache;
  mirror: MirrorStore;
  vault: KeyVault;
}

// NOUVEAU : identité effective d'un appel
export interface Principal {
  subject: string;            // "owner" dans le modèle solo
  scopes: AuthScopes[];       // dérivés du token (HTTP) ou de la config (stdio)
}
```

Les fonctions d'outils et les handlers passent de `(ctx, args)` à `(ctx, principal, args)`.

### 4.2 Émission du credential au démarrage

`main()` :
1. Résout `session.token` dans `dataDir`. S'il n'existe pas → génère 32 octets
   (`crypto.randomBytes(32)`, hex), écrit le fichier en **mode 0600**.
2. Calcule les `scopes` du lancement depuis la config (défaut : `["read","ingest","redact","admin"]` ;
   overridable, ex. `XBERG_SCOPES=read` pour un lancement consultation).
3. Conserve `{ token, scopes }` pour les dériver côté transport.

### 4.3 Surface HTTP — deux couches

Dans `handle()`, **avant** tout traitement d'un endpoint d'état :

1. **Garde d'origine** — rejeter si `Sec-Fetch-Site` ∈ {`cross-site`, `same-site`} ; n'autoriser
   que `same-origin` et `none`. Les requêtes sans `Sec-Fetch-Site` (clients non-navigateur)
   passent cette couche mais restent soumises au token. → tue le drive-by tab.
2. **Token Bearer** — extraire `Authorization: Bearer <token>`, comparer en **temps constant**
   (`crypto.timingSafeEqual`) au token émis. Échec → `401`. Succès → dériver
   `Principal { subject: "owner", scopes: <scopes du lancement> }`.

**Endpoints statiques** (`GET /`, `/wasm/*`, `/models/*`) : servis **sans** token (contenu public
non sensible), mais `GET /` **injecte** le token pour l'UI :

```html
<script>window.__XBERG_TOKEN__ = "…";</script>
```

Le serveur intercepte déjà `GET /` → l'injection s'y fait par un passage de template sur le
`index.html` servi (lecture + insertion du `<script>` en tête de `<head>`, avant le bundle de
l'app). L'UI web lit `window.__XBERG_TOKEN__` et l'envoie en `Bearer` sur ses appels API. Un onglet
cross-origin ne peut **pas** lire ce HTML (SOP) **et** est bloqué par la garde d'origine → double
défense.

**Décision : injection plutôt qu'endpoint `GET /session/token` séparé.** Raison de sécurité, non
d'ergonomie : avec l'injection, la **confidentialité du token repose sur la Same-Origin Policy**
(un invariant du navigateur), pas sur notre propre code de parsing d'en-têtes. Un endpoint séparé
`GET /session/token` devrait s'appuyer *entièrement* sur la garde d'origine pour rester secret — si
cette garde a un bug/bypass, le token fuite. L'injection place la SOP comme rempart principal et la
garde d'origine comme défense-en-profondeur, pas l'inverse. Pour une profession réglementée, la
phrase d'audit *« la confidentialité du credential repose sur la Same-Origin Policy du navigateur »*
est plus forte et plus simple à défendre que *« … sur la correction de notre vérification
d'en-tête »*.

*Durcissement futur documenté (hors périmètre) :* cookie `HttpOnly; SameSite=Strict` — le token ne
transiterait jamais par le JS (immunité au vol par XSS). Écarté ici car il réintroduit des
considérations CSRF (cookie ambiant) et complique les clients non-navigateur (CLI/MCP), alors que
le `Bearer` couvre les deux surfaces simplement.

**Pas de CORS permissif** : aucune en-tête `Access-Control-Allow-Origin: *`.

### 4.4 Surface MCP stdio

`runMcp(ctx)` construit `Principal { subject: "owner", scopes: <scopes du lancement> }` **une
fois**, sans token, et le passe aux outils. Justification explicite dans le code : *le spawn du
process par le client propriétaire est la frontière d'authentification.*

### 4.5 Les quatre contrôles, rendus honnêtes

- **`authorize(principal.scopes, required)`** — signature réduite : on **supprime** le paramètre
  `matter`/`requestedMatterId` et le check tautologique. Il ne reste que le check de scope, qui
  **peut réellement refuser** (ex. token `read` demandant `redact`). Le matter-scoping par-identité
  est **hors périmètre** (il n'existe pas de « matters d'autrui » en solo) — documenté comme
  extension future si multi-sujet.
- **`actorFor(principal)`** → `principal.subject` (`"owner"`). L'`audit_log.actor` porte enfin une
  identité, faible cardinalité mais **vraie**.
- **`requireConsent(store, matter, kind, principal.subject)`** → interroge le vrai subject au lieu
  de `"*"`. Les grants par-sujet deviennent enforçables.
- **HTTP DELETE / routes admin** (quand elles existent sur la branche) : le check `admin` opère
  désormais sur `principal.scopes` dérivés d'un token valide, plus sur un tableau constant.

## 5. Modèle de menace — ce qui est couvert / pas couvert

| Menace | Couvert ? | Par quoi |
|--------|-----------|----------|
| Onglet navigateur tiers → `fetch` DELETE sans credential | ✅ | Garde d'origine (couche 1) + SOP sur le token injecté |
| Autre process local (compte owner) → curl vers l'API HTTP | ⚠️ (hors périmètre, même frontière que la ligne 4) | Le token Bearer est une **capability same-machine**, pas un secret : `GET /` est non-authentifié et l'injecte en clair (`curl http://127.0.0.1:<port>/ \| grep __XBERG_TOKEN__`), et `curl` n'envoie pas de `Sec-Fetch-Site` donc passe la garde d'origine. Un process tournant sous le compte owner peut donc l'obtenir puis le rejouer en `Bearer`. Le 0600 protège seulement contre un **autre utilisateur** de la machine, pas contre un autre process du même compte — même frontière de confiance que la ligne 4 (accès fichier au home). |
| Accès distant off-box | ✅ | bind `127.0.0.1` (existant) |
| Attaquant ayant déjà l'accès fichier au home de l'utilisateur | ❌ (hors périmètre) | Pourrait lire vault/SQLite de toute façon — même frontière de confiance |
| Multi-utilisateur / multi-tenant | ❌ (par design) | Non-objectif ; `subject="owner"` unique |

*Note :* le token Bearer ne protège pas contre un autre process du compte owner — il protège
contre un onglet cross-origin (SOP) et contre un accès distant (bind loopback). Sur le poste
mono-propriétaire visé, un process qui tourne déjà sous le compte owner est hors périmètre au
même titre que l'accès direct au vault/SQLite (ligne 4) : le 0600 est de l'hygiène défense-en-
profondeur pour le compte owner, pas une garantie de confidentialité inter-process.

## 6. État de PR #6 et stratégie de portage vers `main`

**Situation réelle (vérifiée) :** PR #6 est **déjà `CLOSED`** par le propriétaire (`jamon8888`), le
2026-07-18, **délibérément**. Son commentaire de fermeture précise que :

- le **no-egress guard** et le **vault AES-GCM navigateur** (BrowserVault, PBKDF2) sont **déjà
  consolidés sur `main`** (commit `0a368aa822`) ;
- la partie « scoped tokens » **n'a jamais été réellement implémentée** sur la branche (les 4 no-ops
  de l'issue #8) et est volontairement **déférée à #8**, comme *« un vrai design d'identité
  par-requête, pas un copier-coller »* ;
- la branche `plan5-security-gdpr` est **conservée** (ni mergée, ni supprimée).

**Conséquence : il n'y a aucune décision « merger vs remplacer PR #6 » à prendre — le propriétaire
l'a déjà tranchée.** Ce design est aligné avec sa demande explicite. Aucun travail de l'associé
n'est écrasé : sa substance (egress + vault) vit déjà sur `main`.

**Séquence retenue :**

1. Travailler **directement sur `main`** (qui contient déjà egress + vault). Ne PAS réconcilier ni
   merger `plan5` : la branche sert seulement de **référence** pour la forme des 3 fichiers
   `mcp/{scopes,tools,consent}.ts`.
2. **Porter ces 3 fichiers sur `main` réécrits** avec le modèle `Principal` (§4). Sur `main`, `mcp/`
   n'a aujourd'hui qu'un `mod.ts` de stubs → ce portage donne aussi leurs vrais corps aux outils.
3. **Corriger, pendant le portage, les 2 findings CodeRabbit** valides sur le `tools.ts` de plan5
   (voir §6.1) — ne pas les réintroduire.
4. **PR unique** sur `main` : `feat(mcp-server): local single-owner auth (Principal, origin guard, session token)`, référençant et **fermant #8**.

### 6.1 Findings CodeRabbit hérités à corriger au portage

De la revue de PR #6 (encore valides, car ces fichiers ne sont pas sur `main`) :

- **`recordRedaction` absente de `MetadataStore`** (`tools.ts` `redact`) → ne compile pas.
  Ajouter la méthode dans `store.ts` (ou câbler l'API existante) en préservant le flux d'audit.
- **`top_k` non borné** (`registerTools`, `rag_query`) → `z.number().int().positive().max(100).optional()`
  pour éviter un `LIMIT -1` non borné (épuisement mémoire) et le cas `0` qui contourne le défaut `?? 8`.

*(Un 3ᵉ finding — caractères invisibles dans `egress.test.ts` — concerne un fichier déjà consolidé
sur `main` ; hors périmètre de ce design, à vérifier séparément.)*

## 7. Périmètre

**Inclus :** `Principal` + refactor `AppContext` ; émission `session.token` 0600 ; garde
d'origine + Bearer HTTP ; injection token dans `GET /` ; `authorize()` scope-only ;
`actorFor`/`requireConsent` sur vrai subject ; identité stdio implicite ; scopes pilotés par
config ; tests.

**Exclus (YAGNI, extensions futures documentées) :** JWT ; multi-sujet / multi-tenant ;
matter-scoping par-identité ; serveur d'autorisation ; rotation/révocation de token ;
authentification de la surface stdio.

## 8. Tests (esquisse)

- Garde d'origine : `Sec-Fetch-Site: cross-site` → 403 ; `same-origin` → passe.
- Token : absent/invalide → 401 ; valide → 200 ; comparaison temps-constant.
- `GET /` injecte bien `window.__XBERG_TOKEN__` ; endpoints statiques sans token → 200.
- `authorize` : token `read` + action `redact` → refus ; token `admin` → passe.
- `actorFor` : `audit_log.actor === "owner"`.
- `requireConsent` : grant `subject="owner"` actif → passe ; grant `subject="autre"` → refus.
- MCP stdio : `Principal.subject === "owner"` sans token.
