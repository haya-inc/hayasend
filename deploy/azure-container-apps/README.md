# Azure Container Apps deployment pack

This experimental pack binds the shared `portable-postgres` runtime to:

- an external Azure Container App for the API;
- an always-on Container App for durable worker/reconciler work;
- a manual Container Apps Job for migration-first releases;
- a VNet-integrated, private Azure Database for PostgreSQL Flexible Server 18;
- a private Azure Blob container with user-delegation SAS uploads;
- Azure Key Vault references and one user-assigned managed identity; and
- an existing, linked Azure Communication Services Email custom domain with
  recipient-level Event Grid delivery events.

It is an implementation pack, not a production-readiness claim. Hosted
delivery, duplicate/out-of-order convergence, rollback, backup/restore, and
zero-residue evidence are tracked in
[#152](https://github.com/haya-inc/hayasend/issues/152). Running Terraform
creates billable Azure resources and requires separate explicit authorization.

## Security model

- The API, worker, and migration job use the same immutable image digest and
  user-assigned managed identity.
- `api_key`, `database_password`, and `event_grid_secret` are Terraform 1.15
  ephemeral variables. AzureRM `value_wo`/`administrator_password_wo`
  arguments keep their values out of Terraform plans and state.
- Container Apps reference versionless Key Vault secret URIs. Key Vault uses
  RBAC, a private endpoint, public default-deny networking, and either an exact
  operator CIDR or an explicitly acknowledged VNet-connected Terraform
  runner.
- PostgreSQL 18 has no public network endpoint, uses TLS, point-in-time
  backups, and zone-redundant HA by default.
- Blob anonymous access, shared access keys, local users, and cross-tenant
  replication are disabled. Runtime traffic resolves through a private
  endpoint. The public Blob service endpoint remains reachable so an
  authenticated browser can use HayaSend's short-lived `cw` user-delegation
  SAS URL; the private container is never anonymously readable.
- The runtime receives only scoped Blob data/delegation roles, Key Vault
  Secrets User, optional ACR pull, and a custom ACS role limited to email
  submission plus read-only domain inspection.
- A `CanNotDelete` lock protects the dedicated runtime resource group by
  default.

The AzureRM storage-account resource can expose computed storage keys as
sensitive state fields even though this pack disables shared-key
authentication and tells the provider to use Microsoft Entra ID. Treat state
as sensitive metadata: use an encrypted, access-controlled Azure Storage
backend with locking and never commit state or `.tfvars`. The disabled keys
are not used by HayaSend.

## Why Event Grid is outside Terraform

The AzureRM Event Grid `delivery_property.value` field is sensitive but not
write-only, so putting the independent delivery secret in that resource would
persist it in Terraform state. `event-grid.mjs` instead:

1. verifies the exact Azure CLI subscription and tenant;
2. obtains a short-lived management token in memory;
3. creates the exact ACS-scoped subscription through Event Grid API
   `2025-02-15`;
4. marks `x-hayasend-event-grid-secret` as a secret static delivery header;
5. allows only the ACS delivery and engagement event types; and
6. verifies topic, endpoint, TLS, event types, secret metadata, and
   provisioning state without printing secret values.

`deploy.sh`, `verify.sh`, and `cleanup.sh` invoke separate fixed-action
entrypoints backed by `event-grid.mjs`, so a caller-controlled subcommand
cannot select the destructive path and the subscription cannot be orphaned
silently.

## Versions

Validated on 2026-07-28 with:

- Terraform `1.15.8`;
- HashiCorp AzureRM provider `4.81.0`;
- Azure CLI `2.88.0`;
- Event Grid control-plane API `2025-02-15`;
- PostgreSQL Flexible Server `18`; and
- HayaSend's Node.js 24 container.

Exact provider constraints and multi-platform checksums are committed.

## Prerequisites

1. Choose a customer-controlled Azure subscription and a dedicated runtime
   resource-group name. Confirm its cost ceiling before applying.
2. Pre-register `Microsoft.App`, `Microsoft.Communication`,
   `Microsoft.EventGrid`, `Microsoft.Insights`, `Microsoft.KeyVault`,
   `Microsoft.ManagedIdentity`, `Microsoft.Network`,
   `Microsoft.OperationalInsights`, `Microsoft.Storage`, and
   `Microsoft.DBforPostgreSQL`. The provider intentionally does not mutate
   subscription-wide registrations.
3. Install the pinned Terraform and Azure CLI versions, Node.js 24, Docker
   Buildx, `jq`, and `curl`.
4. Authenticate interactively or with workload identity. Do not create a
   long-lived service-principal key for this pack.
5. Prepare an existing ACS resource and Email Communication Services resource,
   verify Domain/SPF/DKIM/DKIM2 for a custom domain, and link that exact domain
   to ACS. This pack never edits DNS or creates/deletes the mail domain.
6. Choose a public GHCR image or an authorized ACR image and pin the exact
   `sha256` digest. ACR images additionally require `acr_resource_id`.
7. Copy `terraform.tfvars.example` to ignored `terraform.tfvars` and provide
   only non-secret settings.

Create independent secrets without placing them in files or command-line
arguments:

```bash
export TF_VAR_subscription_id="$(az account show --query id -o tsv)"
export TF_VAR_tenant_id="$(az account show --query tenantId -o tsv)"
export TF_VAR_deployer_object_id="$(az ad signed-in-user show --query id -o tsv)"
export TF_VAR_image="ghcr.io/haya-inc/hayasend@sha256:..."
export TF_VAR_api_key="re_$(openssl rand -hex 32)"
export TF_VAR_database_password="$(openssl rand -base64 48 | tr -d '\n')"
export TF_VAR_event_grid_secret="$(openssl rand -base64 48 | tr -d '\n')"
```

Move operational copies into the approved password/secret manager, then clear
the shell after deployment.

For production state, copy `backend.tf.example` to ignored `backend.tf` and
point it at a separately managed Azure Storage account using Entra ID. The
state account must not live in this module because a data plane must not delete
its own state or audit trail.

## Migration-first deploy

Run:

```bash
./deploy.sh
```

The script:

1. verifies the exact CLI versions, account/tenant, registered resource
   providers, and immutable image;
2. plans and applies only the migration job plus dependencies while rejecting
   deletion/replacement of the resource group, database, storage account, or
   Key Vault;
3. starts one migration execution and requires `Succeeded`;
4. plans and applies the API, worker, and protection lock;
5. installs the secret Event Grid subscription outside Terraform state; and
6. verifies identity, image, network, database, storage, Key Vault, Event Grid,
   and `/readyz`.

Forward migrations must remain compatible with the immediately previous
application revision. A new API or worker revision is not created until the
migration job succeeds.

## Rotation

Change one value and increment its matching monotonic version:

```bash
export TF_VAR_event_grid_secret="$(openssl rand -base64 48 | tr -d '\n')"
export TF_VAR_event_grid_secret_version=2
./deploy.sh
```

Use `api_key_version` or `database_password_version` for the other secrets.
Versionless Key Vault references pick up a new version; `deploy.sh` also
reconciles the Event Grid header and creates new Container App revisions.

## Rollback

Use a reviewed previous application digest:

```bash
export TF_VAR_image="ghcr.io/haya-inc/hayasend@sha256:..."
export HAYASEND_ALLOW_ROLLBACK=azure-container-apps
./rollback.sh
```

Rollback retains forward database migrations, so every migration must preserve
compatibility with the previous application revision. A destructive schema
downgrade is intentionally unsupported.

## Backup and recovery

PostgreSQL point-in-time recovery and Blob soft-delete/version history are
configured, but configuration is not proof. Before promotion:

- restore PostgreSQL into a separate server and run `/readyz` plus invariant
  checks;
- recover deleted/versioned blobs into an isolated container and verify
  checksum-bound access;
- prove the 30-day database-owned schedule after worker and queue loss; and
- record sanitized timestamps and resource IDs without database contents,
  recipient addresses, message content, or secret values.

## Disposable cleanup

Only an explicitly disposable proof may remove retention and purge Key Vault:
set `key_vault_purge_protection_enabled=false` before that proof's initial
deployment. Azure Key Vault purge protection cannot be disabled after it is
enabled, and `cleanup.sh` refuses to treat such a deployment as disposable.

```bash
export TF_VAR_deletion_protection=false
export TF_VAR_key_vault_purge_protection_enabled=false
export TF_VAR_storage_soft_delete_days=0
export HAYASEND_ALLOW_DESTROY=azure-container-apps
export HAYASEND_ALLOW_PURGE_KEY_VAULT=azure-container-apps
./cleanup.sh
```

The script requires the exact account, a `hayasend_dedicated=true` group, and
an inventory in which every active top-level resource carries the exact
deployment ID. It deletes Event Grid first, removes the lock/retention through
a normal plan, destroys Terraform resources, explicitly purges the disposable
Key Vault, and waits for both runtime and Container Apps infrastructure
resource groups to disappear. Before deletion it verifies that the environment
reports the exact Terraform-derived infrastructure group. If Azure's
asynchronous cleanup leaves that group behind, the script deletes only that
exact group and only after it is empty; any non-empty residue fails closed for
manual investigation.

Do not use this path for production offboarding. Keep purge protection and
recovery retention until a separately reviewed retention/offboarding plan
authorizes irreversible deletion.

## Current limitations

- The exact Azure composition remains experimental until #152 records hosted
  delivery and lifecycle evidence.
- The custom ACS role follows Microsoft's documented managed-identity
  `CommunicationServices/Read` and `Write` requirement. Hosted proof must
  confirm it remains sufficient; widening to Contributor is not automatic.
- Zone-redundant Container Apps and PostgreSQL availability depends on region
  and subscription capacity.
- The default Container Apps hostname is used. A branded API domain and
  certificate are a separate DNS-controlled change.
- No Azure Service Bus/Queue accelerator is created. PostgreSQL and the
  always-on worker own reconciliation and long schedules.

## Official references

Checked on 2026-07-28:

- [AzureRM 4.81.0](https://registry.terraform.io/providers/hashicorp/azurerm/4.81.0)
- [Azure Container Apps Terraform resource](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/container_app)
- [Azure Container Apps Job Terraform resource](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/container_app_job)
- [Container Apps Key Vault secret references](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets)
- [Container Apps managed identities](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity)
- [Container Apps VNet cleanup behavior](https://learn.microsoft.com/en-us/azure/container-apps/vnet-custom#clean-up-resources)
- [PostgreSQL Flexible Server Terraform resource](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/postgresql_flexible_server)
- [Blob user-delegation SAS](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blob-user-delegation-sas-create-javascript)
- [ACS managed identity](https://learn.microsoft.com/en-us/azure/communication-services/how-tos/managed-identity)
- [ACS email domains and sender authentication](https://learn.microsoft.com/en-us/azure/communication-services/concepts/email/email-domain-and-sender-authentication)
- [ACS Email Event Grid events](https://learn.microsoft.com/en-us/azure/event-grid/communication-services-email-events)
- [Event Grid custom delivery properties](https://learn.microsoft.com/en-us/azure/event-grid/delivery-properties)
- [Event Grid API 2025-02-15](https://learn.microsoft.com/en-us/rest/api/eventgrid/controlplane/event-subscriptions/create-or-update?view=rest-eventgrid-controlplane-2025-02-15)
- [Event Grid full webhook URL](https://learn.microsoft.com/en-us/rest/api/eventgrid/controlplane/event-subscriptions/get-full-url?view=rest-eventgrid-controlplane-2025-02-15)
- [Event Grid secret delivery attributes](https://learn.microsoft.com/en-us/rest/api/eventgrid/controlplane/event-subscriptions/get-delivery-attributes?view=rest-eventgrid-controlplane-2025-02-15)
