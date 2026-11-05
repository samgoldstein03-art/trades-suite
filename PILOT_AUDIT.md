# Tradesuite pilot presentation audit

Audit date: November 5, 2026. Baseline: commit `65ef181`.

The main findings below were reported before implementation; a further copy correction found during the work is noted separately. File and line references in the findings refer to that baseline, so the record remains useful after edits move code. The audit covers the existing product and generated emails; it does not assume marketing pages or completed features that are absent from the repository.

## Screens and content actually present

| Surface | Route or entry point | Source |
| --- | --- | --- |
| Landing page | No separate marketing landing page. `/` opens the admin workspace. | `public/index.html`; static mount in `src/app.js:1145` |
| Product and pricing pages | None. There are no three-tier pricing cards, testimonials or sales result claims to remove. | Public file inventory and application routes |
| First-use onboarding | Empty-workspace welcome, Add business and Add customer dialogs. No separate onboarding website. | `public/app.js:240`, `businessModal()` and `contactModal()` |
| Owner workspace | `#dashboard`, `#contacts`, `#requests`, `#quotes`, `#activity`, `#settings` | `public/app.js:34` and its page renderers |
| Review workflow | Customer selection, message preview, request completion, failed-nudge retry and demo reminder dialogs | `public/app.js`; `src/sms.js` |
| Quote workflow | List/filter, builder, live totals, details, delivery history, send choices, reminder cancellation and demo time controls | `public/app.js:317` onward |
| Customer quote | `/q/:token`, including loading, open, accepted, declined, expired, unavailable and send-error states | `public/quote.html`; `public/quote.js`; `public/quote.css`; `src/quotes.js` |
| Message preferences | `/q/unsubscribe/:token` confirmation and completion; one-click POST | `src/quotes.js:311` onward |
| Invalid customer links | HTML error document for explicit browser document requests; existing JSON error contracts for data/API requests | `src/app.js:1158` onward |
| Emails | Initial quote email and day-2/day-5 reminder emails. These are plain-text messages, not HTML marketing templates. | `src/email.js:60`; subjects in `src/quotes.js:190` |
| Full application demo | `npm run demo`: the actual Express app, SQLite, real routes and the shared interface, with simulated providers | `scripts/demo.js`; `src/server.js` |
| Standalone browser preview | Generated `Tradesuite Demo.html`, including customer quote and unsubscribe hash routes | `scripts/build-browser-demo.js`; `scripts/browser-quotes.js` |

The admin sign-in is the browser's HTTP Basic authentication prompt, not a custom product screen. Health checks, JSON API endpoints and signed webhooks are not marketing pages. Missed-call text-back remains planned Phase 3; it is not a working product module in this revision.

## Findings and severity

**Trust-killer** means an unresolved issue could mislead pilot users about their agreement, their data or what has actually been verified. **Cosmetic** means presentation can be improved without changing product behavior.

| Finding | Severity | Where it appeared before this audit | Resolution |
| --- | --- | --- | --- |
| No Terms of Service page or link. | Trust-killer / owner review needed | Workspace footer in `public/index.html:65`; customer footer in `public/quote.html:18`; unsubscribe footer in `src/quotes.js:317`. | Add a clearly marked draft with owner-completion questions and visible draft links. A draft is not approved terms. |
| No Privacy Policy page or link. | Trust-killer / owner review needed | Same footers; no privacy document or route in the public inventory. | Add a clearly marked draft with owner-completion questions. Do not invent the operator's identity, retention promises or legal basis. |
| Browser preview could be mistaken for a verified pilot deployment. | Trust-killer if represented as live verification | `scripts/build-browser-demo.js`; hosting and preview sections in `README.md:275` onward. The preview already disclosed simulated sending. | Keep disclosures and distinguish the actual Express/SQLite demonstration from the browser-local preview. Live delivery still needs real receipts and owner-approved setup. No fake demo footage or screenshots are needed. |
| Familiar outline icon treatment used throughout the interface. | Cosmetic | Inline paths in `public/app.js:9` and `public/quote.js:7`; public status/document icons. | Remove decorative icon-library-style chrome, keep visible text labels and necessary functional controls. There was no installed Lucide dependency to remove. |
| Repeated shadows and soft panel corners. | Cosmetic | `public/design-system.css:73` to `85`, shared panels at `:148`, toast at `:154`; KPI/welcome/dialog rules in `public/styles.css:78`, `:158`, `:195`; customer card in `public/quote.css:11`. | Use flat borders and tighter shared corner tokens. Preserve accessible focus rings, which are not decorative drop shadows. |
| Em dashes in titles and generic missing-value placeholders. | Cosmetic | `public/index.html:11`, `public/quote.html:9`, `public/quote.js:43`, `:64`, `public/app.js:70`, `:305`, `:317`, `:390`, `:395`, `:414`, `:425`; generated document titles in `src/quotes.js:317`, `src/app.js:1169` and `scripts/build-browser-demo.js:193`. | Use restrained title separators and explicit missing-value text. Do not rewrite customer-entered content. |
| A setup block looked technical for a shop-owner product. | Cosmetic / related to the terminal-window tell | Messaging settings in `public/app.js:440`; `.code-block` in `public/styles.css:183`. It showed environment variable names, not credentials or a fake running terminal. | Present connection details as clearly labeled installer information rather than terminal-like chrome. |
| Pastel surfaces were repeated around status and decorative elements. | Cosmetic | Badge/activity rules in `public/styles.css:107`, `:145` to `:149`; accepted/expired panels in `public/quote.css:51` onward. | Use restrained neutral surfaces and retain semantic status text. Keep the existing emerald/amber palette. |
| Inter appears on the user's tell list and in the required design system. | Cosmetic / explicit design constraint | `--font-body` in `public/design-system.css:40`; local font faces in `public/fonts.css`. | Keep Inter and Sora as explicitly requested. The smallest remedy is stronger product-specific typography, plain copy and restrained surfaces, not a wholesale font replacement. |

No fake testimonials or customer result claims were found. Existing demo fixtures contain fictional businesses and contacts in explicitly labeled sample workspaces; they are test data, not social proof. This audit does not add new fictional customer names, logos or results.

An additional cosmetic copy finding appeared during implementation: the accepted-quote state promised “They’ll be in touch about the next steps” (`public/quote.js:24`). The app records a decision but cannot guarantee a business will call. It now states that acceptance is recorded and tells the customer to contact the business to arrange the work. No new response or notification behavior was introduced.

## All 30 tells

| # | Tell | Baseline result and treatment |
| --- | --- | --- |
| 1 | Harsh gradients | Not found. Solid token colors are used throughout. |
| 2 | Lucide icons | No Lucide dependency. Familiar inline outline icons were a cosmetic match to the visual tell; reduce decorative icon chrome. |
| 3 | Pure white background | Not found as a page canvas: the existing background is `#FAFAF9`. White form/document surfaces remain an intentional distinction, not a white full-page redesign. |
| 4 | Rainbow coloring | Not found. The palette is slate, emerald and amber with semantic error/success colors. |
| 5 | Drop shadows | Found on cards, toast and dialogs. Replace decorative elevation with flat borders using shared tokens. Keep focus rings. |
| 6 | Three feature cards in a row | Not found. The dashboard has four actual business metrics, not three promotional feature cards. |
| 7 | Emojis | Not found in displayed product copy. Functional symbols and uploaded customer content are not emoji marketing decoration. |
| 8 | Liquid glass | Not found. A modal's dimming backdrop is not glass/blur styling. |
| 9 | Em dashes | Found in titles and missing-value placeholders; replace in product-owned presentation. Preserve customer-entered text. |
| 10 | Inter / Geist / Space Grotesk | Inter is present and explicitly required alongside Sora. Retain it as a documented constraint; Geist and Space Grotesk are absent. |
| 11 | Colored left stripe | Not found. The delivery timeline used a neutral connector, not a colored card accent stripe. |
| 12 | Fake testimonials | Not found. No testimonial section or attributed customer endorsement exists. Do not invent one. |
| 13 | Bento grids | Not found as decorative marketing layout. Dashboard queues, activity and metrics have operational purposes and remain in place. |
| 14 | Terminal window | No fake terminal window. The setup-only environment-name block was a related cosmetic issue; simplify its presentation. |
| 15 | “It's not X, it's Y” copy | Not found in product-owned copy. Functional explanations distinguishing demo/live behavior remain necessary and truthful. |
| 16 | Checkmark bullets | Not found. A few action/status icons were functional, not checkmark sales bullet lists; remove decorative versions with the icon cleanup. |
| 17 | Three pricing tiers | Not found. No pricing page or product pricing terms exist to rewrite or invent. |
| 18 | No real product demos | Partial readiness gap, not a fake-demo finding. The actual Express/SQLite demo exists; the browser preview substitutes storage/providers and must remain labeled. No hosted backend or real message receipt is established by UI preview alone. |
| 19 | Soft corner radius | Found in shared 8/12/16/24px component tokens and pills. Tighten shared panel/control corners without reorganizing screens. |
| 20 | Purple and black | Not found. The sidebar uses slate, not a purple/black palette. |
| 21 | No skeleton loaders | Not found. Workspace, quote fetch and customer quote loading states already have skeletons; preserve them. |
| 22 | Radial orbs | Not found. |
| 23 | Dot grids | Not found. Small status indicators and timeline nodes are not decorative dot-grid backgrounds. |
| 24 | Sparkle icons | Not found on rendered screens. Unused old star/bulb paths and hidden decorative remnants are cleanup candidates, not displayed social proof. |
| 25 | Animated arrows | Not found. The existing directional links were static; reduce decorative arrows with icon cleanup. |
| 26 | No Terms of Service | Found. Add an explicitly unapproved draft; owner/legal review remains required before it can serve as final terms. |
| 27 | No Privacy Policy | Found. Add an explicitly unapproved draft; owner completion and review remain required. |
| 28 | Hover animations for everything | Not found. Existing state transitions are restrained and mostly on controls, links and table rows. Retain useful hover/focus feedback and reduced-motion support. |
| 29 | Neon colors | Not found. Existing palette and contrast do not use neon effects. |
| 30 | Basic pastel colors | Found in repeated mint/amber status/decorative surfaces. Reduce broad pastel fills while preserving clear semantic states. |

## Presentation fixes applied

- Shared `--shadow-card`, `--shadow-raised` and `--shadow-modal` tokens are now `none`. Normal controls and panels use tighter 4px corner tokens, with functional circles retained for status/profile indicators. Accessible focus treatment remains visible.
- The workspace uses written navigation and action labels. The decorative outline icon set has been removed; necessary add, close and search marks remain. Public quote and preferences pages also shed redundant icons and decorative arrows.
- Generic document titles now use `|`. Missing values use explicit product-owned copy. Customer-entered names, notes and delivered quote terms are not rewritten.
- Repeated pastel badge and public result-panel fills have become neutral surfaces, with readable status text preserving the distinction between sent, accepted, expired and failed states.
- Messaging setup no longer appears as a terminal-like block. The actual configuration identifiers remain available as installer information; credentials stay out of the interface.
- Public Terms and Privacy draft pages now state `Draft. Owner review required.` and contain owner-completion questions. Visible draft links connect the workspace and customer-facing footers to those documents.
- Initial and reminder emails were audited and intentionally kept as factual plain text with their existing business identity, one-click unsubscribe headers and visible opt-out footer. No marketing HTML, fabricated endorsement or unreviewed legal agreement was added to messages.
- The warm page background, white document surfaces, slate ink, emerald/amber palette, locally served Inter/Sora fonts, responsive layout, skeleton loaders and 48px interaction targets remain part of the existing design system.

## Real application demonstration

Use the existing application, not a filmed mockup or manually edited screenshot:

1. Run `npm ci`, then `npm run demo` in the repository, with the chosen port available. This entry point forces demo sending and uses a separate demo SQLite database. Open the printed local address in Chrome or Edge on the same computer and keep the terminal running. This is the actual product interface against the actual Express routes, even if a restricted built-in preview cannot reach the local server.
2. Confirm the demo disclosure. Use existing sample records or an owner-authorized test contact; do not enter unrelated real customer information into a public preview.
3. Create a quote with line items, tax and expiry. Save it, send a simulated text/email, open its customer link without admin sign-in and accept it. Return to the owner's quote list and Activity to verify the saved response.
4. On another unanswered quote, use its demo time controls to verify day-2/day-5 delivery history. Repeating a check must not create a duplicate scheduled delivery. Demonstrate Stop reminders as well.
5. Send a simulated review request, test its three-day nudge and mark it done. Check that all records remain scoped to the selected business.

This proves the product workflow with simulated providers. It does not prove Twilio receipt, SMTP receipt, a permanently available public server or unattended scheduling on a closed laptop. The standalone HTML preview remains useful for interface review, but its browser-local data and duplicate browser-side service logic are not a deployment of the Node/SQLite backend. Anonymous preview URLs are temporary and should not be supplied as a production pilot installation.

## Still needs the owner's real content or decisions

- **Terms:** legal operator, contact details, actual one-time price/license terms, included setup/support, ongoing provider/hosting costs, refund/cancellation decisions and appropriate review. The draft must stay labeled until approved.
- **Privacy:** actual operator and per-business responsibilities, the deployed services, contact for privacy requests, retention/deletion practices, access arrangements and accurate final wording. No retention interval or compliance promise has been invented.
- **Testimonials:** none are currently displayed. If the owner wants social proof later, supply verified quotations, permission and attribution. No testimonial is required to keep the current honest interface.
- **Pilot demonstration:** an owner-approved full-app deployment or working local app demonstration, plus authorized test receipts before describing SMS or email delivery as verified. Screenshots and browser simulation alone are insufficient evidence.
- **Marketing pages:** landing/product/pricing pages do not exist in this repository. If added later, they need the owner's actual offer and scope. Do not advertise missed-call text-back as built; Phase 3 remains planned.

## Verification record

- Source review covered all 30 items against the route inventory, shared tokens, product-owned copy, public quote/preferences documents and both email kinds.
- Focused public quote/UI and email checks passed: 28 tests. Focused legal, admin-access and public quote integration checks passed: 10 tests. These targeted runs are not substitutes for the full-suite and rendered-layout checks in the final delivery.
- The legal documents were independently reviewed as owner-completion checklists: no completed contract, privacy promise, operator identity or effective date has been invented.
- The source inspection confirms that working full-application and browser-preview entry points exist. This report does not claim a real message receipt, approved legal text or successful production deployment from source inspection or simulated-provider tests.


### Integrated verification, 2026-11-05

- Full suite: **179 tests passed, zero failed**, including the original 176 tests. The added coverage checks public draft routes without weakening admin protection and standalone draft navigation with the network-disabled preview.
- Built the standalone preview from current product source. Its draft documents are embedded from the actual legal page files and links stay within the preview.
- Started the actual Express demo with an isolated SQLite file and exercised its interface in the browser. Using an existing explicitly simulated contact, saved a quote with two units at $125.00, 13% tax and a $282.50 total; simulated initial text and email; opened the public customer link; accepted the sample; and saw Accepted in the owner list. A read-only check of the SQLite file confirmed the accepted record, both simulated delivery rows, and sent/viewed/accepted activity.
- Browser-checked the public quote, message preferences, Terms draft and Privacy draft. Draft notices are visible and no legal acceptance form exists. At a narrow phone layout (approximately 360 CSS pixels, accounting for the browser's existing zoom), document scroll width did not exceed its client width. The public quote card computed to 4px corners and no drop shadow, with 48px action styling.
- Real Twilio/SMTP delivery, a production hosting installation and owner approval of the legal documents remain unverified. The demonstration made no real sends and no real job agreement.
