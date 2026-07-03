2026-07-03T12:37:37Z begin blocks-protocol-draft03 — oracle.capability self-attestation; gate contains + #ref length; blockHash prose split for det blocks; republish
2026-07-03T12:51:15Z plan-approved blocks-protocol-draft03 — no blockers; attest slot pinned after blockHash check; asymmetry rationale into §12.5; VER-4 repeal explicit
2026-07-03T12:53:27Z step-1-done red: 13 failing tests + 19 failing harness checks name every missing Draft-03 construct; 61 existing tests green
2026-07-03T12:57:13Z step-2-3-4-done preimage split, protocol-3 stamping + cross-draft refusal, contains/#ref gates, capability attestation; 74/74 tests (3 old-formula expectations migrated, listed in commit)
2026-07-03T13:01:11Z step-5-done PROTOCOL.md Draft 03 text: §12.5 CAP, GAT-8..10, RUN-2 split, VER-4/5, §19; only 5 fresh-artifact checks red
2026-07-03T13:03:37Z step-6-done dogfood: fresh release run r-c07ba399 (protocol 3, split preimages, both gate constructs live, signed+attested approval); harness 91/91; old pairs byte-untouched
2026-07-03T13:17:34Z step-7a-done adversarial gate: ZERO behavioral defects (first draft to achieve it); 1 doc blocker (App D item 7 stale preimage + SPEC.md unsynced) + 7 nits — all repaired; 76/76
2026-07-03T13:18:09Z step-7-done republished, bytes identical
2026-07-03T13:18:09Z complete blocks-protocol-draft03 — 101 requirement IDs → 108 (CAP-1..4, GAT-8..10); 76 tests; harness 91→93 checks ALL PASS
