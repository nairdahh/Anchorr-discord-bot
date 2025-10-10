
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./

RUN npm ci


FROM node:18-alpine
WORKDIR /app


COPY --from=builder /app/node_modules ./node_modules

COPY . .


RUN mkdir -p /app/data && chown -R node:node /app/data


EXPOSE 8282


USER node


CMD ["node", "app.js"]