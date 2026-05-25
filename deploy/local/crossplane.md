# Crossplane control plane (local) + AWS auth

Platformization step 4: provision AWS from **CRDs** instead of ad-hoc CLI calls
(ADR-0005). Reproducible record of what we set up on colima/k3s, and the auth
decision.

## Installed (local)
```bash
helm repo add crossplane-stable https://charts.crossplane.io/stable
helm install crossplane crossplane-stable/crossplane \
  -n crossplane-system --create-namespace --wait

kubectl apply -f - <<'EOF'
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata: { name: provider-aws-bedrock }
spec: { package: xpkg.upbound.io/upbound/provider-aws-bedrock:v2.5.0 }
EOF
kubectl wait provider.pkg.crossplane.io/provider-aws-bedrock --for=condition=Healthy --timeout=8m
```
Granular `provider-aws-bedrock` (+ its `provider-family-aws` dep) — not the
monolith, to fit 4 GB. Gives the CRD `bedrock.aws.upbound.io/v1beta1 InferenceProfile`.

## Auth — never static keys (ADR-0001/0006)
Crossplane needs AWS creds to provision. We do **not** store long-lived keys.

- **EKS (prod):** the provider uses **Pod Identity / IRSA** — keyless, temporary,
  role-scoped. Real provisioning belongs here; no Secret involved.
- **Local:** colima/k3s has no AWS-trusted OIDC, so keyless federation isn't
  available. Use **short-lived STS creds from a scoped role** — temporary *and*
  scoped (mirrors the prod role), never your user's keys.

### Scoped role (provision via your IAM system — one-time)
`get-session-token` would give temporary-but-*unscoped* (your full user) creds.
A dedicated role gives temporary **and scoped** — preferred. Permissions policy:
```json
{ "Version": "2012-10-17", "Statement": [{
  "Effect": "Allow",
  "Action": [
    "bedrock:CreateInferenceProfile", "bedrock:GetInferenceProfile",
    "bedrock:DeleteInferenceProfile", "bedrock:ListInferenceProfiles",
    "bedrock:TagResource", "bedrock:UntagResource"
  ],
  "Resource": "*"
}] }
```
Trust policy (let your user assume it):
```json
{ "Version": "2012-10-17", "Statement": [{
  "Effect": "Allow",
  "Principal": { "AWS": "arn:aws:iam::925318698970:user/developers/nathan-tilsley-dev" },
  "Action": "sts:AssumeRole"
}] }
```

### Mint short-lived creds → Secret (local only)
```bash
ROLE=arn:aws:iam::925318698970:role/agent-os-crossplane
read AK SK ST < <(aws sts assume-role --role-arn "$ROLE" \
  --role-session-name crossplane \
  --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)

kubectl -n crossplane-system create secret generic aws-creds --from-literal=creds="$(printf \
  '[default]\naws_access_key_id = %s\naws_secret_access_key = %s\naws_session_token = %s\n' \
  "$AK" "$SK" "$ST")"

kubectl apply -f deploy/local/crossplane/providerconfig.yaml
```
Creds expire (default 1 h) — fine for a one-off provision; re-run to refresh.

## Provision (declaratively)
```bash
kubectl apply -f deploy/local/crossplane/inferenceprofile.yaml
kubectl get inferenceprofile agent-os-poc -o wide     # watch SYNCED / READY -> True
kubectl describe inferenceprofile agent-os-poc        # status + any AWS error
```
Crossplane calls Bedrock and reconciles the profile into existence; `kubectl
delete` removes it from AWS. That's the gap closed: the guardrail/profile we made
by hand is now a versioned CRD.

## Status
- ✅ Crossplane core + `provider-aws-bedrock` installed & Healthy locally; CRD available.
- ⏳ Live provision pending the scoped role above (keyless on EKS via Pod Identity).

## Cleanup
```bash
kubectl delete -f deploy/local/crossplane/inferenceprofile.yaml
kubectl -n crossplane-system delete secret aws-creds
helm -n crossplane-system uninstall crossplane   # to remove Crossplane entirely
```
