# Pure-JS implementation — no native build tools needed
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --production
COPY . .
# For stdio-based MCP, CMD should just run the index
CMD ["node", "src/index.js"]
