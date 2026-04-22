FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl https://cursor.com/install -fsS | bash \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc && cp -r src/codex_instructions dist/

ENV CODEX_PROVIDER=cursor-agent \
    CODEX_PRESET=cursor-auto \
    CODEX_GATEWAY_HOST=0.0.0.0 \
    CODEX_GATEWAY_PORT=8000

EXPOSE 8000

CMD ["node", "dist/cli.js", "cursor-agent", "--host", "0.0.0.0"]
