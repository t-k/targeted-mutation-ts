# Releasing

A release publishes five npm packages at the same version: `targeted-mutation` and one `@targeted-mutation/tmt-<os>-<cpu>` package for each of `darwin-arm64`, `darwin-x64`, `linux-arm64` and `linux-x64`. The main package lists the platform packages as optional dependencies, so npm installs the one that matches the machine.

The `Release` workflow builds each platform package on a runner of that platform, installs and tests the packages, and publishes the platform packages before the main package. A re-run skips versions that are already on the registry. Workflows run only while the repository is public.

## One-time setup

1. Create the `targeted-mutation` organization on npmjs.com. It owns the `@targeted-mutation` scope.
2. In the GitHub repository, create an environment named `npm`. Restrict it to tags matching `v*` and add required reviewers if a release should need approval.

## First release (token)

npm configures trusted publishing per package, and a package must exist before it can be configured. The first release therefore uses a token.

1. On npmjs.com create a granular access token with read and write access to the `@targeted-mutation` scope and permission to create the unscoped `targeted-mutation` package. Give it a short expiry. If the account enforces two-factor authentication for publishing, allow the token to bypass it.
2. Store it as the secret `NPM_TOKEN` of the `npm` environment (not as a repository secret).
3. Set the version in `package.json` and `package-lock.json`, update `CHANGELOG.md`, merge, and push the tag: `git tag v0.1.0 && git push origin v0.1.0`.
4. After the workflow succeeds, check `npm view targeted-mutation` and install it in an empty project.

## Switch to trusted publishing

Do this once, right after the first release.

1. For each of the five packages, open Settings on npmjs.com, add a trusted publisher of type GitHub Actions, and enter the repository owner and name, the workflow file `release.yml` and the environment `npm`.
2. Delete the `NPM_TOKEN` environment secret and revoke the token on npmjs.com.
3. In each package's settings, require two-factor authentication and disallow tokens.

With the secret gone, the publish step writes no token and npm authenticates through OIDC. This needs npm 11.5.1 or later, which the workflow's Node.js release includes; the step prints the npm version. A new trusted publisher configuration must be used by a successful publish soon after it is created, so plan the second release (a patch release is enough) within that window.

## Later releases

1. Set the version, update `CHANGELOG.md`, merge.
2. Push the tag `v<version>`. The tag must equal the package version or the publish step stops.

If a run fails part-way, fix the cause and re-run it. Published platform packages are skipped and the main package is published last, so an installable main package always has its binaries.

## Local checks

```sh
npm run pack:runtime          # build/packages/*.tgz for this machine
npm run test:package          # install both archives in an empty project and run every profile
node scripts/publish-packages.mjs build/packages --dry-run   # needs all five archives
```

## Workflow dependencies

Actions are pinned by the lockfile `.github/workflows/actions.lock`. After changing a `uses:` line run `gh actions-lock` and commit the lockfile. `gh actions-lock --verify` checks it.
