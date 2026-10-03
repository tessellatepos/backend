FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json ./
RUN npm install --ignore-scripts --legacy-peer-deps

COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-alpine AS production
ENV NODE_ENV=production
WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -S express -u 1001 -G nodejs

COPY --from=builder --chown=express:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=express:nodejs /app/package.json ./
COPY --from=builder --chown=express:nodejs /app/dist ./dist
# Resolved relative to the working directory at runtime
COPY --chown=express:nodejs drizzle ./drizzle
# Plugins are mounted or copied in here; the server also creates it if missing
RUN mkdir plugins && chown express:nodejs plugins

USER express
EXPOSE 3000

# Any HTTP response means the server is up; only a connection failure is unhealthy
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
