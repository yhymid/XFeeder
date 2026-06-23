[Core]
- Added safe run modes so you can test locally without posting anything live.
- Added a config check command to catch mistakes before deployment.
- Reloading now picks up changes from `.env` and `config.json` without restarting the worker.
- Message cache now tracks each destination separately, so one failed target does not cause duplicate posts in another target.

[Dashboard]
- Added password protection for the dashboard.
- Improved the edit flow for `.env` and `config.json` so routine changes are easier.
- Prevented unsafe public dashboard exposure unless a dashboard password is configured.

[Reliability]
- Fixed proxy handling for feed requests.
- Improved channel and delivery flow to be safer during partial failures.
- Added tests for config loading and channel execution behavior.

[Deployment]
- Added systemd examples for the worker and dashboard services.
- Added safer example environment and config files for public sharing.
- Cleaned the public repo so secrets, caches, local virtual environments, and temporary files stay out.
