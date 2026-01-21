# 🚀 Руководство по деплою Contest Auction

Инструкции для развёртывания проекта на бесплатных платформах для демо.

## Требования для всех платформ

- GitHub репозиторий с проектом
- Аккаунт на выбранной платформе
- MongoDB Atlas (бесплатный кластер) или встроенная БД платформы

---

## Вариант 1: Railway.app (рекомендуется)

**Преимущества:** Простой деплой, встроенная MongoDB, 500 часов бесплатно/месяц

### Шаги:

1. **Зарегистрироваться:** https://railway.app
2. **New Project → Deploy from GitHub repo**
3. **Выбрать репозиторий:** contest-auction
4. **Добавить MongoDB:**
   - New → Database → Add MongoDB
   - Railway автоматически создаст переменную `MONGO_URL`

5. **Настроить переменные окружения:**
```
NODE_ENV=production
PORT=3000
WORKER_INLINE=1
```

6. **Настроить билд:**
   - Build Command: `npm install && npm run build`
   - Start Command: `npm run start`

7. **Deploy:** Railway автоматически задеплоит

8. **Получить URL:** Settings → Domains → Generate Domain

### Добавить Workers (опционально):

1. **New Service → Empty Service**
2. **Настроить:**
   - Build Command: `npm install && npm run build`
   - Start Command: `npm run start:worker`
3. **Использовать ту же MONGO_URL**

### Seed данные:
```bash
# Локально
npm run seed:demo -- --api-url=https://your-app.railway.app/api
```

---

## Вариант 2: Fly.io

**Преимущества:** Бесплатный план, хорошая производительность, поддержка Docker

### Шаги:

1. **Установить CLI:**
```bash
# Windows (PowerShell)
iwr https://fly.io/install.ps1 -useb | iex

# macOS/Linux
curl -L https://fly.io/install.sh | sh
```

2. **Войти:**
```bash
fly auth login
```

3. **Создать fly.toml:**
```toml
app = "contest-auction"

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "3000"
  NODE_ENV = "production"
  WORKER_INLINE = "1"

[[services]]
  internal_port = 3000
  protocol = "tcp"

  [[services.ports]]
    handlers = ["http"]
    port = 80

  [[services.ports]]
    handlers = ["tls", "http"]
    port = 443
```

4. **Создать MongoDB на MongoDB Atlas:**
   - https://www.mongodb.com/cloud/atlas/register
   - Create Free Cluster
   - Database Access → Add User
   - Network Access → Add IP Address → Allow Access from Anywhere (0.0.0.0/0)
   - Connect → Connect your application → Copy connection string

5. **Добавить secrets:**
```bash
fly secrets set MONGO_URI="mongodb+srv://user:password@cluster.mongodb.net/contest-auction?retryWrites=true&w=majority"
```

6. **Deploy:**
```bash
fly deploy
```

7. **Открыть:**
```bash
fly open
```

---

## Вариант 3: Render.com

**Преимущества:** Простой, бесплатный SSL, автоматические деплои из GitHub

### Шаги:

1. **Зарегистрироваться:** https://render.com
2. **New → Web Service**
3. **Подключить GitHub репозиторий**
4. **Настроить:**
   - Name: `contest-auction`
   - Environment: `Node`
   - Build Command: `npm install && npm run build`
   - Start Command: `npm run start`
   - Instance Type: `Free`

5. **Добавить переменные:**
```
NODE_ENV=production
PORT=3000
WORKER_INLINE=1
MONGO_URI=<получить из MongoDB Atlas>
```

6. **MongoDB Atlas:** (см. инструкции для Fly.io)

7. **Deploy:** Render автоматически задеплоит

---

## Вариант 4: VPS (DigitalOcean, Hetzner, etc.)

**Преимущества:** Полный контроль, можно использовать docker-compose

### Используя готовый deploy скрипт:

1. **Создать VPS:**
   - Ubuntu 22.04 LTS
   - Минимум: 1GB RAM, 1 vCPU
   - Получить IP-адрес и пароль root

2. **Локально (Windows):**
```bash
pip install -r deploy/requirements.txt
python deploy/deploy.py
```

3. **Следовать инструкциям скрипта:**
   - Ввести IP-адрес
   - Ввести пароль root
   - Скрипт автоматически установит Docker, загрузит код и запустит

4. **Открыть:** `http://your-ip-address:3000`

### Ручной деплой на VPS:

```bash
# SSH на сервер
ssh root@your-ip

# Установить Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh

# Установить Docker Compose
apt-get install -y docker-compose-plugin

# Клонировать репозиторий
git clone https://github.com/your-username/contest-auction.git
cd contest-auction

# Запустить
docker compose -f docker-compose.full.yml up -d --build

# Создать демо-данные
docker exec -it contest-auction-api npm run seed:demo
```

---

## После деплоя

### 1. Проверить работоспособность
```bash
curl https://your-app-url/health
```

### 2. Создать демо-данные
```bash
# Если есть доступ к npm на сервере
npm run seed:demo

# Или через curl
curl -X POST https://your-app-url/api/accounts/demo1/deposit \
  -H "Content-Type: application/json" \
  -d '{"amount":"10000","currency":"RUB"}'
```

### 3. Обновить DEMO.md
Добавить ссылку на развёрнутое приложение:
```markdown
### 🌐 Работающий сайт
https://your-app-url.railway.app
```

### 4. Проверить доступность
- Открыть в браузере (инкогнито режим)
- Проверить что UI загружается
- Создать тестовый аукцион
- Убедиться что всё работает

---

## Мониторинг

После деплоя можно проверить:

### Health check:
```bash
curl https://your-app-url/health
```

### Prometheus метрики:
```bash
curl https://your-app-url/metrics
```

### Логи (Railway):
- Dashboard → Deployments → View Logs

### Логи (Render):
- Dashboard → Logs

### Логи (Fly.io):
```bash
fly logs
```

### Логи (VPS):
```bash
docker compose logs -f
```

---

## Troubleshooting

### Проблема: Не запускается MongoDB транзакции

**Решение:** Убедитесь что MongoDB настроен как replica set:
```javascript
// В mongo-init.js должно быть:
rs.initiate()
```

### Проблема: Connection refused к MongoDB

**Решение:** 
- Проверить MONGO_URI
- Для Atlas: добавить IP в whitelist (или 0.0.0.0/0)
- Для локальной БД: проверить что используется правильный host

### Проблема: Worker не закрывает раунды

**Решение:**
- Если используется `WORKER_INLINE=1`, worker встроен в API
- Если отдельный worker сервис, проверить логи

### Проблема: 502 Bad Gateway

**Решение:**
- Проверить что приложение слушает правильный PORT
- Проверить health check endpoint
- Подождать пару минут (первый запуск может быть долгим)

---

## Рекомендации для конкурса

1. **Railway.app** — самый простой вариант (встроенная MongoDB)
2. **Fly.io** — если нужен полный контроль (Docker)
3. **VPS** — если есть опыт с серверами

**После деплоя:**
- Обязательно заполнить демо-данными
- Проверить работоспособность
- Добавить ссылку в DEMO.md
- Сделать скриншоты (опционально)

---

**Готово!** Теперь у вас есть работающее демо для жюри конкурса. 🚀
