import { createHash } from "node:crypto";

/** Админский адрес PostgreSQL для создания тестовых баз (из docker-compose.dev.yml). */
export const TEST_ADMIN_DATABASE_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://livem:livem@localhost:55439/postgres";

// Своя приставка у каждой копии репозитория: параллельные прогоны в соседних worktree не удаляют чужие базы
const checkoutTag = createHash("sha1").update(process.cwd()).digest("hex").slice(0, 6);

export const TEST_DATABASE_PREFIX = `livem_test_${checkoutTag}_`;
