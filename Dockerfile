FROM node:18-alpine
WORKDIR /app

COPY package*.json ./
COPY . . 

RUN npm ci

RUN mkdir -p /app/data && chown -R node:node /app/data

EXPOSE 8282

USER node

CMD ["node", "app.js"]