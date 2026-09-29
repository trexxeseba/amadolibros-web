#!/usr/bin/env bash
# Only temporary cover QA Workers. Retry the observed registration race, never
# an image assertion, resource limit, authorization failure or arbitrary deploy.
set -euo pipefail
if [[ ! "${WORKER_NAME:-}" =~ ^amado-cover-(index|fix)-[0-9]+-[0-9]+$ ]]; then
  echo 'Expected an isolated cover QA Worker name' >&2
  exit 2
fi
for attempt in 1 2 3; do
  if output=$(npx wrangler@3.114.17 deploy "$@" --name "$WORKER_NAME" 2>&1); then
    printf '%s\n' "$output"
    exit 0
  fi
  printf '%s\n' "$output" >&2
  if [[ "$output" != *'/subdomain) failed'* || "$output" != *'[code: 10007]'* || "$attempt" == 3 ]]; then
    exit 1
  fi
  printf 'Temporary Worker registration not visible yet; retry %s/3\n' "$((attempt + 1))" >&2
  sleep "$((attempt * 5))"
done
