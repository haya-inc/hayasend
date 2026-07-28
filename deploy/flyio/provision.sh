#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=deploy/flyio/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

if [[ "${HAYASEND_FLY_CREATE:-}" != "confirmed" ]]; then
  echo "Set HAYASEND_FLY_CREATE=confirmed to create billable isolated resources." >&2
  exit 1
fi

require_flyctl

: "${HAYASEND_FLY_APP:?Set HAYASEND_FLY_APP to a new isolated Fly App name.}"
: "${HAYASEND_FLY_ORG:?Set HAYASEND_FLY_ORG to the exact organization slug.}"
: "${HAYASEND_FLY_MPG_PLAN:?Set HAYASEND_FLY_MPG_PLAN explicitly after reviewing current pricing.}"
: "${HAYASEND_API_KEY:?Set HAYASEND_API_KEY to an independently generated re_ key.}"

if [[ ! "$HAYASEND_FLY_APP" =~ ^hayasend-flyio-[a-z0-9]([a-z0-9-]{0,31}[a-z0-9])?$ ]]; then
  echo "HAYASEND_FLY_APP must be a lowercase hayasend-flyio-* name of at most 48 characters." >&2
  exit 1
fi
if [[ ! "$HAYASEND_FLY_ORG" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
  echo "HAYASEND_FLY_ORG must be an exact lowercase Fly organization slug." >&2
  exit 1
fi
case "$HAYASEND_FLY_MPG_PLAN" in
  basic | starter | launch | scale | performance) ;;
  *)
    echo "HAYASEND_FLY_MPG_PLAN must be basic, starter, launch, scale, or performance." >&2
    exit 1
    ;;
esac
if [[ "$HAYASEND_API_KEY" != re_* ]] ||
  [[ "${#HAYASEND_API_KEY}" -lt 16 ]] ||
  [[ "${#HAYASEND_API_KEY}" -gt 512 ]]; then
  echo "HAYASEND_API_KEY must be a 16 to 512 character re_ key." >&2
  exit 1
fi

cluster_name="${HAYASEND_FLY_APP}-mpg"
bucket_name="${HAYASEND_FLY_APP}-attachments"

apps="$("$fly_cli" apps list --org "$HAYASEND_FLY_ORG" --json)"
if jq --exit-status --arg app "$HAYASEND_FLY_APP" \
  'any(.[]; (.name // .Name) == $app)' \
  <<<"$apps" >/dev/null; then
  echo "The requested Fly App already exists; provisioning refused." >&2
  exit 1
fi

clusters="$("$fly_cli" mpg list --org "$HAYASEND_FLY_ORG" --json)"
if jq --exit-status --arg name "$cluster_name" \
  'any(.[]; .name == $name)' \
  <<<"$clusters" >/dev/null; then
  echo "The requested Managed Postgres cluster already exists; provisioning refused." >&2
  exit 1
fi

buckets="$("$fly_cli" storage list --org "$HAYASEND_FLY_ORG")"
if awk -v bucket="$bucket_name" \
  '$1 == bucket { found = 1 } END { exit(found ? 0 : 1) }' \
  <<<"$buckets"; then
  echo "The requested Tigris bucket already exists; provisioning refused." >&2
  exit 1
fi

private_directory="$(mktemp -d "${TMPDIR:-/tmp}/hayasend-flyio-provision.XXXXXX")"
chmod 700 "$private_directory"
provision_complete=false
cleanup_private_output() {
  find "$private_directory" -type f -exec sh -c ': > "$1"' _ {} \;
  find "$private_directory" -depth -delete
  if [[ "$provision_complete" != "true" ]]; then
    echo "Provisioning stopped before completion; inspect and clean any named partial Fly resources." >&2
  fi
}
trap cleanup_private_output EXIT

"$fly_cli" apps create "$HAYASEND_FLY_APP" \
  --org "$HAYASEND_FLY_ORG" \
  --yes \
  --json >/dev/null

"$fly_cli" mpg create \
  --name "$cluster_name" \
  --org "$HAYASEND_FLY_ORG" \
  --region nrt \
  --pg-major-version 17 \
  --plan "$HAYASEND_FLY_MPG_PLAN" \
  --volume-size 10 \
  >"$private_directory/mpg-create.txt"

clusters="$("$fly_cli" mpg list --org "$HAYASEND_FLY_ORG" --json)"
cluster_id="$(
  jq --raw-output \
    --arg name "$cluster_name" \
    --arg org "$HAYASEND_FLY_ORG" \
    '[
      .[] |
      select(
        .name == $name and
        .organization.slug == $org and
        .status == "ready"
      )
    ] | if length == 1 then .[0].id else empty end' \
    <<<"$clusters"
)"
if [[ -z "$cluster_id" ]]; then
  echo "Managed Postgres did not become one exact ready cluster." >&2
  exit 1
fi

"$fly_cli" mpg attach "$cluster_id" \
  --app "$HAYASEND_FLY_APP" \
  --variable-name HAYASEND_DATABASE_URL \
  >"$private_directory/mpg-attach.txt"

"$fly_cli" storage create \
  --app "$HAYASEND_FLY_APP" \
  --name "$bucket_name" \
  --yes \
  >"$private_directory/storage-create.txt"

printf '%s\n' \
  "HAYASEND_API_KEY=$HAYASEND_API_KEY" \
  "HAYASEND_OBJECT_STORAGE_BUCKET=$bucket_name" |
  "$fly_cli" secrets import \
    --app "$HAYASEND_FLY_APP" \
    --stage \
    >"$private_directory/secrets-import.txt"

export HAYASEND_FLY_MPG_CLUSTER_ID="$cluster_id"
export HAYASEND_FLY_BUCKET="$bucket_name"
assert_app_inventory
assert_mpg_inventory
assert_bucket_inventory
assert_secret_names false

provision_complete=true
echo "Fly App: $HAYASEND_FLY_APP"
echo "Managed Postgres cluster ID: $cluster_id"
echo "Private Tigris bucket: $bucket_name"
echo "Record these identifiers privately, then run deploy.sh."
