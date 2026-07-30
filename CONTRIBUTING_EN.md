# Contributing

[简体中文](./CONTRIBUTING.md) | English

Thanks for contributing to CS2 Insight Agent. This is a concise guide to the branch and pull-request workflow.

## Branches

| Branch | Purpose |
| --- | --- |
| `main` | Stable, released code. Only release merges and urgent hotfixes. |
| `develop` | Daily integration branch for features and fixes. |
| `V2.x.x` | Optional maintenance branch for a released version; hotfixes must also reach `main` and `develop`. |
| `feat/*`, `fix/*`, `chore/*` | Working branches created from `develop`; open a PR back to `develop`. |

## Development and PRs

```bash
git fetch origin
git checkout develop
git pull origin develop
git checkout -b feat/your-feature # or fix/ or chore/
```

Open pull requests against **`develop`**, not `main`. Keep the title clear, link related issues when applicable, describe how you tested the change, and avoid unrelated formatting changes. For recording, CS2 control, or Windows packaging changes, state whether you tested on Windows.

## Releases and hotfixes

Maintainers merge release-ready `develop` into `main`, tag a version, and run the release pipeline. For an urgent released-version fix, branch from `main`, open a PR to `main`, then bring the same fix back to `develop` (and the relevant maintenance branch, if one exists).

## Local setup

See [developer.md](./docs/developer.md) for the development workflow and [dev-setup.md](./docs/dev-setup.md) for a quick English setup guide. The backend uses Python 3.12 and FastAPI; the frontend uses Node.js, pnpm, and Vite. Full recording, OBS, and CS2 console-injection validation requires Windows.

## Issues and license

Use [GitHub Issues](https://github.com/DrEAmSs59/CS2-insight-agent/issues) for bugs and feature requests; search before filing. Report security concerns privately—do not post secrets or full configurations in public issues. By contributing, you license your changes under [PolyForm Noncommercial 1.0.0](./LICENSE).
