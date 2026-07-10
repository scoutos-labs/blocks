# Editor crashes on save with data loss

- severity: p1 (confidence 0.9)
- component: editor
- repro: press cmd-S in any project — crash every time, ~20 min of work lost
- why: Reproducible crash on the core save path with permanent data loss ('last twenty minutes of work are missing').
