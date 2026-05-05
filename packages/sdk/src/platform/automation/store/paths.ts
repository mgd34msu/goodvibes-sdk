/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import { join } from 'node:path';

export interface AutomationStorePathConfig {
  readonly controlPlaneDir?: string | undefined;
  readonly getControlPlaneConfigDir?: (() => string) | undefined;
}

function resolveAutomationStoreRootDir(config: AutomationStorePathConfig): string {
  const controlPlaneDir = config.controlPlaneDir ?? (
    typeof config.getControlPlaneConfigDir === 'function'
      ? config.getControlPlaneConfigDir()
      : undefined
  );
  if (!controlPlaneDir) {
    throw new Error('Automation stores require an explicit controlPlaneDir or configManager.getControlPlaneConfigDir().');
  }
  return controlPlaneDir;
}

export function resolveAutomationStorePath(
  filename: string,
  config: AutomationStorePathConfig,
): string {
  return join(resolveAutomationStoreRootDir(config), filename);
}
