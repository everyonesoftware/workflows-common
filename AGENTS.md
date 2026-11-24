# Repository guide

- `actions/` contains the public capture composite and internal restore/envelope actions; `.github/workflows/` owns the reusable notification entry point and validation workflow.
- Keep capture and send on the shared `actions/publish-envelope` implementation. Preserve the v1 payload contract and use same-commit `$/` references internally. Pin third-party actions to full commit SHAs.
- Do not run production delivery in tests, check out caller code in the notifier, log credentials or response bodies, or reconstruct missing artifacts.
- Run `node --test tests/*.test.mjs` under Node.js 24. After an authorized push, inspect the exact commit's `Validate workflow components` run to verify GitHub's hosted cross-job artifact round trip.
