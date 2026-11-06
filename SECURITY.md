# Security Policy

## Supported versions

Security fixes are provided for the latest `0.1.x` release.

## Reporting a vulnerability

Do not open a public issue for a security problem. Use GitHub's private vulnerability reporting:

https://github.com/MichelVelzr/ork-dbclient/security/advisories/new

Include the plugin version, Orca version, operating system, database engine and a minimal reproduction. Do not include real credentials, connection strings or production data.

## Data and permissions

- **ork-dbclient** uses Orca's `trusted-worker` execution profile. Its worker runs in a separate Node.js process with the same operating-system access as the Orca user. Install it only if you trust the code.
- Connection metadata (name, type, host, port, database, username, TLS flag and SQLite path) is stored in Orca's plugin storage.
- Passwords are stored through Orca's plugin secrets API and are not returned to the panel. Orca may back that store with the operating system keychain.
- The plugin does not send telemetry and does not load remote UI assets. Database traffic goes directly from the worker to the server you configure.
- SQL is executed exactly as entered. Use a least-privilege database account, keep TLS enabled when available, and restrict network access to the servers you need.
- Redis commands are sent to the selected server and can be destructive. Use a restricted Redis ACL user.

## Scope

Reports about the plugin's worker, panel, dependency bundling, credential handling or permission model are in scope. Vulnerabilities in PostgreSQL, MySQL/MariaDB, SQLite, Redis or Orca itself should be reported to their respective maintainers.
