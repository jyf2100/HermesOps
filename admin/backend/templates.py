import os
from typing import Optional

import yaml

from models import ResourceSpec, TemplateResponse, TemplateTypeResponse
from constants import PROVIDER_URL_MAP, strip_v1_suffix

# Provider -> environment variable name mapping
PROVIDER_KEY_MAP = {
    "openrouter": "OPENROUTER_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "zhipuai": "GLM_API_KEY",
    "minimax": "OPENAI_API_KEY",
    "kimi": "MOONSHOT_API_KEY",
    # Agent's _resolve_openrouter_runtime() checks OPENAI_API_KEY for custom
    # endpoints — CUSTOM_API_KEY is not in the credential resolution path.
    "anthropic-compat": "OPENAI_API_KEY",
    "custom": "OPENAI_API_KEY",
}


def deployment_name(agent_number: int) -> str:
    """Map agent_number to K8s Deployment name (agent 0 -> hermes-gateway, n -> hermes-gateway-n)."""
    return "hermes-gateway" if agent_number == 0 else f"hermes-gateway-{agent_number}"


class TemplateGenerator:

    def __init__(self, templates_dir: str | None = None, data_root: str | None = None):
        if templates_dir is None:
            # Default: templates/ sibling of the backend/ package directory
            # In Docker: __file__ = /app/templates.py -> dirname = /app -> templates_dir = /app/templates/
            self.templates_dir = os.path.join(
                os.path.dirname(os.path.abspath(__file__)),
                "templates"
            )
        else:
            self.templates_dir = templates_dir
        # Persistent overrides directory — survives container restarts
        if data_root:
            self.persist_dir = os.path.join(data_root, "_admin", "templates")
        else:
            self.persist_dir = os.path.join(
                os.path.dirname(os.path.abspath(__file__)),
                "persist_templates"
            )

    def _read_template(self, name: str) -> str:
        # Priority: persisted override > image-baked default
        persisted = os.path.join(self.persist_dir, name)
        if os.path.isfile(persisted):
            with open(persisted) as f:
                return f.read()
        default = os.path.join(self.templates_dir, name)
        if os.path.isfile(default):
            with open(default) as f:
                return f.read()
        return ""

    def _write_template(self, name: str, content: str) -> None:
        os.makedirs(self.persist_dir, exist_ok=True)
        path = os.path.join(self.persist_dir, name)
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            f.write(content)
        os.replace(tmp, path)

    def render_env(self, llm_config, extra_env: list | None = None) -> str:
        """Generate .env content from LLM config."""
        lines = []
        if isinstance(llm_config, dict):
            provider = str(llm_config.get('provider', 'openrouter'))
            api_key = llm_config.get('api_key', '')
        else:
            provider = llm_config.provider.value if hasattr(llm_config.provider, 'value') else str(llm_config.provider)
            api_key = llm_config.api_key

        # Read template as base
        template = self._read_template(".env.template")
        lines.append(template if template else "# Hermes Agent Environment Configuration\n")

        # Inject API key
        env_key = PROVIDER_KEY_MAP.get(provider)
        if not env_key:
            raise ValueError(f"Unknown provider '{provider}' — no API key env var mapping. "
                             f"Known providers: {', '.join(sorted(PROVIDER_KEY_MAP))}")
        lines.append(f"\n{env_key}={api_key}\n")

        if extra_env:
            lines.append("\n# Additional environment variables\n")
            for v in extra_env:
                k = v.key if hasattr(v, 'key') else v['key']
                val = v.value if hasattr(v, 'value') else v['value']
                lines.append(f"{k}={val}\n")

        return "".join(lines)

    def render_config_yaml(self, default_model: str = "anthropic/claude-sonnet-4-20250514",
                           provider: str = "openrouter", base_url: str | None = None,
                           api_mode: str | None = None,
                           api_key: str | None = None,
                           terminal_enabled: bool = True, browser_enabled: bool = False,
                           streaming_enabled: bool = True, memory_enabled: bool = True,
                           session_reset_enabled: bool = False,
                           swarm_enabled: bool = False,
                           swarm_capabilities: list[str] | None = None,
                           swarm_max_tasks: int = 3,
                           swarm_redis_url: str = "redis://hermes-redis:6379/0") -> str:
        """Generate config.yaml content."""
        provider = provider.value if hasattr(provider, "value") else provider
        resolved_url = base_url or PROVIDER_URL_MAP.get(provider, PROVIDER_URL_MAP["openrouter"])
        # The Anthropic SDK appends /v1/messages to base_url. If the URL
        # already ends with /v1, strip it to avoid /v1/v1/messages.
        if api_mode == "anthropic_messages":
            resolved_url = strip_v1_suffix(resolved_url)
        model_cfg: dict = {
            "default": default_model,
            "provider": provider,
            "base_url": resolved_url,
        }
        if api_mode:
            model_cfg["api_mode"] = api_mode
        config_data = {
            "model": model_cfg,
            "terminal": {"enabled": terminal_enabled},
            "browser": {"enabled": browser_enabled},
            "streaming": {"enabled": streaming_enabled},
            "memory": {"enabled": memory_enabled},
            "session_reset": {"enabled": session_reset_enabled},
        }
        if swarm_enabled:
            config_data["swarm"] = {
                "enabled": True,
                "capabilities": swarm_capabilities or [],
                "max_concurrent_tasks": swarm_max_tasks,
                "message_bus": swarm_redis_url,
                "heartbeat_interval": 30,
            }
        # Generate custom_providers for hermes-web-ui model discovery
        _placeholder = PROVIDER_URL_MAP.get("custom")
        if provider == "custom" and resolved_url and resolved_url != _placeholder:
            config_data["custom_providers"] = [{
                "name": "default",
                "base_url": resolved_url.rstrip("/"),
                "model": default_model,
                "api_key": api_key or "",
            }]
        return yaml.dump(config_data, default_flow_style=False, allow_unicode=True)

    def render_service(self, agent_number: int, namespace: str = "hermes-agent") -> dict:
        name = deployment_name(agent_number)
        return {
            "apiVersion": "v1",
            "kind": "Service",
            "metadata": {"name": name, "namespace": namespace},
            "spec": {
                "type": "ClusterIP",
                "ports": [
                    {"name": "webui", "port": 6060, "targetPort": 6060},
                    {"name": "gateway-api", "port": 8642, "targetPort": 8642},
                ],
                "selector": {"app": name},
            },
        }

    def get_all(self) -> TemplateResponse:
        return TemplateResponse(
            deployment_yaml=self._read_template("deployment.yaml"),
            env_template=self._read_template(".env.template"),
            config_yaml_template=self._read_template("config.yaml.template"),
            soul_md_template=self._read_template("SOUL.md.template"),
        )

    _FILE_MAP = {
        "deployment": "deployment.yaml",
        "env": ".env.template",
        "config": "config.yaml.template",
        "soul": "SOUL.md.template",
    }

    def get_template(self, template_type: str) -> str:
        filename = self._FILE_MAP.get(template_type)
        if not filename:
            raise ValueError(f"Unknown template type: {template_type}")
        return self._read_template(filename)

    def set_template(self, template_type: str, content: str) -> None:
        filename = self._FILE_MAP.get(template_type)
        if not filename:
            raise ValueError(f"Unknown template type: {template_type}")
        self._write_template(filename, content)

    # --- Merged gateway + webui deployment (local mode) ---

    def render_webui_deployment(self, agent_number: int, secret_name: str,
                                resources: ResourceSpec, namespace: str = "hermes-agent",
                                display_name: str | None = None,
                                tags: list[str] | None = None,
                                role: str | None = None) -> dict:
        """Return a merged gateway+webui Deployment dict (local mode).

        Uses hermes-web-ui image which includes the hermes binary.
        gateway-manager.ts spawns gateway as a child process (no HERMES_WEB_UI_API_BASE_URL).
        Deployment name stays hermes-gateway-{N} for backward compatibility.
        """
        name = deployment_name(agent_number)
        metadata: dict = {"name": name, "namespace": namespace}
        if display_name:
            metadata["annotations"] = {"hermes/display-name": display_name}

        pod_annotations: dict[str, str] = {}
        if tags:
            pod_annotations["hermes-agent.io/capabilities"] = ",".join(tags)
        if role:
            pod_annotations["hermes-agent.io/role"] = role

        return {
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "metadata": metadata,
            "spec": {
                "replicas": 1,
                "strategy": {"type": "Recreate"},
                "selector": {"matchLabels": {"app": name}},
                "template": {
                    "metadata": {
                        "labels": {
                            "app": name,
                            "app.kubernetes.io/component": "gateway",
                        },
                        **({"annotations": pod_annotations} if pod_annotations else {}),
                    },
                    "spec": {
                        "serviceAccountName": "hermes-gateway",
                        "terminationGracePeriodSeconds": 60,
                        "securityContext": {
                            "runAsUser": 10000,
                            "runAsGroup": 10000,
                            "fsGroup": 10000,
                        },
                        "initContainers": [{
                            "name": "fix-permissions",
                            "image": "docker.io/ekkoye8888/hermes-web-ui:latest",
                            "imagePullPolicy": "IfNotPresent",
                            "command": ["sh", "-c"],
                            "args": [
                                "mkdir -p /home/agent/.hermes/{cron,sessions,logs,hooks,memories,skills,skins,plans,workspace,home,cache} "
                                "&& mkdir -p /home/agent/.hermes/webui-data "
                                "&& { chown -R 10000:10000 /home/agent/.hermes 2>/dev/null || true; }"
                            ],
                            "securityContext": {"runAsUser": 0, "runAsNonRoot": False},
                            "volumeMounts": [
                                {"name": "hermes-data", "mountPath": "/home/agent/.hermes"},
                            ],
                        }],
                        "containers": [{
                            "name": "gateway",
                            "image": "docker.io/ekkoye8888/hermes-web-ui:latest",
                            "imagePullPolicy": "IfNotPresent",
                            "securityContext": {
                                "allowPrivilegeEscalation": False,
                                "capabilities": {"drop": ["ALL"]},
                            },
                            "ports": [
                                {"containerPort": 6060, "name": "webui", "protocol": "TCP"},
                                {"containerPort": 8642, "name": "gateway-api", "protocol": "TCP"},
                            ],
                            "env": [
                                # Web UI
                                {"name": "PORT", "value": "6060"},
                                {"name": "CORS_ORIGINS", "value": "*"},
                                {"name": "LOGIN_MAX_FAILURES", "value": "0"},
                                # Hermes paths (aligned with docker-compose.yml defaults)
                                {"name": "HERMES_BIN", "value": "/opt/hermes/.venv/bin/hermes"},
                                # Local mode: no HERMES_WEB_UI_API_BASE_URL
                                {"name": "HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN", "value": "1"},
                                {"name": "HERMES_ALLOW_ROOT_GATEWAY", "value": "1"},
                                # Auth
                                {"name": "AUTH_TOKEN", "valueFrom": {
                                    "secretKeyRef": {"name": secret_name, "key": "api_key"}
                                }},
                                # Gateway runtime (inherited by child process via process.env)
                                {"name": "API_SERVER_ENABLED", "value": "true"},
                                {"name": "API_SERVER_HOST", "value": "0.0.0.0"},
                                {"name": "API_SERVER_PORT", "value": "8642"},
                                {"name": "API_SERVER_KEY", "valueFrom": {
                                    "secretKeyRef": {"name": secret_name, "key": "api_key"}
                                }},
                                {"name": "API_SERVER_CORS_ORIGINS", "value": "*"},
                                {"name": "GATEWAY_ALLOW_ALL_USERS", "value": "true"},
                                {"name": "GATEWAY_HOST", "value": "127.0.0.1"},
                                {"name": "K8S_NAMESPACE", "value": namespace},
                                {"name": "K8S_DEPLOYMENT", "value": name},
                                {"name": "HERMES_AGENT_NUMBER", "value": str(agent_number)},
                                {"name": "SANDBOX_POOL_NAME", "value": "hermes-sandbox-pool"},
                                {"name": "SANDBOX_TTL_MINUTES", "value": "30"},
                                # Redis (with password)
                                {"name": "SWARM_REDIS_URL",
                                 "value": "redis://:$(REDIS_PASSWORD)@hermes-redis:6379/0"},
                                {"name": "REDIS_PASSWORD", "valueFrom": {
                                    "secretKeyRef": {
                                        "name": "hermes-redis-secret",
                                        "key": "redis-password",
                                    }
                                }},
                                # Node.js tuning
                                {"name": "NODE_OPTIONS", "value": "--max-old-space-size=768"},
                            ],
                            "resources": {
                                "requests": {
                                    "cpu": resources.cpu_request,
                                    "memory": resources.memory_request,
                                },
                                "limits": {
                                    "cpu": resources.cpu_limit,
                                    "memory": resources.memory_limit,
                                },
                            },
                            "readinessProbe": {
                                "httpGet": {"path": "/health", "port": 6060},
                                "initialDelaySeconds": 30, "periodSeconds": 10,
                                "timeoutSeconds": 5, "failureThreshold": 6,
                            },
                            "livenessProbe": {
                                "httpGet": {"path": "/health", "port": 6060},
                                "initialDelaySeconds": 60, "periodSeconds": 30,
                                "timeoutSeconds": 10, "failureThreshold": 5,
                            },
                            "volumeMounts": [
                                {"name": "hermes-data", "mountPath": "/home/agent/.hermes"},
                                {"name": "webui-home", "mountPath": "/home/agent/.hermes-web-ui"},
                                {"name": "hermes-data", "mountPath": "/app/dist/data", "subPath": "webui-data"},
                            ],
                        }],
                        "volumes": [
                            {
                                "name": "hermes-data",
                                "hostPath": {
                                    "path": f"/data/hermes/agent{agent_number}",
                                    "type": "DirectoryOrCreate",
                                },
                            },
                            {
                                "name": "webui-home",
                                "hostPath": {
                                    "path": f"/data/hermes/agent{agent_number}/.webui",
                                    "type": "DirectoryOrCreate",
                                },
                            },
                        ],
                    },
                },
            },
        }

    def render_nip_ingress(self, agent_number: int,
                           namespace: str = "hermes-agent",
                           cluster_ip: str = "172.32.153.184") -> dict:
        """Return a nip.io domain Ingress for direct agent webui access."""
        name = deployment_name(agent_number)
        nip = cluster_ip.replace(".", "-")
        host = f"agent{agent_number}.{nip}.nip.io"
        return {
            "apiVersion": "networking.k8s.io/v1",
            "kind": "Ingress",
            "metadata": {
                "name": f"{name}-nip", "namespace": namespace,
                "annotations": {
                    "nginx.ingress.kubernetes.io/proxy-read-timeout": "3600",
                    "nginx.ingress.kubernetes.io/proxy-send-timeout": "3600",
                    "nginx.ingress.kubernetes.io/proxy-buffering": "off",
                },
            },
            "spec": {
                "ingress_class_name": "nginx",
                "rules": [{
                    "host": host,
                    "http": {
                        "paths": [{
                            "path": "/",
                            "pathType": "Prefix",
                            "backend": {
                                "service": {"name": name, "port": {"number": 6060}},
                            },
                        }],
                    },
                }],
            },
        }
