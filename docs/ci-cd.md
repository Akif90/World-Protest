# GitHub Actions deployment to the existing VM

The workflow in `.github/workflows/ci-cd.yml` runs on pull requests to `main`,
pushes to `main`, and manual runs. Backend tests use a disposable PostgreSQL 16
service, including integration tests that would otherwise be skipped. Frontend
checks run lint, tests, and a production build. A separate job builds both Docker
images. Only successful runs on `main` can deploy.

Deployment uses SSH to the existing checkout, fetches `main`, and checks out the
exact tested commit in detached HEAD mode. If `main` has advanced, that older run
skips deployment. Production deployments are serialized. The VM builds images
for its native architecture before updating containers, then checks the backend,
Nginx, scheduler, frontend page, and proxied API. Recreating containers can cause
a brief interruption; this is a single-VM pipeline, not a zero-downtime rollout.
Images are rebuilt on the VM rather than promoted from CI, so base-image updates
and architecture differences can produce different images from the CI build.

## Prepare the VM

Use the existing checkout and its existing directory name so Compose continues
using the same project and database/certificate volumes. Complete the HTTP/HTTPS
setup in the root README first, including the initial certificate if using HTTPS.
The deployment script does not create `.env` or provision certificates.

The SSH user needs:

- Write access to the checkout, with no local changes or untracked files.
  `.env` remains ignored and stays on the VM.
- Git access to fetch `origin/main`. A public repository needs no credentials;
  a private repository needs its own read-only deploy key on the VM.
- Bash, Git, `flock`, curl, Docker Engine, and Docker Compose v2.
- Working `docker info`, or passwordless `sudo -n docker info`. Docker access
  grants broad control of the host; use a dedicated deployment credential.
- Enough disk and memory to build the frontend and backend containers.

Create a dedicated SSH key locally, without a passphrase, and append its public
key to the VM user's `~/.ssh/authorized_keys`. Keep the private key out of the
repository. For example, generate one with:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/world-protest-actions -C github-actions-deploy
```

Allow the GitHub-hosted runner to reach your SSH port through OCI's network rules
and the host firewall. Existing rules restricted to your personal IP will block
GitHub-hosted runners. If SSH must stay private or restricted to a fixed IP, use
a private connectivity solution or a separate runner with a stable egress IP
before enabling deployment. Do not run untrusted PR jobs on the production VM.

## Configure GitHub

In the repository, create an environment named `production`. Restrict its
allowed deployment branch to `main`. Environment protection options depend on
your GitHub plan and repository visibility. See GitHub's
[deployment controls](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments).

Add these **environment secrets**:

| Name | Value |
| --- | --- |
| `DEPLOY_HOST` | VM public IPv4 address or DNS hostname |
| `DEPLOY_USER` | SSH user, for example `ubuntu` |
| `DEPLOY_SSH_KEY` | Complete private key, including header/footer and newlines |
| `DEPLOY_KNOWN_HOSTS` | Verified OpenSSH known_hosts entry for this VM |

Obtain the host public key/fingerprint through a trusted VM console or an
existing verified SSH connection. Compare it to the entry collected with
`ssh-keyscan -H HOST` before saving that entry in `DEPLOY_KNOWN_HOSTS`.
For a custom port, use `ssh-keyscan -p PORT -H HOST`; the entry must use the
`[HOST]:PORT` form. The workflow requires host-key verification.

Add these **repository Actions variables** under Settings → Secrets and
variables → Actions → Variables:

| Name | Value |
| --- | --- |
| `DEPLOY_PATH` | Absolute existing checkout path, for example `/home/ubuntu/World-Protest`; no spaces |
| `DEPLOY_PORT` | SSH port; defaults to `22` |
| `DEPLOY_HTTPS` | `true` for the existing HTTPS stack (default), or `false` for HTTP only |
| `DEPLOY_ENABLED` | Set to `true` after the VM and secrets are ready |

`DEPLOY_ENABLED` must be a repository variable because the deploy job checks it
before entering the environment. With it unset, CI runs and deployment skips.
The app's database password and other `.env` values stay on the VM.

## First run and subsequent releases

1. Push these files and open a PR. Confirm Backend tests, Frontend checks, and
   Docker builds pass. Make these required status checks in your `main` branch
   protection/ruleset if you want to block merging failing changes.
2. Configure the environment, secrets, variables, and SSH connectivity above.
3. Merge into `main`; the passing workflow deploys automatically when enabled.
   To deploy an already merged commit, use Actions → CI and deploy → Run workflow
   and choose `main`. All checks run again before deployment.
4. Check the deployment log and open the public site from your own browser.
   VM-local HTTPS checks validate certificates and routing, but cannot prove that
   external DNS or OCI firewall rules are correct.

The pipeline leaves the checkout at detached HEAD. For manual updates, use
`git fetch origin main` and `git checkout --detach origin/main`, followed by the
same Compose commands; do not use the older `git pull` instructions on a detached
checkout. Keep the same checkout directory and both Compose files for HTTPS.

## Failure and recovery

A build failure leaves the existing containers running, although the checkout
will already point at the attempted commit. A failure after services restart
fails the Actions run and may leave the new services running. There is no
automatic rollback because database schema changes may need manual recovery.
The script prints the previous commit SHA. Inspect service logs on the VM:

```bash
cd /home/ubuntu/World-Protest
sudo docker compose -f docker-compose.yml -f docker-compose.https.yml ps
sudo docker compose -f docker-compose.yml -f docker-compose.https.yml logs --tail=100 backend scheduler frontend
```

For normal recovery, revert the bad change through a PR and let `main` redeploy.
For urgent manual recovery, inspect schema compatibility and backups, then check
out the previous full SHA and rebuild/restart with the same Compose files:

```bash
git checkout --detach PREVIOUS_FULL_SHA
sudo docker compose -f docker-compose.yml -f docker-compose.https.yml build backend scheduler frontend
sudo docker compose -f docker-compose.yml -f docker-compose.https.yml up -d --no-build db backend scheduler
sudo docker compose -f docker-compose.yml -f docker-compose.https.yml up -d --no-build --no-deps --force-recreate frontend
curl -fsS http://127.0.0.1:8000/health
```

For HTTP-only deployments omit the HTTPS override. Disable `DEPLOY_ENABLED`
while doing manual recovery. Keep off-VM database backups. Deployment never
runs `down --volumes`, resets the database, or overwrites `.env`.
