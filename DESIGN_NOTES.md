# Tradesuite design notes

The current presentation follows the owner's original brand specification. This replaces the earlier slate/Inter/Sora and flat-4px presentation decisions. See [PILOT_AUDIT.md](PILOT_AUDIT.md) for the complete 30-item audit and before-fix locations.

## Existing brand, restored through tokens

- Canvas `#f6f7f3`; ink `#243d34`; deep-green primary `#184c3f`.
- Lime `#daecbb` and orange `#ce723a` accents; muted `#78817b`; borders `#e5e9e2`.
- White sidebar, existing deep-green brand mark and buttons, 16px panels/modals. Smaller control/identity radii retain their component roles.
- Original self-hosted DM Sans body and Manrope headings, using the nine existing local font assets and their licences. Public customer/legal assets and the offline preview use these same fonts.
- Flat borders, no decorative drop shadows. Lime and 16px corners are deliberate brand exceptions to the checklist, not reasons to invent another visual system.

The supplied muted swatch measures about 3.74:1 against the canvas and 4.02:1 against white. It remains the base swatch; small readable copy and placeholders use the specified ink through the secondary-text role. White on the deep-green primary measures about 9.79:1; green on lime about 7.79:1. Orange is an accent, not small text on white.

## Screens and behaviour preserved

The sidebar, max-width containers, dashboard sections, list/filter patterns, forms, quote builder, delivery history, reminder controls, customer quote, message preferences and legal draft layouts stay in place. The same responsive rules, 48px control styling, focus indicators, skeleton loaders and reduced-motion support remain.

- **Dashboard:** restores A little word of mouth. Four cards show recorded counts only; no percentages, deltas or reconstructed historical comparisons.
- **Quotes:** existing status filters, saved quote terms, live money/tax calculations, send choices, customer links and reminder controls are unchanged.
- **Contacts:** existing customer fields, tags and message permission indicators are unchanged.
- **Review requests:** existing send/preview/done/retry controls are unchanged. Just one reminder. Never a string of texts applies to review requests; quote reminders still follow their two-day/five-day sequence.
- **Activity:** actual recorded messages and status changes retain their timestamps and business scope.
- **Customer quote/preferences:** restore matching brand/type roles and readable small copy; keep response and unsubscribe behaviour. The business mark stays deep green when the admin sidebar becomes white.
- **Emails:** existing initial/reminder plain-text messages and one-click unsubscribe headers/footer remain. No marketing template or unapproved legal agreement is added.
- **Legal pages:** existing Terms/Privacy owner-review drafts remain visibly unfinished, with no invented final policy or effective date.

There is no marketing landing page and none was built. Missed-call text-back, jobs/scheduling, invoices and maintenance remain future work.

## Measured dashboard values

1. Review requests sent: saved request rows, including ones later closed by the owner.
2. Quotes awaiting response: current sent/viewed quote rows.
3. Follow-up messages sent: review requests with a successful nudge timestamp plus successful/simulated quote reminder delivery rows. Failures and initial sends are excluded; each channel delivery counts as a message.
4. Requests marked done: request rows with status done, explicitly labelled Marked manually by you.

No card claims that Google reviews were received. The app does not detect them. Demo sending remains visibly simulated, and provider acceptance does not prove delivery to a phone or inbox.

## Verification

The full automated suite and current browser checks are recorded in PILOT_AUDIT.md. Tests intentionally replace the removed conversion/trend expectations with direct-record count checks; sending, business isolation, reminders and opt-out regressions remain in the suite. An added public-font regression requests the restored font CSS and checks all nine referenced files without exposing admin data.

## Jobs and scheduling addition

- **Jobs & schedule:** existing card, row, filter, status pill, modal and empty-state patterns. Search and status/type filters, customer-specific shortcuts and reset, list plus weekly agenda, and an explicit unscheduled queue. No invented percentage or dispatch map.
- **Job editor/detail:** customer and optional accepted quote reuse existing records. Work, address, local date/arrival window and time zone are distinct from internal notes and published customer updates. Delivered quote terms are unchanged.
- **Dashboard:** recorded upcoming visits and jobs needing booking join the existing queues without new performance metrics.
- **Customer job page:** same self-hosted fonts and brand tokens, business identity, address, arrival window, actual status and published history, optional accepted quote, business contact links and draft legal links. It is read-only, with an explicit sample-data label for demo jobs. Loading/unavailable/retry states preserve privacy and clear revoked content.
- **Sharing:** explicit enable/copy/replace/disable controls explain that anyone with the link can read that one job. No automatic SMS or email is introduced.

This addition does not change the original brand exceptions (16px panels and restrained lime), existing messaging behavior, quote terms or legal draft status.

Verification for this addition: **239 tests pass, zero failures**, including the complete existing suite and new jobs, customer-page, sample-preview and save-recovery checks. The actual Express/SQLite demo was exercised in the browser: accepted-quote conversion, local appointment booking, published progress, hidden internal notes, link disabling and a fresh replacement link. The customer page, owner list, weekly schedule and editor fit a roughly 360px phone viewport without horizontal overflow; form controls retain 48px targets. Opening a customer's jobs and then adding work preserves that customer. The standalone sample preview was rebuilt from current source. All walkthrough records are explicitly sample data, and no real messages were sent.
