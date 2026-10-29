#!/usr/bin/env bash
# Установка «Генератора лидмагнитов»: настройки, запуск в Docker и пароль владельца.
# Запуск из папки проекта: ./install.sh
# Повторный запуск безопасен: готовый .env не трогает, только пересобирает и перезапускает.
# Без вопросов (для скриптов): OWNER_EMAIL, DEEPSEEK_API_KEY, DOMAIN и OWNER_PASSWORD в окружении.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n▸ %s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || fail "Нужен Docker: https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || fail "Нужен Docker Compose v2 (команда «docker compose»)."
command -v openssl >/dev/null || fail "Нужна программа openssl."

# Записать значение в .env: строка KEY= заменяется целиком, значение берётся как есть
set_env() {
  KEY="$1" VALUE="$2" awk 'BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"] }
    index($0, k "=") == 1 { print k "=" v; done = 1; next } { print }
    END { if (!done) print k "=" v }' .env > .env.tmp && mv .env.tmp .env
}
get_env() { sed -n "s/^$1=//p" .env | tail -n 1; }

ask() { # ask ПЕРЕМЕННАЯ "вопрос" [скрыто]
  local name="$1" question="$2" hidden="${3:-}" value="${!1:-}"
  if [ -z "$value" ]; then
    [ -t 0 ] || fail "Задайте $name в окружении или запустите ./install.sh в терминале."
    if [ -n "$hidden" ]; then read -r -s -p "$question: " value; echo; else read -r -p "$question: " value; fi
  fi
  printf -v "$name" '%s' "$value"
}

if [ ! -f .env ]; then
  say "Настройки: создаю .env"
  cp .env.example .env
  ask OWNER_EMAIL "Ваша почта для входа в кабинет"
  ask DEEPSEEK_API_KEY "Ключ DeepSeek (platform.deepseek.com → API keys), ввод скрыт" hidden
  if [ -z "${DOMAIN+x}" ] && [ -t 0 ]; then
    read -r -p "Домен сервера для HTTPS (Enter — ставлю на этот компьютер): " DOMAIN
  fi
  DOMAIN="${DOMAIN:-}"

  set_env ALLOWED_EMAILS "$(printf '%s' "$OWNER_EMAIL" | tr 'A-Z' 'a-z')"
  set_env DEEPSEEK_API_KEY "$DEEPSEEK_API_KEY"
  set_env AUTH_COOKIE_SECRET "$(openssl rand -hex 32)"
  set_env BOT_TOKEN_KEY "$(openssl rand -base64 32)"
  set_env POSTGRES_PASSWORD "$(openssl rand -hex 24)"
  set_env GETCOURSE_WEBHOOK_SECRET "$(openssl rand -hex 24)"
  if [ -n "$DOMAIN" ]; then
    set_env DOMAIN "$DOMAIN"
    set_env PUBLIC_BASE_URL "https://$DOMAIN"
  fi
  chmod 600 .env
else
  say "Настройки: .env уже есть, оставляю как есть"
fi

DOMAIN="$(get_env DOMAIN)"
PROFILE=()
[ -n "$DOMAIN" ] && PROFILE=(--profile https)

say "Собираю и запускаю (первый раз — 5–10 минут)"
docker compose ${PROFILE[@]+"${PROFILE[@]}"} up -d --build

say "Жду, пока база и приложение будут готовы"
for _ in $(seq 1 120); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q web)" 2>/dev/null || true)"
  [ "$status" = "healthy" ] && break
  sleep 5
done
[ "${status:-}" = "healthy" ] || fail "Приложение не запустилось. Посмотрите журнал: docker compose logs worker web"

OWNER_EMAIL="${OWNER_EMAIL:-$(get_env ALLOWED_EMAILS | cut -d, -f1)}"
if [ -n "${OWNER_PASSWORD:-}" ]; then
  say "Пароль для $OWNER_EMAIL"
  printf '%s\n' "$OWNER_PASSWORD" | docker compose exec -T web node dist/set-password.js "$OWNER_EMAIL"
elif [ -t 0 ]; then
  say "Придумайте пароль для $OWNER_EMAIL (от 10 символов, ввод скрыт)"
  docker compose exec web node dist/set-password.js "$OWNER_EMAIL"
else
  say "Пароль задайте командой: docker compose exec web node dist/set-password.js $OWNER_EMAIL"
fi

say "Готово. Кабинет: $(get_env PUBLIC_BASE_URL)"
