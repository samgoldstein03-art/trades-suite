# Tradesuite: scoped presentation and measurement audit

Audit date: November 5, 2026. Baseline: `a8b2c7e`. Findings were reported to the owner before this pass changed files. Line references describe the pre-fix checkout.

The latest brief supersedes the earlier slate/Inter/Sora redesign. The actual baseline had that later styling, rather than the original tokens specified in this brief. This pass restores the specified brand through shared tokens and existing local fonts. It does not replace screen layouts or rebuild the application.

## Surfaces covered

| Surface | Source |
| --- | --- |
| Dashboard, quotes, contacts, requests, activity | Their hash routes and page renderers in `public/app.js` |
| Onboarding and settings | Empty workspace, business/customer forms, quote builder, message preview, delivery/reminder dialogs and installer disclosure in `public/app.js` |
| Customer quote | `/q/:token`, loading/open/accepted/declined/expired/unavailable states: `public/quote.html`, `public/quote.js`, `public/quote.css`, `src/app.js` |
| Message preferences | `/q/unsubscribe/:token`, confirmation/completion: `src/quotes.js` |
| Emails | Initial quote and day-2/day-5 reminders: plain text in `src/email.js`, subjects in `src/quotes.js` |
| Legal drafts | `/terms`, `/privacy`: `public/terms.html`, `public/privacy.html`, `public/legal.css` |
| Actual application demo | `scripts/demo.js`: real Express/SQLite and shared interface, simulated providers |
| Browser preview | `scripts/build-browser-demo.js`, `scripts/browser-quotes.js`: labelled sample data, browser-local storage and simulated providers |

**No marketing landing, product or pricing page exists.** `/` opens the admin workspace. None is added. The browser's Basic authentication prompt, health checks, APIs and signed callbacks are not marketing screens. Missed-call text-back remains unbuilt Phase 3.

## Findings reported first

| Finding | Baseline file + page/section | Severity | Smallest correction |
| --- | --- | --- | --- |
| Palette, fonts, sidebar and radius differ from the specified brand | `public/design-system.css:4-78`, `public/fonts.css`, `public/styles.css:25-47`; all web surfaces | Cosmetic | Restore supplied values and local fonts, white sidebar and 16px panels; retain layouts, actions and breakpoints. |
| Inter is active despite the latest DM Sans/Manrope instruction | Font faces and shared type tokens | Cosmetic, tell 10 | Restore the original nine local faces. No download or new type system. |
| Conversion percentage and reconstructed historical comparisons appear | `public/app.js:123-145,279`; dashboard | Trust-killer against the stated measurement scope | Remove percentages and all trend comparisons. Show recorded counts only. Accepted quote status is stored, but completed jobs, paid work and Google reviews are not measured. |
| Public font allowlist would reject the restored fonts | `src/quotes.js:347-350`; quote/preferences/legal pages | Functional issue during restoration | Explicitly allow `font-0.ttf` through `font-8.ttf`, retaining the path allowlist and admin protection. |
| Metadata/favicon retain the later slate/emerald palette | `public/index.html`, `public/quote.html`, `public/terms.html`, `public/privacy.html`, `src/quotes.js`, `public/favicon.svg` | Cosmetic | Recolour the existing mark and metadata. Do not invent a logo. |
| Required radius and lime overlap tell-list items | Shared corner/accent tokens; panels and active navigation | Cosmetic, accepted brand exceptions | Keep the explicitly requested 16px panels and lime. Use flat borders and restrained accents. |
| Supplied muted colour is too faint for small text | `#78817b` on `#f6f7f3`: about 3.74:1; on white: about 4.02:1 | Readability | Preserve the base swatch; use the supplied ink through the secondary-text role for small copy. Orange remains an accent, not small text on white. |
| Terms and Privacy remain unapproved | `/terms`, `/privacy`; public review drafts | Owner-review trust gap | Keep draft notices and completion questions. Do not invent final policies, operator details, retention promises or agreement terms. |

No product-owned review-received claim or fake testimonial was found. Request `done` is a manual owner action. Existing fictional businesses/contacts remain labelled demo/test records, not endorsements or business results. This pass adds no customer names, logos, testimonials or results.

## All 30 tells

| # | Tell | Where checked | Assessment and treatment |
| --- | --- | --- | --- |
| 1 | Harsh gradients | Shared/admin/quote/legal CSS | Not found. Solid token colours retained. |
| 2 | Lucide icons | `package.json`, app control marks, customer markup | No Lucide package or decorative library set. Simple add, close and search marks remain. |
| 3 | Pure white background | Shared canvas, sidebar and documents | Restore `#f6f7f3`. White sidebar/cards are specified brand roles, not a pure-white page canvas. |
| 4 | Rainbow colouring | Palette and statuses | Not found. Restore green/lime/orange; reserve semantic colours for statuses. |
| 5 | Drop shadows | Shared tokens, cards, toast, dialogs | Already absent. Keep shadow tokens `none`; focus rings are not decorative shadows. |
| 6 | Three feature cards in a row | Dashboard | Not found. Four operational counts remain; no promotional feature-card section. |
| 7 | Emojis | Product-owned copy and emails | Not found. Functional symbols and user content are separate from emoji marketing. |
| 8 | Liquid glass | CSS and modal backdrop | Not found. No blur/glass surfaces. |
| 9 | Em dashes | Titles, headings and emails | Already removed from product-authored separators. Preserve customer-entered names/notes and saved quote terms. |
| 10 | Inter/Geist/Space Grotesk | Font faces/tokens/public font route | Inter was active: restore DM Sans/Manrope. Geist/Space Grotesk are absent. |
| 11 | Coloured left stripe | Panels, notices, delivery timeline | Not found. Neutral timeline connector is functional. |
| 12 | Fake testimonials | Pages, demos, emails | Not found. Any future testimonials need verified owner content and permission. |
| 13 | Bento grids | Dashboard/lists | No decorative marketing bento. Operational queues/activity/counts stay in place. |
| 14 | Terminal window | Settings/onboarding | No fake terminal. Actual setup identifiers stay behind a labelled installer disclosure. |
| 15 | It's not X, it's Y | Copy/emails | Not found as marketing copy. Demo and draft disclosures stay factual. |
| 16 | Checkmark bullets | Pages/dialogs/emails | Not found. No sales checklist section. |
| 17 | Three pricing tiers | Public inventory | Not found. No pricing page or invented purchase terms. |
| 18 | No real product demos | Demo entry points and README | Actual Express/SQLite demo exists. Browser preview stays labelled sample/simulated. Neither proves production hosting or real provider receipts. |
| 19 | Soft corner radius | Shared panel/modal tokens | Explicit 16px brand exception. Restore it with flat borders; do not redesign components. |
| 20 | Purple and black | Palette/sidebar | No purple treatment. Replace the later dark-slate sidebar with specified white. |
| 21 | No skeleton loaders | Workspace, quote dialogs, public quote | Not found. Existing skeletons remain. |
| 22 | Radial orbs | CSS/markup | Not found. |
| 23 | Dot grids | CSS/markup | Not found. Status dots/timeline nodes are functional indicators. |
| 24 | Sparkle icons | Active markup/control marks | Not found. |
| 25 | Animated arrows | Links/controls/styles | Not found. No animated arrow effect added. |
| 26 | No TOS | `/terms` and footer links | Clear owner-review draft exists. Final approved terms still need owner content. |
| 27 | No privacy policy | `/privacy` and footer links | Clear owner-review draft exists. Final approved policy still needs owner content. |
| 28 | Hover animations for everything | CSS interaction rules | Not found. Restrained control feedback, focus and reduced-motion support remain. |
| 29 | Neon colours | Tokens/metadata/favicon | No glow/neon effects. Restore the specified brand palette. |
| 30 | Basic pastel colours | Navigation/statuses/notices | Lime is an explicit brand exception. Keep it restrained; documents remain neutral with readable status text. |

## Recorded dashboard values

- **Review requests sent:** saved request rows, including ones later marked done. Provider acceptance does not establish phone delivery. Simulated records remain labelled.
- **Quotes awaiting response:** current `sent` or `viewed` quote rows.
- **Follow-up messages sent:** review requests with `nudged_at`, plus quote reminder deliveries of kind `nudge_2`/`nudge_5` with status `sent`/`simulated`. Initial sends and failed/uncertain/skipped attempts are excluded. Text/email deliveries count as separate messages.
- **Requests marked done:** request rows with status `done`, labelled **Marked manually by you**. This does not detect or count Google reviews.

There is no conversion percentage, review-received metric, revenue metric or historical trend comparison. Sending, response, reminder, permission and business-isolation rules are unchanged.

## Applied scope

- Restore exact base palette, existing self-hosted fonts, white sidebar, deep-green mark/buttons and 16px panels. Keep layouts and responsive rules.
- Use ink for small readable copy while retaining the original muted swatch.
- Replace conversion/trends with recorded counts and honest labels.
- Restore warm copy: A little word of mouth; review-only Just one reminder. Never a string of texts. Quotes retain their two-reminder schedule.
- Keep public font serving and offline embedding consistent, including original font licences.
- Preserve plain-text emails, SMS footers, delivered quote terms, legal draft content, skeletons, opt-outs and actions.
- Add no marketing page, invented social proof, final legal text or business module.

## Still needs the owner

- Approved Terms/Privacy with the actual operator, contact, offer, responsibilities and data practices. Drafts stay marked until approved.
- Genuine testimonials and attribution only if wanted. None is required for the present honest interface.
- Actual business identity/uploaded logo for a live installation. Demo identities are sample data only.
- A suitable running installation and consenting verification of SMS/email delivery and opt-outs. Simulated demos do not establish real provider receipts or production hosting.
- Actual offer/content for any future marketing page. Jobs/scheduling, invoices, missed-call text-back and maintenance are agreed future work, outside this audit.

## Verification of this pass

- Full suite: **180 tests passed, zero failures**. The direct-count tests intentionally replace the removed percentage/trend expectations. Sending, isolation, reminders, opt-outs and legal-draft regressions remain green.
- The added public-font regression checks the restored CSS and all nine explicitly allowed local font files, including access without the admin password and rejection of unlisted files.
- Standalone preview rebuilt from current product source, with DM Sans/Manrope embedded locally and draft-document navigation retained.
- Actual app browser check confirmed canvas `rgb(246,247,243)`, ink `rgb(36,61,52)`, white sidebar, 16px panels, no shadow, four recorded-count cards and no percentage on the dashboard.
- DM Sans and Manrope loaded successfully on the admin dashboard, public customer quote and Privacy draft. The old owned demo server was restarted to update its font allowlist while preserving the existing customer quote URL and saved terms.
- The actual Express/SQLite demo remains explicitly simulated. These checks do not claim approved legal documents, real SMS/email receipts, Google review detection or a production deployment.
- All six admin routes were also checked at a narrow phone viewport (about 360 CSS pixels after the browser's existing zoom): client and scroll widths matched, with no horizontal page overflow. The existing responsive layouts were retained.

## Subsequent Jobs and scheduling addition

Jobs and scheduling are now implemented; the historical audit inventory above describes the earlier presentation-only pass. The new owner list, weekly agenda, editor/detail and public customer job page reuse the existing design tokens, self-hosted DM Sans/Manrope, flat borders, skeletons and plain-spoken copy. They add no social proof, conversion metric, percent-complete estimate, marketing page or provider-delivery claim. The standalone preview remains simulated and clearly labelled sample data.

The owner-review Terms/Privacy drafts still require actual operator details and reviewed coverage of job addresses, published progress and private-link sharing. Invoices/payment tracking, equipment/maintenance and missed-call text-back remain unbuilt.
