# Trades Suite

A simple customer desk for HVAC, plumbing, and electrical shops. Pick a business, add a customer, ask for a Google review, or send a quote they can accept from their phone. Each business has its own customers, activity, review requests, quotes, and sending settings.

This repository implements **Phases 1 and 2** using **Node.js, Express, and SQLite**, with a plain HTML/CSS/JavaScript interface. It has one admin workspace shared across businesses. Hosted installations require one admin password; there are no separate business accounts. Customer quote pages need no login.

## Start locally

**Want to see the interface without starting a server?** After the install commands below, run `npm run build:browser-demo` and open the generated **Tradesuite Demo.html** file directly in Chrome or Edge. It contains the same interface with a separate browser-only sample workspace. You can add businesses and customers, simulate review requests, test a three-day nudge, and mark requests done. It does not send SMS, connect to Twilio, or use the server's SQLite database. Changes stay in that browser when browser storage is available. This file is a preview, not a hosted deployment of the full app.

This repository contains the full Node/Express/SQLite application, interface, tests, demo builder, and deployment setup. GitHub is the source of truth for code updates. Generated demos, dependencies, private environment settings, and customer records are excluded from Git; the demo can be rebuilt from its source. You can also download and extract a source ZIP from GitHub instead of cloning.

On Windows, **Push to GitHub.cmd** uploads already committed changes to this
repository's `main` branch and lets Git prompt for GitHub sign-in. It does not
stage files, create commits, or force-push. Keep credentials and customer data
out of commits; `.gitignore` excludes the usual private files.

On Windows, after installing Node.js and downloading the source, you can double-click **Start Demo.cmd** inside the repository folder. It installs dependencies if needed, starts the simulated workspace, and opens your browser. Keep the terminal window open. **ERR_CONNECTION_REFUSED** means the browser cannot reach the server; a stopped server or a restricted preview environment can cause it. The standalone browser demo avoids local server connections entirely.

Install [Node.js 24 or newer](https://nodejs.org/en/download). SQLite is included through Node's built-in `node:sqlite` module; a separate database server is not needed.

```sh
git clone https://github.com/samgoldstein03-art/trades-suite.git
cd trades-suite
npm ci
```

Copy `.env.example` to `.env`:

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

```sh
# macOS or Linux
cp .env.example .env
```

Leave `SMS_MODE=demo` for the first run, then start the app:

```sh
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The first run creates the database automatically. Keep this terminal running while using the app. `npm run dev` restarts the server when source files change.

**Demo mode never contacts Twilio or SMTP and never sends a real text or email.** It records simulated messages so you can try the whole workflow before supplying credentials. The interface identifies demo mode and demo messages. An app running in Twilio mode does not send follow-ups for old demo requests or quotes.

For a ready-to-use walkthrough, stop any running app on port 3000 and run **`npm run demo`**. It creates sample businesses and customers in a separate `data/demo.sqlite` database, always uses simulated texts, and preserves your demo changes between runs. `npm start` uses the database configured in `.env`. Set `DEMO_DATABASE_PATH` if you want a different demo file.

If your Windows network uses a trusted company certificate and npm reports `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, enable Node's system certificate store for that terminal with `$env:NODE_USE_SYSTEM_CA='1'`, then run `npm ci` again. Keep certificate verification enabled.

To fill an empty demo workspace with sample businesses, customers, and requests, leave the server running and run this in a second terminal from the repository folder:

```sh
npm run seed:demo
```

The seed command refuses a nonempty workspace or a server using Twilio mode. It connects to `http://127.0.0.1:3000`; set `APP_URL` for a server on another port. Skip this step to start with your own blank workspace. Use a separate `DATABASE_PATH`, such as `data/live.sqlite`, when moving from the sample workspace to real customers.

## Use the app

1. **Add a business.** Enter its name, phone, booking link, Google review link, and an optional PNG, JPEG, or WebP logo up to 2 MB. Give it a short SMS settings key, such as `HARBOR`; this identifies its environment variables. You can edit the business later.
2. **Add a customer.** Save their name, phone, email, notes, and lead/customer tag. Use phone numbers with the country code, for example `+14165550123`.
3. **Send a review request.** Record the customer's permission in their customer form, then select them and preview the message before sending. The message includes the selected business's Google review link.
4. **Check Activity.** The message and the request's status changes are recorded with timestamps. Dashboard totals and recent activity update for the selected business.
5. **Mark done.** When you see the customer's review, mark the request done. The app does not read Google reviews or guess whether a review has been posted.

Use the business switcher to work with another business. Changing businesses changes the customer list, review requests, quotes, dashboard, and activity together.

Changing a customer's phone number clears their text permission. Save the new number, then edit the customer again to confirm permission for that number. An older request will not nudge the new number; finish that request before starting a new one.

### What the request statuses mean

| Status | Meaning                                                            |
| ------ | ------------------------------------------------------------------ |
| Sent   | Twilio accepted the initial SMS request, or demo mode recorded it. |
| Nudged | The one follow-up SMS was accepted, or demo mode recorded it.      |
| Done   | The owner marked the request complete. No further nudge is due.    |

The app's **Sent** status does not prove handset delivery. Twilio can accept a message into a queue before the carrier delivers it. Phase 1 does not process delivery receipts; use the business's Twilio Console messaging logs for final delivery results. See [Twilio message statuses](https://www.twilio.com/docs/messaging/api/message-resource).

## Connect each business to Twilio

Use an SMS-capable Twilio number owned by that business. Collect its Account SID, Auth Token, and Twilio phone number from its Twilio account. Its normal office phone number can be different from its SMS sending number.

For a business whose SMS settings key is `HARBOR`, add these values to the **server's `.env` file**:

```dotenv
SMS_MODE=twilio
BUSINESS_HARBOR_ACCOUNT_SID=your_account_sid
BUSINESS_HARBOR_AUTH_TOKEN=your_auth_token
BUSINESS_HARBOR_PHONE_NUMBER=+14165550123
PUBLIC_BASE_URL=https://your-webhook-host.example
```

These are placeholders, not working credentials. Replace them privately on the server. For another business with key `MAPLE`, add `BUSINESS_MAPLE_ACCOUNT_SID`, `BUSINESS_MAPLE_AUTH_TOKEN`, and `BUSINESS_MAPLE_PHONE_NUMBER` using that business's own values. Restart the server after editing `.env`.

Only the settings key belongs in the business form. Credentials are read on the server; they are not saved in SQLite, returned to the browser, or included in activity logs. `.env` is excluded from Git. Do not paste tokens into customer notes, source files, screenshots, or support messages.

Before the first live send:

1. Complete Twilio's account and sender verification for your number and destinations. Trial accounts can send only to verified recipients and have additional account and geographic limits; see [Twilio trial restrictions](https://www.twilio.com/docs/usage/trials). Test credentials do not send real texts.
2. Configure the incoming-message webhook below so STOP replies also update this app.
3. Restart with `SMS_MODE=twilio`, choose the business, and send to a consenting test number you control. Confirm the text arrived, then check its Activity entry and Twilio's message log.

You can check credentials, SMS support, and each business's direct incoming-message webhook before sending:

```sh
npm run check:twilio
# Or check only the business with SMS settings key HARBOR:
npm run check:twilio -- --business=HARBOR
```

Run this from the app directory with access to its existing database and private environment settings. The checker makes read-only Twilio API calls; it does not send a text, buy a number, change settings, or print credentials. It also runs inside the hosted container. A passing check does not prove delivery or STOP/START processing: complete the authorized phone test above. Messaging Service or TwiML application routing requires a separate configuration check.

### Incoming STOP replies

Set `PUBLIC_BASE_URL` to the externally reachable **HTTPS origin**, without a trailing slash. In the Twilio Console for each business's phone number, set the incoming-message webhook to **HTTP POST**:

```text
https://your-webhook-host.example/webhooks/twilio/BUSINESS_ID
```

Use the business's actual ID. The business API at `/api/businesses` returns these IDs. Route this webhook path to the app while keeping the admin pages private. If you use a tunnel or reverse proxy, the external URL must match `PUBLIC_BASE_URL` exactly; the app validates Twilio's signature against that URL and the corresponding business's Auth Token. It also checks the account and destination number. Invalid requests are rejected. See [Twilio webhook security](https://www.twilio.com/docs/usage/security).

STOP and other standard opt-out keywords block further sends to that phone number for that business, including automatic nudges. Opt-outs are recorded by business and phone number, so adding another contact with the same number does not bypass the block. Twilio also blocks opted-out numbers on its side. The app accepts `OptOutType` when configured through Twilio Advanced Opt-Out and recognizes standard reply text; see [Twilio opt-out handling](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out). Twilio handles its own confirmation reply; the app does not send a second confirmation SMS. A customer must reply START or UNSTOP to the business's number to remove the phone-level block; checking permission in the admin form cannot override it. START does not undo an unsubscribe made through a quote email.

Every review-request, quote, and follow-up SMS ends with the business name and this exact line:

```text
Reply STOP to opt out
```

Send only with a valid basis for consent and retain the relevant records. The footer is one part of responsible sending, not a guarantee of Canadian anti-spam compliance: the CRTC also requires appropriate consent and sender identification/contact information for commercial electronic messages. Review the [CRTC's CASL guidance](https://crtc.gc.ca/eng/com500/faq500.htm) for your business and message content before live use.

## How the three-day nudge works

- A successful initial request gets a follow-up due time **72 hours after it is sent**, stored in UTC.
- The server checks for due requests at startup and then every minute by default. Keep the server running. Closing the laptop, stopping the process, or losing power pauses checks; eligible overdue requests catch up when the server starts again.
- The dashboard shows **Follow-ups last checked at** with the time of the most recent completed check. A timestamp that stops advancing means checks are no longer completing. Refresh the page to see the latest check; this indicator does not keep a stopped server running.
- Only sent requests that are still unfinished, have no prior nudge attempt, and are eligible to receive texts can be nudged.
- A successful follow-up moves the request to **Nudged**. There is no second automatic follow-up. Marking the request done before it is claimed prevents the nudge.
- A nudge attempt is reserved in SQLite before contacting the provider so overlapping checks cannot send it twice. A request already being sent cannot be recalled.
- Failed or uncertain attempts are logged and listed under **Attention needed** on the dashboard. They leave the request at **Sent** and are not automatically retried. After fixing a confirmed Twilio rejection, use **Retry nudge** for that request. Retrying still requires text permission, the original customer phone number, and valid business SMS settings. A timeout can mean Twilio accepted the message but the app did not receive the response, so uncertain sends cannot be retried from this button. Check Twilio's log and reconcile their outcome first; the app cannot guarantee exactly-once delivery across a provider/network failure.

`NUDGE_INTERVAL_MS` changes how often the worker checks, **not** the 72-hour waiting period. There is no separate cron setup or background worker installation.

An initial send that remains uncertain or was interrupted while sending also blocks another request for that customer. There is no force-retry button. An operator must compare the stored attempt with Twilio's log and reconcile the result before retrying; deleting the contact or database is not a recovery procedure.

### Test without waiting three days

```sh
npm test
```

Tests use temporary databases, a simulated clock, and a fake SMS provider. A restart test closes and reopens a persisted SQLite workspace after its nudge becomes overdue, then verifies that the startup check sends it once. The suite also exercises the exact three-day boundary, a single nudge, business isolation, per-business credentials, completion/opt-out suppression, concurrent operations, failures, input validation, rate limits, and signed incoming webhooks without sending real messages or touching your running app's data.

For a visible walkthrough in **demo mode**:

1. Add a business and customer, then send a simulated review request.
2. Open that business's dashboard and select **Test the 3-day nudge**.
3. Confirm the explanation. This simulates three days for requests in the selected business only; no SMS is sent.
4. Check the request's **Nudged** status and its new message and status entries in Activity.
5. Run the test again: the same request gets no second nudge. Send a demo request to another customer and mark it done first to verify that completed requests are skipped.

The time simulation is unavailable in Twilio mode. Live sends always use the real 72-hour due time.

## Quotes and follow-ups (Phase 2)

1. Select the business and open **Quotes**, then **Create quote**. Choose an existing customer and add the work, quantity, unit price, tax percentage, expiry date, and any customer-facing notes. The app calculates line totals, subtotal, tax, and total in Canadian dollars. Prices are stored as cents, and each line and tax amount is rounded to the nearest cent.
2. Save the draft and check the details. Send it by **SMS**, **email**, or both. SMS uses that business's existing Twilio configuration and requires text permission. Email is optional and uses the SMTP settings below. Demo mode simulates both channels.
3. The customer receives a link to a mobile-friendly page with the quote details and **Accept** / **Decline** buttons. They need no account or admin password. Opening the page marks a sent quote **Viewed**; their decision updates the quote immediately and writes to the same business's Activity log.
4. Use the quote list's status filter to find drafts, sent, viewed, accepted, declined, or expired quotes. The dashboard also lists **Quotes awaiting response**. Open an unanswered quote to stop its reminders at any time.

Drafts are editable. Once delivery has been attempted, the quote keeps the terms and customer details that were prepared for that delivery; changing a business or customer later does not rewrite what the customer received. Create a new quote for revised terms. Quote expiry uses the end of the selected date in **UTC**. An expired quote cannot be accepted or declined and receives no further reminders.

Customer links contain a long, random access token. Anyone who has the link can see that quote and respond, so share it only with its intended customer. Do not put links in public posts or server access logs. The private Activity log records sent messages and their links. The public page shows the quote's customer-facing details, not private customer notes, other quotes, or the admin workspace. The link opens the same stored quote on any device when the real backend is hosted; browser-demo links are only for the sample workspace in that browser.

### Quote reminders

Unanswered sent or viewed quotes are eligible for **one reminder after 48 hours and one after 120 hours per original delivery channel**, measured from the quote's first successful send. An email-only quote receives email reminders, an SMS-only quote receives text reminders, and a quote successfully sent both ways receives both. A failed or unconfirmed initial email does not start email reminders. The same worker that checks review requests checks these reminders on startup and at `NUDGE_INTERVAL_MS`.

Before each text reminder, the app checks text permission, the original phone number, the business's Twilio configuration, and opt-outs. Before each email reminder, it checks the original email address, its validity, the business's SMTP configuration, and opt-outs. A changed address or a permanent recipient rejection stops further email reminders for that quote. Email reminders include the same visible unsubscribe footer and one-click headers as the initial email. A shared customer opt-out stops both channels; losing text permission does not prevent an otherwise eligible email reminder.

Accepting, declining, expiring, or stopping reminders prevents future unclaimed sends on both channels. A message already being sent cannot be recalled. Each reminder is reserved in SQLite by business, quote, channel, and schedule slot to prevent overlapping checks from sending it twice. If the server restarts after both reminder times, it skips the two-day slot and sends only the five-day reminder on each eligible channel, avoiding a burst of overdue reminders. Each reminder gets one attempt; failures and uncertain outcomes appear in delivery history and Activity without an automatic retry. An uncertain message must be checked in the provider's log before any further sending. Provider acceptance means a message was queued, not that the customer received or read it. Permanent recipient failures reported during SMTP submission stop later email reminders; a bounce received after SMTP acceptance must be handled by the email provider, because the app does not ingest later bounce notices.

The automated tests exercise quote creation, calculated totals, business isolation, delivery, public viewing and decisions, expiry, cancelled reminders, opt-outs, and the two reminder boundaries using a fake clock and providers. Run `npm test`; no test needs real Twilio or email credentials. In demo mode, open a sent quote and use its reminder test controls to exercise the sequence without waiting. To check the full flow manually, create a quote, send a simulated SMS, open the customer link, accept it, and refresh the owner's quote list and Activity.

### Customer quote link address

Live quotes require an externally reachable **HTTPS origin**. Set `QUOTE_PUBLIC_BASE_URL=https://your-service.example` without a path or trailing slash. If blank, the app uses `ADMIN_ORIGIN`, then Render's `RENDER_EXTERNAL_URL`. The hostname must point to the running Express app; a static browser demo cannot serve live quotes. Local HTTP links are allowed only for the private demo walkthrough.

Customer quote pages and their decision endpoints are intentionally public and have their own request limits. All business/customer administration stays behind the shared admin password. Keep the quote page paths reachable through any reverse proxy; do not require the admin login on them.

### Optional email setup

SMS-only quotes work without an email account. To offer email as well, use that business's authenticated SMTP service and an address the provider allows it to send from. For a business with settings key `HARBOR`, add these **private server environment variables**:

```dotenv
BUSINESS_HARBOR_SMTP_HOST=smtp.your-provider.example
BUSINESS_HARBOR_SMTP_PORT=587
BUSINESS_HARBOR_SMTP_USER=your_smtp_username
BUSINESS_HARBOR_SMTP_PASSWORD=your_smtp_password
BUSINESS_HARBOR_SMTP_FROM=quotes@your-business.example
```

Use the provider's SMTP-specific credential or app password when required. These examples are placeholders. Add a separate group for every business and restart the app. `SMTP_FROM` must be a single email address, without a display name or recipient list. Do not paste SMTP passwords into the business form, Git, or customer notes.

Port **587** requires a successful STARTTLS upgrade; port **465** starts with TLS. Certificate verification stays enabled, plaintext SMTP is not supported, and sending uses bounded timeouts without automatic retries. Provider debug logging is disabled. See the [Nodemailer SMTP documentation](https://nodemailer.com/smtp) for the transport options and your provider's instructions for sender/domain verification. Email mode follows `SMS_MODE`: `demo` sends no email, and `twilio` enables real configured deliveries. Confirm one authorized test email arrived before calling email delivery verified.

### Unsubscribe from quote messages

Every initial quote email and email reminder contains a visible **Stop quote emails and texts** footer link. It also includes `List-Unsubscribe: <https://...>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers for email clients that offer an Unsubscribe action. Both use a private, random link for that customer in that business; no customer login or admin password is required.

Following the footer link opens a page with an unsubscribe button. Simply fetching the link does not change permission, so email scanners cannot unsubscribe someone just by previewing it. Submitting the button, or the email client's one-click POST, opts out immediately and records the change in the business's Activity log. Repeating an unsubscribe is safe and does not create duplicate changes. The public endpoint accepts the one-click form value `List-Unsubscribe=One-Click` and returns the result directly without redirecting.

The opt-out belongs to the existing contact in the selected business. It blocks quote emails, quote texts, and automatic quote reminders; the existing review-request SMS checks also respect the contact opt-out. An opt-out in one business does not change permission in another business. A phone-level STOP also prevents quote email sending for that opted-out contact. Replying START can remove a phone-level STOP but does not restore permission withdrawn through the quote email link, and changing an email address or phone number does not clear that unsubscribe.

Keep the unsubscribe endpoint reachable through the public HTTPS host used for customer quote links, outside the admin login. Treat unsubscribe links as private customer links, and exclude them from public logs. For live email, configure the SMTP provider to apply a valid **DKIM signature covering both unsubscribe headers**; receiving mail systems may hide their one-click action without it. The app supplies the headers and public handler, while the provider supplies sender-domain signing. See [RFC 8058, sections 3 and 4](https://www.rfc-editor.org/rfc/rfc8058.html#section-3). Verify the received message's headers and test an unsubscribe using a consenting test contact before sending to real customers.

## Settings and storage

| Environment variable          | Default             | Purpose                                                                 |
| ----------------------------- | ------------------- | ----------------------------------------------------------------------- |
| `SMS_MODE`                    | `demo`              | `demo` records simulated sends; `twilio` contacts Twilio.               |
| `HOST`                        | `127.0.0.1`         | Local-only address for the admin app.                                   |
| `PORT`                        | `3000`              | HTTP port.                                                              |
| `DATABASE_PATH`               | `data/suite.sqlite` | SQLite database file.                                                   |
| `UPLOAD_DIR`                  | `data/uploads`      | Uploaded business logos.                                                |
| `NUDGE_INTERVAL_MS`           | `60000`             | Automatic nudge check interval in milliseconds.                         |
| `TRUST_PROXY_HOPS`            | `0`                 | `0` for direct/local access; `1` only behind one trusted ingress proxy, as configured in the Render template. |
| `PUBLIC_BASE_URL`             | Render URL or unset | Exact public HTTPS origin for signed Twilio webhooks.                   |
| `QUOTE_PUBLIC_BASE_URL`       | Admin or Render URL | Public HTTPS origin for live customer quote links.                      |
| `ADMIN_ORIGIN`                | Render URL or unset | Exact HTTPS origin of the hosted admin app.                             |
| `ADMIN_USERNAME`              | `admin`             | Shared admin sign-in name.                                              |
| `ADMIN_PASSWORD`              | unset               | Unique password of at least 16 characters; required when hosted.        |
| `RENDER_EXTERNAL_URL`         | supplied by Render  | Default admin and webhook origin when their explicit settings are blank. |
| `BUSINESS_<KEY>_ACCOUNT_SID`  | unset               | That business's Twilio account.                                         |
| `BUSINESS_<KEY>_AUTH_TOKEN`   | unset               | That business's Twilio secret.                                          |
| `BUSINESS_<KEY>_PHONE_NUMBER` | unset               | That business's SMS-capable Twilio number.                              |
| `BUSINESS_<KEY>_SMTP_HOST`    | unset               | That business's authenticated SMTP hostname (email is optional).        |
| `BUSINESS_<KEY>_SMTP_PORT`    | `587`               | `587` with required STARTTLS, or `465` with TLS from connection start.   |
| `BUSINESS_<KEY>_SMTP_USER`    | unset               | That business's SMTP username.                                         |
| `BUSINESS_<KEY>_SMTP_PASSWORD`| unset               | That business's SMTP secret.                                           |
| `BUSINESS_<KEY>_SMTP_FROM`    | unset               | A single sender email address approved by that business's provider.    |

Run one app instance for a workspace and use persistent local storage. The default data directory and `.env` are excluded from Git. For a simple consistent backup, stop the server, copy the database and its existing companion files together with the uploads folder to private backup storage, and restart. Restore them together. Store a separate protected backup of the environment configuration; it contains secrets. Do not remove the database to clear a warning or retry an uncertain message.

This app has **one admin view and no per-business logins**. Private localhost use can run without a password. A hosted installation requires `ADMIN_PASSWORD` and an HTTPS admin origin; the app refuses to start without them. Browser HTTP Basic authentication protects the admin pages, API, and uploaded logos using `ADMIN_USERNAME` and `ADMIN_PASSWORD`. Customer quote links, their public decision endpoints, `/healthz`, and the signed Twilio webhook remain reachable without that password.

API requests are limited to **300 per five minutes per IP address**. The shared admin sign-in has a stricter limit of **10 failed attempts per 15 minutes per IP address**, covering pages, API routes, and uploads. Successful sign-ins do not consume that failed-attempt allowance, but once it is exhausted even correct credentials must wait for the window to reset. A blocked request returns HTTP 429 with a `Retry-After` header. Counters are held in memory and reset when the process restarts; this matches the single-instance deployment below.

For direct or localhost access, keep `TRUST_PROXY_HOPS=0`; forwarded IP headers are then ignored. The Render template sets `TRUST_PROXY_HOPS=1` for its trusted ingress proxy so rate limits use the visitor's address. Use `1` only when all requests must pass through that trusted proxy, which must replace untrusted forwarding information. A directly reachable app with this setting could allow callers to spoof their IP address and bypass the limits.

Set `ADMIN_ORIGIN=https://your-admin.example` to the exact external origin, without a path or trailing slash, and preserve that host through the proxy. Render supplies `RENDER_EXTERNAL_URL`, which the app uses automatically when `ADMIN_ORIGIN` or `PUBLIC_BASE_URL` is blank. Other hosts require explicit settings. `PUBLIC_BASE_URL` can be a different host for the webhook. Use HTTPS at the hosting provider or reverse proxy. Business separation is enforced in the app and database; everyone with the shared admin password can access all businesses.

## Built and planned

**Built in Phase 1:** multiple editable business profiles with logo uploads; separate customer lists with notes and tags; per-business Twilio configuration; review-request SMS; one automatic three-day nudge; manual completion; phone-level opt-out handling; timestamped activity; a per-business dashboard; demo mode and automated tests.

**Built in Phase 2:** business-scoped quotes with line items, tax, totals, expiry, and customer-facing notes; drafts and status filters; delivery by SMS and optional email with unsubscribe headers and a visible footer; customer opt-outs shared across sending channels; mobile-friendly customer links with Accept/Decline; activity and dashboard integration; two cancellable reminders after two and five days through each channel that successfully sent the original quote; simulated sends and automated tests.

**Planned for Phase 3:** missed-call text-back. It is not built or shown as a working control. There are no per-business logins, payments, billing, mobile app, Google review detection, or delivery-receipt processing in these phases.

The data model keeps businesses as the owner of contacts, review requests, quotes, messages, and activity records. Relationships carry `business_id`, and references are checked within the selected business. Quotes reuse the existing business/contact IDs and activity stream; future missed-call records can use those same relationships without combining customers from different businesses. Twilio and SMTP credentials remain environment configuration rather than becoming business data.

## Hosting

### Recommended for real use: the full backend on Render

**For real customers and automatic SMS follow-ups, use the full app on an always-running paid Render web service with persistent storage.** This keeps the nudge worker running when your laptop is closed and keeps SQLite records and logos across restarts. The repository includes a `Dockerfile`, `.dockerignore`, and `render.yaml` for this recommended path. These files prepare a hosted installation; their presence does not mean a service has been created or a backend public link has been verified. The free browser demo below remains available for trying the interface.

This template uses **one paid web service and a 1 GB persistent disk**. Render requires paid compute for persistent disks. Its free web service can sleep and cannot retain this app's SQLite database on a persistent disk, so it is unsuitable for the automatic nudge worker. Review the current service and storage estimate in Render before approving creation. See [Render persistent disks](https://render.com/docs/disks), [free service limits](https://render.com/docs/free), and [current pricing](https://render.com/pricing).

### First deployment

1. Put this implementation, including the three deployment files, in a GitHub branch you can connect to Render. The repository root must contain `package.json` and `render.yaml`.
2. In the [Render Dashboard](https://dashboard.render.com), create a **Blueprint** from that repository and branch. Review the proposed web service and disk before approving the paid resources.
3. When prompted, enter a unique `ADMIN_PASSWORD` of at least 16 characters and enter `demo` for `SMS_MODE`. The username is `admin`; change `ADMIN_USERNAME` in the service's Environment page if preferred. Keep the password in Render, not in Git, Docker build arguments, or browser code.
4. Deploy. The service builds a Node.js 24 image and starts the real Express app with an initially empty SQLite database. It does not load the standalone browser demo or seed fictional records. The image includes server code, interface files, the read-only Twilio checker, and production dependencies; it excludes `.env`, local databases, uploads, and demo seed scripts.
5. Open the HTTPS `onrender.com` address shown by Render and sign in with the shared admin credentials. The app uses Render's assigned `RENDER_EXTERNAL_URL` as the default admin and webhook origin. For a custom domain, set `ADMIN_ORIGIN` and `PUBLIC_BASE_URL` to the exact HTTPS origin you will use, without a path or trailing slash, then redeploy. See [Render's default environment variables](https://render.com/docs/environment-variables).
6. Add a sample business and customer, send a simulated request, and check Activity. Use **Test the 3-day nudge**, verify one follow-up, and mark the request done. Restart the service and confirm the records and any uploaded logo remain. Confirm an unauthenticated browser is asked to sign in and `/healthz` returns HTTP 200.
7. Create a demo quote, send its link, and open that link in a separate browser session without the admin password. Accept it and check that its status and Activity update. Test reminders on a second unanswered quote. Render's address also becomes the default customer quote origin; set `QUOTE_PUBLIC_BASE_URL` only if these links should use a different configured HTTPS origin.

The shared login protects the dashboard, customer data, admin API, and uploaded logos. Customer quote links and decisions, the readiness route, and the signed Twilio webhook remain reachable without the admin password. This is one owner login for the whole workspace; it does not create separate business accounts.

### Turn on real SMS

In the service's **Environment** page, add the Twilio variables for each business's SMS settings key. For example, `HARBOR` uses `BUSINESS_HARBOR_ACCOUNT_SID`, `BUSINESS_HARBOR_AUTH_TOKEN`, and `BUSINESS_HARBOR_PHONE_NUMBER`. Add the actual values privately, following the Twilio setup section above. Set `SMS_MODE=twilio` and redeploy only when ready for real sends. `SMS_MODE` is prompted with `sync: false` so later Blueprint syncs do not reset the mode you selected. See [Blueprint environment settings](https://render.com/docs/blueprint-spec#prompting-for-secret-values).

Point that business's Twilio incoming-message webhook to `https://YOUR-SERVICE.onrender.com/webhooks/twilio/BUSINESS_ID` using HTTP POST. Do not include the admin password in the URL. Verify one authorized test send to a number you control, its Activity entry, and its final delivery result in Twilio. Receipt on the phone is required before calling real SMS verified. Old simulated requests are not nudged in live mode.

For optional quote emails, add each business's SMTP variables in the same private Environment page. Send an authorized test quote to your own email address and confirm receipt. SMTP credentials are not needed for SMS-only quotes.

### Storage and operation

The disk is mounted at `/var/data`. Both `DATABASE_PATH=/var/data/suite.sqlite` and `UPLOAD_DIR=/var/data/uploads` point inside it, so records and logos survive restarts and redeployments. Keep both paths on persistent storage if you change them. Run exactly one always-running service instance: the same process serves the dashboard and checks for due nudges every 60 seconds. Check the dashboard's **Follow-ups last checked at** timestamp to confirm checks continue. A restart or redeploy pauses checks briefly, and eligible overdue requests catch up immediately on startup. No separate cron job or second worker is needed.

Render's health check calls `/healthz`. The server listens on `0.0.0.0` and the configured `PORT`, as required for [Render web services](https://render.com/docs/web-services#port-binding). The template disables automatic deploys; use a manual deploy when you want to release a reviewed change. Services with an attached disk briefly stop during redeploys, and their disk cannot be shared across multiple instances. Keep a separate, consistent SQLite and logo backup as described above. See [disk deployment limits](https://render.com/docs/disks#disk-limitations-and-considerations).

For another host, use the same Docker image with a persistent volume at `/var/data` writable by the container's `node` user (UID 1000). Supply the admin password, exact public HTTPS origins, and each business's Twilio settings as runtime environment variables. Terminate HTTPS at the hosting provider or reverse proxy and keep one always-running instance.

### Publish the free browser demo

The browser demo can be rebuilt and published independently of the backend:

```powershell
npm run build:browser-demo
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/publish-browser-demo.ps1
```

The publishing script uploads only the generated sample demo and font licenses
to [here.now](https://here.now/docs), verifies the public page, and prints its URL.
It saves the private ownership link and publication state in the ignored
`.publish/` directory. Keep those files private. Running it again uses that state
to update the same demo. Anonymous publications expire after 24 hours; use the
saved ownership link to claim the site with a free account before it expires.
This publishes a browser-only demo with simulated texts and browser-local data.
It does not deploy Express, SQLite, or a background nudge worker.
