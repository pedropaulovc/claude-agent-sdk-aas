FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist/ dist/
ENV AAS_ROLE=control-plane
EXPOSE 8080
CMD ["node", "dist/entry.js"]
