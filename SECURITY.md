# Security Policy

## Supported versions

HayaSend is currently pre-1.0. Only the latest release and the default branch
receive security fixes.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's
private vulnerability reporting feature for this repository. Include:

- affected version or commit;
- impact and prerequisites;
- minimal reproduction without real credentials or personal data;
- suggested remediation, if known.

Do not test against infrastructure you do not own or administer.

## Operational notes

- Use a high-entropy bootstrap key and rotate it if disclosed.
- Restrict AWS deployment permissions and CloudTrail access.
- Process SES bounce and complaint events in every sending path.
- Treat webhook URLs as sensitive operational configuration.
- Do not put secrets or raw messages in logs or issue reports.
