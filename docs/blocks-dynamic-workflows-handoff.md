2026-07-02T14:52:56Z begin blocks-dynamic-workflows — design skill-shaped no-code blocks + deterministic DAG workflow system
2026-07-02T15:01:53Z plan-approved blocks-dynamic-workflows — 7-step plan; B1 resolved (standard frontmatter + contract.json + blocks link); evidence: docs/blocks-dynamic-workflows-prd.html
2026-07-02T15:04:27Z step-1-done SPEC.md (9 sections) + skeleton dirs; evidence: SPEC.md, ls -R
2026-07-02T15:10:06Z step-2-done CLI core (list/validate/graph), 20 tests green; evidence: node --test 'cli/tests/*.test.js'; cyclic fixture exits 1 naming a -> b -> a
2026-07-02T15:16:58Z step-3-done det runtime: double-run IDENTICAL, injection literal, exit-3 fence, resume; evidence: cli/tests/run.test.js (29 tests green)
2026-07-02T15:16:58Z step-4-done fuzzy machinery: check-output names /score above maximum 1; record repair loop 3 attempts
