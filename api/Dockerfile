# Charity backend (API only on Railway; the site is on Vercel). Node 24: the pump.fun SDK
# does not import on Node 20/22.
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    SERVE_SITE=0

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

CMD ["node", "src/server.js"]
