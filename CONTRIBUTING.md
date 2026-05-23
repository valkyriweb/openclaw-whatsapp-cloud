# Contributing

Thanks for looking — small, focused PRs welcome.

## Dev setup

```bash
git clone https://github.com/TomasWard1/openclaw-whatsapp-kapso
cd openclaw-whatsapp-kapso
npm install
npm test
```

Node `>=20` (matrix-tested against 20 and 22 in CI).

## TDD expectation

- New behavior starts as a **failing test** in `test/<module>.test.ts`, then implementation in `src/<module>.ts`.
- No untested public function. Keep tests black-box where possible — test observable behavior, not private internals.
- If you find yourself mocking the module under test, step back and test the real thing.

## Branches & PRs

- Branch off `staging`, never `main`.
- One concern per PR. Big refactors welcome but separate from feature work.
- Target the `staging` branch. `staging` → `main` is the promote PR, opened automatically.

## Commit style

[Conventional commits](https://www.conventionalcommits.org/):

- `feat:` new user-facing feature
- `fix:` bug fix
- `docs:` documentation only
- `test:` test-only change
- `refactor:` no behavior change
- `ci:` workflow / infra
- `chore:` everything else

Breaking changes: append `!` (e.g. `feat!:`) and include a `BREAKING CHANGE:` footer.

## Running the full local check

```bash
npm test
npm run check:pack   # verify the package manifest only ships shipping files
```

## Questions?

Open a discussion or issue. PRs with a clear "why" in the description get reviewed faster.
