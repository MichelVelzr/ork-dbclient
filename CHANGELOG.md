# Changelog

## 0.2.0

- Added Microsoft SQL Server (MSSQL) connections with optional TLS.
- Added per-column result filters that build `LIKE '%value%'` conditions in the SQL editor and combine with `AND`.
- Added a clear-filters action to the results toolbar.
- Added `npm run package` to produce a clean `release/` folder for local installs.
- Added the plugin cover image.

## 0.1.0

- First public release.
- Connection profiles for PostgreSQL, MySQL/MariaDB/Percona, SQLite and Redis.
- Add, edit and delete connections, with optional database/schema selection.
- Passwords stored through Orca plugin secrets; connection metadata stored in plugin storage.
- Collapsible object browser grouped by database/schema.
- CodeMirror SQL editor with dialect-aware highlighting and completion.
- Query results with CSV and JSON export through Orca's save dialog.
- Redis command console.
- Optional TLS for network connections.
