# syntax=docker/dockerfile:1.25.0@sha256:0adf442eae370b6087e08edc7c50b552d80ddf261576f4ebd6421006b2461f12

FROM node:24.18.1-alpine3.24@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3 AS build

RUN npm install --global --ignore-scripts npm@12.0.2

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.18.1-alpine3.24@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3 AS runtime

RUN npm install --global --ignore-scripts npm@12.0.2

ARG VERSION=dev
ARG REVISION=unknown

LABEL org.opencontainers.image.title="HayaSend" \
      org.opencontainers.image.description="Resend-compatible, provider-portable email infrastructure" \
      org.opencontainers.image.source="https://github.com/haya-inc/hayasend" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="Apache-2.0"

ENV NODE_ENV=production \
    HAYASEND_MODE=local \
    HAYASEND_HOST=0.0.0.0 \
    HAYASEND_PORT=8787

WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

USER node

EXPOSE 8787

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "dist/server.js"]
