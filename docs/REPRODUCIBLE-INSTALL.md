# Reproducible SDK checkout installation

Run from an isolated SDK checkout with the committed `package-lock.json`:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run lint
npm run build
npm run types:check
npm run fixtures:events:check
SKIP_MAINNET_TESTS=1 npm test -- --runInBand
```

The lock uses public registry URLs and integrity values. It requires no sibling
`../sdk` checkout or shared `node_modules`. The 2026-11-13 repair preserved all
358 package versions recorded by the old linked lock and restored 58 nested
records from the existing registry lock, including their existing versions and
integrity values. Root package metadata now matches SDK version `0.4.0`.
No dependency versions were upgraded.

The clean Mini qualification used pinned Node 22.21.1 / npm 10.9.9, disabled
lifecycle scripts and passed all commands above: 2,660 offline tests, seven
explicit live-RPC skips. The SDK supports 110 instruction bindings / 81 event
bindings at that interface epoch. A generated binding test is distinct from an
executed on-chain financial path, issuer authorization or a full protocol proof.

Contracts validator/fork runners separately pin the SDK source, full compiled
`dist`, lock and compiler through `fixtures/sdk-v61-runtime.json` in the
contracts checkout. Changing the lock intentionally invalidates an earlier
manifest. Build on the authorized compute host, capture to a separate candidate
path, review its identities, and run the relevant final runtime/fork checks
before replacing that manifest. An old immutable package or runtime receipt
continues to certify only its own bytes.
