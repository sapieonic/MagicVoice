# MagicVoice Core Service
# Multi-stage build for smaller production image

# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev)
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Stage 2: Production
FROM node:20-alpine AS production

# Create non-root user for security
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

WORKDIR /app

# Copy package files and install dependencies (as root for npm ci)
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy built files from builder stage with correct ownership
COPY --chown=appuser:appgroup --from=builder /app/dist ./dist

# Copy public assets and config with correct ownership
COPY --chown=appuser:appgroup --from=builder /app/dist/public ./dist/public
COPY --chown=appuser:appgroup --from=builder /app/dist/prompts ./dist/prompts

# Copy external config directory with correct ownership
COPY --chown=appuser:appgroup config-external ./config-external

# Change ownership of package files only (small, fast)
RUN chown appuser:appgroup package*.json

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/config || exit 1

# Start the service
CMD ["node", "--import", "./dist/instrumentation.js", "dist/server.js"]
