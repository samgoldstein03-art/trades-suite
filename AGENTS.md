# Working on Tradesuite

This repository is the source of truth for the project:
https://github.com/samgoldstein03-art/trades-suite

The owner has requested that all completed code and future updates be committed
and pushed to this repository as part of the work. Do not leave a completed
implementation only in local files or a ZIP. Run the relevant checks, commit the
changes, push without rewriting history, and verify the remote commit. If
authentication or repository protections block a push, preserve the local commit
and clearly report that the remote is not yet updated. Do not claim a successful
upload without verification. Follow any branch protections or review requirements.

Keep application code, tests, source assets, build scripts, and setup/deployment
documentation here. Never commit real credentials, `.env`, customer databases,
customer uploads, hosting claim tokens, or local publication state. Example
configuration must contain placeholders only.

Phase 1 uses Node.js/Express and SQLite. Keep the interface plain-spoken. Quotes
and missed-call text-back are later phases. A public browser demo simulates SMS;
publishing code or that demo does not verify a hosted backend or real SMS delivery.
