import { useEffect, useState } from "react";

interface Perm { id: number; permissionKey: string; name: string; category: string; isForbidden: boolean; }
interface Role { id: number; roleKey: string; name: string; }
interface Matrix { matrix: Record<string, Record<string, boolean>>; }

export default function RolesPermissions() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [perms, setPerms] = useState<Perm[]>([]);
  const [matrix, setMatrix] = useState<Matrix["matrix"]>({});

  useEffect(() => {
    Promise.all([
      fetch("/api/security/roles").then((r) => r.json()),
      fetch("/api/security/permissions").then((r) => r.json()),
      fetch("/api/security/role-permissions").then((r) => r.json()),
    ]).then(([r, p, m]) => { setRoles(r.roles); setPerms(p.permissions); setMatrix(m.matrix); });
  }, []);

  return (
    <div className="space-y-6" data-testid="roles-permissions">
      <h1 className="text-2xl font-bold">Roles & Permissions</h1>
      <div className="border rounded p-4 overflow-auto">
        <h2 className="font-semibold mb-3">Role × Permission Matrix</h2>
        <table className="text-xs">
          <thead>
            <tr><th className="text-left p-1 sticky left-0 bg-white">Permission</th>{roles.map((r) => <th key={r.id} className="p-1 px-3">{r.roleKey}</th>)}</tr>
          </thead>
          <tbody>
            {perms.map((p) => (
              <tr key={p.id} className={p.isForbidden ? "bg-danger/10" : ""}>
                <td className="p-1 font-mono sticky left-0 bg-inherit">
                  {p.permissionKey} {p.isForbidden && <span className="ml-1 text-danger font-bold">[FORBIDDEN-LOCKED]</span>}
                </td>
                {roles.map((r) => {
                  const ok = matrix[r.roleKey]?.[p.permissionKey] ?? false;
                  return <td key={r.id} className={`p-1 text-center ${p.isForbidden ? "text-danger font-bold" : ok ? "text-success" : "text-txt-secondary"}`}>{p.isForbidden ? "✕" : ok ? "✓" : "·"}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-xs text-txt-muted">
        Forbidden permissions (red) can never be granted to any role; attempts are logged as CRITICAL security events.
      </div>
    </div>
  );
}
