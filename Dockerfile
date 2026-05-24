# Minimal image so MCP directories (e.g. Glama) can build + boot the server and
# verify it responds to introspection (tools/list). No API key needed to start —
# BLACKWALL_API_KEY is only required when the `forecast` tool is actually called.
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY index.mjs ./
CMD ["node", "index.mjs"]
