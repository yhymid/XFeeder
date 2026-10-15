FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY main.js dashboard.js ./
COPY src ./src
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /data
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "/app/main.js"]
