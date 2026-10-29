import { createAuthHandlers } from "@/auth";
import { findAccountByEmail } from "@/modules/accounts";
import { getDatabase } from "@/modules/platform/db";

export const dynamic = "force-dynamic";

// База открывается при первом входе по паролю, не при загрузке маршрута: сборка идёт без базы
export const { GET, POST } = createAuthHandlers({
  env: process.env,
  accounts: { findByEmail: (email) => findAccountByEmail(getDatabase().db, email) },
});
