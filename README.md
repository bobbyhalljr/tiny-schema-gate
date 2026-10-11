# tiny-schema-gate

A tiny schema gate for structured LLM output in TypeScript.

Validate. One constrained repair. Accept or reject.

No API key. No network. Mock model fixtures only.

## Run

```bash
npm install
npx tsx gate.ts
```

Typecheck:

```bash
npx tsc --noEmit
```

## What it does

1. Defines a JSON schema for a routing decision: `action`, `target`, `confidence`
2. Runs eight scripted "model" replies (valid, truncated, wrong types, bad enum, extras, missing fields, out of range, stubborn)
3. Validates with a zero-dependency checker
4. Feeds validation errors into one repair pass
5. Prints pass@1, pass@repair, reject rate, and a ship gate

The fixtures and numbers are **example inputs**, not measurements of any real model.

## Write-up

- Dev.to: https://dev.to/bobbyhalljr/your-structured-output-passed-once-build-a-tiny-schema-gate-in-typescript-gf8

## License

MIT
