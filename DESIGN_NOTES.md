# Tradesuite design overhaul

## Screen inventory before implementation

The inventory below was completed against the existing application before visual implementation began. The written design brief is the visual reference; no mockup file was available in this workspace.

| Surface | Routes and states inventoried |
| --- | --- |
| Shared admin shell | `/` and `/index.html`; business selection; initial connection; business switch; shared dialog; toast; empty workspace; refresh failure; demo notice; desktop sidebar and mobile navigation. Unknown hashes return to Overview. |
| Overview | `#dashboard`: existing review totals, recent activity, upcoming review nudges, failed-nudge attention/retry queue, worker last-check timestamp, recent review requests, unanswered quotes, and demo actions. |
| Customers | `#contacts`: list, search, lead/customer filter, permission and opt-out states, empty and no-results states; add/edit customer dialogs. |
| Review requests | `#requests`: search and sent/nudged/done filter, request rows, empty state, send dialog and live SMS preview, no eligible customer, preview failure, mark-done dialog, failed-nudge retry dialog, simulated three-day follow-up dialog. |
| Quotes | `#quotes`: search and six-status filter; draft/sent/viewed/accepted/declined/expired rows; empty and no-results states; new/edit builder with customer selection, dynamic items, totals, tax, expiry and notes; no-customer branch; detail dialog; deliveries; reminder controls; customer link; send dialog with channel availability and partial-delivery errors; simulated reminder actions. |
| Activity | `#activity`: chronological log, message bodies, timestamps and empty state. |
| Business settings | `#settings`: existing business profile, field validation/save feedback, logo upload/preview, credential readiness, add-business dialog. |
| Customer quote | `/q/:token`: loading, unanswered, accepted, declined, expired, response-in-progress and unavailable/error states. `/q/:token/data` and `/respond` provide the existing data and response behavior; `/logo` and `/q/assets/*` serve resources. |
| Message preferences | `/q/unsubscribe/:token`: confirmation and completed states, invalid link; the existing public POST performs unsubscribe. `/data` provides the standalone demo's preference state. |
| Standalone browser demo | The six admin hashes above, plus `#quote/:token` and `#unsubscribe/:token`; customer view has a return-to-workspace link. All message sending remains simulated. |
| Access and service responses | Shared admin access uses the browser's native HTTP Basic-auth prompt. Authentication, rate-limit and API errors remain existing service responses; `/healthz`, `/api/*` and the Twilio inbound webhook are not independent product screens. Direct `/quote.html` is a static resource rather than a valid customer quote URL. |

## Design direction

Use a dark slate workspace frame, warm off-white canvas, white cards, emerald actions and a restrained amber secondary accent. UI/body type uses Inter and headings use Sora, with system fallbacks. Money and dashboard figures use tabular numerals. The design should organize actual business information with clear hierarchy, comfortable spacing and one consistent set of controls.

## Per-screen changes

### Workspace shell and onboarding

- Replaced the light sidebar with a slate workspace frame, restrained emerald active navigation, and a business identity area with logo/initials. On mobile the frame becomes a compact top navigation and business picker.
- Added the app favicon, page-specific document titles and a useful first-load skeleton. Kept the existing shared admin gate, business selection and data isolation.
- Removed decorative sidebar slogans and stars so the business and navigation lead the frame. Empty workspaces use the shared helpful empty/onboarding language.

### Overview

- Removed the large promotional hero. The first-open view now starts with a greeting, the date and one state-appropriate main action.
- Added four large tabular-number cards for requested reviews, unanswered quotes, successful reminder messages and quote conversion. Comparison captions explain the underlying periods.
- Put the unanswered quote queue and recent activity at the center of the page. Existing review follow-ups, failed-nudge retry controls, scheduler timestamp and recent requests remain available in the same component language.

### Customers and review requests

- Replaced slogan headings with direct screen names and concise supporting copy. Search and filters share the same input style as the rest of the app.
- Used consistent white list cards, restrained status pills, readable customer hierarchy and 48px actions. Customer message permission and opt-out information remain visible.
- Mobile list rows become labeled stacked records, keeping customer, status and actions available without a wide-table pan. Desktop keeps scannable table columns.
- Add/edit customer, request preview, mark-done, retry-nudge and demo dialogs inherit the shared form, button and feedback system. Their existing permission and sending rules remain unchanged.

### Quotes

- Matched the quote list to customer/request rows, with right-aligned tabular totals, a complete status filter and clear quote/reminder context.
- Reorganized the builder for phone use: item description occupies its own row, quantity and price stay alongside the remove control, totals update in place and the action area stays reachable at the bottom of the dialog.
- Added a chronological delivery timeline using the existing initial/day-2/day-5 records, with channel, outcome and time. Reminder state and Stop reminders stay next to that history.
- Added a copyable customer-link field and Copy link control alongside the existing open-link action. Link access and response behavior remain unchanged.
- Quote detail and send dialogs now show skeletons while fetching. A dismissed loading dialog stays dismissed, late responses cannot overwrite a newer dialog, and a quote answered during loading does not leave a stuck send dialog.

### Activity and business settings

- Gave the activity feed a consistent timeline-like rhythm, quiet timestamps and distinct message-body blocks; no activity data or event rules changed.
- Brought business details, logo upload and messaging readiness into the shared white-card form layout. Settings and all dialogs use the same inputs, focus treatment and save feedback.

### Customer quote and preferences

- Replaced the promotional quote layout with a checkout-style document: business logo or initials, quote reference, visible expiry, work/material amounts, right-aligned totals and a prominent final amount.
- Kept Accept as the single primary action and Decline as its secondary action. Existing decision rules, duplicate-submit protection, error recovery and periodic status refresh remain intact.
- Designed accepted, declined, expired, unavailable and loading states in the same card language. Public page titles identify the business and current quote state when available.
- Brought unsubscribe confirmation/completion into the same branded document style. The existing read-only GET and one-click POST behavior remain unchanged.
- Shared styles and type assets are available on the existing public asset path so customer pages do not require admin access.

### Shared design system

- Defined palette, typography, spacing, radii, shadows, focus and touch-size tokens in `public/design-system.css`. The requested emerald `#059669` remains the accent/focus color; body-sized white button text uses the darker emerald action color `#047857` for sufficient contrast.
- Calculated contrast from the actual token values: muted body text on the warm canvas is 4.56:1; white action text is 5.48:1; muted sidebar text is 6.96:1; the active sidebar accent is 6.38:1. Warning, success and error text combinations exceed 5.9:1.
- Inter and Sora are Google Fonts served locally, with their licenses included and system-font fallbacks. Customer pages and the self-contained demo use the same assets without a third-party font request.
- Editable controls use the dedicated `#8490A2` border token: 3.24:1 against white and 3.10:1 against the warm canvas. Noninteractive card/table separators remain visually quiet.

The standalone browser demo bundles the same fonts, favicon, design tokens and scoped customer styles so its appearance stays aligned with the installed application.

### Dashboard metric definitions

The redesigned cards derive their figures from the selected business's existing request and quote records. They do not add invented sample trends or change saved records.

- **Reviews requested:** all requests; the delta compares requests sent in the trailing seven days with those sent in the preceding seven days.
- **Quotes awaiting response:** currently sent/viewed quotes; the delta compares that count with the open backlog seven days ago, reconstructed from sent/response timestamps and expiry dates. A terminal quote without its response timestamp is conservatively excluded from the historical backlog.
- **Nudges sent:** successful review nudges plus successful quote reminder deliveries. A reminder sent by text and email counts as two messages; unsuccessful/uncertain/skipped attempts and initial quote sends do not count. The delta compares the same two trailing seven-day periods.
- **Quote conversion:** accepted quotes divided by delivered quotes, with drafts excluded. The comparison is the change in percentage points since seven days ago, using the saved send and response timestamps. Empty denominators display zero.

Focused regressions cover zero baselines, period boundaries, completed review requests, successful delivery channels, historical backlog reconstruction, conversion rounding and safe mobile table labels. Controlled pending-request tests also cover dialog dismissal on success/failure, replacement by a newer dialog and a quote answered while its send dialog is loading. All 14 tests in `tests/design.test.js` passed in the focused run.

## Self-review

### Round 1 — coverage, hierarchy and anti-goals

The first review checked the route inventory and the initial component/source implementation before final browser verification.

The first rendered pass was then inspected at desktop and 360px phone widths, including the Overview and quote builder. The published sample's business and message figures came from the demo's existing stored records. The phone document measured 360px wide with no horizontal page overflow; adding an item and changing tax kept the live total correct ($275.00 subtotal plus 13% tax = $310.75).

| Finding | Correction |
| --- | --- |
| The old Overview hero and decorative sidebar competed with real customer work. | Replace the promotional first-open treatment with the dated greeting, operational metrics, unanswered-quote queue and recent activity. |
| The existing quote detail showed delivery errors but no complete delivery history. | Render existing delivery records as a timeline alongside reminder state and the customer link. |
| A 640px minimum table would hide important information behind horizontal scrolling on a 360px phone. | Give mobile rows their own stacked layout with visible status, labeled metadata, totals and full-size actions. |
| Editable control borders were only 1.48:1 against white. | Add a dedicated slate control-border token with at least 3.10:1 contrast against both surrounding surfaces; keep quiet noninteractive card/table separators. |
| Some spacing tokens used 12px/20px values outside the requested spacing grid. | Align the shared aliases to 8px/24px values and use the shared spacing scale. |
| The native file-picker button was smaller than the minimum touch target. | Use the shared 48px target; checkbox labels also provide at least a 48px effective target. |
| A successful day-2 reminder on two channels could look like two reminder rounds if presentation used delivery counts carelessly. | Keep the existing round-based reminder-status helpers; count successful channel deliveries only for the dashboard's messages-sent metric. |

The rendered review also flagged four refinements for the second pass: give the compact desktop quote queue more room by removing its redundant expiry column; avoid repeating the business name in the identity and switcher; keep the active mobile navigation item visible after rendering; and lock the page behind an open dialog so it has only one scrolling surface.

No gradients, stock artwork, placeholder copy or unrelated accent colors were introduced. Status colors remain semantic; emerald is the shared action/brand accent. Second-pass results appear below.

### Round 2 — after corrections

The second review inspected the rendered mobile customer list, quote detail and customer quote, plus all six desktop admin routes, and rechecked the integrated source against the first-round findings. Customer details use labeled rows rather than a desktop-width pan; the checkout keeps business branding, expiry, line-item amounts, a clear total and 48px Accept/Decline controls. The detail view keeps financial information readable in the narrow dialog. No gradients, stock imagery, lorem ipsum or competing accent palettes appeared.

| Second-pass finding | Final correction and check |
| --- | --- |
| Duplicate browser-demo disclosures above the customer quote. | Removed the extra gray paragraph; one amber demo notice remains. |
| A success toast overlapped the detail's sticky action area. | Offset dialog toasts above its footer. The final phone check placed the toast bottom at 680px and the action bottom at 775px, keeping the action clear. |
| The initial detail image still showed background-page scrolling. | Lock the document behind an open modal. The republished builder/detail show one dialog scrolling surface; computed document overflow is `hidden`. |
| The compact quote queue wrapped reference/reminder and expiry text unnecessarily. | Removed redundant expiry/reminder metadata from the compact queue; the full quote list retains it. The final desktop image has comfortable customer/status/amount/action columns. |
| The business name appeared twice in the workspace switcher. | Combined the logo/initials and selector into one brand row; the final sidebar shows the name once. |
| A rebuilt mobile navigation could leave the selected route offscreen. | Center the active item within the navigation scroller. The final Settings check confirms its active item is fully visible. |

### Verification

- **176/176 tests passed**, including all 161 existing tests. The new tests cover presentation-derived metrics, responsive row labeling, loading-dialog races and the public unavailable-page presentation. Existing sending, business-isolation, follow-up and unsubscribe tests remain green.
- The standalone demo build and `git diff --check` passed.
- All six admin routes were checked at a 1440px desktop viewport with no horizontal page overflow. Phone route/builder/customer checks used a 360px viewport; measured document width stayed 360px.
- At 360px, the builder's footer buttons measured 48px tall and remained fully inside the visible dialog. The final dialog bottom was 792px in an 800px viewport, and footer actions ended at 775px.
- Both locally served Inter and Sora passed the browser's font availability check. Keyboard Tab focused the customer input with the custom solid emerald focus outline (`rgb(5, 150, 105)`). Hover and focus treatments use the shared tokens; normal transitions are 160ms, and reduced-motion preferences disable motion.
- The existing sample quote journey was exercised through the redesigned UI: two items, $300.00 subtotal, 13% tax and $339.00 total; simulated text/email send; Copy link confirmation; customer acceptance; and the owner's Accepted status and updated conversion card.
- Explicit browser requests for an unavailable customer document receive a styled error page while preserving the HTTP status. JSON API/data responses and existing fallback content negotiation remain intact.
