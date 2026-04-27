import type { CloudflareProvisionStep } from './types.js';
import {
  deriveZoneHostname,
  hostnameBelongsToZone,
  isLocalHostname,
  isPlaceholderHostname,
  normalizeHostname,
} from './utils.js';

export function normalizeProvisionHostnames(input: {
  readonly zoneName: string;
  readonly workerName: string;
  readonly daemonHostname: string;
  readonly workerHostname: string;
  readonly needsDaemonHostname: boolean;
  readonly needsWorkerHostname: boolean;
  readonly steps: CloudflareProvisionStep[];
}): { readonly daemonHostname: string; readonly workerHostname: string } {
  let daemonHostname = normalizeHostname(input.daemonHostname);
  let workerHostname = normalizeHostname(input.workerHostname);
  const zoneName = normalizeHostname(input.zoneName);

  if (zoneName && input.needsDaemonHostname) {
    const derivedDaemon = deriveZoneHostname('daemon', zoneName);
    const daemonBelongsToZone = hostnameBelongsToZone(daemonHostname, zoneName);
    const daemonSourceIsNotUsable = !daemonHostname ||
      isLocalHostname(daemonHostname) ||
      (isPlaceholderHostname(daemonHostname) && !daemonBelongsToZone);
    if (daemonSourceIsNotUsable) {
      if (daemonHostname && daemonHostname !== derivedDaemon) {
        input.steps.push({ name: 'daemon-hostname', status: 'ok', message: `Using ${derivedDaemon} instead of placeholder/local daemon hostname ${daemonHostname} for selected zone ${zoneName}.` });
      } else if (!daemonHostname) {
        input.steps.push({ name: 'daemon-hostname', status: 'ok', message: `Using ${derivedDaemon} as the Cloudflare-managed daemon hostname for selected zone ${zoneName}.` });
      }
      daemonHostname = derivedDaemon;
    } else if (!daemonBelongsToZone) {
      input.steps.push({ name: 'daemon-hostname', status: 'warning', message: `Configured daemonHostname ${daemonHostname} does not belong to selected zone ${zoneName}; Tunnel, DNS, and Access hostname automation for the daemon will be skipped.` });
      daemonHostname = '';
    }
  }

  if (zoneName && input.needsWorkerHostname && workerHostname) {
    const derivedWorker = deriveZoneHostname(input.workerName, zoneName);
    const workerBelongsToZone = hostnameBelongsToZone(workerHostname, zoneName);
    if (isPlaceholderHostname(workerHostname) && !workerBelongsToZone) {
      input.steps.push({ name: 'worker-hostname', status: 'ok', message: `Using ${derivedWorker} instead of placeholder Worker hostname ${workerHostname} for selected zone ${zoneName}.` });
      workerHostname = derivedWorker;
    } else if (!workerBelongsToZone) {
      input.steps.push({ name: 'worker-hostname', status: 'warning', message: `Configured workerHostname ${workerHostname} does not belong to selected zone ${zoneName}; Worker DNS automation will be skipped.` });
      workerHostname = '';
    }
  }

  if (!zoneName && input.needsDaemonHostname && isPlaceholderHostname(daemonHostname)) {
    input.steps.push({ name: 'daemon-hostname', status: 'warning', message: `Configured daemonHostname ${daemonHostname} is a placeholder; Cloudflare daemon hostname automation will be skipped until a real zone hostname is configured.` });
    daemonHostname = '';
  }
  if (!zoneName && input.needsWorkerHostname && isPlaceholderHostname(workerHostname)) {
    input.steps.push({ name: 'worker-hostname', status: 'warning', message: `Configured workerHostname ${workerHostname} is a placeholder; Worker DNS automation will be skipped until a real zone hostname is configured.` });
    workerHostname = '';
  }

  return { daemonHostname, workerHostname };
}
