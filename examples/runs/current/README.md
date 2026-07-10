# Current run examples

Protocol-3 committed run ledgers that must pass current audit.

```sh
for f in examples/runs/current/*.run.json; do
  cli/bin/blocks audit "$f" || exit 1
done
```
