# Contributing

Each change comes by pull request from a branch, and links its issue.

1. Open an issue first, or take an open one.
2. A change to behavior also changes `docs/standard.md` and the conformance suite in the same pull request.
3. A change to a choice in `docs/design.md` gives its source or its measurement.
4. Each new test must fail before the change and pass after it. State both results in the pull request.
5. Operate `npm ci`, then `npm run check`, before you push.

Commit messages use plain English and the imperative mood, for example "Add the getMany statement".
