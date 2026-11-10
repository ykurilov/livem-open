// Публичная поверхность модуля. Приложение импортирует только отсюда.
export { createAuthHandlers, type AuthHandlerOptions } from './handlers';
export { authMode, type AuthMode } from './core/auth-mode';
export type { AccountStore, PasswordAccount } from './password/password-session';
export { createAuthMiddleware, type MiddlewareOptions, type NextHandler } from './middleware';
export { getUser } from './server';
export type { SessionUser, SessionData } from './core/session-data';
export type { ModuleConfig } from './core/config';
