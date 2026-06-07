# agent-os — common commands, with the AWS profile + region always set.
# Override per-invocation:  make deploy AWS_PROFILE=other AWS_REGION=us-east-1
AWS_PROFILE ?= nathan-tilsley-developer
AWS_REGION  ?= eu-west-2
RUNS_TABLE  ?= agent-os-runs

export AWS_PROFILE
export AWS_REGION
export AWS_DEFAULT_REGION = $(AWS_REGION)
export REGION = $(AWS_REGION)            # the app's region env (packages/core/config.ts)

.DEFAULT_GOAL := help

help: ## show this help
	@grep -hE '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*## "}{printf "  \033[36m%-14s\033[0m %s\n",$$1,$$2}'

whoami: ## print the AWS account this profile resolves to (run before deploying!)
	aws sts get-caller-identity

# --- CDK (infra/) ---
bootstrap: ## cdk bootstrap this account/region (one-time)
	cd infra && bunx cdk bootstrap

synth: ## synth the implemented stacks
	cd infra && bunx cdk synth AgentOsState AgentOsBedrock

diff: ## diff against what's deployed
	cd infra && bunx cdk diff AgentOsState AgentOsBedrock

deploy: whoami ## deploy StateStack + BedrockStack (prints identity first)
	cd infra && bunx cdk deploy AgentOsState AgentOsBedrock

destroy: ## destroy StateStack + BedrockStack
	cd infra && bunx cdk destroy AgentOsState AgentOsBedrock

outputs: ## print deployed stack outputs (table, role, guardrail id)
	@aws cloudformation describe-stacks --stack-name AgentOsState   --query 'Stacks[0].Outputs' --output table
	@aws cloudformation describe-stacks --stack-name AgentOsBedrock --query 'Stacks[0].Outputs' --output table

# --- full-mode store (ADR-0027): Aurora Serverless v2, scale-to-zero — deploy per trip ---
deploy-postgres: whoami ## deploy the full-mode Aurora store (opens 5432 to YOUR current IP)
	cd infra && bunx cdk deploy AgentOsPostgres -c dbAllowedCidr=$$(curl -s https://checkip.amazonaws.com)/32 --require-approval never

destroy-postgres: ## tear the Aurora store back down (~$$0 idle while paused anyway)
	cd infra && bunx cdk destroy AgentOsPostgres --force

aurora-bootstrap: ## create the rds_iam DB user (agentos_app) from tracked SQL — run once after deploy-postgres
	cd services/inference-gateway/litellm && uv run python ../../../deploy/aurora/bootstrap.py

postgres-url: ## print the SPEND_DATABASE_URL for the deployed Aurora store
	@SECRET=$$(aws cloudformation describe-stacks --stack-name AgentOsPostgres --query "Stacks[0].Outputs[?OutputKey=='SecretArn'].OutputValue" --output text); \
	 HOST=$$(aws cloudformation describe-stacks --stack-name AgentOsPostgres --query "Stacks[0].Outputs[?OutputKey=='Endpoint'].OutputValue" --output text); \
	 PASS=$$(aws secretsmanager get-secret-value --secret-id $$SECRET --query SecretString --output text | bun -e "const s=JSON.parse(await Bun.stdin.text());console.log(encodeURIComponent(s.password))"); \
	 echo "postgresql://postgres:$$PASS@$$HOST:5432/agentos"

# --- runtime (local process) ---
run: ## run agent-runtime locally (in-memory store)
	SANDBOX_PROVIDER=local bun run services/agent-runtime/server.ts

run-dynamodb: ## run agent-runtime locally against the real DynamoDB table
	RUN_STORE=dynamodb RUNS_TABLE=$(RUNS_TABLE) SANDBOX_PROVIDER=local bun run services/agent-runtime/server.ts

dep-migrator: ## run the dep-migrator agent (local sandbox + Bedrock)
	bun run apps/dep-migrator/migrate.ts

# --- local k8s (colima + k3s) ---
image: ## build the agent-runtime image for k3s
	docker build -t agent-runtime:dev -f services/agent-runtime/Dockerfile .

k8s-creds: ## create the aws-creds secret from this profile (local only; short-lived for SSO/role)
	kubectl apply -f deploy/local/namespace.yaml
	@eval "$$(aws configure export-credentials --format env-no-export)"; \
	  args="--from-literal=AWS_ACCESS_KEY_ID=$$AWS_ACCESS_KEY_ID --from-literal=AWS_SECRET_ACCESS_KEY=$$AWS_SECRET_ACCESS_KEY"; \
	  [ -n "$$AWS_SESSION_TOKEN" ] && args="$$args --from-literal=AWS_SESSION_TOKEN=$$AWS_SESSION_TOKEN"; \
	  kubectl -n agent-os create secret generic aws-creds $$args --dry-run=client -o yaml | kubectl apply -f -

k8s-deploy: ## apply the k8s manifests (namespace + workload)
	kubectl apply -f deploy/local/namespace.yaml -f deploy/local/agent-runtime.yaml
	kubectl -n agent-os rollout status deploy/agent-runtime

k8s-logs: ## tail the runtime logs
	kubectl -n agent-os logs -f deploy/agent-runtime

k8s-forward: ## port-forward the runtime to localhost:3000
	kubectl -n agent-os port-forward svc/agent-runtime 3000:80

sandbox-egress-test: ## prove egress lockdown slice 1 — the wall (think-works / exfil-dies)
	bash deploy/local/sandbox-egress-test.sh

sandbox-egress-proxy-test: ## prove egress lockdown slice 2 — named-domain allowlist via the proxy
	bash deploy/local/sandbox-egress-proxy-test.sh

.PHONY: help whoami bootstrap synth diff deploy destroy outputs deploy-postgres destroy-postgres aurora-bootstrap postgres-url run run-dynamodb dep-migrator image k8s-creds k8s-deploy k8s-logs k8s-forward sandbox-egress-test sandbox-egress-proxy-test
