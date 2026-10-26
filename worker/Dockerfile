FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends lua5.4 && rm -rf /var/lib/apt/lists/*
COPY check.cjs manifest.cjs /opt/nd-ai/
USER 65534:65534
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/nd-ai/check.cjs"]
