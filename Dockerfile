# For any container host (the Qloo harness needs Node 22.19+ and a long-running process).
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server.js"]
