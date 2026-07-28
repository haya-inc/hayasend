#!/usr/bin/env bash

pack_directory="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")" || exit 1
  pwd
)"
fly_cli="${FLY_CLI:-flyctl}"

require_flyctl() {
  local required_version installed_version
  required_version="$(<"$pack_directory/.flyctl-version")"
  installed_version="$(
    "$fly_cli" version |
      sed -n '1s/^flyctl v\([^ ]*\).*/\1/p'
  )"
  if [[ "$installed_version" != "$required_version" ]]; then
    echo "flyctl $required_version is required; found ${installed_version:-unknown}." >&2
    exit 1
  fi
}

require_resource_inputs() {
  : "${HAYASEND_FLY_APP:?Set HAYASEND_FLY_APP to the isolated Fly App name.}"
  : "${HAYASEND_FLY_ORG:?Set HAYASEND_FLY_ORG to the exact organization slug.}"
  : "${HAYASEND_FLY_MPG_CLUSTER_ID:?Set HAYASEND_FLY_MPG_CLUSTER_ID to the exact Managed Postgres cluster ID.}"
  : "${HAYASEND_FLY_BUCKET:?Set HAYASEND_FLY_BUCKET to the exact private Tigris bucket name.}"

  if [[ ! "$HAYASEND_FLY_APP" =~ ^hayasend-flyio-[a-z0-9]([a-z0-9-]{0,31}[a-z0-9])?$ ]]; then
    echo "HAYASEND_FLY_APP must be a lowercase hayasend-flyio-* name of at most 48 characters." >&2
    exit 1
  fi
  if [[ ! "$HAYASEND_FLY_ORG" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
    echo "HAYASEND_FLY_ORG must be an exact lowercase Fly organization slug." >&2
    exit 1
  fi
  if [[ ! "$HAYASEND_FLY_MPG_CLUSTER_ID" =~ ^[a-zA-Z0-9_-]{6,128}$ ]]; then
    echo "HAYASEND_FLY_MPG_CLUSTER_ID has an invalid format." >&2
    exit 1
  fi
  if [[ "$HAYASEND_FLY_BUCKET" != "${HAYASEND_FLY_APP}-attachments" ]]; then
    echo "HAYASEND_FLY_BUCKET must equal HAYASEND_FLY_APP plus -attachments." >&2
    exit 1
  fi
}

require_image() {
  : "${HAYASEND_IMAGE:?Set HAYASEND_IMAGE to an immutable HayaSend GHCR digest.}"
  : "${HAYASEND_FLY_MACHINE_IMAGE_DIGEST:?Set HAYASEND_FLY_MACHINE_IMAGE_DIGEST to the Linux/amd64 manifest digest selected from HAYASEND_IMAGE.}"
  if [[ ! "$HAYASEND_IMAGE" =~ ^ghcr\.io/haya-inc/hayasend@sha256:[a-f0-9]{64}$ ]]; then
    echo "HAYASEND_IMAGE must be an immutable official HayaSend GHCR digest." >&2
    exit 1
  fi
  if [[ ! "$HAYASEND_FLY_MACHINE_IMAGE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    echo "HAYASEND_FLY_MACHINE_IMAGE_DIGEST must be an immutable Linux/amd64 manifest digest." >&2
    exit 1
  fi
}

assert_app_inventory() {
  local apps
  apps="$("$fly_cli" apps list --org "$HAYASEND_FLY_ORG" --json)"
  if ! jq --exit-status \
    --arg app "$HAYASEND_FLY_APP" \
    --arg org "$HAYASEND_FLY_ORG" \
    '[
      .[] |
      select(
        (.name // .Name) == $app and
        (
          .organization.slug //
          .Organization.Slug //
          .owner //
          .Owner //
          ""
        ) == $org
      )
    ] | length == 1' \
    <<<"$apps" >/dev/null; then
    echo "The exact isolated Fly App is missing or duplicated." >&2
    exit 1
  fi
}

assert_mpg_inventory() {
  local clusters
  clusters="$("$fly_cli" mpg list --org "$HAYASEND_FLY_ORG" --json)"
  if ! jq --exit-status \
    --arg id "$HAYASEND_FLY_MPG_CLUSTER_ID" \
    --arg name "${HAYASEND_FLY_APP}-mpg" \
    --arg app "$HAYASEND_FLY_APP" \
    --arg org "$HAYASEND_FLY_ORG" \
    '[
      .[] |
      select(
        .id == $id and
        .name == $name and
        .organization.slug == $org and
        .status == "ready" and
        ([.attached_apps[]?.name] | sort) == [$app]
      )
    ] | length == 1' \
    <<<"$clusters" >/dev/null; then
    echo "Managed Postgres is not the exact ready cluster attached only to this app." >&2
    exit 1
  fi
}

assert_bucket_inventory() {
  local buckets bucket_status
  buckets="$("$fly_cli" storage list --org "$HAYASEND_FLY_ORG")"
  if ! awk \
    -v bucket="$HAYASEND_FLY_BUCKET" \
    -v org="$HAYASEND_FLY_ORG" \
    '$1 == bucket && $2 == org { matches++ }
      END { exit(matches == 1 ? 0 : 1) }' \
    <<<"$buckets"; then
    echo "The exact Tigris bucket is missing or duplicated." >&2
    exit 1
  fi

  bucket_status="$(
    "$fly_cli" storage status "$HAYASEND_FLY_BUCKET" \
      --app "$HAYASEND_FLY_APP"
  )"
  if ! awk \
    -v bucket="$HAYASEND_FLY_BUCKET" \
    -v app="$HAYASEND_FLY_APP" \
    '
      tolower($1) == "name" && $2 == bucket { name_ok = 1 }
      tolower($1) == "status" &&
        (tolower($2) == "ready" || tolower($2) == "active") {
        status_ok = 1
      }
      tolower($1) == "public" && tolower($2) == "false" {
        private_ok = 1
      }
      tolower($1) == "app" && $2 == app { app_ok = 1 }
      END {
        if (!(name_ok && status_ok && private_ok && app_ok)) {
          exit 1
        }
      }
    ' \
    <<<"$bucket_status"; then
    echo "Tigris must be the exact active private bucket attached to this app." >&2
    exit 1
  fi
}

assert_secret_names() {
  local require_deployed="${1:-false}"
  local secrets
  secrets="$(
    "$fly_cli" secrets list \
      --app "$HAYASEND_FLY_APP" \
      --json
  )"
  if ! jq --exit-status \
    --argjson require_deployed "$require_deployed" \
    '
      def required:
        [
          "AWS_ACCESS_KEY_ID",
          "AWS_ENDPOINT_URL_S3",
          "AWS_REGION",
          "AWS_SECRET_ACCESS_KEY",
          "BUCKET_NAME",
          "HAYASEND_API_KEY",
          "HAYASEND_DATABASE_URL",
          "HAYASEND_OBJECT_STORAGE_BUCKET",
          "SENDGRID_API_KEY",
          "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY"
        ];
      ([.[].name] | sort) as $names |
      (required | all(. as $name | $names | index($name) != null)) and
      (
        ($require_deployed | not) or
        all(
          .[];
          (
            .name as $name |
            required | index($name)
          ) == null or
          (.status // "Unknown") == "Deployed"
        )
      )
    ' \
    <<<"$secrets" >/dev/null; then
    echo "Required app secrets are missing or not fully deployed." >&2
    exit 1
  fi
}

assert_machine_inventory() {
  local machines
  machines="$(
    "$fly_cli" machine list \
      --app "$HAYASEND_FLY_APP" \
      --json
  )"
  if ! jq --exit-status \
    --arg digest "$HAYASEND_FLY_MACHINE_IMAGE_DIGEST" \
    '
      def process_group:
        (
          .config.metadata.fly_process_group //
          .config.metadata["fly_process_group"] //
          .process_group //
          ""
        );
      length == 2 and
      ([.[] | process_group] | sort) == ["api", "worker"] and
      ([.[].config.image] | unique | length) == 1 and
      all(
        .[];
        .state == "started" and
        (.config.image // "") != "" and
        .image_ref.digest == $digest and
        .image_ref.labels["org.opencontainers.image.source"] ==
          "https://github.com/haya-inc/hayasend" and
        (
          .image_ref.labels["org.opencontainers.image.title"] |
          ascii_downcase
        ) == "hayasend" and
        ((.config.mounts // []) | length == 0)
      )
    ' \
    <<<"$machines" >/dev/null; then
    echo "Fly Machines are not the exact started API/worker pair on the expected image." >&2
    exit 1
  fi
}
