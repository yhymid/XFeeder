Agents have lowered the cost of writing code, but most apps and tools that users build never make it off of localhost.
Now, you can build live apps directly in Cursor and share them with a link. Describe what you want to create and Cursor will handle the rest: build the app, set up a database, configure auth, and deploy it.
With this release, anyone in your org can now build useful tools for their work and share them with teammates. Update Cursor to try it out.

**How it works**
To get started, kick off a [cloud agent](https://cursor.com/docs/cloud-agent) and tell it explicitly that you want to build an app.
Cursor will scaffold the web app, spin up a Postgres database if needed, set up authentication behind Cursor SSO, and provision hosting. If the app needs to connect to your systems, like a data warehouse, Cursor will ask for the secrets it needs.
When you go to publish your app, you pick a unique domain and Cursor gets you back a live link.
At Cursor, users across sales, operations, legal, finance, and engineering are building internal apps. Some of the most useful ones are:
• Internal ops tools for event registration, account assignments, and desk seating
• Multimedia presentations for customers that combine slides, videos, and interactive demos
• Training, enablement, and onboarding experiences for new hires
• Live dashboards and tools for sales teams to understand their pipeline and opportunities
• Portals to manage engineering services
Cursor can deploy apps from new or existing repos across Cursor Origin and GitHub. Support for other git providers like GitLab is coming soon.

**Controls and guardrails**
When you publish an app, Cursor will run deterministic and agentic security checks to catch common issues, like secrets written in app files or exposed credentials. If a check fails, the agent tells you what it needs to fix. Nothing goes live until the checks pass and you explicitly publish the app.
Team admins can see every app and secret on the team. They can also add their own rules to the security review, approve publishes the review blocked, and unpublish any app.

**Share with your team**
Once the checks pass, Cursor deploys the app to the URL you chose. You can then share your app with specific people, groups, or your entire team, all behind Cursor sign-in. On individual plans, you can also share apps publicly.
You can also provision a Cursor API key if you want a script or Grok Bot to use your app.

**Get started**
This capability is now available on all paid plans with cloud agents enabled. Learn more by reading our [docs](https://cursor.com/docs/cloud-agent/apps)
