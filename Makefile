.PHONY: help install up down logs start-all seed-demo test build clean

# Default target
help:
	@echo "Contest Auction - Makefile команды:"
	@echo ""
	@echo "  make install      - Установить зависимости"
	@echo "  make up           - Запустить MongoDB"
	@echo "  make down         - Остановить MongoDB"
	@echo "  make logs         - Показать логи MongoDB"
	@echo "  make start-all    - Запустить все сервисы (API + Workers)"
	@echo "  make seed-demo    - Создать демо-данные"
	@echo "  make test         - Запустить тесты"
	@echo "  make build        - Собрать проект"
	@echo "  make clean        - Очистить сборку"
	@echo ""
	@echo "Быстрый старт:"
	@echo "  make install && make up && make start-all"
	@echo ""
	@echo "Полный Docker стек:"
	@echo "  docker compose -f docker-compose.full.yml up --build"

install:
	npm install

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f

start-all:
	npm run start:all

seed-demo:
	npm run seed:demo

test:
	npm test

build:
	npm run build

clean:
	rm -rf dist node_modules
