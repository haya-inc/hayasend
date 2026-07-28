#!/usr/bin/env bash
set -euo pipefail

: "${TF_VAR_project_id:?Set TF_VAR_project_id.}"

name_prefix="${TF_VAR_name_prefix:-hayasend}"
region="${TF_VAR_region:-asia-northeast1}"
if [[ ! "$TF_VAR_project_id" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
  echo "TF_VAR_project_id is not a safe Google Cloud project ID." >&2
  exit 1
fi
if [[ ! "$name_prefix" =~ ^[a-z][a-z0-9-]{1,18}[a-z0-9]$ ]]; then
  echo "TF_VAR_name_prefix is not a safe HayaSend prefix." >&2
  exit 1
fi
if [[ ! "$region" =~ ^[a-z]+-[a-z]+[0-9]$ ]]; then
  echo "TF_VAR_region is not a safe Google Cloud region." >&2
  exit 1
fi

residue=0

check_empty() {
  local label="$1"
  shift
  local output
  output="$("$@")"
  if [[ -n "$output" ]]; then
    echo "$label residue remains." >&2
    residue=1
  fi
}

check_empty "Cloud Run service" \
  gcloud run services list \
  --project="$TF_VAR_project_id" \
  --region="$region" \
  --filter="metadata.name~^${name_prefix}-" \
  --format="value(metadata.name)"
check_empty "Cloud Run job" \
  gcloud run jobs list \
  --project="$TF_VAR_project_id" \
  --region="$region" \
  --filter="metadata.name~^${name_prefix}-" \
  --format="value(metadata.name)"
check_empty "Cloud Run worker pool" \
  gcloud run worker-pools list \
  --project="$TF_VAR_project_id" \
  --region="$region" \
  --filter="metadata.name~^${name_prefix}-" \
  --format="value(metadata.name)"
check_empty "Cloud SQL instance" \
  gcloud sql instances list \
  --project="$TF_VAR_project_id" \
  --filter="name~^${name_prefix}-" \
  --format="value(name)"
check_empty "Cloud Storage bucket" \
  gcloud storage buckets list \
  --project="$TF_VAR_project_id" \
  --filter="name~${name_prefix}-attachments$" \
  --format="value(name)"
check_empty "Secret Manager secret" \
  gcloud secrets list \
  --project="$TF_VAR_project_id" \
  --filter="name~^${name_prefix}-" \
  --format="value(name)"
check_empty "service account" \
  gcloud iam service-accounts list \
  --project="$TF_VAR_project_id" \
  --filter="email~^${name_prefix}-(api|worker|migrate)@" \
  --format="value(email)"
check_empty "VPC network" \
  gcloud compute networks list \
  --project="$TF_VAR_project_id" \
  --filter="name=${name_prefix}-network" \
  --format="value(name)"
check_empty "reserved address" \
  gcloud compute addresses list \
  --project="$TF_VAR_project_id" \
  --global \
  --filter="name=${name_prefix}-private-services" \
  --format="value(name)"
check_empty "Pub/Sub topic" \
  gcloud pubsub topics list \
  --project="$TF_VAR_project_id" \
  --filter="name~/${name_prefix}-wakeup$" \
  --format="value(name)"
check_empty "Pub/Sub subscription" \
  gcloud pubsub subscriptions list \
  --project="$TF_VAR_project_id" \
  --filter="name~/${name_prefix}-wakeup$" \
  --format="value(name)"

iam_residue="$(
  gcloud projects get-iam-policy "$TF_VAR_project_id" \
    --format=json |
    jq --raw-output \
      --arg prefix "serviceAccount:${name_prefix}-" \
      '[
        .bindings[]?.members[]?
        | select(contains($prefix))
      ] | length'
)"
if [[ "$iam_residue" != "0" ]]; then
  echo "HayaSend workload IAM bindings remain." >&2
  residue=1
fi

if [[ "$residue" != "0" ]]; then
  exit 1
fi

echo "Verified zero HayaSend residue in project $TF_VAR_project_id."
