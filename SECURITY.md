# Security

To report a vulnerability, use the private form at "Security", then "Report a vulnerability", in this repository. Do not open a public issue for it.

kvpg sends each key and each value as a query parameter, never as text inside SQL. The schema and the table name are options, and the store quotes them as identifiers. A report that shows SQL built from untrusted input is in scope.
