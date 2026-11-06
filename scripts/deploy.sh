#!/usr/bin/env bash
# Run by CI over SSH, or manually: bash scripts/deploy.sh PATH COMMIT HTTPS
set -euo pipefail

project_dir=${1:?Provide the existing VM checkout path}
commit=${2:?Provide the tested commit SHA}
https=${3:-true}
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected a full commit SHA.' >&2; exit 1; }
[[ "$https" == true || "$https" == false ]] || exit 1
cd "$project_dir"
[[ -f .env ]] || { echo 'Provision the VM .env before deploying.' >&2; exit 1; }

# Also serialize manual invocations; keep the lock outside the working tree.
exec 9>"$(git rev-parse --git-dir)/world-protest-deploy.lock"
flock -w 1200 9
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] || {
  echo 'VM checkout has local changes. Commit or move them before deploying.' >&2
  exit 1
}
git fetch origin main
# A slow CI run must not replace a newer main deployment with an older commit.
if [[ "$(git rev-parse FETCH_HEAD)" != "$commit" ]]; then
  echo "Skipping $commit: main has moved. The latest main run will deploy."
  exit 0
fi
previous_commit=$(git rev-parse HEAD)
git checkout --detach "$commit"

docker_cmd=(docker)
if ! docker info >/dev/null 2>&1; then
  docker_cmd=(sudo -n docker)
fi
compose=("${docker_cmd[@]}" compose -f docker-compose.yml)
if [[ "$https" == true ]]; then
  compose+=(-f docker-compose.https.yml)
fi

on_failure() {
  result=$?
  echo "Deployment failed. Previous commit: $previous_commit" >&2
  "${compose[@]}" ps || true
  echo 'Inspect container logs on the VM; see docs/ci-cd.md for recovery.' >&2
  exit "$result"
}
trap on_failure ERR
# Validate without printing interpolated secrets. Build before touching containers.
"${compose[@]}" config --quiet
"${compose[@]}" build backend scheduler frontend
"${compose[@]}" up -d --no-build db backend scheduler
# Nginx resolves the backend container address on startup; refresh it every deploy.
"${compose[@]}" up -d --no-build --no-deps --force-recreate frontend

for attempt in {1..30}; do
  if "${compose[@]}" exec -T backend python -c \
    'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=5)' \
    >/dev/null 2>&1 &&
    "${compose[@]}" exec -T frontend nginx -t >/dev/null 2>&1; then
    # Check both static serving and the API through the public reverse proxy.
    if [[ "$https" == true ]]; then
      domain=$("${compose[@]}" exec -T frontend printenv DOMAIN_NAME)
      base_url="https://$domain"
      curl_args=(--resolve "$domain:443:127.0.0.1")
    else
      base_url=http://127.0.0.1
      curl_args=()
    fi
    if curl --fail --silent --show-error --max-time 10 "${curl_args[@]}" "$base_url/" >/dev/null &&
      curl --fail --silent --show-error --max-time 10 "${curl_args[@]}" \
        "$base_url/api/points?zoom=0&days=1" >/dev/null &&
      [[ -n "$("${compose[@]}" ps --status running -q scheduler)" ]]; then
      echo "Deployed $commit (previous: $previous_commit)."
      exit 0
    fi
  fi
  sleep 2
done

echo 'Services failed deployment health checks.' >&2
false # Trigger the same failure diagnostics as other deployment errors.
