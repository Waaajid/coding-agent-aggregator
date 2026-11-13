# Security policy

This daemon launches coding agents that can run shell commands on your machine, so please report vulnerabilities privately.

Use GitHub's **Report a vulnerability** button (Security tab → Advisories). Please don't open a public issue for auth bypasses, approval-gate bypasses, or anything that lets a worker or web page act without human approval.

The daemon binds to `127.0.0.1` only and checks Host and Origin on every request. Exposing it beyond localhost (Tailscale, LAN) is your responsibility; see the README.
