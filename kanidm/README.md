# Kanidm and OpenBao OIDC extension

This extension manages Kanidm groups and OAuth2 clients through the Kanidm v1
HTTP API. It also adds `configure_kanidm_oidc` to the existing
`@evrardjp/openbao-configurator` type. The extension source belongs in
Swamp-ext. Behavior instances that use it belong in the consumer repository,
such as swamp-lab.

Configure a Kanidm API token in a Swamp vault. Use an API token for a service
account that has the required group and OAuth2 administration access. Do not
put the token in model files or source control. The OAuth2 client secret output
is marked sensitive so Swamp stores it in its vault.

```yaml
type: '@jamesakeech/kanidm'
globalArguments:
  baseUrl: https://auth.example.com
  apiToken: '${{ vault.get("default", "kanidm-api-token") }}'
```

Call `ensure_group` before `ensure_oauth2_client`. The OAuth2 method accepts
redirect URIs, group scope mappings, and the public origin. Its secret can then
be passed to the OpenBao extension method through Swamp data expressions.

```yaml
type: '@evrardjp/openbao-configurator'
methods:
  configure_kanidm_oidc:
    discoveryUrl: https://auth.example.com/oauth2/openid/openbao
    clientId: openbao
    clientSecret: '${{ data.latest("kanidm-openbao", "oauth2Credential").attributes.clientSecret }}'
```

The OpenBao extension method configures the OIDC auth mount, discovery client,
role, callback URIs, group claim, and policy names. Supply its OpenBao token
from a Swamp vault. Review the arguments and policy assignments before running
against a live instance.

The API requests are implemented here. No Kanidm or OpenBao CLI wrapper is
used. Validate this extension with `swamp extension fmt kanidm/manifest.yaml
--check` before publishing it.
