#
# Seen frontend Dockerfile
#
# Builds the Vite React app and serves the static bundle via nginx.
# Configure the backend URL at build time with:
#   docker build --build-arg VITE_API_BASE_URL=https://seen.example.com -t seen-frontend .
#

# ---- Build stage -----------------------------------------------------------
FROM node:20-alpine AS build

WORKDIR /app

# Ensure devDependencies (TypeScript, Vite, etc.) are installed for the build
ENV NODE_ENV=development

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci

# Allow overriding the backend URL and enabling the Docker file browser at build time
ARG VITE_API_BASE_URL=http://localhost:9161
ARG VITE_ENABLE_FILE_BROWSER=0
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
ENV VITE_ENABLE_FILE_BROWSER=${VITE_ENABLE_FILE_BROWSER}

# Copy the rest of the source and build the production bundle
COPY . .

RUN npm run build

 # ---- Runtime stage ---------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

# Create templates directory and copy nginx config template (will be processed by entrypoint)
RUN mkdir -p /etc/nginx/templates
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY docker-entrypoint.sh /docker-entrypoint.sh
# Fix line endings and make executable (handles Windows CRLF -> Unix LF conversion)
RUN sed -i 's/\r$//' /docker-entrypoint.sh && chmod +x /docker-entrypoint.sh

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

ENTRYPOINT ["/docker-entrypoint.sh"]

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost/ || exit 1


