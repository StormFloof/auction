FROM node:18-alpine AS builder

WORKDIR /app

# Копируем package files
COPY package*.json ./
RUN npm ci --only=production

# Копируем исходники
COPY tsconfig.json ./
COPY src ./src

# Собираем проект
RUN npm install -D typescript @types/node
RUN npm run build

# Production образ
FROM node:18-alpine

WORKDIR /app

# Копируем зависимости из builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./

# Копируем статику
COPY public ./public

# Создаем пользователя
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 3000

CMD ["node", "dist/index.js"]
