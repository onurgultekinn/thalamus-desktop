# Security Policy

## Reporting a Vulnerability

If you find a security vulnerability in Thalamus Desktop, please report it
privately rather than opening a public issue:

- **GitHub Security Advisories**: use "Report a vulnerability" on the
  Security tab of this repository.
- **Email**: onurgultekinn26@gmail.com (please include "Thalamus security"
  in the subject).

Please include a description of the issue, reproduction steps, and, if
possible, the error code shown in the app. We aim to respond within a few
days.

## Scope notes

- Provider API keys are stored in the operating system credential vault
  and never leave the machine except in direct requests to the provider
  you configured.
- The local backend binds to 127.0.0.1 only. Report anything that changes
  that assumption.
- Agent file tools are restricted to the workspace root; escape paths from
  that sandbox are in scope.
