# @yc-tools/next-yc

CLI for deploying Next.js applications to Yandex Cloud (Cloud Functions + API Gateway + Object Storage), using terraform under the hood.

## Install

```bash
npm install -g @yc-tools/next-yc
# or run ad hoc
npx @yc-tools/next-yc --help
```

Requires Node.js >= 20 and a `terraform` binary on PATH for `deploy`. The Next.js app must use `output: "standalone"` in `next.config.js`.

## Commands

- `next-yc analyze -p <path>` — detect project capabilities (App/Pages Router, API routes, ISR, middleware, server actions, image optimization) and check them against the compatibility matrix.
- `next-yc plan -p <path>` — print the deployment plan without building.
- `next-yc build -p <path> -o <dir>` — run the Next.js build, package server/image functions and static assets, and write `deploy.manifest.json`.
- `next-yc deploy-manifest -b <build-dir> -o <path>` — generate/copy the deployment manifest from build artifacts.
- `next-yc upload -b <build-dir> --bucket <name>` — upload assets, function zips, and manifest to Object Storage (`--dry-run` supported).
- `next-yc deploy` — build, upload, and `terraform apply` in one go.

## Configuration

Options are resolved in order: CLI flag > environment variable > config file. Config file names: `next-yc-cfg.json`, `.next-yc-cfg`, `next-yc-cfg.yml`, `next-yc-cfg.yaml` (looked up in the project directory; or pass `--config`).

### Environment variables

| Variable | Purpose |
|---|---|
| `NYC_PROJECT` | Path to the Next.js project |
| `NYC_OUTPUT` | Build output directory (default `./build`) |
| `NYC_BUILD_ID` | Custom build ID |
| `NYC_SKIP_BUILD` | Skip `next build`, package existing output |
| `NYC_BUCKET` | Assets bucket name (otherwise read from terraform outputs) |
| `NYC_REGION`, `NYC_ENDPOINT` | Object Storage region / S3 endpoint |
| `NYC_STORAGE_ACCESS_KEY`, `NYC_STORAGE_SECRET_KEY` | Object Storage credentials for uploads (fall back to `YC_ACCESS_KEY`/`YC_SECRET_KEY`, then `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`) |
| `NYC_STATE_BUCKET`, `NYC_STATE_KEY` | Terraform remote state bucket/key (**required for deploy**; `TF_STATE_BUCKET`/`TF_STATE_KEY` also accepted) |
| `NYC_STATE_REGION`, `NYC_STATE_ENDPOINT`, `NYC_STATE_ACCESS_KEY`, `NYC_STATE_SECRET_KEY` | Terraform backend overrides |
| `NYC_APP_NAME`, `NYC_ENV`, `NYC_DOMAIN_NAME` | Terraform variables `app_name`, `env`, `domain_name` |
| `NYC_CLOUD_ID`, `NYC_FOLDER_ID`, `NYC_IAM_TOKEN`, `NYC_ZONE` | Yandex Cloud provider settings |
| `NYC_DNS_ZONE_ID`, `NYC_CERTIFICATE_ID`, `NYC_CREATE_DNS_ZONE` | DNS / TLS settings |
| `NYC_AUTO_APPROVE` | Run `terraform apply -auto-approve` (required when stdin is not a TTY) |
| `NYC_TF_VAR_<name>` | Extra terraform variable (`NYC_TF_VAR_FOO=1` -> `TF_VAR_foo=1`) |
| `NYC_ENV_<name>` | Extra runtime env var injected into the server function |

## Example

```bash
export NYC_STATE_BUCKET=my-tf-state
export NYC_STATE_KEY=next-app/terraform.tfstate
export YC_ACCESS_KEY=... YC_SECRET_KEY=...

next-yc deploy -p ./my-next-app --app-name my-next-app --environment prod --auto-approve
```

## License

MIT
