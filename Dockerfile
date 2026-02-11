FROM node:20-alpine

RUN mkdir -p /usr/src/node-app && chown -R node:node /usr/src/node-app

WORKDIR /usr/src/node-app

# Use npm (project has package-lock.json, not yarn.lock)
COPY package.json package-lock.json ./

USER node

# Install dependencies without running lifecycle scripts (skips husky "prepare")
RUN npm ci --omit=dev --ignore-scripts

COPY --chown=node:node . .

EXPOSE 3000

CMD ["node", "src/index.js"]
