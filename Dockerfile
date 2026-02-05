# Build Stage
FROM node:25-alpine AS builder

ARG BACKEND_DIR=backend
ARG SQUARE_TOKEN=""

# Put backend files in /app/backend so that file://../common resolves to /app/common
WORKDIR /app/backend

# Copy backend package files
COPY ${BACKEND_DIR}/package*.json ./

# Copy local common package into a sibling path so file://../common resolves correctly
COPY common /app/common

# Provide SQUARE_TOKEN to build stage if needed
ENV SQUARE_TOKEN=${SQUARE_TOKEN}

# Install dependencies (including dev) to build the project
RUN npm ci

# Copy rest of the backend source needed for the build
COPY ${BACKEND_DIR}/tsconfig.json ./
COPY ${BACKEND_DIR}/src ./src

# Build the TypeScript project (expects a build script that outputs to ./dist)
RUN npm run build

# Remove devDependencies to reduce what we copy into the final image
RUN npm prune --production

# Production Stage
FROM node:25-alpine AS production

ARG SQUARE_TOKEN=""
WORKDIR /app

# Create non-root user/group
RUN addgroup -g 1001 -S nodejs && \
    adduser -S express -u 1001 -G nodejs

# Copy only built artifacts and production node_modules + package files from builder
COPY --from=builder --chown=express:nodejs /app/backend/dist ./dist
COPY --from=builder --chown=express:nodejs /app/backend/node_modules ./node_modules
COPY --from=builder --chown=express:nodejs /app/backend/package*.json ./

# Expose SQUARE_TOKEN at runtime (defaults to empty if not provided)
ENV SQUARE_TOKEN=${SQUARE_TOKEN}
ENV NODE_ENV=production

USER express

EXPOSE 3000

# Healthcheck that considers HTTP 200 as healthy
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# Start the built application (assumes compiled entry is dist/server.js)
CMD ["node", "dist/server.js"]
