# Übergabe – Analytics Experience Platform (Track A)

Stand: 20.10.2026 · Version `v0.10-mvp-acceptance` · Schema 10

Dieses Dokument richtet sich an das Team, das die Plattform in der
Unternehmensumgebung bereitstellt. Es beschreibt den Stand, was für einen Betrieb
gebraucht wird und was vor einem Produktivbetrieb noch fehlt.

## 1. Stand in einem Satz

Das **Engineering-MVP ist abgeschlossen**: alle zehn Meilensteine (F0–F10) sind
mit ihren Gates nachgewiesen, alle 127 Punkte der Abnahme-Checkliste haben einen
Nachweis. Es ist **noch nicht produktionsreif** – es wurde ausschließlich gegen
einen simulierten Matomo-Adapter entwickelt und getestet (Entscheidung des
Auftraggebers), und eine Reihe von Betriebsthemen ist bewusst als
„Production Readiness“ eingeordnet (Abschnitt 6).

**Empfehlung:** zuerst eine **Pilot-/Staging-Umgebung** mit einem echten Matomo
und einem kleinen Nutzerkreis, Produktivbetrieb erst nach den Punkten in
Abschnitt 6.

## 2. Was übergeben wird

| Teil                             | Inhalt                                                                                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dieses Repository                | Code, Migrationen, Tests, Gate-Skripte, Doku; vollständige Git-Historie mit Tags `v0.1` … `v0.10`. Privat auf GitHub: <https://github.com/roka2308/axp-claude> (Zugang über Einladung) |
| Spezifikation (separater Ordner) | `analytics_experience_version_d_v1.0/` – Master-Spezifikation, Engineering-Vertrag, Entwicklungsplan, Abnahme-Checkliste, Demo-Fixture. Maßgeblich für das Produkt                     |
| Nicht enthalten                  | `.env` (Secrets), `node_modules`, Build-Artefakte, `.local/` (lokale Datenbank, Logs)                                                                                                  |

Wichtige Dokumente im Repository:

| Datei                                   | Wofür                                                              |
| --------------------------------------- | ------------------------------------------------------------------ |
| `README.md`                             | Entwicklungsumgebung, Befehle, Architektur                         |
| `docs/acceptance/mvp-acceptance.md`     | Abnahme je Checklistenpunkt mit Nachweis; Liste der offenen Punkte |
| `docs/gates/F0.md` … `F10.md`           | Gate-Protokolle mit Belegen                                        |
| `docs/adr/`                             | Architekturentscheidungen (0001–0013)                              |
| `DEVIATIONS.md`                         | Abweichungen von der Spezifikation und ihr Status                  |
| `docs/operations/backup-and-restore.md` | Backup/Restore-Runbook (im Gate F10 geprobt)                       |
| `docs/operations/upgrade.md`            | Upgrade-Runbook (im Gate F10 von v0.9 aus geprobt)                 |

## 3. Architektur für den Betrieb

Ein Codebestand, drei Node.js-Prozesse, eine MySQL-Datenbank:

```
Browser ─▶ Web (Next.js, Port WEB_PORT) ─▶ API (Fastify, Port API_PORT) ─▶ MySQL 8.4
                                              ▲            └──────────────▶ Matomo (HTTPS)
           Worker (Jobs, Mails, Aufräumen) ───┘ Health auf API_PORT+1      SMTP
```

- Der Browser spricht **nur mit dem Web-Server**. Die API muss nicht öffentlich
  erreichbar sein, nur für den Web-Server und den Worker-Host.
- Matomo ist der einzige Speicher für Analysedaten; MySQL hält nur
  Produktkonfiguration. Matomo-Zugangsdaten liegen verschlüsselt in MySQL.
- Der Worker verarbeitet die Job-Queue (Berichte, Konto-Mails) und Aufräumaufgaben.
  Genau **eine** API- und **eine** Worker-Instanz betreiben (siehe Abschnitt 6).

## 4. Voraussetzungen

| Komponente        | Anforderung                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js           | ≥ 22.12 (entwickelt und getestet mit 24)                                                                                                            |
| MySQL             | 8.4, Zeichensatz `utf8mb4`, Kollation `utf8mb4_0900_ai_ci`, eigener Benutzer nur für die Datenbank                                                  |
| SMTP              | Ein Relay für Einladungen, Passwort-Links, Adressbestätigungen und Berichte                                                                         |
| Reverse Proxy     | TLS-Terminierung vor dem Web-Server; muss `X-Forwarded-For` setzen                                                                                  |
| Matomo            | Erreichbar per HTTPS vom API-Server; ein Token mit Lesezugriff je Verbindung. Liegt es im internen Netz: Hostname in `MATOMO_ALLOWED_PRIVATE_HOSTS` |
| Build-/Admin-Host | Vollständiger Checkout mit `npm ci` (inkl. Dev-Abhängigkeiten): Migrationen, Erst-Admin und Notfallzugang laufen über `tsx`                         |

## 5. Bereitstellung Schritt für Schritt

1. **Code holen und bauen**

   ```bash
   npm ci
   npm run verify      # Typen, Lint, Format, Unit-, Integrationstests, Build
   ```

   `npm run build` erzeugt `apps/api/dist`, `apps/worker/dist` und den
   Next.js-Standalone-Server unter `apps/web/.next/standalone`.

2. **Konfiguration** – als Umgebungsvariablen (Vorlage: `.env.example`).
   Mit `APP_ENV=production` verweigern alle Prozesse den Start, wenn eine der
   eingebauten Schutzregeln verletzt ist (Demo-Daten an, kein JSON-Log, keine
   HTTPS-URLs, Entwickler-Zugangsdaten in `DATABASE_URL`).

   | Variable                       | Produktivwert / Hinweis                                                                                                                                                                                  |
   | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `NODE_ENV`, `APP_ENV`          | `production`                                                                                                                                                                                             |
   | `DEPLOYMENT_PROFILE`           | `central_multi_tenant`, `dedicated_single_customer` oder `customer_hosted`                                                                                                                               |
   | `LOG_FORMAT`, `LOG_LEVEL`      | `json`, `info`                                                                                                                                                                                           |
   | `API_HOST`, `API_PORT`         | Bind-Adresse und Port der API                                                                                                                                                                            |
   | `API_PUBLIC_URL`               | HTTPS-URL, unter der der Web-Server die API erreicht                                                                                                                                                     |
   | `WEB_PORT`, `WEB_PUBLIC_URL`   | Port des Web-Servers; öffentliche HTTPS-URL (Links in Mails zeigen dorthin)                                                                                                                              |
   | `API_TRUSTED_PROXIES`          | Adresse(n) des Web-Servers, kommagetrennt (ADR 0012)                                                                                                                                                     |
   | `DATABASE_URL`                 | `mysql://<benutzer>:<passwort>@<host>:<port>/<datenbank>`                                                                                                                                                |
   | `SESSION_SECRET`               | 32 Byte, Base64 – im Secret Store                                                                                                                                                                        |
   | `CREDENTIAL_ENCRYPTION_KEY`    | 32 Byte, Base64 – im Secret Store, **separat sichern** (verschlüsselt Matomo-Token, Exporte)                                                                                                             |
   | `MAIL_TRANSPORT`               | `smtp`, dazu `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM`                                                                                                          |
   | `ENABLE_DEMO_FIXTURES`         | `false`                                                                                                                                                                                                  |
   | `EXPORT_ARTIFACT_DIR`          | Privates, beschreibbares Verzeichnis für kurzlebige, verschlüsselte Exporte                                                                                                                              |
   | `REPORTS_PPTX_ENABLED`         | `false` (PowerPoint für geplante Berichte wartet auf sein Stabilitäts-Gate)                                                                                                                              |
   | `MATOMO_ALLOWED_PRIVATE_HOSTS` | Interne Matomo-Server, kommagetrennt und exakt benannt (z. B. `matomo.intern.firma.de`). Ohne Eintrag sind Matomo-Adressen im internen Netz gesperrt. Keine Platzhalter, Bereiche oder Ports (ADR 0013). |

   Schlüssel erzeugen:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`

3. **Datenbank anlegen und migrieren**

   ```bash
   npm run db:migrate
   ```

   Migrationen sind vorwärtsgerichtet und idempotent (`docs/operations/upgrade.md`).

4. **Prozesse starten** (z. B. als systemd-Units oder Windows-Dienste)

   ```bash
   node apps/api/dist/main.js
   node apps/worker/dist/main.js
   PORT=$WEB_PORT node apps/web/.next/standalone/apps/web/server.js
   ```

   Gesundheitsprüfungen: `GET /livez` und `GET /readyz` auf der API und auf dem
   Worker (`API_PORT+1`).

5. **Ersten Plattform-Admin anlegen** – es gibt **keine Standardkonten und
   keine Standardpasswörter**:

   ```bash
   npm run bootstrap-admin
   ```

   Die ausgegebene URL einmalig öffnen, Adresse und Passwort wählen; danach ist
   der Einrichtungsweg dauerhaft geschlossen. Notfallzugang:
   `npm run recover-admin -- --requested-by "<Name>"` (separat, auditiert).

6. **Kunden, Projekt und Matomo** in der Oberfläche anlegen: Administration →
   Kunden → „Tenant anlegen“, dann im Projekt die Matomo-Verbindung einrichten
   (URL und Token werden geprüft, bevor sie gespeichert werden).

7. **Backups einrichten** nach `docs/operations/backup-and-restore.md`
   (MySQL-Dump plus separat gesicherter `CREDENTIAL_ENCRYPTION_KEY`).

## 6. Vor einem Produktivbetrieb zu klären

Vollständige Liste mit Einordnung: `docs/acceptance/mvp-acceptance.md`, letzte
Tabelle. Die für eine Bereitstellung wichtigsten Punkte:

| Thema                                     | Warum es zählt                                                                                                                                                                                                                                 | Einordnung                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **Matomo im internen Netz**               | Außerhalb der Entwicklung lehnt die API Matomo-Adressen in privaten Netzen ab (Schutz gegen SSRF). Ein internes Firmen-Matomo wird über `MATOMO_ALLOWED_PRIVATE_HOSTS` ausdrücklich freigegeben; danach API und Worker neu starten (ADR 0013). | Konfiguration vor dem Pilot |
| **Echtes Matomo nie angebunden**          | Der HTTP-Adapter ist gebaut und abgesichert, aber nur gegen den Mock getestet. Fähigkeitsprüfung, Kennzahlen und Zeitzonen gegen die eigene Matomo-Version prüfen.                                                                             | Production Readiness        |
| **Anmeldung**                             | Nur lokale Konten mit Passwort. OIDC/SSO ist im Datenmodell vorbereitet, die Anbindung fehlt.                                                                                                                                                  | Production Readiness        |
| **Reverse Proxy & `API_TRUSTED_PROXIES`** | Rate-Limits und Login-Sperren zählen pro Besucher; das funktioniert nur, wenn der Proxy `X-Forwarded-For` setzt und die API nur dem Web-Server glaubt.                                                                                         | Production Readiness        |
| **Nur eine Instanz je Prozess**           | Rate-Limits und Analytics-Cache liegen im Speicher; Exportdateien im lokalen Verzeichnis. Horizontal skalieren erfordert gemeinsame Ablagen.                                                                                                   | Production Readiness        |
| **Keine Container-Images**                | Bereitstellung derzeit als Node-Prozesse aus dem Build; Images/Helm-Charts fehlen.                                                                                                                                                             | Production Readiness        |
| **Mailzustellung**                        | SPF, DKIM, Bounce-Behandlung für den Absender.                                                                                                                                                                                                 | Production Readiness        |
| **Barrierefreiheit manuell**              | Automatische WCAG-2.1-AA-Prüfung bestanden; ein Durchgang mit Screenreader (NVDA, JAWS, VoiceOver) steht aus. Firefox-Smoke-Tests sind eingebaut (`E2E_FIREFOX=1`), liefen aber auf der Entwicklungsmaschine nicht.                            | Production Readiness        |
| **Zwei npm-Hinweise**                     | `image-size` (über pptxgenjs) und `uuid` (über exceljs) – Code, den das Produkt nicht ausführt. Ersetzen, sobald die Pakete aktualisiert werden.                                                                                               | Production Readiness        |
| **Sicherheitsprüfung**                    | Interne Prüfung bzw. Penetrationstest durch das Unternehmen.                                                                                                                                                                                   | vor Go-live empfohlen       |
| **Löschfristen beim Offboarding**         | In der Spezifikation offen.                                                                                                                                                                                                                    | On Hold                     |

## 7. Prüfen, dass alles funktioniert

```bash
npm run verify          # schnelle Prüfung in CI-Reihenfolge
npm run gate:f10        # komplette Abnahme (zerstört die Entwicklungsdatenbank!)
```

Gate F10 läuft nur mit `APP_ENV=development` und setzt die Datenbank zurück –
**niemals gegen eine Umgebung mit echten Daten ausführen.** Es prüft unter
anderem Mandantentrennung über alle Routen, Upgrade von v0.9, Backup/Restore,
Mail-Abläufe, Log-Inhalte und die Browser-Journeys.

## 8. Sicherheitsgrundsätze, die nicht verändert werden dürfen

- Der Browser bekommt nie Matomo-Zugangsdaten und fragt Matomo nie selbst ab.
- Mandantentrennung wird serverseitig erzwungen; Datenzugriff braucht Rolle **und**
  Objektfreigabe (ADR 0006).
- Keine Standardkonten; der Erst-Admin entsteht nur über den einmaligen Bootstrap.
- Secrets gehören in den Secret Store, nie ins Repository oder in Logs.
- Fehlende oder unbekannte Werte werden nie als 0 angezeigt.

Weitere Invarianten: `CLAUDE.md` und `README.md`.
