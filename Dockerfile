FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN tar -czf /tmp/claude-hub-agent.tar.gz agent hub/validate.ts shared/types.ts

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/hub ./hub
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/package.json ./package.json
COPY --from=build /tmp/claude-hub-agent.tar.gz ./claude-hub-agent.tar.gz
USER node
EXPOSE 1780
CMD ["node", "hub/index.ts"]
