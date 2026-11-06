# AuraBot Panel

A Railway-friendly, dark purple Discord bot dashboard with bot workspaces, individual file uploads, ZIP uploads, downloads, deletion, and process logs.

## Features

- Express dashboard with secure cookie sessions and Helmet security headers.
- Admin login configured through Railway Variables.
- Create separate bot workspaces.
- Upload up to 3 files per request, maximum 50 MB per file by default (configurable up to 100 MB).
- ZIP extraction checks for absolute paths, `..` traversal, Windows paths, hidden paths, symlinks, excessive entry count, and expanded-size limits.
- Uploads never overwrite existing files.
- Download and delete project files.
- Start/stop Node.js `.js`/`.cjs` bots and Python `.py` bots (Python must exist in the runtime).
- Bounded in-memory console output.

## Deploy to Railway

1. Create a new GitHub repository and upload the contents of this folder.
2. In Railway, create a project and deploy the repository as a service.
3. Open **Variables** and set:
   - `ADMIN_USERNAME`: your chosen username
   - `ADMIN_PASSWORD`: a unique password of at least 12 characters
   - `SESSION_SECRET`: a random secret of at least 32 characters
   - `DATA_DIR`: `/data`
   - `MAX_UPLOAD_MB`: `50`
4. To keep uploaded files after redeploys/restarts, add a Railway Volume and mount it at `/data`. Without a persistent volume, local uploads may be lost when Railway replaces the container.
5. In **Settings → Networking**, generate a public domain. The panel listens on `0.0.0.0:$PORT`; you do not need your own public IPv4.
6. Visit the Railway domain and log in with the configured admin credentials.

Generate a session secret locally with:
`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

Do not paste secrets into source code or commit `.env`. Use Railway Variables.

## Runtime limitations and security

- This version does not require Docker or root privileges. Railway can still restrict subprocesses or available runtimes; Node.js is expected, but Python may not be installed unless added to the build.
- **Uploaded bot code is executable code. Only upload code you trust.** Running arbitrary code without Docker or another isolation boundary can access the same filesystem and environment as the panel process, including environment variables. This is not a multi-tenant sandbox and should not be exposed to untrusted users.
- The default session store is in-memory; sessions are cleared when the service restarts. Use a production persistent session store before scaling to multiple replicas.
- ZIP upload limits: 500 entries, 4× configured upload limit total expanded size, and no overwrite of existing files.
- This starter does not include Discord OAuth, per-user accounts, package installation from the dashboard, or Railway API provisioning.
- If a bot needs packages, install them in that bot's own project environment/build workflow. No shell/terminal command endpoint is exposed by the dashboard.
- This panel manages child processes only while the panel process is alive. A Railway restart stops running bot processes; for reliable production bot hosting, deploy each bot as its own Railway service or use a dedicated bot runtime service.

## Local run

Requires Node.js 20+:
1. `npm install`
2. Set `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `SESSION_SECRET` in your environment.
3. Optional: set `DATA_DIR=./data` and `PORT=3000`.
4. `npm start`
