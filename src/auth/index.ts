// Публичная поверхность модуля. Приложение импортирует только отсюда.
export { createAuthHandlers, type AuthHandlerOptions } from './handlers.js';
export { authMode, type AuthMode } from './core/auth-mode.js';
export type { AccountStore, PasswordAccount } from './password/password-session.js';
export { createAuthMiddleware, type MiddlewareOptions, type NextHandler } from './middleware.js';
export { getUser } from './server.js';
export type { SessionUser, SessionData } from './core/session-data.js';
export type { ModuleConfig } from './core/config.js';
