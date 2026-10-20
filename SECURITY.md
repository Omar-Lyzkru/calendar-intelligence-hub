# Security policy

## Scope and support

The latest development tree is the maintenance target. This is a local-development project without a production deployment, security SLA or supported historical-release matrix. Use synthetic data for investigation. The [README](README.md) and [automation safety document](docs/automation-safety.md) describe verified behavior and limits.

## Reporting

Never put credentials, private messages, provider payloads, account identifiers, OAuth callback URLs/codes, session cookies or database archives into a public issue, discussion or pull request.

For a public repository with private vulnerability reporting enabled, use GitHub's **Security → Report a vulnerability**. Include a minimal synthetic reproduction, affected revision and impact; remove private data. This channel's availability must be checked on GitHub; adding this file does not enable it.

If the private reporting button is unavailable, open only a generic request for a private security contact, without vulnerability details, exploit instructions, credentials or user data. Wait for a private channel before sharing the technical report. Maintainers should enable private vulnerability reporting when the repository becomes public. See GitHub's [private reporting instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately).

If a credential was exposed, revoke/rotate it through its provider and notify the maintainer privately. Do not treat deleting a file or committing a replacement as removing it from history. Do not rotate the application's encryption key casually: existing encrypted credentials depend on it.

## Safe investigation

No testing against other people's mailboxes, calendars, Discord servers or tenants. No scope escalation, account-policy bypass, real provider writes or publication of captured data. Database recovery/concurrency tests belong in a separate disposable database.

## Release privacy

A public-release review must inspect current files AND all reachable history, including author/committer email metadata, branches/tags and provider fixtures. Known-value/pattern scans are targeted evidence, not a guarantee that every unknown private string is absent. Repository visibility is changed only by the owner after review.
