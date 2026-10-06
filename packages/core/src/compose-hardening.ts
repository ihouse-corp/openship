import type { ComposeAdvanced } from "./types";

/** Shared by YAML import and normalized Docker Compose CLI sync. Invalid
 * restrictions block import instead of silently widening the container. */
export function parseComposeHardening(
  svc: Record<string, unknown>,
  interpolate: (value: string) => string = (value) => value,
): {
  advanced: ComposeAdvanced;
  issues: Array<{ field: string; reason: string; blocking: true }>;
} {
  const advanced: ComposeAdvanced = {};
  const issues: Array<{ field: string; reason: string; blocking: true }> = [];
  const block = (field: string, reason: string) => issues.push({ field, reason, blocking: true });

  if (svc.read_only !== undefined && svc.read_only !== null) {
    const value = typeof svc.read_only === "string" ? interpolate(svc.read_only) : svc.read_only;
    if (value === true || value === "true") advanced.readOnly = true;
    else if (value === false || value === "false") advanced.readOnly = false;
    else block("read_only", "read_only must resolve to a boolean.");
  }

  if (svc.cap_drop !== undefined && svc.cap_drop !== null) {
    if (Array.isArray(svc.cap_drop) && svc.cap_drop.every((v) => typeof v === "string")) {
      const caps = svc.cap_drop.map((v) => interpolate(v).toUpperCase());
      if (caps.every((v) => /^[A-Z][A-Z0-9_]*$/.test(v))) advanced.capDrop = caps;
      else block("cap_drop", "cap_drop must contain capability names.");
    } else block("cap_drop", "cap_drop must be a list of capability names.");
  }

  if (svc.tmpfs !== undefined && svc.tmpfs !== null) {
    const mounts = typeof svc.tmpfs === "string" ? [svc.tmpfs] : svc.tmpfs;
    if (Array.isArray(mounts) && mounts.every((v) => typeof v === "string")) {
      const tmpfs: Record<string, string> = {};
      for (const mount of mounts) {
        const value = interpolate(mount);
        const split = value.indexOf(":");
        const target = split < 0 ? value : value.slice(0, split);
        const options = split < 0 ? "" : value.slice(split + 1);
        if (
          !/^\/[^:\u0000-\u001F\u007F]+$/.test(target) ||
          target.split("/").some((part) => part === "." || part === "..") ||
          /[\u0000-\u001F\u007F]/.test(options) ||
          target in tmpfs
        ) {
          block(
            "tmpfs",
            "tmpfs requires distinct absolute container paths and valid mount options.",
          );
        } else tmpfs[target] = options;
      }
      advanced.tmpfs = tmpfs;
    } else block("tmpfs", "tmpfs must be a path string or list of path strings.");
  }

  if (svc.security_opt !== undefined && svc.security_opt !== null) {
    if (Array.isArray(svc.security_opt) && svc.security_opt.every((v) => typeof v === "string")) {
      for (const option of svc.security_opt) {
        const value = interpolate(option);
        if (/^no-new-privileges(?::true|=true)?$/.test(value)) advanced.noNewPrivileges = true;
        else block("security_opt", "Only no-new-privileges:true is supported.");
      }
    } else block("security_opt", "security_opt must be a list of security options.");
  }

  return { advanced, issues };
}
