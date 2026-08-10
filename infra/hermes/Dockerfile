# syntax=docker/dockerfile:1.7

ARG HERMES_SOURCE_IMAGE
FROM ${HERMES_SOURCE_IMAGE}

ARG CORE_AGENT_GIT_SHA
ARG HERMES_GIT_SHA

LABEL org.opencontainers.image.title="Core-Agent Hermes Runtime"
LABEL org.opencontainers.image.description="Source-built managed Hermes runtime for Core-Agent"
LABEL org.opencontainers.image.vendor="Core-Agent"
LABEL org.opencontainers.image.revision="${CORE_AGENT_GIT_SHA}"
LABEL io.core-agent.hermes.upstream.revision="${HERMES_GIT_SHA}"

RUN printf '%s\n' "${CORE_AGENT_GIT_SHA}" | grep -Eq '^[a-f0-9]{40}$' \
    && printf '%s\n' "${HERMES_GIT_SHA}" | grep -Eq '^[a-f0-9]{40}$'

USER root

COPY infra/hermes/managed/config.yaml /etc/hermes/config.yaml
COPY infra/hermes/runtime/initialize.py /opt/core-agent/initialize.py
COPY infra/hermes/runtime/gateway-entrypoint.sh /opt/core-agent/gateway-entrypoint.sh

RUN chmod 0755 /etc/hermes \
    && chmod 0644 /etc/hermes/config.yaml \
    && install -d -m 01777 -o root -g root /opt/data \
    && chown root:root /opt/core-agent/initialize.py /opt/core-agent/gateway-entrypoint.sh \
    && chmod 0555 /opt/core-agent/initialize.py /opt/core-agent/gateway-entrypoint.sh

ENV API_SERVER_ENABLED=true \
    API_SERVER_HOST=0.0.0.0 \
    API_SERVER_PORT=8642 \
    GATEWAY_MULTIPLEX_PROFILES=true

USER hermes

ENTRYPOINT ["/opt/core-agent/gateway-entrypoint.sh"]
