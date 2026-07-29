#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=deploy/flyio/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

require_flyctl
require_transport
require_resource_inputs
require_image
: "${HAYASEND_FLY_BUCKET_EVIDENCE_FILE:?Set a private output path for bucket evidence.}"

assert_app_inventory
assert_mpg_inventory
assert_bucket_inventory
assert_secret_names true
assert_machine_inventory

machines="$(
  "$fly_cli" machine list \
    --app "$HAYASEND_FLY_APP" \
    --json
)"
api_machine="$(
  jq --raw-output '
    [
      .[] |
      select(
        (
          .config.metadata.fly_process_group //
          .process_group //
          ""
        ) == "api"
      )
    ] |
    if length == 1 then .[0].id else empty end
  ' <<<"$machines"
)"
if [[ ! "$api_machine" =~ ^[a-f0-9]{14}$ ]]; then
  echo "The exact API Machine ID is unavailable for private bucket verification." >&2
  exit 1
fi

remote_command='node --input-type=module --eval '"'"'import {ListObjectsV2Command,S3Client} from "@aws-sdk/client-s3";const bucket=process.env.BUCKET_NAME;const client=new S3Client({region:process.env.AWS_REGION,endpoint:process.env.AWS_ENDPOINT_URL_S3,forcePathStyle:false});let continuationToken;let objectCount=0;do{const page=await client.send(new ListObjectsV2Command({Bucket:bucket,ContinuationToken:continuationToken}));objectCount+=page.KeyCount??0;continuationToken=page.IsTruncated?page.NextContinuationToken:undefined;}while(continuationToken);process.stdout.write(JSON.stringify({object:"hayasend_flyio_bucket_inventory",bucket,object_count:objectCount,empty:objectCount===0})+"\\n");'"'"''
result="$(
  "$fly_cli" machine exec "$api_machine" "$remote_command" \
    --app "$HAYASEND_FLY_APP" \
    --timeout 120 \
    --json
)"
if ! jq --exit-status \
  '.exit_code == 0 and (.stderr // "") == ""' \
  <<<"$result" >/dev/null; then
  echo "The authenticated private Tigris inventory command failed." >&2
  exit 1
fi
jq --raw-output '.stdout' <<<"$result" \
  >"$HAYASEND_FLY_BUCKET_EVIDENCE_FILE"
jq --exit-status \
  --arg bucket "$HAYASEND_FLY_BUCKET" \
  '.object == "hayasend_flyio_bucket_inventory" and
    .bucket == $bucket and
    .object_count == 0 and
    .empty == true' \
  "$HAYASEND_FLY_BUCKET_EVIDENCE_FILE" >/dev/null

echo "The exact private Tigris bucket contains zero objects."
