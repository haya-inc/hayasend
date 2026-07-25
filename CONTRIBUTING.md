# Contributing

Thank you for improving HayaSend.

## Before coding

1. Search existing issues and discussions.
2. Open an issue for behavioral or API changes.
3. Keep Resend compatibility changes backed by a contract test.
4. Do not include real email addresses, message bodies, AWS account data, or
   credentials in fixtures.

## Development

```bash
npm install
npm run check
npm test
npm run build
```

Pull requests should explain the user impact, include tests, update relevant
documentation, and remain focused on one change.

## Sign-off

Contributions use the Developer Certificate of Origin. Add a sign-off to each
commit with:

```bash
git commit --signoff
```

By signing off, you certify that you have the right to submit the contribution
under this project's Apache-2.0 license.
