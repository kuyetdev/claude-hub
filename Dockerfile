FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/hub ./hub
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/agent ./agent
COPY --from=build /app/package.json ./package.json
RUN tar -czf agent-bundle.tar.gz agent shared/types.ts hub/validate.ts \
  && sha256sum agent-bundle.tar.gz | cut -d' ' -f1 > agent-bundle.version
USER node
EXPOSE 1780
CMD ["node", "hub/index.ts"]
