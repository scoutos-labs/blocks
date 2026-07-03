2026-07-03T01:43:42Z begin blocks-protocol-draft02 — workflow outputs + nested workflow nodes + signed oracle approvals (AAITL); spec + reference impl + republish
2026-07-03T01:59:19Z plan-approved blocks-protocol-draft02 — no blockers; canonical preimage gains blockHash; key discovery pinned keys/<id>.private.json; step 3 split
2026-07-03T02:01:51Z step-1-done harness extended: 15 new named failures on current state, old checks green
2026-07-03T02:07:54Z step-2-done validator/loader surface: oracle key, keys registry (d-rejection), canon.js, outputs, workflow nodes, cross-file cycles, grant coverage, protocol field; 42/42 tests
2026-07-03T02:12:19Z step-3-done runner: recursive driveRun, output resolution, signed record, new key; 56/56 tests
2026-07-03T02:16:43Z step-4-done PROTOCOL.md Draft 02: OUT/NST/SIG/VER/SEC additions; only dogfood-artifact checks remain red
2026-07-03T02:23:10Z step-5-done dogfood: release workflow (nesting + signed approval) run live; happy pair + negative pair committed; harness 71/71 incl. live signature re-verification
2026-07-03T02:41:28Z step-6-done adversarial review: 3 blockers (VER-4 runs unenforced; secret digest flowed back on resume; mid-run drift crash) + 10 nits — all repaired; 61/61 tests; harness 73/73
