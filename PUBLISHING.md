# Publishing dsh-provider-guard

## First publish: NPM_TOKEN

The first publish needs a token that can bypass interactive 2FA, because GitHub
Actions has no TTY for `npm publish`'s OTP prompt.

1. Open <https://www.npmjs.com/settings/tanqvv/tokens> and create a **Granular Access Token**.
   - Permissions: **Packages and scopes: Read and write**
   - Packages: **All packages** (the package does not exist yet, so a per-package
     selection cannot be used for the first publish)
   - **Bypass two-factor authentication (2FA): enabled**
   - Expiration: 30-90 days is fine
2. Add it to the repository secret (paste at the prompt, never in chat or a file):

   ```sh
   gh secret set NPM_TOKEN --repo tanqvv/dsh-provider-guard
   ```

3. Run the workflow:

   ```sh
   gh workflow run publish.yml --repo tanqvv/dsh-provider-guard
   gh run watch --repo tanqvv/dsh-provider-guard
   ```

4. Verify:

   ```sh
   npm view dsh-provider-guard version
   ```

The workflow runs `npm whoami`, `npm publish --access public --provenance`, and
`npm view dsh-provider-guard version`, so a green run means the version is
actually on the registry.

## Security freeze

If `npm publish` returns
`403 Forbidden ... temporarily suspended due to a recent security-sensitive action`,
the account is in a temporary security freeze. Community reports describe a
72-hour freeze after 2FA / recovery-code / OTP anomalies; it cannot be
accelerated. The freeze also blocks token creation. Appeal at
<https://www.npmjs.com/support> (Account -> Suspended account), or wait it out.

Do not use a 2FA recovery code as `--otp`; that is one of the actions that
triggers the freeze.

## After the first publish: Trusted Publishing

Once the package exists, configure an npm Trusted Publisher for this repository
and workflow so future releases use GitHub Actions OIDC instead of a long-lived
token. The `id-token: write` permission is already present in `publish.yml`.

## Token policy (2026)

Granular access tokens that bypass 2FA can no longer perform account, org, or
package management actions. Direct publishing with such a token still works
until January 2027; move to Trusted Publishing (OIDC) or staged publishing
before then.
