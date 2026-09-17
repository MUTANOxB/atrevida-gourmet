FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
COPY backend/package*.json ./backend/
RUN npm ci

COPY . .
RUN npm run typecheck \
    && npm test \
    && npm run test:frontend \
    && npm run build \
    && npm run scan:build

FROM node:20-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
COPY backend/package*.json ./backend/
RUN npm ci --omit=dev

COPY --from=build --chown=node:node /app/backend/dist ./backend/dist
COPY --from=build --chown=node:node /app/dist ./dist

USER node
EXPOSE 3333
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3333)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "backend/dist/server.js"]
