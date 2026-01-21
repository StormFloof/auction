# Инструкция по деплою на Railway

## Шаг 1: Добавь MongoDB в Railway

1. Открой свой проект на Railway
2. Нажми **"+ New"** → **"Database"** → **"Add MongoDB"**
3. Railway создаст MongoDB instance и автоматически выставит переменные

## Шаг 2: Настрой переменные окружения

Перейди в настройки проекта (Variables) и добавь:

```
MONGODB_URI=${{MongoDB.MONGO_URL}}
PORT=3000
NODE_ENV=production
WORKER_INLINE=1
```

**Важно:** `${{MongoDB.MONGO_URL}}` - это reference переменная Railway, которая автоматически подставит connection string от созданной базы данных.

## Шаг 3: Деплой

```bash
git add .
git commit -m "Configure Railway deployment"
git push
```

Railway автоматически запустит деплой после push.

## Что было исправлено

1. ✅ **railway.toml** - конфигурация build/deploy процесса
2. ✅ **src/shared/db.ts** - убрано требование replica set для production
3. ✅ **package.json** - scripts уже настроены правильно (start, build)
4. ✅ **Dockerfile** - настроен для корректного запуска

## Альтернатива: MongoDB Atlas

Если Railway MongoDB не подходит, можно использовать бесплатный MongoDB Atlas:

1. Создай кластер на https://cloud.mongodb.com (бесплатный M0 tier)
2. Получи connection string
3. Добавь в Railway переменную: `MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/contest-auction`

## Проверка деплоя

После деплоя проверь логи в Railway dashboard:
- Должно быть успешное подключение к MongoDB
- API должен запуститься на указанном порту
- Отсутствуют ошибки подключения

## Возможные проблемы

### Ошибка "cannot connect to 127.0.0.1:27017"
- Убедись что `MONGODB_URI` правильно установлен
- Проверь что MongoDB service создан в Railway
- Проверь что используется reference `${{MongoDB.MONGO_URL}}`

### Ошибка "ReplicaSetNoPrimary"
- Уже исправлено: в production не используется replica set
- Fallback автоматически переключается на standalone mode
