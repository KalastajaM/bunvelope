# Node 24 LTS: node:20 reached end of life in April 2026 and gets no more
# security fixes. package.json's engines (>=20) still admits it.
#
# Pinned to the multi-arch index digest (linux/amd64, arm64, s390x) of
# node:24-alpine as served by Docker Hub on 2026-09-24, so a rebuild gets the
# same base until someone deliberately moves it. To refresh (monthly, or on a
# Node security release), read the current digest and replace it here:
#   TOKEN=$(curl -fsS "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull" | jq -r .token)
#   curl -fsSI -H "Authorization: Bearer $TOKEN" \
#     -H "Accept: application/vnd.oci.image.index.v1+json" \
#     -H "Accept: application/vnd.docker.distribution.manifest.list.v2+json" \
#     https://registry-1.docker.io/v2/library/node/manifests/24-alpine | grep -i docker-content-digest
# (or `docker buildx imagetools inspect node:24-alpine`).
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

WORKDIR /app

# Install only runtime dependencies for a smaller image. The npm cache is
# root's and never needed at runtime.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Application source. Copied as root and left root-owned: the server only
# reads these files (no runtime writes under /app), so the unprivileged user
# below needs read access, which the default modes already give, and cannot
# modify its own code if it is ever compromised.
COPY server ./server
COPY js ./js
COPY css ./css
COPY fonts ./fonts
COPY budgets/example-project ./budgets/example-project
COPY index.html ./index.html

ENV NODE_ENV=production
EXPOSE 3000

# The official image ships an unprivileged `node` user (uid 1000). Port 3000
# is above 1024, so no capability is needed to bind it.
USER node

CMD ["node", "server/index.js"]
