# agent-os authorization policy (ADR-0015). Evaluated by OPA; the OpaAuthorizer
# adapter POSTs { input: { principal, action, resource } } and reads
# data.agentos.authz -> { allow, reason }.
#
# Run locally:  opa run --server deploy/local/opa/authz.rego
# In cluster:   mounted into the OPA pod that the runtime queries (AUTHZ=opa).
package agentos.authz

import rego.v1

default allow := false

# An authenticated caller (real tenant + subject) may create runs...
allow if {
	input.action == "run:create"
	input.principal.tenant != "default"
	input.principal.subject != "anonymous"
	not sensitive_agent
}

# ...but a sensitive agent additionally requires the 'admins' group.
allow if {
	input.action == "run:create"
	sensitive_agent
	"admins" in input.principal.groups
}

sensitive_agent if input.resource == "admin-bot"

reason := "permitted" if allow

reason := "unauthenticated principal" if {
	not allow
	input.principal.tenant == "default"
}

reason := sprintf("agent %q requires the 'admins' group", [input.resource]) if {
	not allow
	sensitive_agent
	input.principal.tenant != "default"
}

reason := sprintf("not permitted: %s / %s", [input.action, input.resource]) if {
	not allow
	not sensitive_agent
	input.principal.tenant != "default"
}
