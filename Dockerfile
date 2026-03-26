FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY supe-analytics/package.json supe-analytics/package-lock.json ./
RUN npm ci

COPY supe-analytics/tsconfig.json ./
COPY supe-analytics/docs ./docs
COPY supe-analytics/src ./src

RUN npm run build

FROM node:20-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/docs ./docs

RUN npm prune --omit=dev

EXPOSE 3010

CMD ["node", "dist/server.js"]
