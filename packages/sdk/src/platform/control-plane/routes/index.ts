// The live daemon route dispatch is daemon-sdk's; this barrel re-exports it.
// The former sdk-local dispatcher copies (automation/tasks/operator/remote/
// sessions + their context types) were a superseded, unreachable parallel —
// deleted in the Wave-1 spine integration cleanup (0 callers, 0 api.md
// presence; every test imports the daemon-sdk originals). Pay-its-way rule.
export { dispatchDaemonApiRoutes } from './api-router.js';
